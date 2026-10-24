// options.js — 独立配置页逻辑
// 职责：常用语管理（CRUD / 多标签 / 导入导出 / 吸收词管理）、快捷键与冷却设置、
//       AI 配置（保留但标注不影响本地功能）、云存档与账户（注册/登录/上传/下载/自动同步）。
// 全部数据存 chrome.storage.local（纯本地），云同步仅在用户开启自动同步或手动操作时访问网络。

'use strict';

const $ = (id) => document.getElementById(id);

const state = {
  phrases: [],
  absorbed: [],
  aiConfig: null,
  settings: null, // { shortcuts, cooldownSec, enabled, cloud: { serverUrl, username, token, autoSync } }
  editingId: null // 正在编辑的常用语 id
};

const DEFAULT_CONFIG = { provider: 'openai', apiKey: '', model: 'gpt-4o-mini', baseUrl: '' };
const DEFAULT_SERVER_URL = 'http://127.0.0.1:8787';

// 默认快捷键（与 background.js / content.js / popup.js 保持一致）
const DEFAULT_SHORTCUTS = {
  toggleEnabled: 'Alt+Q',
  manualSuggest: 'Alt+Space',
  closeCooldown: 'Alt+X',
  fillTop: 'Ctrl+Shift+Enter',
  select1: 'Alt+1',
  select2: 'Alt+2'
};
const DEFAULT_COOLDOWN_SEC = 30;

// 功能名 -> 配置页输入框 id
const SHORTCUT_FIELDS = {
  toggleEnabled: 'shortcutToggle',
  manualSuggest: 'shortcutSuggest',
  closeCooldown: 'shortcutClose',
  fillTop: 'shortcutFill',
  select1: 'shortcutSelect1',
  select2: 'shortcutSelect2'
};

// 标签分隔符：支持逗号 / 分号 / 顿号
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

/** 读取常用语的标签文本（多标签数组优先，兼容旧单标签字符串） */
function getTagText(p) {
  if (Array.isArray(p.tags) && p.tags.length > 0) return p.tags.join('、');
  return p.tag || '';
}

// 各 provider 默认 baseUrl
const PROVIDER_DEFAULTS = {
  openai: 'https://api.openai.com/v1',
  deepseek: 'https://api.deepseek.com/v1',
  moonshot: 'https://api.moonshot.cn/v1',
  qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  custom: ''
};

init();

async function init() {
  const data = await chrome.storage.local.get(['phrases', 'absorbed', 'aiConfig', 'settings']);
  state.phrases = Array.isArray(data.phrases) ? data.phrases : [];
  state.absorbed = Array.isArray(data.absorbed) ? data.absorbed : [];
  state.aiConfig = Object.assign({}, DEFAULT_CONFIG, data.aiConfig || {});
  state.settings = Object.assign(
    {},
    { shortcuts: {}, cooldownSec: DEFAULT_COOLDOWN_SEC, enabled: true, cloud: {} },
    data.settings || {}
  );
  state.settings.shortcuts = Object.assign({}, DEFAULT_SHORTCUTS, (data.settings && data.settings.shortcuts) || {});
  state.settings.cloud = Object.assign(
    { serverUrl: DEFAULT_SERVER_URL, username: '', token: '', autoSync: false },
    (data.settings && data.settings.cloud) || {}
  );

  renderList();
  renderAbsorbed();
  fillConfigForm();
  fillShortcutForm();
  fillCloudForm();
  bindEvents();
  bindAutoSyncWatcher();
}

