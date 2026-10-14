export type PromptKind = 'system' | 'user';
export type Strategy = 'general' | 'concise' | 'structured';
export interface Message { role: 'system' | 'user' | 'assistant'; content: string }
export interface ModelConfig {
  id: string; name: string; baseUrl: string; model: string; temperature: number; hasKey: boolean;
}
export type ModelDraft = Omit<ModelConfig, 'hasKey'> & { apiKey?: string };
export interface PromptVersion { id: string; content: string; note: string; createdAt: string }
export interface HistoryEntry {
  id: string; original: string; kind: PromptKind; strategy: Strategy;
  modelId: string; modelName: string; createdAt: string; updatedAt: string; versions: PromptVersion[];
}
export interface Favorite {
  id: string; title: string; content: string; tags: string[]; kind: PromptKind; createdAt: string; updatedAt: string;
}
export interface AppData { schemaVersion: 1; models: ModelConfig[]; history: HistoryEntry[]; favorites: Favorite[] }
export interface RunRequest { requestId: string; modelId: string; messages: Message[] }
export interface RunResult { content: string }
export interface StreamDelta { requestId: string; delta: string }
export interface OptimizationInput { original: string; kind: PromptKind; strategy: Strategy }
export interface IterationInput extends OptimizationInput { current: string; instruction: string }
export interface ComparisonInput { original: string; optimized: string; kind: PromptKind; testInput: string; systemContext: string }
export interface DesktopAPI {
  load(): Promise<AppData>;
  saveModel(model: ModelDraft): Promise<AppData>;
  deleteModel(id: string): Promise<AppData>;
  saveHistory(entry: HistoryEntry): Promise<AppData>;
  deleteHistory(id: string): Promise<AppData>;
  saveFavorite(favorite: Favorite): Promise<AppData>;
  deleteFavorite(id: string): Promise<AppData>;
  run(request: RunRequest): Promise<RunResult>;
  cancel(requestId: string): Promise<void>;
  onDelta(listener: (delta: StreamDelta) => void): () => void;
  exportBackup(): Promise<string | null>;
  importBackup(): Promise<AppData | null>;
  copy(text: string): Promise<void>;
}
declare global { interface Window { promptlite?: DesktopAPI } }
