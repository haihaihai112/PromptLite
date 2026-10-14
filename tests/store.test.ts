import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AppStore, type SecretCodec } from '../electron/store.ts';
import type { Favorite, HistoryEntry, ModelDraft } from '../src/shared/contracts.ts';

// Encryption belongs to the OS adapter; tests exercise real persistence with a reversible stand-in.
const codec: SecretCodec = {
  isAvailable: () => true,
  encrypt: value => Buffer.from(`sealed:${value}`).toString('base64'),
  decrypt: value => {
    const decoded = Buffer.from(value, 'base64').toString();
    if (!decoded.startsWith('sealed:')) throw new Error('Cannot decrypt');
    return decoded.slice(7);
  },
};
const model = (id = 'model-1'): ModelDraft => ({ id, name: 'Local model', baseUrl: 'http://127.0.0.1:9000/v1', model: 'local-chat', temperature: 0.7 });
const history = (id = 'history-1'): HistoryEntry => ({ id, original: 'Original prompt', kind: 'user', strategy: 'general', modelId: 'model-1', modelName: 'Local model', createdAt: '2026-10-14T00:00:00.000Z', updatedAt: '2026-10-14T00:00:00.000Z', versions: [{ id: 'version-1', content: 'Improved prompt', note: 'First optimization', createdAt: '2026-10-14T00:00:00.000Z' }] });
const favorite = (id = 'favorite-1'): Favorite => ({ id, title: 'My prompt', content: 'Saved prompt', tags: ['writing'], kind: 'system', createdAt: '2026-10-14T00:00:00.000Z', updatedAt: '2026-10-14T00:00:00.000Z' });
async function fixture(t: { after: (fn: () => Promise<void>) => void }, secrets = codec) {
  const directory = await mkdtemp(join(tmpdir(), 'promptlite-store-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'data.json');
  return { directory, file, store: new AppStore(file, secrets) };
}

test('persists complete data across restarts and returns detached public snapshots', async t => {
  const { file, store } = await fixture(t);
  assert.deepEqual(await store.load(), { schemaVersion: 1, models: [], history: [], favorites: [] });
  await store.saveModel({ ...model(), apiKey: 'private-key-123' });
  await store.saveHistory(history());
  await store.saveFavorite(favorite());
  const loaded = await new AppStore(file, codec).load();
  assert.equal(loaded.models[0].hasKey, true);
  assert.deepEqual(loaded.history, [history()]);
  assert.deepEqual(loaded.favorites, [favorite()]);
  loaded.history[0].versions[0].content = 'Mutated outside';
  assert.equal((await store.load()).history[0].versions[0].content, 'Improved prompt');
});

test('keeps API keys only in encrypted disk fields and excludes secrets from public data and backup', async t => {
  const { file, store } = await fixture(t);
  const data = await store.saveModel({ ...model(), apiKey: 'private-key-123' });
  const disk = await readFile(file, 'utf8');
  assert.equal(disk.includes('private-key-123'), false);
  assert.equal(typeof JSON.parse(disk).models[0].encryptedKey, 'string');
  for (const value of [JSON.stringify(data), await store.exportBackup()]) {
    assert.equal(value.includes('encryptedKey'), false);
    assert.equal(value.includes('apiKey'), false);
    assert.equal(value.includes('private-key-123'), false);
  }
  assert.equal((await store.getModelConnection('model-1')).apiKey, 'private-key-123');
});

test('preserves existing key during missing and blank updates and can replace it', async t => {
  const { store } = await fixture(t);
  await store.saveModel({ ...model(), apiKey: 'first-key' });
  await store.saveModel({ ...model(), name: 'Renamed' });
  await store.saveModel({ ...model(), apiKey: '' });
  assert.equal((await store.getModelConnection('model-1')).apiKey, 'first-key');
  await store.saveModel({ ...model(), apiKey: 'second-key' });
  assert.equal((await store.getModelConnection('model-1')).apiKey, 'second-key');
});

test('merges valid backups by ID while preserving credentials only for existing models', async t => {
  const { store } = await fixture(t);
  await store.saveModel({ ...model(), apiKey: 'existing-key' });
  await store.saveHistory(history());
  const imported = await store.importBackup(JSON.stringify({ schemaVersion: 1, models: [{ ...model(), name: 'Imported model', hasKey: false }, { ...model('model-2'), hasKey: true }], history: [{ ...history(), original: 'Imported original' }], favorites: [favorite()] }));
  assert.equal(imported.models.length, 2);
  assert.equal(imported.models[0].name, 'Imported model');
  assert.equal(imported.models[0].hasKey, true);
  assert.equal(imported.models[1].hasKey, false);
  assert.equal((await store.getModelConnection('model-1')).apiKey, 'existing-key');
  assert.equal((await store.getModelConnection('model-2')).apiKey, '');
  assert.equal(imported.history[0].original, 'Imported original');
  assert.equal(imported.favorites.length, 1);
});

test('rejects a fully invalid backup without changing bytes or in-memory state', async t => {
  const { file, store } = await fixture(t);
  await store.saveModel({ ...model(), apiKey: 'existing-key' });
  const before = await readFile(file, 'utf8');
  const backup = { schemaVersion: 1, models: [{ ...model(), name: 'Should not apply', hasKey: false }], history: [history()], favorites: [{ ...favorite(), kind: 'invalid' }] };
  await assert.rejects(store.importBackup(JSON.stringify(backup)));
  assert.equal(await readFile(file, 'utf8'), before);
  assert.equal((await store.load()).models[0].name, 'Local model');
});

test('rejects secrets, duplicate IDs and malformed rows in imported backups', async t => {
  const { store } = await fixture(t);
  const empty = { schemaVersion: 1, models: [], history: [], favorites: [] };
  const badValues = [
    { ...empty, schemaVersion: 2 },
    { ...empty, models: [{ ...model(), apiKey: 'injected' }] },
    { ...empty, models: [{ ...model(), encryptedKey: 'injected' }] },
    { ...empty, models: [{ ...model(), nested: { apiKey: 'injected' } }] },
    { ...empty, models: [model(), model()] },
    { ...empty, history: [{ ...history(), versions: [] }] },
    { ...empty, history: [{ ...history(), createdAt: 'yesterday' }] },
    { ...empty, history: [{ ...history(), strategy: 'invented' }] },
    { ...empty, favorites: [{ ...favorite(), tags: [17] }] },
    { ...empty, favorites: [favorite(), favorite()] },
    { ...empty, models: [null] },
  ];
  for (const value of badValues) await assert.rejects(store.importBackup(JSON.stringify(value)));
  assert.equal((await store.load()).models.length, 0);
});

test('serializes concurrent mutations without dropping independent writes', async t => {
  const { file, store } = await fixture(t);
  await Promise.all(Array.from({ length: 30 }, (_, index) => store.saveFavorite(favorite(`favorite-${index}`))));
  assert.equal((await new AppStore(file, codec).load()).favorites.length, 30);
});

test('rejects unavailable credential encryption without writing plaintext or poisoning later mutations', async t => {
  const { file, store } = await fixture(t, { ...codec, isAvailable: () => false });
  await assert.rejects(store.saveModel({ ...model(), apiKey: 'private-key' }), /加密|encrypt/i);
  await store.saveFavorite(favorite());
  assert.equal((await store.load()).models.length, 0);
  assert.equal((await readFile(file, 'utf8')).includes('private-key'), false);
});

test('reports unavailable decryption but still permits loading public data and secret-free backups', async t => {
  const { file, store } = await fixture(t);
  await store.saveModel({ ...model(), apiKey: 'stored-key' });
  const locked = new AppStore(file, { ...codec, isAvailable: () => false });
  assert.equal((await locked.load()).models[0].hasKey, true);
  assert.equal(JSON.parse(await locked.exportBackup()).models.length, 1);
  await assert.rejects(locked.getModelConnection('model-1'), /加密|encrypt/i);
});

test('never overwrites corrupt existing files on load or later mutation attempts', async t => {
  const { file, store } = await fixture(t);
  const corrupt = '{broken JSON';
  await writeFile(file, corrupt, 'utf8');
  await assert.rejects(store.load());
  await assert.rejects(store.saveFavorite(favorite()));
  assert.equal(await readFile(file, 'utf8'), corrupt);
});

test('rejects structurally corrupt disk rows instead of silently dropping them', async t => {
  const { file, store } = await fixture(t);
  const corrupt = JSON.stringify({ schemaVersion: 1, models: [{ ...model(), apiKey: 'plaintext' }], history: [], favorites: [] });
  await writeFile(file, corrupt, 'utf8');
  await assert.rejects(store.load());
  await assert.rejects(store.saveModel(model('model-2')));
  assert.equal(await readFile(file, 'utf8'), corrupt);
});

test('deleting a model retains its historical prompt versions and deletes collections by ID', async t => {
  const { store } = await fixture(t);
  await store.saveModel(model());
  await store.saveHistory(history());
  await store.saveFavorite(favorite());
  assert.equal((await store.deleteModel('model-1')).history[0].modelName, 'Local model');
  await assert.rejects(store.getModelConnection('model-1'));
  assert.equal((await store.deleteHistory('history-1')).history.length, 0);
  assert.equal((await store.deleteFavorite('favorite-1')).favorites.length, 0);
});

test('accepts HTTPS and local HTTP endpoints but rejects remote HTTP and unsafe endpoint details', async t => {
  const { store } = await fixture(t);
  for (const baseUrl of ['https://example.com/v1/', 'https://example.com/v1/chat/completions', 'http://localhost:9000', 'http://[::1]:9000/v1']) {
    await store.saveModel({ ...model(), baseUrl });
  }
  for (const baseUrl of ['http://example.com/v1', 'ftp://localhost', 'https://user:pass@example.com', 'https://example.com/v1?token=secret', 'https://example.com/#fragment', 'http://127.0.0.2', 'not a URL']) {
    await assert.rejects(store.saveModel({ ...model(), baseUrl }));
  }
});

test('rejects invalid model metadata and unbounded content before writing', async t => {
  const { file, store } = await fixture(t);
  await store.saveModel(model());
  const before = await readFile(file, 'utf8');
  for (const invalid of [{ ...model(), temperature: NaN }, { ...model(), temperature: Infinity }, { ...model(), temperature: -0.1 }, { ...model(), temperature: 2.1 }, { ...model(), id: '' }, { ...model(), name: ' ' }, { ...model(), model: '' }]) await assert.rejects(store.saveModel(invalid));
  await assert.rejects(store.saveHistory({ ...history(), original: 'x'.repeat(2_000_000) }));
  await assert.rejects(store.saveFavorite({ ...favorite(), tags: Array(1000).fill('tag') }));
  await assert.rejects(store.importBackup(JSON.stringify({ schemaVersion: 1, models: [], history: [], favorites: Array.from({ length: 20_000 }, (_, index) => favorite(`f-${index}`)) })));
  assert.equal(await readFile(file, 'utf8'), before);
});

test('leaves no temporary files after successful atomic updates', async t => {
  const { directory, store } = await fixture(t);
  await store.saveModel(model());
  await store.saveFavorite(favorite());
  assert.deepEqual(await readdir(directory), ['data.json']);
});

test('rejects an empty userinfo delimiter rather than accepting credential URL syntax', async t => {
  const { store } = await fixture(t);
  for (const baseUrl of ['https://@example.com/v1', 'https://:@example.com/v1']) {
    await assert.rejects(store.saveModel({ ...model(), baseUrl }));
  }
});

test('clears an existing key when a backup changes the model origin', async t => {
  const { file, store } = await fixture(t);
  await store.saveModel({ ...model(), baseUrl: 'https://trusted.example/v1', apiKey: 'trusted-key' });
  const backup = JSON.parse(await store.exportBackup());
  backup.models[0].baseUrl = 'https://other.example/v1';
  const imported = await store.importBackup(JSON.stringify(backup));
  assert.equal(imported.models[0].hasKey, false);
  assert.equal((await store.getModelConnection('model-1')).apiKey, '');
  assert.equal(JSON.parse(await readFile(file, 'utf8')).models[0].encryptedKey, undefined);
});

test('clears an existing key when a backup changes the full endpoint path on the same origin', async t => {
  const { store } = await fixture(t);
  await store.saveModel({ ...model(), baseUrl: 'https://trusted.example/v1', apiKey: 'trusted-key' });
  const backup = JSON.parse(await store.exportBackup());
  backup.models[0].baseUrl = 'https://trusted.example/other/v1';
  const imported = await store.importBackup(JSON.stringify(backup));
  assert.equal(imported.models[0].hasKey, false);
  assert.equal((await store.getModelConnection('model-1')).apiKey, '');
});

test('preserves a key when backup and direct edit only change canonical endpoint formatting', async t => {
  const { store } = await fixture(t);
  await store.saveModel({ ...model(), baseUrl: 'https://TRUSTED.example:443/v1/', apiKey: 'trusted-key' });
  const backup = JSON.parse(await store.exportBackup());
  backup.models[0].baseUrl = 'https://trusted.example/v1';
  assert.equal((await store.importBackup(JSON.stringify(backup))).models[0].hasKey, true);
  assert.equal((await store.getModelConnection('model-1')).apiKey, 'trusted-key');
  await store.saveModel({ ...model(), baseUrl: 'https://trusted.example/v1/', apiKey: '' });
  assert.equal((await store.getModelConnection('model-1')).apiKey, 'trusted-key');
});

test('clears a key on direct destination edits with a blank or missing new key', async t => {
  const { store } = await fixture(t);
  for (const apiKey of [undefined, '']) {
    for (const baseUrl of ['https://other.example/v1', 'https://trusted.example/other/v1']) {
      await store.saveModel({ ...model(), baseUrl: 'https://trusted.example/v1', apiKey: 'trusted-key' });
      const changed = await store.saveModel({ ...model(), baseUrl, apiKey });
      assert.equal(changed.models[0].hasKey, false);
      assert.equal((await store.getModelConnection('model-1')).apiKey, '');
    }
  }
});

test('allows an explicit replacement key when directly saving a new destination', async t => {
  const { store } = await fixture(t);
  await store.saveModel({ ...model(), baseUrl: 'https://trusted.example/v1', apiKey: 'trusted-key' });
  const changed = await store.saveModel({ ...model(), baseUrl: 'https://other.example/v2', apiKey: 'replacement-key' });
  assert.equal(changed.models[0].hasKey, true);
  assert.equal((await store.getModelConnection('model-1')).apiKey, 'replacement-key');
});
