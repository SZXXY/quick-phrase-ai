// popup.js — 弹窗逻辑
// 职责：常用语增删改查 + AI 配置管理；保存后写入 chrome.storage.local 并通知 content 刷新。

'use strict';

const $ = (id) => document.getElementById(id);

const state = {
  phrases: [],
  aiConfig: null,
  editingId: null // 正在编辑的常用语 id
};

const DEFAULT_CONFIG = { provider: 'openai', apiKey: '', model: 'gpt-4o-mini', baseUrl: '' };

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
  const data = await chrome.storage.local.get(['phrases', 'aiConfig']);
  state.phrases = Array.isArray(data.phrases) ? data.phrases : [];
  state.aiConfig = Object.assign({}, DEFAULT_CONFIG, data.aiConfig || {});
  renderList();
  fillConfigForm();
  bindEvents();
}

function bindEvents() {
  $('addBtn').addEventListener('click', savePhrase);
  $('cancelEditBtn').addEventListener('click', cancelEdit);
  $('saveConfigBtn').addEventListener('click', saveConfig);
  $('testBtn').addEventListener('click', testConnection);
  $('provider').addEventListener('change', onProviderChange);
  $('newText').addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      savePhrase();
    }
  });
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
    tag.textContent = p.tag || '未分类';

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
  $('newTag').value = p.tag || '';
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
  const tag = $('newTag').value.trim();
  const now = new Date().toISOString();

  if (state.editingId) {
    const p = state.phrases.find((x) => x.id === state.editingId);
    if (p) {
      p.text = text;
      p.tag = tag;
    }
    cancelEdit();
  } else {
    state.phrases.push({ id: uuid(), text, tag, createdAt: now });
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
