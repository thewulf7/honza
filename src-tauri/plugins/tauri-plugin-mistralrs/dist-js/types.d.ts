export interface SessionInfo {
    pid: number;
    port: number;
    model_id: string;
    model_path: string;
    is_embedding: boolean;
    api_key: string;
}
export interface UnloadResult {
    success: boolean;
    error?: string;
}
export type MistralrsConfig = {
    /** Max context window tokens (0 → 4096). */
    ctx_size: number;
    /** Model weight dtype: "auto" | "bf16" | "f16" | "f32". Default: "auto". */
    dtype?: string;
    /** Max concurrent sequences (0 → 16). */
    max_seqs?: number;
    /** GPU layers to offload. Empty string → automatic mapping. */
    num_device_layers?: string;
    /** Disable KV cache. Default: false. */
    no_kv_cache?: boolean;
    /** In-situ quantization method: "none" | "q4k" | "q5k" | "q6k" | "q8k" | "q4_0" | "q8_0" | "hqq4" | "hqq8" | "fp8". */
    in_situ_quant?: string;
    /** HuggingFace tokenizer model ID. Empty string → use tokenizer from GGUF file. */
    tok_model_id?: string;
    /** Force CPU-only inference. Default: false. */
    force_cpu?: boolean;
    /** On-device prefix-cache slots (0 → 16). */
    prefix_cache_n?: number;
};
