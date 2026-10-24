// popup.js — 弹窗逻辑
// 职责：常用语增删改查 + AI 配置管理；保存后写入 chrome.storage.local 并通知 content 刷新。

'use strict';

const $ = (id) => document.getElementById(id);

const state = {
  phrases: [],
  aiConfig: null,
  settings: null, // { shortcuts, cooldownSec, enabled }
  editingId: null // 正在编辑的常用语 id
};

const DEFAULT_CONFIG = { provider: 'openai', apiKey: '', model: 'gpt-4o-mini', baseUrl: '' };

// 默认快捷键（与 background.js / content.js 保持一致）
const DEFAULT_SHORTCUTS = {
  toggleEnabled: 'Alt+Q',
  manualSuggest: 'Alt+Space',
  closeCooldown: 'Alt+X',
  fillTop: 'Ctrl+Shift+Enter',
  select1: 'Alt+1',
  select2: 'Alt+2'
};
const DEFAULT_COOLDOWN_SEC = 30;

// 功能名 -> popup 输入框 id
const SHORTCUT_FIELDS = {
  toggleEnabled: 'shortcutToggle',
  manualSuggest: 'shortcutSuggest',
  closeCooldown: 'shortcutClose',
  fillTop: 'shortcutFill',
  select1: 'shortcutSelect1',
  select2: 'shortcutSelect2'
};

// 标签分隔符：支持逗号 / 分号 / 顿号，录入时按分隔符拆分为多个标签
const TAG_SEP = /[,，;；、]/;

/** 拆分标签：兼容数组输入与分隔字符串输入，去空去重 */
function parseTags(raw) {
  if (Array.isArray(raw)) {
    return raw.map((t) => String(t || '').trim()).filter(Boolean);
  }
  return String(raw || '')
    .split(TAG_SEP)
    .map((t) => t.trim())
    .filter(Boolean);
}

/** 读取常用语的标签文本（多标签数组优先，兼容旧单标签字符串），用于展示与回填 */
function getTagText(p) {
  if (Array.isArray(p.tags) && p.tags.length > 0) return p.tags.join('、');
  return p.tag || '';
}

// 各 provider 默认 baseUrl（仅在选择 provider 时自动填充，用户可覆盖）
const PROVIDER_DEFAULTS = {
  openai: 'https://api.openai.com/v1',
  deepseek: 'https://api.deepseek.com/v1',
  moonshot: 'https://api.moonshot.cn/v1',
  qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  custom: ''
};

init();

async function init() {
  const data = await chrome.storage.local.get(['phrases', 'aiConfig', 'settings']);
  state.phrases = Array.isArray(data.phrases) ? data.phrases : [];
  state.aiConfig = Object.assign({}, DEFAULT_CONFIG, data.aiConfig || {});
  state.settings = Object.assign({}, { shortcuts: {}, cooldownSec: DEFAULT_COOLDOWN_SEC, enabled: true }, data.settings || {});
  state.settings.shortcuts = Object.assign({}, DEFAULT_SHORTCUTS, (data.settings && data.settings.shortcuts) || {});
  renderList();
  fillConfigForm();
  fillShortcutForm();
  bindEvents();
}

function bindEvents() {
  $('addBtn').addEventListener('click', savePhrase);
  $('cancelEditBtn').addEventListener('click', cancelEdit);
  $('saveConfigBtn').addEventListener('click', saveConfig);
  $('testBtn').addEventListener('click', testConnection);
  $('provider').addEventListener('change', onProviderChange);
  $('importBtn').addEventListener('click', () => $('importFile').click());
  $('importFile').addEventListener('change', handleImportFile);
  $('newText').addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      savePhrase();
    }
  });

  // 快捷键录制：点击输入框聚焦后按组合键录入；Esc 取消；Delete/Backspace 清除
  document.querySelectorAll('.shortcut-input').forEach((input) => {
    input.addEventListener('focus', () => {
      recordingValue = input.value;
      input.select();
    });
    input.addEventListener('keydown', onShortcutKeydown);
    input.addEventListener('blur', () => { input.value = input.value; });
  });
  $('resetShortcutsBtn').addEventListener('click', resetShortcuts);
  $('cooldownSec').addEventListener('change', onCooldownChange);
}

// ========== 快捷键与冷却设置 ==========

/** 当前正在录制的快捷键输入框原值（Esc 取消时恢复） */
let recordingValue = '';

/**
 * 将 keydown 事件解析为规范组合键字符串（与 content.js 一致）。
 * 仅处理「修饰键 + 非纯字符主键」的组合且必须含 Ctrl/Alt/Meta 之一，
 * 避免 Shift+q（输出大写 Q）等纯字符输入被当作快捷键。
 */
