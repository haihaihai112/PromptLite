<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, reactive, ref } from 'vue';
import AppIcon from './components/AppIcon.vue';
import AppDialog from './components/AppDialog.vue';
import { buildOptimizationMessages, buildIterationMessages, buildComparisonMessages } from './core/requests';
import type { AppData, Favorite, HistoryEntry, Message, ModelConfig, ModelDraft, PromptKind, Strategy } from './shared/contracts';

const api = window.promptlite;
const data = ref<AppData>({ schemaVersion: 1, models: [], history: [], favorites: [] });
const page = ref<'work' | 'history' | 'favorites'>('work');
const loaded = ref(false);
const loadError = ref('');
const original = ref('');
const optimized = ref('');
const kind = ref<PromptKind>('system');
const strategy = ref<Strategy>('general');
const modelId = ref('');
const instruction = ref('');
const currentEntry = ref<HistoryEntry | null>(null);
const branch = ref(false);
const editorState = ref<'idle' | 'running' | 'complete' | 'partial' | 'error'>('idle');
const editorError = ref('');
const working = ref(false);
const saving = ref(false);
const testOpen = ref(false);
const testInput = ref('');
const systemContext = ref('');
const testing = ref(false);
const lastTestSignature = ref('');
const lastTestModel = ref('');
type ResultState = { content: string; status: 'idle' | 'running' | 'complete' | 'partial' | 'error'; error: string };
const comparison = reactive<{ original: ResultState; optimized: ResultState }>({ original: { content: '', status: 'idle', error: '' }, optimized: { content: '', status: 'idle', error: '' } });
const toast = ref<{ text: string; error: boolean } | null>(null);
let toastTimer: ReturnType<typeof setTimeout>;
const historySearch = ref('');
const favoriteSearch = ref('');
const selectedHistory = ref('');
const selectedVersion = ref(0);
const modal = ref<'models' | 'favorite' | 'confirm' | null>(null);
const pendingConfirm = ref<(() => Promise<void>) | null>(null);
const confirmText = ref('');
const modelDraft = reactive<ModelDraft>({ id: '', name: '', baseUrl: 'https://api.openai.com/v1', model: '', temperature: 0.7, apiKey: '' });
const modelEditing = ref(false);
const modelTestId = ref('');
const modelTestResult = ref('');
const favoriteDraft = reactive<Favorite>({ id: '', title: '', content: '', tags: [], kind: 'system', createdAt: '', updatedAt: '' });
const favoriteTags = ref('');
const activeRequests = new Map<string, { cancelled: boolean; delta: (value: string) => void }>();
let unsubscribe: (() => void) | undefined;
const busy = computed(() => working.value || testing.value || !!modelTestId.value || saving.value);
const selectedModel = computed(() => data.value.models.find(model => model.id === modelId.value));
const testSignature = computed(() => JSON.stringify({ original: original.value, optimized: optimized.value, kind: kind.value, testInput: testInput.value, systemContext: systemContext.value, model: selectedModel.value }));
const testsStale = computed(() => !!lastTestSignature.value && lastTestSignature.value !== testSignature.value);
const canRun = computed(() => !!api && loaded.value && !!selectedModel.value && !busy.value);
const filteredHistory = computed(() => [...data.value.history].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).filter(item => `${item.original} ${item.modelName} ${item.versions.map(version => version.content).join(' ')}`.toLocaleLowerCase().includes(historySearch.value.toLocaleLowerCase())));
const historyDetail = computed(() => data.value.history.find(item => item.id === selectedHistory.value));
const displayedVersion = computed(() => historyDetail.value?.versions[selectedVersion.value]);
const filteredFavorites = computed(() => [...data.value.favorites].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).filter(item => `${item.title} ${item.content} ${item.tags.join(' ')}`.toLocaleLowerCase().includes(favoriteSearch.value.toLocaleLowerCase())));
const strategies = [{ value: 'general', title: '通用优化', description: '明确目标与边界' }, { value: 'concise', title: '精简表达', description: '减少冗余与歧义' }, { value: 'structured', title: '结构化', description: '组织任务与输出' }] as const;
const statusLabels = { idle: '等待测试', running: '正在生成', complete: '已完成', partial: '未完成 · 保留部分内容', error: '请求失败' };
const uid = () => crypto.randomUUID();
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '');
const shortDate = (date: string) => new Date(date).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
function notify(text: string, error = false) { clearTimeout(toastTimer); toast.value = { text, error }; if (!error) toastTimer = setTimeout(() => { toast.value = null; }, 4500); }
function requireApi() { if (!api) throw new Error('请在 PromptLite 桌面应用中执行此操作。'); return api; }
function applyData(next: AppData) { data.value = next; if (!modelId.value && next.models.length) modelId.value = next.models[0].id; }
async function load() { loaded.value = false; loadError.value = ''; try { applyData(await requireApi().load()); loaded.value = true; } catch (error) { loadError.value = message(error); } }
onMounted(() => { if (api) { unsubscribe = api.onDelta(event => activeRequests.get(event.requestId)?.delta(event.delta)); void load(); } });
onBeforeUnmount(() => { unsubscribe?.(); clearTimeout(toastTimer); for (const id of activeRequests.keys()) void api?.cancel(id); });

