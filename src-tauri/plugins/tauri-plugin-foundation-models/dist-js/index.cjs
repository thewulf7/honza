'use strict';

var core = require('@tauri-apps/api/core');

async function checkFoundationModelsAvailability() {
    return await core.invoke('plugin:foundation-models|check_foundation_models_availability');
}
async function loadFoundationModels(modelId) {
    return await core.invoke('plugin:foundation-models|load_foundation_models', { modelId });
}
async function unloadFoundationModels() {
    return await core.invoke('plugin:foundation-models|unload_foundation_models');
}
async function isFoundationModelsLoaded() {
    return await core.invoke('plugin:foundation-models|is_foundation_models_loaded');
}
async function foundationModelsChatCompletion(body) {
    return await core.invoke('plugin:foundation-models|foundation_models_chat_completion', { body });
}
async function foundationModelsChatCompletionStream(body, requestId) {
    return await core.invoke('plugin:foundation-models|foundation_models_chat_completion_stream', {
        body,
        requestId,
    });
}
async function abortFoundationModelsStream(requestId) {
    return await core.invoke('plugin:foundation-models|abort_foundation_models_stream', { requestId });
}
async function cleanupFoundationModelsProcesses() {
    return await core.invoke('plugin:foundation-models|cleanup_foundation_models_processes');
}

exports.abortFoundationModelsStream = abortFoundationModelsStream;
exports.checkFoundationModelsAvailability = checkFoundationModelsAvailability;
exports.cleanupFoundationModelsProcesses = cleanupFoundationModelsProcesses;
exports.foundationModelsChatCompletion = foundationModelsChatCompletion;
exports.foundationModelsChatCompletionStream = foundationModelsChatCompletionStream;
exports.isFoundationModelsLoaded = isFoundationModelsLoaded;
exports.loadFoundationModels = loadFoundationModels;
exports.unloadFoundationModels = unloadFoundationModels;
