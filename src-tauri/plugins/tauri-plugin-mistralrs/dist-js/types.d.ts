export interface SessionInfo {
    pid: number;
    port: number;
    model_id: string;
    model_path: string;
    is_embedding: boolean;
    /** Always empty: mistralrs-server has no request authentication. */
    api_key: string;
}
export interface UnloadResult {
    success: boolean;
    error?: string;
}
export type MistralrsConfig = {
    /** Max prompt sequence length in tokens (--max-seq-len). 0 → server default. */
    ctx_size: number;
    /** Model weight dtype: "auto" | "bf16" | "f16" | "f32". Default: "auto". */
    dtype?: string;
    /** Max concurrent scheduled sequences (--max-seqs). 0 → server default. */
    max_seqs?: number;
    /** Max prompt batch size (--max-batch-size). 0 → server default. */
    max_batch_size?: number;
    /** GPU layers to offload (--num-device-layers). Empty string → automatic mapping. */
    num_device_layers?: string;
    /** Disable KV cache (--no-kv-cache). Default: false. */
    no_kv_cache?: boolean;
    /** In-situ quantization (--isq): "none" | "q4k" | "q5k" | "q6k" | "q8k" | "q4_0" | "q8_0" | "hqq4" | "hqq8" | "fp8". */
    in_situ_quant?: string;
    /** HuggingFace tokenizer model ID (--tok-model-id). Empty → tokenizer from GGUF file. */
    tok_model_id?: string;
    /** Force CPU-only inference (--cpu). Default: false. */
    force_cpu?: boolean;
    /** On-device prefix-cache slots (--prefix-cache-n). 0 → server default. */
    prefix_cache_n?: number;
    /** RNG seed (--seed). Negative → unset. */
    seed?: number;
    /** Enable PagedAttention on Metal (--paged-attn). */
    paged_attn?: boolean;
    /** Disable PagedAttention on CUDA (--no-paged-attn). */
    no_paged_attn?: boolean;
    /** GPU memory for the PagedAttention KV cache in MB (--pa-gpu-mem). 0 → unset. */
    paged_attn_gpu_mem?: number;
    /** Fraction (0-1] of GPU memory for the PagedAttention KV cache (--pa-gpu-mem-usage). 0 → unset. */
    paged_attn_gpu_mem_usage?: number;
    /** Total context length the PagedAttention KV cache is sized for (--pa-ctxt-len). 0 → unset. */
    paged_ctxt_len?: number;
    /** PagedAttention block size (--pa-blk-size). 0 → unset. */
    paged_attn_block_size?: number;
    /** PagedAttention KV cache type (--pa-cache-type): "auto" | "f8e4m3". */
    paged_cache_type?: string;
    /** Path to a JINJA chat template file (--chat-template). */
    chat_template?: string;
    /** Path to an explicit JINJA chat template file (--jinja-explicit). */
    jinja_explicit?: string;
    /** HuggingFace token source (--token-source): "cache" | "env:<VAR>" | "path:<file>" | "literal:<token>" | "none". */
    token_source?: string;
};
