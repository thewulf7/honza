import ArgumentParser
import Foundation
import Hummingbird
import MLX

@main
struct MLXServerCommand: AsyncParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "mlx-server",
        abstract: "MLX-Swift inference server with OpenAI-compatible API"
    )

    @Option(name: [.long, .short], help: "Path to the GGUF model file")
    var model: String

    @Option(name: .long, help: "Port to listen on")
    var port: Int = 8080

    @Option(name: .long, help: "Context window size (used as default max output tokens)")
    var ctxSize: Int = 4096

    @Option(name: .long, help: "KV cache quantization bits: 4 or 8 (0 = disabled)")
    var kvBits: Int = 0

    @Option(name: .long, help: "Rotating KV cache max tokens — old entries evicted when full (0 = unlimited)")
    var maxKvSize: Int = 0

    @Option(name: .long, help: "Prefill step size in tokens (default: 512)")
    var prefillStepSize: Int = 512

    @Option(name: .long, help: "GPU memory limit in GB (0 = system default)")
    var memoryLimitGb: Float = 0

    @Option(name: .long, help: "API key for authentication (optional)")
    var apiKey: String = ""

    @Option(name: .long, help: "Model ID reported by the API (defaults to parent directory name)")
    var modelId: String = ""

    func run() async throws {
        if memoryLimitGb > 0 {
            Memory.memoryLimit = Int(memoryLimitGb * 1024 * 1024 * 1024)
        }

        // Print startup info
        log("[mlx] MLX-Swift Server starting...")
        log("[mlx] Model path: \(model)")
        log("[mlx] Port: \(port)")
        log("[mlx] Context size: \(ctxSize)")
        if kvBits == 4 || kvBits == 8 { log("[mlx] KV cache: \(kvBits)-bit quantized") }
        if maxKvSize > 0 { log("[mlx] KV cache max tokens: \(maxKvSize) (rotating)") }
        if prefillStepSize != 512 { log("[mlx] Prefill step size: \(prefillStepSize)") }
        if memoryLimitGb > 0 { log("[mlx] GPU memory limit: \(memoryLimitGb)GB") }

        // Resolve model ID: use --model-id if provided, otherwise derive from parent directory
        let modelURL = URL(fileURLWithPath: model)
        let resolvedModelId = modelId.isEmpty
            ? modelURL.deletingPathExtension().lastPathComponent
            : modelId

        // Load the model
        let modelRunner = ModelRunner()

        do {
            try await modelRunner.load(modelPath: model)
        } catch {
            log("[mlx] Failed to load model: \(error)")
            throw error
        }

        await modelRunner.configure(
            kvBits: (kvBits == 4 || kvBits == 8) ? kvBits : nil,
            maxKvSize: maxKvSize > 0 ? maxKvSize : nil,
            prefillStepSize: prefillStepSize
        )

        // Set up the HTTP server
        let server = MLXHTTPServer(
            modelRunner: modelRunner,
            modelId: resolvedModelId,
            apiKey: apiKey,
            defaultMaxTokens: ctxSize > 0 ? ctxSize : 4096
        )

        let router = server.buildRouter()
        let app = Application(router: router, configuration: .init(address: .hostname("127.0.0.1", port: port)))

        // Emit readiness signal after the server actually accepts connections.
        // Polling the health endpoint is more reliable than guessing when app.run() binds.
        Task.detached {
            let healthURL = URL(string: "http://127.0.0.1:\(port)/health")!
            for _ in 0..<400 {  // up to 20s in 50ms steps
                try? await Task.sleep(nanoseconds: 50_000_000)
                if let (_, resp) = try? await URLSession.shared.data(from: healthURL),
                   (resp as? HTTPURLResponse)?.statusCode == 200 {
                    log("[mlx] server is listening on 127.0.0.1:\(port)")
                    return
                }
            }
            // Fallback: signal anyway so Tauri doesn't hang forever
            log("[mlx] server is listening on 127.0.0.1:\(port)")
        }

        try await app.run()
    }
}