async function request(model: string, messages: Message[], delta: (value: string) => void) {
  const requestId = uid();
  const record = { cancelled: false, delta };
  activeRequests.set(requestId, record);
  try { const result = await requireApi().run({ requestId, modelId: model, messages }); if (record.cancelled) throw new Error('请求已取消，部分内容未保存到历史。'); if (!result.content.trim()) throw new Error('模型返回了空内容，请检查模型配置后重试。'); return result.content; }
  finally { activeRequests.delete(requestId); }
}
async function cancelAll() { for (const [id, record] of activeRequests) { record.cancelled = true; try { await requireApi().cancel(id); } catch (error) { notify(message(error), true); } } }

async function optimize(iterate = false) {
  if (!canRun.value || !original.value.trim() || (iterate && (!optimized.value.trim() || !instruction.value.trim() || editorState.value === 'partial' || editorState.value === 'error'))) return;
  const snapshot = { original: original.value, current: optimized.value, kind: kind.value, strategy: strategy.value, instruction: instruction.value };
  const model = clone(selectedModel.value!);
  const baseEntry = currentEntry.value ? clone(currentEntry.value) : null;
  const isBranch = branch.value;
  let messages: Message[];
  try { messages = iterate ? buildIterationMessages(snapshot) : buildOptimizationMessages(snapshot); }
  catch (error) { notify(message(error), true); return; }
  working.value = true; editorState.value = 'running'; editorError.value = ''; optimized.value = '';
  try {
    const content = await request(model.id, messages, delta => { optimized.value += delta; });
    optimized.value = content; editorState.value = 'complete';
    const now = new Date().toISOString();
    const continuing = iterate && baseEntry && baseEntry.original === snapshot.original && baseEntry.kind === snapshot.kind && baseEntry.strategy === snapshot.strategy && baseEntry.modelId === model.id;
    const entry: HistoryEntry = continuing ? { ...baseEntry, id: isBranch ? uid() : baseEntry.id, createdAt: isBranch ? now : baseEntry.createdAt, updatedAt: now } : { id: uid(), original: snapshot.original, kind: snapshot.kind, strategy: snapshot.strategy, modelId: model.id, modelName: model.name, createdAt: now, updatedAt: now, versions: [] };
    entry.versions.push({ id: uid(), content, note: iterate ? snapshot.instruction : '首次优化', createdAt: now });
    try { applyData(await requireApi().saveHistory(entry)); currentEntry.value = clone(entry); branch.value = false; notify(iterate ? '新版本已保存到历史' : '优化完成，已保存到历史'); }
    catch (error) { currentEntry.value = null; notify(`结果已生成，但历史保存失败：${message(error)}`, true); }
  } catch (error) { editorState.value = optimized.value ? 'partial' : 'error'; editorError.value = message(error); notify(editorError.value, true); }
  finally { working.value = false; }
}
async function compare() {
  if (!canRun.value || !original.value.trim() || !optimized.value.trim() || editorState.value === 'partial' || editorState.value === 'error') return;
  const snapshot = { original: original.value, optimized: optimized.value, kind: kind.value, testInput: testInput.value, systemContext: systemContext.value };
  let messages: { original: Message[]; optimized: Message[] };
  try { messages = buildComparisonMessages(snapshot); }
  catch (error) { notify(message(error), true); return; }
  const model = modelId.value;
  lastTestSignature.value = testSignature.value;
  lastTestModel.value = `${selectedModel.value!.name} · 温度 ${selectedModel.value!.temperature}`;
  testing.value = true;
  const runSide = async (side: 'original' | 'optimized') => {
    Object.assign(comparison[side], { content: '', status: 'running', error: '' });
    try { comparison[side].content = await request(model, messages[side], delta => { comparison[side].content += delta; }); comparison[side].status = 'complete'; }
    catch (error) { comparison[side].status = comparison[side].content ? 'partial' : 'error'; comparison[side].error = message(error); }
  };
  await Promise.allSettled([runSide('original'), runSide('optimized')]); testing.value = false;
}
function newWorkspace() { if (busy.value) return; original.value = ''; optimized.value = ''; instruction.value = ''; currentEntry.value = null; branch.value = false; editorState.value = 'idle'; editorError.value = ''; testInput.value = ''; systemContext.value = ''; lastTestSignature.value = ''; lastTestModel.value = ''; for (const side of ['original', 'optimized'] as const) Object.assign(comparison[side], { content: '', status: 'idle', error: '' }); page.value = 'work'; }
function chooseHistory(entry: HistoryEntry) { selectedHistory.value = entry.id; selectedVersion.value = entry.versions.length - 1; }
function restoreHistory() {
  const entry = historyDetail.value; const version = displayedVersion.value; if (!entry || !version || busy.value) return;
  original.value = entry.original; optimized.value = version.content; kind.value = entry.kind; strategy.value = entry.strategy; modelId.value = entry.modelId; instruction.value = ''; editorState.value = 'complete'; editorError.value = '';
  currentEntry.value = { ...clone(entry), versions: clone(entry.versions.slice(0, selectedVersion.value + 1)) }; branch.value = selectedVersion.value < entry.versions.length - 1; page.value = 'work';
  notify(selectedModel.value ? '已恢复该版本，可以编辑或继续迭代' : '版本已恢复；原模型已删除，请重新选择模型。', !selectedModel.value);
}
async function copy(content: string) { try { await requireApi().copy(content); notify('已复制到剪贴板'); } catch (error) { notify(message(error), true); } }
function askDelete(text: string, action: () => Promise<void>) { confirmText.value = text; pendingConfirm.value = action; modal.value = 'confirm'; }
function deleteSelectedHistory() {
  const entry = historyDetail.value;
  if (!entry) return;
  const id = entry.id;
  askDelete('删除整条历史记录及其所有版本？此操作不可撤销。', async () => {
    applyData(await requireApi().deleteHistory(id));
    if (currentEntry.value?.id === id) { currentEntry.value = null; branch.value = false; }
    if (selectedHistory.value === id) selectedHistory.value = '';
  });
}
async function confirmDelete() { if (!pendingConfirm.value) return; saving.value = true; try { await pendingConfirm.value(); modal.value = null; pendingConfirm.value = null; notify('已删除'); } catch (error) { notify(message(error), true); } finally { saving.value = false; } }
function editModel(model?: ModelConfig) { Object.assign(modelDraft, model ? { id: model.id, name: model.name, baseUrl: model.baseUrl, model: model.model, temperature: model.temperature, apiKey: '' } : { id: uid(), name: '', baseUrl: 'https://api.openai.com/v1', model: '', temperature: 0.7, apiKey: '' }); modelEditing.value = true; modelTestResult.value = ''; }
function openModels() { modal.value = 'models'; modelEditing.value = false; modelTestResult.value = ''; }
async function saveModel() {
  saving.value = true;
  const draft = clone(modelDraft); if (!draft.apiKey?.trim()) delete draft.apiKey;
  try { applyData(await requireApi().saveModel(draft)); modelId.value = draft.id; modelEditing.value = false; modelDraft.apiKey = ''; notify('模型配置已保存'); } catch (error) { notify(message(error), true); } finally { saving.value = false; }
}
async function testModel(model: ModelConfig) {
  if (busy.value) return; modelTestId.value = model.id; modelTestResult.value = '';
  try { await request(model.id, [{ role: 'user', content: '请只回复：连接成功' }], () => {}); modelTestResult.value = `${model.name} 已返回内容，连接可用。`; }
  catch (error) { modelTestResult.value = `${model.name}：${message(error)}`; }
  finally { modelTestId.value = ''; }
}
function editFavorite(favorite?: Favorite) { const now = new Date().toISOString(); Object.assign(favoriteDraft, favorite ? clone(favorite) : { id: uid(), title: '', content: optimized.value || original.value, tags: [], kind: kind.value, createdAt: now, updatedAt: now }); favoriteTags.value = favorite?.tags.join('，') || ''; modal.value = 'favorite'; }
async function saveFavorite() { saving.value = true; try { const favorite = { ...clone(favoriteDraft), title: favoriteDraft.title.trim(), tags: [...new Set(favoriteTags.value.split(/[,，]/).map(tag => tag.trim()).filter(Boolean))], updatedAt: new Date().toISOString() }; applyData(await requireApi().saveFavorite(favorite)); modal.value = null; notify('收藏已保存'); } catch (error) { notify(message(error), true); } finally { saving.value = false; } }
function reuseFavorite(favorite: Favorite) { newWorkspace(); original.value = favorite.content; kind.value = favorite.kind; notify('已放入原始提示词'); }
async function backup(importing: boolean) { saving.value = true; try { if (importing) { const result = await requireApi().importBackup(); if (result) { applyData(result); notify('备份已合并导入'); } } else { const path = await requireApi().exportBackup(); if (path) notify('备份已导出，不包含 API 密钥'); } } catch (error) { notify(message(error), true); } finally { saving.value = false; } }
function closeModal() { if (busy.value) return; modal.value = null; modelDraft.apiKey = ''; }
</script>

