import Foundation

// MARK: - OpenAI Responses API Request

struct ResponsesRequest: Codable {
    let model: String
    let input: [ResponsesInputItem]
    var stream: Bool?
    var temperature: Float?
    var max_output_tokens: Int?
    var tools: [AnyCodable]?
    // Fields normalized/removed by the proxy before forwarding are intentionally omitted.
}

struct ResponsesInputItem: Codable {
    // Common
    var type: String?
    var role: String?
    var content: ResponsesContent?
    // function_call
    var call_id: String?
    var name: String?
    var arguments: String?
    // function_call_output
    var output: String?
}

enum ResponsesContent: Codable {
    case string(String)
    case parts([ResponsesContentPart])

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let s = try? c.decode(String.self) { self = .string(s); return }
        if let p = try? c.decode([ResponsesContentPart].self) { self = .parts(p); return }
        self = .string("")
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .string(let s): try c.encode(s)
        case .parts(let p): try c.encode(p)
        }
    }

    var text: String {
        switch self {
        case .string(let s): return s
        case .parts(let parts):
            return parts.compactMap { part -> String? in
                guard ["input_text", "text", "output_text"].contains(part.type) else { return nil }
                return part.text
            }.joined(separator: "\n")
        }
    }
}

struct ResponsesContentPart: Codable {
    let type: String
    var text: String?
}

// MARK: - OpenAI Responses API Response (non-streaming)

struct ResponsesResponse: Codable {
    let id: String
    let object: String
    let created_at: Int
    let model: String
    let output: [ResponsesOutputItem]
    let status: String
    var usage: ResponsesUsage?
}

struct ResponsesOutputItem: Codable {
    let type: String
    let id: String
    // message fields
    var role: String?
    var content: [ResponsesOutputContent]?
    var status: String?
    // function_call fields
    var call_id: String?
    var name: String?
    var arguments: String?
}

struct ResponsesOutputContent: Codable {
    let type: String  // "output_text"
    let text: String
}

struct ResponsesUsage: Codable {
    let input_tokens: Int
    let output_tokens: Int
    let total_tokens: Int
}

// MARK: - Conversion: Responses → internal ChatMessages

func responsesToInternalMessages(_ req: ResponsesRequest) -> [ChatMessage] {
    var messages: [ChatMessage] = []
    var pendingToolCalls: [ToolCallInfo] = []

    func flushToolCalls() {
        guard !pendingToolCalls.isEmpty else { return }
        messages.append(ChatMessage(
            role: "assistant",
            content: .string(""),
            tool_calls: pendingToolCalls
        ))
        pendingToolCalls.removeAll()
    }

    for item in req.input {
        let itemType = item.type ?? "message"
        switch itemType {
        case "message", "":
            flushToolCalls()
            let role = item.role ?? "user"
            let text = item.content?.text ?? ""
            messages.append(ChatMessage(role: role, content: .string(text)))

        case "reasoning":
            flushToolCalls()
            let text = item.content?.text ?? ""
            if !text.isEmpty {
                messages.append(ChatMessage(role: "assistant", content: .string(text)))
            }

        case "function_call":
            let callId = item.call_id ?? generateToolCallId()
            let name = item.name ?? ""
            let args = item.arguments ?? "{}"
            pendingToolCalls.append(ToolCallInfo(
                id: callId,
                type: "function",
                function: FunctionCall(name: name, arguments: args)
            ))

        case "function_call_output":
            flushToolCalls()
            var msg = ChatMessage(role: "tool", content: .string(item.output ?? ""))
            msg.tool_call_id = item.call_id ?? ""
            messages.append(msg)

        default:
            break
        }
    }

    flushToolCalls()
    return messages
}

/// Responses API tools are flat {type, name, description, parameters}.
/// Chat Completions needs {type, function: {name, description, parameters}}.
func responsesToolsToChatTools(_ tools: [AnyCodable]) -> [AnyCodable] {
    tools.compactMap { tool -> AnyCodable? in
        guard var dict = tool.value as? [String: Any],
              (dict["type"] as? String) == "function",
              dict["function"] == nil else {
            return tool
        }
        var fnDef: [String: Any] = [:]
        for key in ["name", "description", "parameters"] {
            if let v = dict.removeValue(forKey: key) {
                fnDef[key] = v
            }
        }
        dict["function"] = fnDef
        return AnyCodable(dict)
    }
}
