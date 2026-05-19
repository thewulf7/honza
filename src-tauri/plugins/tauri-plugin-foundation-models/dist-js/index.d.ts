export { StreamEvent } from './types';
export declare function checkFoundationModelsAvailability(): Promise<string>;
export declare function loadFoundationModels(modelId: string): Promise<void>;
export declare function unloadFoundationModels(): Promise<void>;
export declare function isFoundationModelsLoaded(): Promise<boolean>;
export declare function foundationModelsChatCompletion(body: string): Promise<string>;
export declare function foundationModelsChatCompletionStream(body: string, requestId: string): Promise<void>;
export declare function abortFoundationModelsStream(requestId: string): Promise<void>;
export declare function cleanupFoundationModelsProcesses(): Promise<void>;