function bindEvents() {
  $('backBtn').addEventListener('click', () => {
    try { chrome.runtime.openOptionsPage(); /* 已在配置页，保持打开 */ } catch (e) { /* 忽略 */ }
  });
  $('addBtn').addEventListener('click', savePhrase);
  $('cancelEditBtn').addEventListener('click', cancelEdit);
  $('saveConfigBtn').addEventListener('click', saveConfig);
  $('provider').addEventListener('change', onProviderChange);
  $('importBtn').addEventListener('click', () => $('importFile').click());
  $('importFile').addEventListener('change', handleImportFile);
  $('exportBtn').addEventListener('click', exportBackup);
  $('newText').addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      savePhrase();
    }
  });

  // 快捷键录制（同 popup：readonly + keydown 录制；Esc 取消；Delete 清除）
  document.querySelectorAll('.shortcut-input').forEach((input) => {
    input.addEventListener('focus', () => {
      recordingValue = input.value;
      input.select();
    });
    input.addEventListener('keydown', onShortcutKeydown);
  });
  $('resetShortcutsBtn').addEventListener('click', resetShortcuts);
  $('cooldownSec').addEventListener('change', onCooldownChange);

  // 云存档
  $('testServerBtn').addEventListener('click', testServer);
  $('registerBtn').addEventListener('click', registerAccount);
  $('loginBtn').addEventListener('click', loginAccount);
  $('uploadBtn').addEventListener('click', () => runCloudAction(uploadSave));
  $('downloadBtn').addEventListener('click', () => runCloudAction(downloadSave));
  $('autoSync').addEventListener('change', onAutoSyncChange);
  $('logoutBtn').addEventListener('click', logoutAccount);
}

// ========== 快捷键与冷却设置 ==========

/** 当前正在录制的快捷键输入框原值（Esc 取消时恢复） */
let recordingValue = '';

/** 将 keydown 事件解析为规范组合键字符串（与 content.js / popup.js 一致） */
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
    input.value = recordingValue;
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

  if (state.editingId) {
    const p = state.phrases.find((x) => x.id === state.editingId);
    if (p) {
      p.text = text;
      p.tags = tags;
      delete p.tag;
    }
    cancelEdit();
  } else {
    state.phrases.push({ id: uuid(), text, tags, createdAt: new Date().toISOString() });
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

// ========== 吸收词管理 ==========

function renderAbsorbed() {
  const list = $('absorbedList');
  list.innerHTML = '';
  $('absorbedCount').textContent = '(' + state.absorbed.length + ')';
  $('absorbedEmptyTip').hidden = state.absorbed.length > 0;

  state.absorbed.forEach((a, idx) => {
    const li = document.createElement('li');
    li.className = 'absorbed-item';

    const main = document.createElement('div');
    main.className = 'absorbed-main';

    const text = document.createElement('div');
    text.className = 'phrase-text';
    text.textContent = a.text;

    const meta = document.createElement('div');
    meta.className = 'absorbed-meta';
    meta.textContent = '使用 ' + (a.count || 0) + ' 次' + (a.lastUsed ? ' · ' + formatTime(a.lastUsed) : '');

    main.appendChild(text);
    main.appendChild(meta);

    const actions = document.createElement('div');
    actions.className = 'absorbed-actions';

    const addBtn = document.createElement('button');
    addBtn.className = 'btn-mini';
    addBtn.textContent = '入库';
    addBtn.title = '加入常用语库并从吸收词移除';
    addBtn.addEventListener('click', () => addAbsorbedToPhrases(a, idx));

    const delBtn = document.createElement('button');
    delBtn.className = 'btn-mini btn-danger';
    delBtn.textContent = '移除';
    delBtn.addEventListener('click', () => removeAbsorbed(idx));

    actions.appendChild(addBtn);
    actions.appendChild(delBtn);

    li.appendChild(main);
    li.appendChild(actions);
    list.appendChild(li);
  });
}

/** 吸收词入库：常用语已存在同文本时仅移除吸收词；否则加入常用语 */
async function addAbsorbedToPhrases(a, idx) {
  const text = String(a.text || '').trim();
  if (!text) return;
  const dup = state.phrases.some((p) => p && p.text && p.text.toLowerCase() === text.toLowerCase());

  if (!dup) {
    state.phrases.push({ id: uuid(), text, tags: [], createdAt: new Date().toISOString() });
  }
  state.absorbed.splice(idx, 1);

  await chrome.storage.local.set({ phrases: state.phrases, absorbed: state.absorbed });
  renderList();
  renderAbsorbed();
  notifyContentRefresh();
  if (dup) alert('该词已存在于常用语中，仅从吸收词移除');
}

/** 移除吸收词 */
async function removeAbsorbed(idx) {
  if (!confirm('确定移除该吸收词吗？')) return;
  state.absorbed.splice(idx, 1);
  await chrome.storage.local.set({ absorbed: state.absorbed });
  renderAbsorbed();
  notifyContentRefresh();
}

// ========== 导入 / 导出 ==========

/**
 * 导入文件：
 * - 完整备份 JSON（含 phrases 数组）→ 覆盖导入（需确认）；
 * - 字符串数组 / {text,tag} 对象数组 JSON → 去重合并进常用语；
 * - .txt → 按行拆分合并进常用语。
 */
async function handleImportFile(e) {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file) return;

  const resultEl = $('importResult');
  resultEl.hidden = false;
  resultEl.textContent = '正在解析 ' + file.name + ' ...';

  try {
    const text = await file.text();
    const isJson = file.name.toLowerCase().endsWith('.json');
    const full = isJson ? tryParseBackup(text) : null;

    if (full) {
      if (!confirm('检测到完整备份，导入将覆盖当前常用语 / 吸收词 / 设置。是否继续？')) {
        resultEl.textContent = '已取消导入';
        return;
      }
      syncSuppressUntil = Date.now() + 5000; // 覆盖写入期间暂停自动同步
      state.phrases = Array.isArray(full.phrases) ? full.phrases : [];
      state.absorbed = Array.isArray(full.absorbed) ? full.absorbed : [];
      if (full.settings) {
        const cloud = state.settings.cloud || {};
        state.settings = Object.assign({}, state.settings, full.settings, { cloud });
        state.settings.shortcuts = Object.assign({}, DEFAULT_SHORTCUTS, state.settings.shortcuts || {});
      }
      if (full.aiConfig) state.aiConfig = Object.assign({}, DEFAULT_CONFIG, full.aiConfig);
      await chrome.storage.local.set({ phrases: state.phrases, absorbed: state.absorbed, settings: state.settings, aiConfig: state.aiConfig });
      renderList();
      renderAbsorbed();
      fillConfigForm();
      fillShortcutForm();
      notifyContentRefresh();
      resultEl.textContent = '导入成功：已应用完整备份（常用语 ' + state.phrases.length + ' 条）';
      return;
    }

    const imported = await parseImportText(text, isJson);
    const added = mergeImported(imported);
    await persistPhrases();
    renderList();
    resultEl.textContent = added.length > 0 ? ('导入成功：新增 ' + added.length + ' 条常用语') : '导入完成：没有新增内容（内容为空或已存在）';
  } catch (err) {
    resultEl.textContent = '导入失败：' + String((err && err.message) || err);
  }
}