<template>
  <div class="app-shell">
    <aside class="sidebar">
      <div class="brand"><span class="brand-mark">P<span></span></span><div><strong>PromptLite</strong><small>个人提示词工作台</small></div></div>
      <button class="new-button" :disabled="busy" @click="newWorkspace"><AppIcon name="plus" />新建提示词</button>
      <nav aria-label="主导航">
        <button :class="{ active: page === 'work' }" @click="page = 'work'"><AppIcon name="work" />工作台</button>
        <button :class="{ active: page === 'history' }" @click="page = 'history'"><AppIcon name="history" />历史记录<span class="nav-count">{{ data.history.length }}</span></button>
        <button :class="{ active: page === 'favorites' }" @click="page = 'favorites'"><AppIcon name="star" />我的收藏<span class="nav-count">{{ data.favorites.length }}</span></button>
      </nav>
      <div class="sidebar-bottom"><button :disabled="!api || !loaded || busy" @click="openModels"><AppIcon name="settings" />模型设置</button><div class="backup-buttons"><button :disabled="!api || !loaded || busy" @click="backup(false)"><AppIcon name="download" :size="15" />导出备份</button><button :disabled="!api || !loaded || busy" @click="backup(true)"><AppIcon name="upload" :size="15" />导入</button></div><p>本地保存 · haihaihai112</p></div>
    </aside>
    <main class="main-area">
      <header class="page-header"><div><h1>{{ page === 'work' ? '提示词工作台' : page === 'history' ? '历史记录' : '我的收藏' }}</h1><p>{{ page === 'work' ? '从一个想法开始，让表达更清楚。' : page === 'history' ? '每次优化都有迹可循，随时回到合适的版本。' : '收好常用的表达，下次直接开始。' }}</p></div><span :class="['desktop-badge', { offline: !api }]"><i></i>{{ api ? '本地桌面应用' : '浏览器预览' }}</span></header>
      <div v-if="!api" class="notice warning" role="status">此页面为桌面界面预览。请启动 PromptLite 桌面应用以配置模型、发起请求和保存数据。</div>
      <div v-else-if="loadError" class="notice warning" role="alert">{{ loadError }}<button :disabled="busy" @click="load">重新加载</button></div>
      <div v-else-if="!loaded" class="notice">正在读取本地数据…</div>

      <template v-if="page === 'work'">
        <div class="toolbar"><div class="kind-switch" role="group" aria-label="提示词类型"><button :class="{ selected: kind === 'system' }" :disabled="busy" @click="kind = 'system'">系统提示词</button><button :class="{ selected: kind === 'user' }" :disabled="busy" @click="kind = 'user'">用户提示词</button></div><div class="model-picker"><label for="work-model">使用模型</label><select id="work-model" v-model="modelId" :disabled="!api || busy"><option value="" disabled>请选择模型</option><option v-if="modelId && !selectedModel" :value="modelId">原模型已删除，请重新选择</option><option v-for="model in data.models" :key="model.id" :value="model.id">{{ model.name }}</option></select><button class="icon-button" aria-label="打开模型设置" :disabled="!api || !loaded || busy" @click="openModels"><AppIcon name="settings" /></button></div></div>
        <div v-if="api && loaded && !data.models.length" class="notice setup-notice"><span>先添加一个模型，让工作台连接到你选择的服务。</span><button class="text-button" :disabled="busy" @click="openModels">添加模型<AppIcon name="arrow" :size="15" /></button></div>
        <div class="editor-grid">
          <section class="editor-panel"><header><div><span class="editor-dot original-dot"></span><label for="original-prompt">原始提示词</label></div><span class="char-count">{{ original.length }} 字</span></header><textarea id="original-prompt" v-model="original" maxlength="100000" :disabled="busy" spellcheck="false" placeholder="描述你希望 AI 完成的任务…&#10;&#10;例如：你是一名中文编辑。请帮我修改一段文字，保留原意，减少冗余，让表达自然、清楚。" /><footer><span>{{ kind === 'system' ? '定义 AI 的角色、规则和输出要求' : '表达要完成的具体任务' }}</span><button class="icon-button" aria-label="复制原始提示词" :disabled="!api || !original" @click="copy(original)"><AppIcon name="copy" :size="16" /></button></footer></section>
          <section class="editor-panel result-panel"><header><div><span class="editor-dot result-dot"></span><label for="optimized-prompt">优化结果</label><span v-if="editorState === 'running'" class="state-label running">生成中</span><span v-else-if="editorState === 'partial'" class="state-label warning-text">部分内容</span><span v-else-if="editorState === 'complete'" class="state-label">可编辑</span></div><span class="char-count">{{ optimized.length }} 字</span></header><textarea id="optimized-prompt" v-model="optimized" maxlength="100000" :readonly="working" spellcheck="false" placeholder="优化后的提示词会显示在这里。&#10;&#10;你可以直接修改结果，或提出进一步要求。" /><footer><span>{{ currentEntry ? `当前版本 ${currentEntry.versions.length}${branch ? ' · 继续迭代将创建分支' : ''}` : '可复制、收藏或继续迭代' }}</span><div class="inline-actions"><button class="icon-button" aria-label="收藏当前结果" :disabled="!api || !loaded || !optimized || busy || editorState === 'partial' || editorState === 'error'" @click="editFavorite()"><AppIcon name="star" :size="16" /></button><button class="icon-button" aria-label="复制优化结果" :disabled="!api || !optimized" @click="copy(optimized)"><AppIcon name="copy" :size="16" /></button></div></footer></section>
        </div>
        <div v-if="editorError" class="notice warning" role="alert">{{ editorError }}<span>未完成内容不会保存为成功版本；重新优化可重试。</span></div>
        <div class="optimization-bar"><fieldset class="strategy-options"><legend class="sr-only">优化策略</legend><label v-for="item in strategies" :key="item.value" :class="{ selected: strategy === item.value }"><input v-model="strategy" type="radio" name="strategy" :value="item.value" :disabled="busy" /><span><strong>{{ item.title }}</strong><small>{{ item.description }}</small></span></label></fieldset><button v-if="working" class="button cancel-button" @click="cancelAll"><AppIcon name="stop" :size="16" />停止生成</button><button v-else class="button primary" :disabled="!canRun || !original.trim()" @click="optimize(false)"><AppIcon name="bolt" :size="17" />开始优化</button></div>
        <div class="iteration-bar"><label for="iteration-note">继续迭代</label><input id="iteration-note" v-model="instruction" maxlength="2000" :disabled="working" placeholder="例如：再精简一些，并明确输出格式" @keydown.enter="optimize(true)" /><button class="button secondary" :disabled="!canRun || !original.trim() || !optimized.trim() || !instruction.trim() || editorState === 'partial' || editorState === 'error'" @click="optimize(true)">生成新版本<AppIcon name="arrow" :size="16" /></button></div>
        <section class="test-section"><button class="test-toggle" :aria-expanded="testOpen" aria-controls="comparison-panel" @click="testOpen = !testOpen"><div><AppIcon name="work" /><strong>前后对比测试</strong><span>用相同模型与输入，观察两份提示词的表现</span></div><AppIcon name="down" :class="{ rotate: testOpen }" /></button><div v-show="testOpen" id="comparison-panel" class="test-content"><div class="test-fields"><label v-if="kind === 'user'" for="test-context">共同系统上下文<textarea id="test-context" v-model="systemContext" :disabled="testing" rows="2" placeholder="可选：两侧使用相同的系统规则" /></label><label for="test-input">{{ kind === 'system' ? '共同用户输入' : '共同补充材料' }}<textarea id="test-input" v-model="testInput" :disabled="testing" rows="3" :placeholder="kind === 'system' ? '输入一段真实任务或材料，测试两份系统提示词' : '可选：两份用户提示词使用同一段补充材料'" /></label></div><div class="test-actions"><p>分别发起两次请求；结果取决于模型与输入，不自动评分。</p><button v-if="testing" class="button cancel-button" @click="cancelAll"><AppIcon name="stop" :size="16" />停止测试</button><button v-else class="button secondary" :disabled="!canRun || !original.trim() || !optimized.trim() || (kind === 'system' && !testInput.trim()) || editorState === 'partial' || editorState === 'error'" @click="compare">运行对比测试</button></div><p v-if="testsStale" class="test-stale" role="status">提示词、测试输入或模型已修改；下面是上一次测试的结果，重新运行可更新。</p><p v-if="lastTestModel" class="test-model-label">本次测试：{{ lastTestModel }}</p><div class="comparison-grid"><section v-for="side in (['original', 'optimized'] as const)" :key="side" class="comparison-result"><header><strong>{{ side === 'original' ? '原始提示词的回答' : '优化提示词的回答' }}</strong><span :class="{ 'warning-text': comparison[side].status === 'partial' || comparison[side].status === 'error' }">{{ statusLabels[comparison[side].status] }}</span><button class="icon-button" :aria-label="`复制${side === 'original' ? '原始' : '优化'}测试回答`" :disabled="!api || !comparison[side].content" @click="copy(comparison[side].content)"><AppIcon name="copy" :size="15" /></button></header><p v-if="comparison[side].error" class="inline-error" role="alert">{{ comparison[side].error }}</p><pre>{{ comparison[side].content || '运行测试后，模型回答显示在这里。' }}</pre></section></div></div></section>
      </template>

      <template v-else-if="page === 'history'"><div class="collection-toolbar"><div class="search-box"><AppIcon name="search" /><input v-model="historySearch" aria-label="搜索历史记录" placeholder="搜索提示词、模型或版本内容" /></div><span>{{ filteredHistory.length }} 条记录</span></div><div v-if="!filteredHistory.length" class="empty-state"><AppIcon name="history" :size="35" /><h2>{{ historySearch ? '没有找到相关记录' : '还没有历史记录' }}</h2><p>{{ historySearch ? '试试其他关键词。' : '成功优化或迭代后，版本会自动保存在这里。' }}</p><button class="button secondary" @click="page = 'work'">回到工作台</button></div><div v-else class="history-layout"><div class="history-list"><button v-for="entry in filteredHistory" :key="entry.id" :class="['history-item', { selected: selectedHistory === entry.id }]" @click="chooseHistory(entry)"><strong>{{ entry.original }}</strong><span>{{ entry.modelName }}<small>{{ entry.versions.length }} 个版本</small></span><time :datetime="entry.updatedAt">{{ shortDate(entry.updatedAt) }}</time></button></div><section v-if="historyDetail" class="history-detail"><header><div><h2>版本详情</h2><p>{{ historyDetail.kind === 'system' ? '系统提示词' : '用户提示词' }} · {{ strategies.find(item => item.value === historyDetail?.strategy)?.title }} · {{ historyDetail.modelName }}</p></div><button class="icon-button danger" aria-label="删除这条历史记录" :disabled="!api || busy" @click="deleteSelectedHistory"><AppIcon name="trash" /></button></header><label for="history-version">查看版本<select id="history-version" v-model="selectedVersion"><option v-for="(version, index) in historyDetail.versions" :key="version.id" :value="index">版本 {{ index + 1 }} · {{ shortDate(version.createdAt) }} · {{ version.note.slice(0, 50) }}</option></select></label><p v-if="displayedVersion?.note" class="version-note">版本说明：{{ displayedVersion.note }}</p><div class="history-original"><h3>原始提示词</h3><p>{{ historyDetail.original }}</p></div><div class="history-version"><h3>优化结果</h3><pre>{{ displayedVersion?.content }}</pre></div><footer><button class="button secondary" :disabled="!api || !displayedVersion" @click="copy(displayedVersion!.content)"><AppIcon name="copy" :size="16" />复制结果</button><button class="button primary" :disabled="busy" @click="restoreHistory">恢复到工作台<AppIcon name="arrow" :size="16" /></button></footer></section><div v-else class="detail-placeholder">选择左侧记录，查看与恢复版本。</div></div></template>

      <template v-else><div class="collection-toolbar"><div class="search-box"><AppIcon name="search" /><input v-model="favoriteSearch" aria-label="搜索收藏" placeholder="搜索名称、内容或标签" /></div><button class="button secondary" :disabled="!api || !loaded || busy" @click="editFavorite()"><AppIcon name="plus" :size="16" />新建收藏</button></div><div v-if="!filteredFavorites.length" class="empty-state"><AppIcon name="star" :size="35" /><h2>{{ favoriteSearch ? '没有找到相关收藏' : '把常用提示词收在这里' }}</h2><p>{{ favoriteSearch ? '试试其他名称或标签。' : '在工作台收藏优化结果，或直接新建一份收藏。' }}</p></div><div v-else class="favorites-grid"><article v-for="favorite in filteredFavorites" :key="favorite.id" class="favorite-card"><header><h2>{{ favorite.title }}</h2><span>{{ favorite.kind === 'system' ? '系统' : '用户' }}</span></header><p>{{ favorite.content }}</p><div class="tags"><span v-for="tag in favorite.tags" :key="tag">{{ tag }}</span></div><footer><button class="text-button" :disabled="busy" @click="reuseFavorite(favorite)">使用提示词<AppIcon name="arrow" :size="15" /></button><div><button class="icon-button" :disabled="busy" :aria-label="`编辑收藏 ${favorite.title}`" @click="editFavorite(favorite)"><AppIcon name="settings" :size="16" /></button><button class="icon-button danger" :disabled="!api || busy" :aria-label="`删除收藏 ${favorite.title}`" @click="askDelete(`删除收藏「${favorite.title}」？此操作不可撤销。`, async () => applyData(await requireApi().deleteFavorite(favorite.id)))"><AppIcon name="trash" :size="16" /></button></div></footer></article></div></template>
      <footer class="workspace-footnote">提示词与收藏保存在此电脑。模型请求会发送到你配置的服务。</footer>
    </main>

    <AppDialog v-if="modal === 'models'" title="模型设置" wide :busy="busy" :notice="toast" @dismiss="toast = null" @close="closeModal"><p class="dialog-intro">连接 OpenAI Chat Completions 兼容服务；可使用 HTTPS 接口或本地 HTTP 服务。</p><div class="model-settings-layout"><div class="model-list"><button v-for="model in data.models" :key="model.id" :class="{ selected: modelEditing && modelDraft.id === model.id }" :disabled="busy" @click="editModel(model)"><strong>{{ model.name }}</strong><code>{{ model.model }}</code><small>{{ model.hasKey ? '密钥已设置' : '未设置密钥' }}</small></button><button class="add-model" :disabled="busy" @click="editModel()"><AppIcon name="plus" :size="16" />添加模型</button></div><form v-if="modelEditing" class="form-stack model-form" @submit.prevent="saveModel"><label for="model-name">名称<input id="model-name" v-model="modelDraft.name" required maxlength="100" placeholder="例如：日常写作" :disabled="busy" /></label><label for="model-url">接口地址<input id="model-url" v-model="modelDraft.baseUrl" required type="url" placeholder="https://服务地址/v1" :disabled="busy" /><small>填写接口根地址，通常以 /v1 结尾。</small></label><label for="model-code">模型 ID<input id="model-code" v-model="modelDraft.model" required maxlength="200" placeholder="填写服务商提供的模型 ID" :disabled="busy" /></label><label for="model-key">API 密钥<input id="model-key" v-model="modelDraft.apiKey" type="password" autocomplete="new-password" :placeholder="data.models.find(model => model.id === modelDraft.id)?.hasKey ? '已设置；留空保留现有密钥' : '本地服务可留空'" :disabled="busy" /><small>密钥加密保存在此电脑，备份不包含密钥。</small></label><label for="model-temperature">温度<input id="model-temperature" v-model.number="modelDraft.temperature" required type="number" min="0" max="2" step="0.1" :disabled="busy" /></label><div class="form-actions"><button type="button" class="button secondary" :disabled="busy" @click="modelEditing = false; modelDraft.apiKey = ''">取消编辑</button><button type="submit" class="button primary" :disabled="busy">保存模型</button></div></form><div v-else class="model-overview"><h3>{{ data.models.length ? '选择模型进行编辑' : '添加你的第一个模型' }}</h3><p>保存后可测试连接。测试会发起一次真实模型请求，可能产生服务费用。</p><div v-for="model in data.models" :key="model.id" class="model-test-row"><div><strong>{{ model.name }}</strong><code>{{ model.model }}</code></div><button class="button secondary small" :disabled="busy" @click="testModel(model)">{{ modelTestId === model.id ? '测试中…' : '测试连接' }}</button><button class="icon-button danger" :aria-label="`删除模型 ${model.name}`" :disabled="busy" @click="askDelete(`删除模型「${model.name}」及其密钥？历史记录仍会保留。`, async () => { applyData(await requireApi().deleteModel(model.id)); if (modelId === model.id) modelId = data.models[0]?.id || ''; })"><AppIcon name="trash" :size="16" /></button></div><p v-if="modelTestResult" class="connection-result" role="status">{{ modelTestResult }}</p><button v-if="modelTestId" class="button cancel-button" @click="cancelAll">停止测试</button></div></div></AppDialog>
    <AppDialog v-else-if="modal === 'favorite'" :title="data.favorites.some(item => item.id === favoriteDraft.id) ? '编辑收藏' : '新建收藏'" :busy="saving" :notice="toast" @dismiss="toast = null" @close="closeModal"><form class="form-stack" @submit.prevent="saveFavorite"><label for="favorite-title">名称<input id="favorite-title" v-model="favoriteDraft.title" required maxlength="160" autofocus :disabled="saving" placeholder="为这份提示词起个容易找到的名字" /></label><label for="favorite-kind">提示词类型<select id="favorite-kind" v-model="favoriteDraft.kind" :disabled="saving"><option value="system">系统提示词</option><option value="user">用户提示词</option></select></label><label for="favorite-content">提示词内容<textarea id="favorite-content" v-model="favoriteDraft.content" required maxlength="100000" rows="9" :disabled="saving" /></label><label for="favorite-tags">标签<input id="favorite-tags" v-model="favoriteTags" maxlength="1000" :disabled="saving" placeholder="例如：写作，代码，学习（用逗号分隔）" /></label><div class="form-actions"><button type="button" class="button secondary" :disabled="saving" @click="closeModal">取消</button><button type="submit" class="button primary" :disabled="saving || !favoriteDraft.title.trim() || !favoriteDraft.content.trim()">保存收藏</button></div></form></AppDialog>
    <AppDialog v-else-if="modal === 'confirm'" title="确认删除" :busy="saving" :notice="toast" @dismiss="toast = null" @close="closeModal"><p class="confirm-copy">{{ confirmText }}</p><div class="form-actions"><button class="button secondary" autofocus :disabled="saving" @click="closeModal">取消</button><button class="button danger-solid" :disabled="saving" @click="confirmDelete">确认删除</button></div></AppDialog>
    <div v-if="toast && !modal" :class="['toast', { error: toast.error }]" :role="toast.error ? 'alert' : 'status'"><AppIcon :name="toast.error ? 'close' : 'check'" :size="18" /><span>{{ toast.text }}</span><button class="icon-button" aria-label="关闭通知" @click="toast = null"><AppIcon name="close" :size="15" /></button></div>
  </div>
</template>
