import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { AppData, Favorite, HistoryEntry, ModelConfig, ModelDraft, PromptVersion } from '../src/shared/contracts.js';

export interface SecretCodec {
  isAvailable(): boolean;
  encrypt(value: string): string;
  decrypt(value: string): string;
}

type StoredModel = Omit<ModelConfig, 'hasKey'> & { encryptedKey?: string };
interface StoredData { schemaVersion: 1; models: StoredModel[]; history: HistoryEntry[]; favorites: Favorite[] }
export interface ModelConnection extends Omit<ModelConfig, 'hasKey'> { apiKey: string }
type Row = Record<string, unknown>;
const MAX_BYTES = 20 * 1024 * 1024;
const MAX_TEXT = 100_000;
const MODEL_FIELDS = ['id', 'name', 'baseUrl', 'model', 'temperature'];

function invalid(field: string): never { throw new Error(`数据格式无效：${field}`); }
function object(value: unknown, fields: string[], label: string): Row {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid(label);
  const row = value as Row;
  if (Object.keys(row).some(key => !fields.includes(key))) invalid(`${label} 包含未知字段`);
  return row;
}
function text(value: unknown, label: string, max = MAX_TEXT, allowEmpty = false): string {
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && !value.trim()) || value.includes('\0')) invalid(label);
  return value;
}
function id(value: unknown): string {
  const result = text(value, 'ID', 128);
  if (!/^[A-Za-z0-9_.:-]+$/.test(result)) invalid('ID');
  return result;
}
function date(value: unknown, label: string): string {
  const result = text(value, label, 40);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(result) || !Number.isFinite(Date.parse(result))) invalid(label);
  const [year, month, day] = result.slice(0, 10).split('-').map(Number);
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) invalid(label);
  return result;
}
function kind(value: unknown): 'system' | 'user' {
  if (value !== 'system' && value !== 'user') invalid('提示词类型');
  return value;
}
function endpoint(value: unknown): string {
  const result = text(value, '接口地址', 2048).trim();
  let url: URL;
  try { url = new URL(result); } catch { return invalid('接口地址'); }
  const authority = /^[A-Za-z]+:\/\/([^/?#]*)/.exec(result)?.[1] ?? '';
  if (url.username || url.password || authority.includes('@') || url.search || url.hash || result.includes('?') || result.includes('#')) invalid('接口地址不能包含凭据、查询或片段');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) invalid('接口地址需要 HTTPS 或本地 HTTP');
  // Reject alternative numeric host forms that URL would normalize into loopback.
  if (url.protocol === 'http:') {
    if (!/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(authority)) invalid('本地 HTTP 地址');
  }
  return result;
}
function sameDestination(first: string, second: string): boolean {
  // Keys belong to a complete endpoint, including its path, rather than only a model ID.
  const canonical = (value: string) => new URL(value).href.replace(/\/$/, '');
  return canonical(first) === canonical(second);
}
function modelFields(row: Row): Omit<ModelConfig, 'hasKey'> {
  if (typeof row.temperature !== 'number' || !Number.isFinite(row.temperature) || row.temperature < 0 || row.temperature > 2) invalid('温度范围为 0–2');
  return { id: id(row.id), name: text(row.name, '模型名称', 200).trim(), baseUrl: endpoint(row.baseUrl), model: text(row.model, '模型标识', 200).trim(), temperature: row.temperature };
}
function draft(value: unknown): ModelDraft {
  const row = object(value, [...MODEL_FIELDS, 'apiKey'], '模型配置');
  const result: ModelDraft = modelFields(row);
  if (row.apiKey !== undefined) result.apiKey = text(row.apiKey, 'API Key', 16_384, true);
  return result;
}
function storedModel(value: unknown, backup: boolean): StoredModel {
  const row = object(value, [...MODEL_FIELDS, backup ? 'hasKey' : 'encryptedKey'], '模型配置');
  const result: StoredModel = modelFields(row);
  if (backup) {
    if (row.hasKey !== undefined && typeof row.hasKey !== 'boolean') invalid('密钥状态');
  } else if (row.encryptedKey !== undefined) {
    result.encryptedKey = text(row.encryptedKey, '加密密钥', 65_536);
  }
  return result;
}
function collection<T extends { id: string }>(value: unknown, max: number, validate: (row: unknown) => T, label: string): T[] {
  if (!Array.isArray(value) || value.length > max) invalid(label);
  const result = value.map(validate);
  const seen = new Set<string>();
  for (const row of result) {
    if (seen.has(row.id)) invalid(`${label} ID 重复`);
    seen.add(row.id);
  }
  return result;
}
function version(value: unknown): PromptVersion {
  const row = object(value, ['id', 'content', 'note', 'createdAt'], '提示词版本');
  return { id: id(row.id), content: text(row.content, '版本内容'), note: text(row.note, '版本说明', 2000, true), createdAt: date(row.createdAt, '版本日期') };
}
function historyEntry(value: unknown): HistoryEntry {
  const row = object(value, ['id', 'original', 'kind', 'strategy', 'modelId', 'modelName', 'createdAt', 'updatedAt', 'versions'], '历史记录');
  if (!['general', 'concise', 'structured'].includes(row.strategy as string)) invalid('优化策略');
  const versions = collection(row.versions, 1000, version, '提示词版本');
  if (!versions.length) invalid('提示词版本不能为空');
  const createdAt = date(row.createdAt, '创建日期');
  const updatedAt = date(row.updatedAt, '更新日期');
  if (Date.parse(updatedAt) < Date.parse(createdAt)) invalid('更新日期早于创建日期');
  return { id: id(row.id), original: text(row.original, '原始提示词'), kind: kind(row.kind), strategy: row.strategy as HistoryEntry['strategy'], modelId: id(row.modelId), modelName: text(row.modelName, '历史模型名称', 200), createdAt, updatedAt, versions };
}
function favoriteEntry(value: unknown): Favorite {
  const row = object(value, ['id', 'title', 'content', 'tags', 'kind', 'createdAt', 'updatedAt'], '收藏');
  if (!Array.isArray(row.tags) || row.tags.length > 50) invalid('收藏标签');
  const tags = row.tags.map(tag => text(tag, '收藏标签', 100));
  const createdAt = date(row.createdAt, '创建日期');
  const updatedAt = date(row.updatedAt, '更新日期');
  if (Date.parse(updatedAt) < Date.parse(createdAt)) invalid('更新日期早于创建日期');
  return { id: id(row.id), title: text(row.title, '收藏标题', 200), content: text(row.content, '收藏内容'), tags, kind: kind(row.kind), createdAt, updatedAt };
}
function data(value: unknown, backup = false): StoredData {
  const row = object(value, ['schemaVersion', 'models', 'history', 'favorites'], '数据文件');
  if (row.schemaVersion !== 1) invalid('不支持的数据版本');
  return { schemaVersion: 1, models: collection(row.models, 100, value => storedModel(value, backup), '模型列表'), history: collection(row.history, 2000, historyEntry, '历史列表'), favorites: collection(row.favorites, 2000, favoriteEntry, '收藏列表') };
}
function parse(json: unknown, backup: boolean): StoredData {
  if (typeof json !== 'string' || Buffer.byteLength(json, 'utf8') > MAX_BYTES) invalid('数据文件过大');
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch { return invalid('JSON 无法解析，请保留原文件并检查备份'); }
  return data(parsed, backup);
}
function publicData(state: StoredData): AppData {
  return structuredClone({ schemaVersion: 1, models: state.models.map(({ encryptedKey, ...model }) => ({ ...model, hasKey: Boolean(encryptedKey) })), history: state.history, favorites: state.favorites });
}
function merge<T extends { id: string }>(existing: T[], incoming: T[]): T[] {
  const rows = new Map(existing.map(row => [row.id, row]));
  for (const row of incoming) rows.set(row.id, row);
  return [...rows.values()];
}

export class AppStore {
  private readonly filePath: string;
  private readonly secrets: SecretCodec;
  private state?: StoredData;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(filePath: string, secrets: SecretCodec) { this.filePath = filePath; this.secrets = secrets; }

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.queue.then(operation);
    this.queue = pending.catch(() => undefined);
    return pending;
  }

  private async read(): Promise<StoredData> {
    if (this.state) return this.state;
    let initial: StoredData;
    try {
      if ((await stat(this.filePath)).size > MAX_BYTES) invalid('数据文件过大');
      initial = parse(await readFile(this.filePath, 'utf8'), false);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      initial = { schemaVersion: 1, models: [], history: [], favorites: [] };
    }
    this.state = initial;
    return initial;
  }

  private async write(next: StoredData): Promise<void> {
    const json = JSON.stringify(next, null, 2);
    if (Buffer.byteLength(json, 'utf8') > MAX_BYTES) invalid('数据文件过大');
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try { await handle.writeFile(json, 'utf8'); await handle.sync(); } finally { await handle.close(); }
      await rename(temporary, this.filePath);
    } finally {
      await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
    }
    this.state = next;
  }

  private mutate(update: (state: StoredData) => void): Promise<AppData> {
    return this.serialized(async () => {
      const next = structuredClone(await this.read());
      update(next);
      const checked = data(next);
      await this.write(checked);
      return publicData(checked);
    });
  }

  load(): Promise<AppData> { return this.serialized(async () => publicData(await this.read())); }

  async saveModel(value: ModelDraft): Promise<AppData> {
    const clean = draft(value);
    return this.mutate(state => {
      const previous = state.models.find(model => model.id === clean.id);
      const { apiKey, ...fields } = clean;
      const next: StoredModel = { ...fields };
      if (previous?.encryptedKey && sameDestination(previous.baseUrl, clean.baseUrl)) next.encryptedKey = previous.encryptedKey;
      if (apiKey?.trim()) {
        if (!this.secrets.isAvailable()) throw new Error('系统加密不可用，无法安全保存 API Key。');
        try { next.encryptedKey = text(this.secrets.encrypt(apiKey), '加密密钥', 65_536); }
        catch { throw new Error('无法加密 API Key，配置未保存。'); }
      }
      state.models = merge(state.models, [next]);
    });
  }

  async deleteModel(value: string): Promise<AppData> { const key = id(value); return this.mutate(state => { state.models = state.models.filter(model => model.id !== key); }); }
  async saveHistory(value: HistoryEntry): Promise<AppData> { const clean = historyEntry(value); return this.mutate(state => { state.history = merge(state.history, [clean]); }); }
  async deleteHistory(value: string): Promise<AppData> { const key = id(value); return this.mutate(state => { state.history = state.history.filter(row => row.id !== key); }); }
  async saveFavorite(value: Favorite): Promise<AppData> { const clean = favoriteEntry(value); return this.mutate(state => { state.favorites = merge(state.favorites, [clean]); }); }
  async deleteFavorite(value: string): Promise<AppData> { const key = id(value); return this.mutate(state => { state.favorites = state.favorites.filter(row => row.id !== key); }); }

  async getModelConnection(value: string): Promise<ModelConnection> {
    const key = id(value);
    return this.serialized(async () => {
      const stored = (await this.read()).models.find(model => model.id === key);
      if (!stored) throw new Error('模型配置不存在，请重新选择模型。');
      const { encryptedKey, ...fields } = stored;
      let apiKey = '';
      if (encryptedKey) {
        if (!this.secrets.isAvailable()) throw new Error('系统加密不可用，无法读取 API Key。');
        try { apiKey = text(this.secrets.decrypt(encryptedKey), 'API Key', 16_384); }
        catch { throw new Error('API Key 无法解密，请重新保存模型密钥。'); }
      }
      return { ...fields, apiKey };
    });
  }

  exportBackup(): Promise<string> { return this.serialized(async () => JSON.stringify(publicData(await this.read()), null, 2)); }

  async importBackup(json: string): Promise<AppData> {
    const imported = parse(json, true);
    return this.mutate(state => {
      const models = imported.models.map(model => {
        const previous = state.models.find(existing => existing.id === model.id);
        return previous?.encryptedKey && sameDestination(previous.baseUrl, model.baseUrl) ? { ...model, encryptedKey: previous.encryptedKey } : model;
      });
      state.models = merge(state.models, models);
      state.history = merge(state.history, imported.history);
      state.favorites = merge(state.favorites, imported.favorites);
    });
  }
}
