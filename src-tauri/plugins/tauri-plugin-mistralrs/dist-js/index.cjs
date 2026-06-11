'use strict';

var core = require('@tauri-apps/api/core');

function asNumber(v, defaultValue = 0) {
    if (v === '' || v === null || v === undefined)
        return defaultValue;
    const n = Number(v);
    return isFinite(n) ? n : defaultValue;
}
function asString(v, defaultValue = '') {
    if (v === null || v === undefined)
        return defaultValue;
    return String(v);
}
function asBool(v, defaultValue = false) {
    if (v === null || v === undefined)
        return defaultValue;
    return Boolean(v);
}
function normalizeMistralrsConfig(config) {
    return {
        ctx_size: asNumber(config.ctx_size),
        dtype: asString(config.dtype, 'auto'),
        max_seqs: asNumber(config.max_seqs, 16),
        num_device_layers: asString(config.num_device_layers, ''),
        no_kv_cache: asBool(config.no_kv_cache, false),
        in_situ_quant: asString(config.in_situ_quant, 'none'),
        tok_model_id: asString(config.tok_model_id, ''),
        force_cpu: asBool(config.force_cpu, false),
        prefix_cache_n: asNumber(config.prefix_cache_n, 16),
    };
}
async function loadMistralrsModel(modelId, modelPath, port, cfg, envs, isEmbedding = false, timeout = 600) {
    const config = normalizeMistralrsConfig(cfg);
    return await core.invoke('plugin:mistralrs|load_mistralrs_model', {
        modelId,
        modelPath,
        port,
        config,
        envs,
        isEmbedding,
        timeout,
    });
}
async function unloadMistralrsModel(pid) {
    return await core.invoke('plugin:mistralrs|unload_mistralrs_model', { pid });
}
async function isMistralrsProcessRunning(pid) {
    return await core.invoke('plugin:mistralrs|is_mistralrs_process_running', { pid });
}
async function getMistralrsRandomPort() {
    return await core.invoke('plugin:mistralrs|get_mistralrs_random_port');
}
async function findMistralrsSessionByModel(modelId) {
    return await core.invoke('plugin:mistralrs|find_mistralrs_session_by_model', {
        modelId,
    });
}
async function getMistralrsLoadedModels() {
    return await core.invoke('plugin:mistralrs|get_mistralrs_loaded_models');
}
async function getMistralrsAllSessions() {
    return await core.invoke('plugin:mistralrs|get_mistralrs_all_sessions');
}

exports.findMistralrsSessionByModel = findMistralrsSessionByModel;
exports.getMistralrsAllSessions = getMistralrsAllSessions;
exports.getMistralrsLoadedModels = getMistralrsLoadedModels;
exports.getMistralrsRandomPort = getMistralrsRandomPort;
exports.isMistralrsProcessRunning = isMistralrsProcessRunning;
exports.loadMistralrsModel = loadMistralrsModel;
exports.normalizeMistralrsConfig = normalizeMistralrsConfig;
exports.unloadMistralrsModel = unloadMistralrsModel;