/** 尝试解析完整备份对象（含 phrases 数组）；非备份格式返回 null */
function tryParseBackup(text) {
  try {
    const data = JSON.parse(text);
    if (data && typeof data === 'object' && Array.isArray(data.phrases)) {
      return {
        phrases: data.phrases,
        absorbed: Array.isArray(data.absorbed) ? data.absorbed : null,
        settings: data.settings || null,
        aiConfig: data.aiConfig || null
      };
    }
  } catch (e) { /* 非 JSON */ }
  return null;
}

/** 解析导入文本为 [{ text, tag }]（与 popup 兼容） */
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
    return text.split('\n').map((s) => s.trim()).filter(Boolean).map((t) => ({ text: t, tag: '' }));
  }
  return text.split('\n').map((s) => s.trim()).filter(Boolean).map((t) => ({ text: t, tag: '' }));
}

/** 与现有常用语去重后合并，返回新增条目 */
function mergeImported(imported) {
  const existing = new Set(state.phrases.map((p) => p.text.trim().toLowerCase()));
  const added = [];
  for (const item of imported) {
    const text = (item.text || '').trim();
    if (!text) continue;
    const key = text.toLowerCase();
    if (existing.has(key)) continue;
    existing.add(key);
    added.push({ id: uuid(), text, tags: parseTags(item.tags != null ? item.tags : item.tag), createdAt: new Date().toISOString() });
  }
  state.phrases = state.phrases.concat(added);
  return added;
}

/** 导出完整 JSON 备份并触发下载 */
function exportBackup() {
  const backup = {
    version: 1,
    exportedAt: new Date().toISOString(),
    phrases: state.phrases,
    absorbed: state.absorbed,
    settings: stripCloud(state.settings),
    aiConfig: state.aiConfig
  };
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'quick-phrase-ai-backup-' + stamp() + '.json';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
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
  if (def) $('baseUrl').value = def;
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
  state.aiConfig = config;
  await chrome.storage.local.set({ aiConfig: config });
  notifyContentRefresh();
  alert('AI 配置已保存');
}