function normalizeShortcut(e) {
  const key = e.key;
  let main = null;
  if (/^[a-zA-Z]$/.test(key)) main = key.toUpperCase();
  else if (/^[0-9]$/.test(key)) main = key;
  else if (/^F([1-9]|1[0-2])$/.test(key)) main = key;
  else if (key === ' ' || key === 'Spacebar') main = 'Space';
  else if (key === 'Enter') main = 'Enter';
  else if (key === 'Escape') main = 'Esc';
  else return null;

  if (!(e.ctrlKey || e.altKey || e.metaKey)) return null;

  const parts = [];
  if (e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  if (e.metaKey) parts.push('Meta');
  parts.push(main);
  return parts.join('+');
}

/** 快捷键输入框 keydown：录制组合键 / Esc 取消 / Delete 清除 */
function onShortcutKeydown(e) {
  e.preventDefault();
  e.stopPropagation();
  const input = e.currentTarget;
  const fn = input.dataset.fn;
  if (!fn) return;

  if (e.key === 'Escape') {
    input.value = recordingValue; // 取消录入，恢复原值
    input.blur();
    return;
  }
  if (e.key === 'Delete' || e.key === 'Backspace') {
    setShortcut(fn, '');
    return;
  }

  const combo = normalizeShortcut(e);
  if (!combo) return;
  setShortcut(fn, combo);
}

/** 保存单个快捷键（空字符串表示清除） */
function setShortcut(fn, combo) {
  state.settings.shortcuts[fn] = combo;
  const input = $(SHORTCUT_FIELDS[fn]);
  if (input) input.value = combo;
  saveSettings();
}

/** 恢复默认快捷键 */
function resetShortcuts() {
  Object.keys(DEFAULT_SHORTCUTS).forEach((fn) => {
    state.settings.shortcuts[fn] = DEFAULT_SHORTCUTS[fn];
    const input = $(SHORTCUT_FIELDS[fn]);
    if (input) input.value = DEFAULT_SHORTCUTS[fn];
  });
  saveSettings();
}

/** 冷却秒数变更 */
function onCooldownChange() {
  const raw = parseInt($('cooldownSec').value, 10);
  const sec = isNaN(raw) ? 0 : Math.max(0, Math.min(3600, raw));
  $('cooldownSec').value = sec;
  state.settings.cooldownSec = sec;
  saveSettings();
}

/** 填充快捷键与冷却表单 */
function fillShortcutForm() {
  Object.keys(SHORTCUT_FIELDS).forEach((fn) => {
    const input = $(SHORTCUT_FIELDS[fn]);
    if (input) input.value = state.settings.shortcuts[fn] || '';
  });
  $('cooldownSec').value = (state.settings.cooldownSec === undefined ? DEFAULT_COOLDOWN_SEC : state.settings.cooldownSec);
}

/** 将 settings 写入 storage（content.js 通过 onChanged 自动刷新） */
async function saveSettings() {
  try {
    await chrome.storage.local.set({ settings: state.settings });
  } catch (e) {
    console.warn('[QuickPhraseAI] save settings failed:', e);
  }
}

// ========== 常用语 CRUD ==========

function renderList() {
  const list = $('phraseList');
  list.innerHTML = '';
  $('emptyTip').hidden = state.phrases.length > 0;
  $('count').textContent = '(' + state.phrases.length + ')';

  state.phrases.forEach((p, idx) => {
    const li = document.createElement('li');
    li.className = 'phrase-item';

    const main = document.createElement('div');
    main.className = 'phrase-main';

    const text = document.createElement('div');
    text.className = 'phrase-text';
    text.textContent = p.text;

    const tag = document.createElement('div');
    tag.className = 'phrase-tag';
    tag.textContent = getTagText(p) || '未分类';

    main.appendChild(text);
    main.appendChild(tag);

    const actions = document.createElement('div');
    actions.className = 'phrase-actions';

    const editBtn = document.createElement('button');
    editBtn.className = 'btn-mini';
    editBtn.textContent = '编辑';
    editBtn.addEventListener('click', () => startEdit(p.id));

    const delBtn = document.createElement('button');
    delBtn.className = 'btn-mini btn-danger';
    delBtn.textContent = '删除';
    delBtn.addEventListener('click', () => deletePhrase(p.id, idx));

    actions.appendChild(editBtn);
    actions.appendChild(delBtn);

    li.appendChild(main);
    li.appendChild(actions);
    list.appendChild(li);
  });
}

function startEdit(id) {
  const p = state.phrases.find((x) => x.id === id);
  if (!p) return;
  state.editingId = id;
  $('newText').value = p.text;
  $('newTag').value = getTagText(p);
  $('addTitle').textContent = '编辑常用语';
  $('addBtn').textContent = '更新常用语';
  $('cancelEditBtn').hidden = false;
  $('newText').focus();
}

function cancelEdit() {
  state.editingId = null;
  $('newText').value = '';
  $('newTag').value = '';
  $('addTitle').textContent = '添加常用语';
  $('addBtn').textContent = '保存常用语';
  $('cancelEditBtn').hidden = true;
}

async function savePhrase() {
  const text = $('newText').value.trim();
  if (!text) {
    alert('常用语内容不能为空');
    return;
  }
  const tags = parseTags($('newTag').value);
  const now = new Date().toISOString();

  if (state.editingId) {
    const p = state.phrases.find((x) => x.id === state.editingId);
    if (p) {
      p.text = text;
      p.tags = tags;
      delete p.tag; // 新数据统一走 tags 数组，避免新旧字段歧义
    }
    cancelEdit();
  } else {
    state.phrases.push({ id: uuid(), text, tags, createdAt: now });
    $('newText').value = '';
    $('newTag').value = '';
  }

  await persistPhrases();
  renderList();
}

async function deletePhrase(id, idx) {
  if (!confirm('确定删除这条常用语吗？')) return;
  state.phrases.splice(idx, 1);
  await persistPhrases();
  renderList();
}

/** 写入 storage 并通知 background / content 刷新 */
async function persistPhrases() {
  await chrome.storage.local.set({ phrases: state.phrases });
  notifyContentRefresh();
}

// ========== 导入常用语 ==========

/**
 * 处理导入文件：
 * - .txt：按行拆分为常用语；
 * - .json：先按字符串数组 / {text,tag} 对象数组解析；
 * - 无结构自由文本（json 解析失败或非数组）：已配置 AI 则调用 AI 提取，未配置/失败时按行兜底拆分。
 * 导入成功后去重合并进 state.phrases，刷新列表并提示新增数量。
 */
async function handleImportFile(e) {
  const file = e.target.files && e.target.files[0];
  // 重置 input，允许连续选择同一文件
  e.target.value = '';
  if (!file) return;

  const resultEl = $('importResult');
  resultEl.hidden = false;
  resultEl.textContent = '正在解析 ' + file.name + ' ...';

  try {
    const text = await file.text();
    const imported = await parseImportText(text, file.name.toLowerCase().endsWith('.json'));
    const added = mergeImported(imported);

    await persistPhrases();
    renderList();

    if (added.length > 0) {
      resultEl.textContent = '导入成功：新增 ' + added.length + ' 条常用语';
    } else {
      resultEl.textContent = '导入完成：没有新增内容（内容为空或已存在）';
    }
  } catch (err) {
    resultEl.textContent = '导入失败：' + String((err && err.message) || err);
  }
}

/** 解析导入文本为 [{ text, tag }] */
async function parseImportText(text, isJson) {
  if (isJson) {
    try {
      const data = JSON.parse(text);
      if (Array.isArray(data)) {
        const items = [];
        for (const item of data) {
          if (typeof item === 'string' && item.trim()) {
            items.push({ text: item.trim(), tags: [] });
          } else if (item && typeof item === 'object' && typeof item.text === 'string' && item.text.trim()) {
            items.push({ text: item.text.trim(), tags: parseTags(item.tags != null ? item.tags : item.tag) });
          }
        }
        if (items.length > 0) return items;
      }
    } catch (e) { /* JSON 解析失败：视为无结构自由文本 */ }
    // 无结构自由文本：AI 提取（未配置 / 失败时按行兜底）
    return extractFreeText(text);
  }

  // .txt：按行拆分
  return text.split('\n').map((s) => s.trim()).filter(Boolean).map((t) => ({ text: t, tag: '' }));
}

/** 无结构自由文本：已配置 AI 则调用 background 提取，否则按行兜底 */
async function extractFreeText(text) {
  if (state.aiConfig && state.aiConfig.apiKey) {
    try {
      const res = await chrome.runtime.sendMessage({ type: 'AI_EXTRACT_PHRASES', payload: { text } });
      if (res && !res.fallback && Array.isArray(res.phrases) && res.phrases.length > 0) {
        return res.phrases;
      }
    } catch (e) { /* 请求失败走按行兜底 */ }
  }
  return text.split('\n').map((s) => s.trim()).filter(Boolean).map((t) => ({ text: t, tag: '' }));
}

/** 与现有常用语去重后合并进 state.phrases，返回实际新增的条目 */
function mergeImported(imported) {
  const existing = new Set(state.phrases.map((p) => p.text.trim().toLowerCase()));
  const added = [];
  for (const item of imported) {
    const text = (item.text || '').trim();
    if (!text) continue;
    const key = text.toLowerCase();
    if (existing.has(key)) continue;
    existing.add(key);
    added.push({ id: uuid(), text: text, tags: parseTags(item.tags != null ? item.tags : item.tag), createdAt: new Date().toISOString() });
  }
  state.phrases = state.phrases.concat(added);
  return added;
}

// ========== AI 配置 ==========

function fillConfigForm() {
  $('provider').value = state.aiConfig.provider || 'openai';
  $('apiKey').value = state.aiConfig.apiKey || '';
  $('model').value = state.aiConfig.model || '';
  $('baseUrl').value = state.aiConfig.baseUrl || '';
}

function onProviderChange() {
  const provider = $('provider').value;
  const def = PROVIDER_DEFAULTS[provider];
  if (def) $('baseUrl').value = def; // 切换 provider 时填充默认 baseUrl
  if (provider === 'openai' && !$('model').value) $('model').value = 'gpt-4o-mini';
  if (provider === 'deepseek' && !$('model').value) $('model').value = 'deepseek-chat';
  if (provider === 'moonshot' && !$('model').value) $('model').value = 'moonshot-v1-8k';
  if (provider === 'qwen' && !$('model').value) $('model').value = 'qwen-plus';
}

async function saveConfig() {
  const config = {
    provider: $('provider').value,
    apiKey: $('apiKey').value.trim(),
    model: $('model').value.trim() || DEFAULT_CONFIG.model,
    baseUrl: $('baseUrl').value.trim()
  };

  if (config.apiKey && !config.baseUrl) {
    config.baseUrl = PROVIDER_DEFAULTS[config.provider] || '';
  }

  await chrome.storage.local.set({ aiConfig: config });
  notifyContentRefresh();
  alert('AI 配置已保存');
}

/**
 * 测试 AI 连接：调用 background 发起最小请求并展示结果。
 * background 的 AI_TEST 每次直接读 storage 最新配置，因此保存后再测无需额外同步。
 */
async function testConnection() {
  const btn = $('testBtn');
  const result = $('testResult');

  // 预检查：表单中未填 API Key 时直接提示，避免无意义请求
  if (!$('apiKey').value.trim()) {
    result.hidden = false;
    result.className = 'test-result test-fail';
    result.textContent = '连接失败：请先填写 API Key 并保存 AI 配置';
    return;
  }

  // 进入测试中状态：禁用按钮并给出提示
  btn.disabled = true;
  btn.textContent = '测试中...';
  result.hidden = false;
  result.className = 'test-result';
  result.textContent = '';

  try {
    // MV3 Promise 风格 sendMessage；background 返回 true 保持异步通道
    const res = await chrome.runtime.sendMessage({ type: 'AI_TEST' });

    if (res && res.ok) {
      result.className = 'test-result test-ok';
      result.textContent = '连接成功 · 延迟 ' + res.latency + ' ms · 模型 ' + res.model;
    } else if (!res) {
      // background 未响应（常见于修改 background.js 后未重新加载扩展，旧 SW 不识别 AI_TEST）
      result.className = 'test-result test-fail';
      result.textContent = '连接失败：扩展未响应，请先在 edge://extensions 中点击刷新/重新加载扩展后再试';
    } else {
      result.className = 'test-result test-fail';
      result.textContent = '连接失败：' + ((res && res.error) || '未知错误');
    }
  } catch (e) {
    // sendMessage 本身异常（如 background 未就绪）
    result.className = 'test-result test-fail';
    result.textContent = '连接失败：' + String((e && e.message) || e);
  } finally {
    // 无论成败恢复按钮可用状态
    btn.disabled = false;
    btn.textContent = '测试连接';
  }
}

// ========== 通知已打开页面刷新缓存 ==========

/** 通知所有标签页的 content script 刷新缓存；同时通知 background 刷新 */
async function notifyContentRefresh() {
  try {
    // background 缓存刷新
    chrome.runtime.sendMessage({ type: 'PHRASES_UPDATED' }).catch(() => {});
  } catch (e) { /* 忽略 */ }

  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (tab.id == null) continue;
      try {
        await chrome.tabs.sendMessage(tab.id, { type: 'PHRASES_UPDATED' });
      } catch (e) { /* 无 content script 的页面会抛错，忽略 */ }
    }
  } catch (e) {
    console.warn('[QuickPhraseAI] notify tabs failed:', e);
  }
}

// ========== 工具 ==========

function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