// ========== 云存档与账户 ==========

/** 填充云存档表单与登录状态 */
function fillCloudForm() {
  const cloud = state.settings.cloud || {};
  $('serverUrl').value = cloud.serverUrl || DEFAULT_SERVER_URL;
  const loggedIn = !!cloud.token;
  $('loginArea').hidden = loggedIn;
  $('accountArea').hidden = !loggedIn;
  $('autoSync').checked = !!cloud.autoSync;
  if (loggedIn) {
    $('accountName').textContent = cloud.username || '未知用户';
    $('username').value = cloud.username || '';
  }
  setCloudStatus('', true);
}

/** 展示云存档操作状态 */
function setCloudStatus(msg, isOk) {
  const el = $('cloudStatus');
  if (!msg) { el.hidden = true; return; }
  el.hidden = false;
  el.textContent = msg;
  el.style.color = isOk ? '#18a058' : '#f53f3f';
}

/** 保存 cloud 字段到 storage */
async function saveCloud() {
  try { await chrome.storage.local.set({ settings: state.settings }); } catch (e) { console.warn('[QuickPhraseAI] save cloud failed:', e); }
}

/** 服务器基础请求封装 */
async function apiFetch(method, path, body, token) {
  const serverUrl = ($('serverUrl').value || state.settings.cloud.serverUrl || DEFAULT_SERVER_URL).trim().replace(/\/+$/, '');
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const resp = await fetch(serverUrl + path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const text = await resp.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
  if (!resp.ok) {
    throw new Error((data && (data.error || data.message)) || ('HTTP ' + resp.status));
  }
  return data;
}

/** 测试服务器连通性 */
async function testServer() {
  const btn = $('testServerBtn');
  btn.disabled = true;
  btn.textContent = '测试中...';
  try {
    const data = await apiFetch('GET', '/api/health');
    setCloudStatus('连接成功：' + ((data && data.service) || '服务正常'), true);
  } catch (e) {
    setCloudStatus('连接失败：' + String((e && e.message) || e), false);
  } finally {
    btn.disabled = false;
    btn.textContent = '测试连接';
  }
}

/** 注册账户 */
async function registerAccount() {
  const username = $('username').value.trim();
  const password = $('password').value;
  if (!username || !password) {
    setCloudStatus('请填写用户名和密码（密码至少 6 位）', false);
    return;
  }
  try {
    const data = await apiFetch('POST', '/api/register', { username, password });
    applyLogin(data);
    setCloudStatus('注册成功，已自动登录', true);
  } catch (e) {
    setCloudStatus('注册失败：' + String((e && e.message) || e), false);
  }
}

/** 登录账户 */
async function loginAccount() {
  const username = $('username').value.trim();
  const password = $('password').value;
  if (!username || !password) {
    setCloudStatus('请填写用户名和密码', false);
    return;
  }
  try {
    const data = await apiFetch('POST', '/api/login', { username, password });
    applyLogin(data);
    setCloudStatus('登录成功', true);
  } catch (e) {
    setCloudStatus('登录失败：' + String((e && e.message) || e), false);
  }
}

/** 登录 / 注册成功后写入本地 cloud 状态 */
function applyLogin(data) {
  const cloud = state.settings.cloud || {};
  cloud.serverUrl = ($('serverUrl').value || DEFAULT_SERVER_URL).trim();
  cloud.username = (data && data.username) || $('username').value.trim();
  cloud.token = (data && data.token) || '';
  state.settings.cloud = cloud;
  $('password').value = '';
  saveCloud();
  fillCloudForm();
}

/** 退出登录（仅清除本地 token，不清除服务器存档） */
async function logoutAccount() {
  const cloud = state.settings.cloud || {};
  cloud.token = '';
  cloud.autoSync = false;
  state.settings.cloud = cloud;
  $('autoSync').checked = false;
  await saveCloud();
  fillCloudForm();
  setCloudStatus('已退出登录', true);
}

/** 自动同步开关 */
async function onAutoSyncChange() {
  const checked = $('autoSync').checked;
  const cloud = state.settings.cloud || {};
  if (checked && !cloud.token) {
    $('autoSync').checked = false;
    setCloudStatus('请先登录再开启自动同步', false);
    return;
  }
  cloud.autoSync = checked;
  state.settings.cloud = cloud;
  await saveCloud();
  if (checked) {
    setCloudStatus('自动同步已开启，变更后 3 秒自动上传', true);
  } else {
    setCloudStatus('自动同步已关闭', true);
  }
}

/** 去掉 settings 中的 cloud 字段（云存档不上传账户凭据） */
function stripCloud(settings) {
  const copy = Object.assign({}, settings || {});
  delete copy.cloud;
  return copy;
}

/** 上传存档 */
async function uploadSave() {
  const cloud = state.settings.cloud || {};
  if (!cloud.token) throw new Error('未登录');
  const save = {
    phrases: state.phrases,
    absorbed: state.absorbed,
    settings: stripCloud(state.settings),
    aiConfig: state.aiConfig
  };
  await apiFetch('PUT', '/api/save', save, cloud.token);
  return '上传成功（常用语 ' + state.phrases.length + ' 条 · 吸收词 ' + state.absorbed.length + ' 条）';
}

/** 下载存档：服务器存档整体覆盖本地常用语 / 吸收词 / 设置并刷新 */
async function downloadSave() {
  const cloud = state.settings.cloud || {};
  if (!cloud.token) throw new Error('未登录');
  const data = await apiFetch('GET', '/api/save', undefined, cloud.token);
  const save = data && data.save;
  if (!save || !Array.isArray(save.phrases)) throw new Error('服务器存档为空或格式无效');

  syncSuppressUntil = Date.now() + 5000; // 覆盖写入期间暂停自动同步，避免下载后立即回传
  state.phrases = save.phrases.slice();
  state.absorbed = Array.isArray(save.absorbed) ? save.absorbed.slice() : [];
  if (save.settings) {
    const curCloud = state.settings.cloud || {};
    state.settings = Object.assign({}, state.settings, save.settings, { cloud: curCloud });
    state.settings.shortcuts = Object.assign({}, DEFAULT_SHORTCUTS, state.settings.shortcuts || {});
  }
  if (save.aiConfig) state.aiConfig = Object.assign({}, DEFAULT_CONFIG, save.aiConfig);

  await chrome.storage.local.set({ phrases: state.phrases, absorbed: state.absorbed, settings: state.settings, aiConfig: state.aiConfig });
  renderList();
  renderAbsorbed();
  fillConfigForm();
  fillShortcutForm();
  notifyContentRefresh();
  return '下载成功（常用语 ' + state.phrases.length + ' 条 · 吸收词 ' + state.absorbed.length + ' 条）';
}

/** 云操作统一入口：执行并展示状态 */
async function runCloudAction(fn) {
  try {
    const msg = await fn();
    setCloudStatus(msg, true);
  } catch (e) {
    setCloudStatus('操作失败：' + String((e && e.message) || e), false);
  }
}

// ========== 自动同步（防抖 3 秒） ==========

/** 覆盖写入（下载 / 完整备份导入）期间暂停自动同步的截止时间戳 */
let syncSuppressUntil = 0;
let cloudSyncTimer = null;

/** 监听 storage 变更：自动同步开启且已登录时，数据变更后防抖 3 秒上传 */
function bindAutoSyncWatcher() {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    if (Date.now() < syncSuppressUntil) return;
    if (changes.phrases || changes.absorbed || changes.aiConfig || changes.settings) {
      scheduleCloudSync();
    }
  });
}

/** 条件满足时防抖调度上传 */
function scheduleCloudSync() {
  const cloud = state.settings.cloud || {};
  if (!cloud.token || !cloud.autoSync) return;
  clearTimeout(cloudSyncTimer);
  cloudSyncTimer = setTimeout(() => {
    runCloudAction(uploadSave).then((msg) => {
      if (msg && !msg.startsWith('操作失败')) {
        // 静默成功不打扰；失败已由 runCloudAction 展示
      }
    });
  }, 3000);
}

// ========== 通知已打开页面刷新缓存 ==========

/** 通知 background 与所有标签页 content script 刷新缓存 */
async function notifyContentRefresh() {
  try {
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

function stamp() {
  const d = new Date();
  const p = (n) => (n < 10 ? '0' + n : String(n));
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

function formatTime(ts) {
  try {
    return new Date(ts).toLocaleString('zh-CN', { hour12: false });
  } catch (e) {
    return '';
  }
}
