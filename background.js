// background.js — Service Worker
// 职责：接收 content.js 的 AI_SUGGEST 请求，调用 AI API 获取候选词并做容错解析；
//       接收 PHRASES_UPDATED 通知刷新常用语缓存；
//       接收 AI_EXTRACT_PHRASES 从自由文本提取常用语（导入入口，未配置时降级按行拆分）；
//       接收 ABSORB_WORD 静默记录用户高频词（AI 吸收）与 ADD_ABSORB_TO_PHRASES 将吸收词入库。

'use strict';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

// 常用语 / AI 配置缓存（PHRASES_UPDATED 时刷新）
let phrasesCache = [];
let aiConfigCache = null;

reloadCache();
ensureDefaultSettings();
chrome.runtime.onInstalled.addListener(() => {
  reloadCache();
  ensureDefaultSettings();
});
chrome.runtime.onStartup && chrome.runtime.onStartup.addListener(() => {
  reloadCache();
  ensureDefaultSettings();
});

/** 从 chrome.storage.local 重新加载缓存 */
async function reloadCache() {
  try {
    const data = await chrome.storage.local.get(['phrases', 'aiConfig']);
    phrasesCache = Array.isArray(data.phrases) ? data.phrases : [];
    aiConfigCache = data.aiConfig || null;
  } catch (e) {
    console.warn('[QuickPhraseAI] reload cache failed:', e);
  }
}

// ========== 默认设置（快捷键与冷却，首次安装/更新时写入，用户已设置项保留） ==========
const DEFAULT_SHORTCUTS = {
  toggleEnabled: 'Alt+Q',        // 切换推荐功能总开关
  manualSuggest: 'Alt+Space',    // 手动触发当前聚焦输入框的推荐
  closeCooldown: 'Alt+X',        // 关闭浮层与虚影并进入冷却
  fillTop: 'Ctrl+Shift+Enter',   // 直接补全最高可能候选/虚影
  select1: 'Alt+1',              // 填入候选框第 1 条候选
  select2: 'Alt+2'               // 填入候选框第 2 条候选
};
const DEFAULT_SETTINGS = {
  shortcuts: DEFAULT_SHORTCUTS,
  cooldownSec: 30,               // 关闭浮层后的冷却秒数，0 表示关闭冷却
  enabled: true                  // 推荐功能总开关
};

/** 合并默认设置写入 storage：只补充缺失项，不覆盖用户自定义值 */
async function ensureDefaultSettings() {
  try {
    const data = await chrome.storage.local.get(['settings']);
    const cur = data.settings || {};
    const shortcuts = Object.assign({}, DEFAULT_SHORTCUTS, cur.shortcuts || {});
    const settings = Object.assign({}, DEFAULT_SETTINGS, cur, { shortcuts });
    await chrome.storage.local.set({ settings });
  } catch (e) {
    console.warn('[QuickPhraseAI] ensure default settings failed:', e);
  }
}

// ========== 消息入口（统一超时兜底 + 保证 sendResponse 被调用） ==========
const MSG_TIMEOUT_MS = 8000; // 异步消息处理超时（8 秒），防止通道悬挂

/**
 * 异步消息处理统一封装：
 * - Promise.race 超时兜底（8 秒后回发 { ok:false, error:'timeout' }）；
 * - .catch 保证 sendResponse 一定被调用（handler 异常时回发错误）；
 * - responded 标志避免重复调用 sendResponse，杜绝"return true 但通道关闭"报错。
 */
function withTimeout(promise, sendResponse) {
  let responded = false;
  const timer = setTimeout(() => {
    done({ ok: false, error: 'timeout' });
  }, MSG_TIMEOUT_MS);

  function done(res) {
    if (responded) return;
    responded = true;
    clearTimeout(timer);
    try { sendResponse(res); } catch (e) { /* 通道已关闭（发送方页面已关），忽略 */ }
  }

  Promise.resolve(promise)
    .then((res) => done(res))
    .catch((err) => done({ ok: false, error: String((err && err.message) || err) }));
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return;

  // AI 推荐请求：异步处理，保持消息通道开启
  if (message.type === 'AI_SUGGEST') {
    withTimeout(handleAISuggest(message.payload || {}), sendResponse);
    return true;
  }

  // 常用语更新通知：刷新缓存后回执
  if (message.type === 'PHRASES_UPDATED') {
    withTimeout(reloadCache().then(() => ({ ok: true })), sendResponse);
    return true;
  }

  // AI 连通性测试：异步处理，保持消息通道开启
  if (message.type === 'AI_TEST') {
    withTimeout(handleAITest(), sendResponse);
    return true;
  }

  // AI 提取常用语：自由文本 -> 常用语列表（不可用时降级按行拆分）
  if (message.type === 'AI_EXTRACT_PHRASES') {
    withTimeout(handleAIExtractPhrases(message.payload || {}), sendResponse);
    return true;
  }

  // AI 静默吸收：输入框失焦时记录用户高频词（absorbed 数组）
  if (message.type === 'ABSORB_WORD') {
    withTimeout(handleAbsorbWord(message.payload || {}), sendResponse);
    return true;
  }

  // 吸收词确认加入常用语库
  if (message.type === 'ADD_ABSORB_TO_PHRASES') {
    withTimeout(handleAddAbsorbToPhrases(message.payload || {}), sendResponse);
    return true;
  }

  // 常用语被使用：累加 useCount（微信输入法常用语仿制的排序依据）
  if (message.type === 'PHRASE_USED') {
    withTimeout(handlePhraseUsed(message.payload || {}), sendResponse);
    return true;
  }
});

// ========== AI 推荐主流程 ==========
async function handleAISuggest(payload) {
  const aiConfig = await readAIConfig();

  // AI 未配置 -> 降级标记，由 content.js 走本地关键词匹配
  if (!aiConfig || !aiConfig.apiKey) {
    return { fallback: true, candidates: [] };
  }

  try {
    const candidates = await requestAICandidates(aiConfig, payload);
    if (Array.isArray(candidates) && candidates.length > 0) {
      return { fallback: false, candidates };
    }
    // AI 返回空候选 -> 降级
    return { fallback: true, candidates: [] };
  } catch (err) {
    console.warn('[QuickPhraseAI] AI request failed:', err);
    return { fallback: true, candidates: [], error: String((err && err.message) || err) };
  }
}

/** 读取 AI 配置 */
async function readAIConfig() {
  try {
    const data = await chrome.storage.local.get(['aiConfig']);
    return data.aiConfig || null;
  } catch (e) {
    return null;
  }
}

/**
 * 规整 baseUrl 为完整的 /chat/completions 地址。
 * 兼容三种输入：根地址、已含 /v1、完整的 /chat/completions。
 */
function normalizeBaseUrl(baseUrl) {
  let url = (baseUrl || DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

  if (/\/chat\/completions$/i.test(url)) return url;           // 已是完整地址
  if (!/\/v\d+$/i.test(url)) url = url + '/v1';               // 补版本段
  return url + '/chat/completions';
}

/** 构造 OpenAI Chat Completions 格式请求并调用 AI API（AbortController 8 秒超时） */
async function requestAICandidates(aiConfig, payload) {
  const { context, phrases } = payload || {};
  const prompt = buildPrompt(context, phrases);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);

  const body = {
    model: aiConfig.model || 'gpt-4o-mini',
    temperature: 0.6,
    max_tokens: 600,
    messages: [
      {
        role: 'system',
        content:
          '你是网页输入场景的智能推荐助手。你会收到用户当前输入框的上下文信号和候选常用语列表。' +
          '你的任务是从常用语列表中挑选最贴合当前场景的 3~5 条，按相关度降序输出，并给出简短推荐理由。'
      },
      { role: 'user', content: prompt }
    ]
  };

  try {
    const resp = await fetch(normalizeBaseUrl(aiConfig.baseUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + aiConfig.apiKey
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    if (!resp.ok) {
      const detail = await safeReadBody(resp);
      throw new Error('AI API HTTP ' + resp.status + ': ' + detail);
    }

    const data = await resp.json();
    const text = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
    return parseCandidates(text);
  } finally {
    clearTimeout(timer);
  }
}

/** 安全读取错误响应体（截断，防止污染日志） */
async function safeReadBody(resp) {
  try {
    const t = await resp.text();
    return t ? t.slice(0, 300) : '';
  } catch (e) {
    return '';
  }
}

/**
 * 组装给 AI 的 prompt：包含输入上下文信号 + 全部常用语（text + tag），
 * 要求返回 3~5 条 JSON 数组 [{"phraseId":"...","reason":"..."}]。
 */
function buildPrompt(context, phrases) {
  const ctx = context || {};
  const list = (Array.isArray(phrases) && phrases.length)
    ? phrases.map((p, i) => (i + 1) + '. [id=' + p.id + '] text=' + p.text + ' tag=' + (Array.isArray(p.tags) && p.tags.length ? p.tags.join('、') : (p.tag || ''))).join('\n')
    : '（暂无常用语）';

  return [
    '请根据当前网页输入场景，从以下常用语中挑选 3~5 条最合适的候选。',
    '',
    '【输入场景上下文】',
    '- 已输入内容: ' + (ctx.inputValue || ''),
    '- placeholder: ' + (ctx.placeholder || ''),
    '- aria-label: ' + (ctx.ariaLabel || ''),
    '- 关联 label: ' + (ctx.label || ''),
    '- 控件 name/id: ' + (ctx.nameId || ''),
    '- 父级上下文文本: ' + (ctx.parentText || ''),
    '- 控件类型: ' + (ctx.elementType || ''),
    '',
    '【全部常用语】',
    list,
    '',
    '要求：只返回 JSON 数组，格式 [{"phraseId":"...","reason":"简短推荐理由"}]，' +
    '按相关度降序输出 3~5 条，不要返回任何其他文字或 markdown。'
  ].join('\n');
}

/**
 * 容错解析 AI 返回的候选数组：
 * 1) 去除 markdown 代码块围栏；2) 截取首个 [ ... ] 区间；3) JSON.parse；
 * 4) 失败时逐行正则兜底提取 phraseId/reason。
 */
function parseCandidates(text) {
  if (!text) return [];
  let cleaned = String(text).trim();

  // 去除 ```json ... ``` 代码块
  const fence = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) cleaned = fence[1].trim();

  // 截取第一个 [ ... ] 数组区间
  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
  if (start !== -1 && end > start) {
    cleaned = cleaned.slice(start, end + 1);
  }

  try {
    const arr = JSON.parse(cleaned);
    if (Array.isArray(arr)) {
      return arr
        .filter((item) => item && typeof item.phraseId === 'string' && typeof item.reason === 'string')
        .slice(0, 5);
    }
  } catch (e) {
    console.warn('[QuickPhraseAI] JSON parse failed, fallback to line scan:', e);
  }

  // 兜底：逐行提取
  const result = [];
  for (const line of String(text).split('\n')) {
    const idMatch = line.match(/"phraseId"\s*:\s*"([^"]+)"/);
    const reasonMatch = line.match(/"reason"\s*:\s*"([^"]+)"/);
    if (idMatch) result.push({ phraseId: idMatch[1], reason: reasonMatch ? reasonMatch[1] : '' });
  }
  return result.slice(0, 5);
}

// ========== AI 连通性测试 ==========

/**
 * 处理 AI_TEST：发起一个最小 Chat Completions 请求验证
 * API Key / baseUrl / model 配置是否可用。
 * 每次直接读取 storage 拿到最新 aiConfig（不走缓存），超时复用 8000ms。
 * 成功返回 { ok: true, latency, model }，失败返回 { ok: false, error }。
 */
async function handleAITest() {
  // 直接读 storage，确保测试的是最新保存的配置（而非旧缓存）
  const aiConfig = await readAIConfig();

  if (!aiConfig || !aiConfig.apiKey) {
    return { ok: false, error: '未配置 API Key' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  const startTime = Date.now();

  // 最小请求体：一条极短 ping 消息，max_tokens 设为 1 节省开销
  const body = {
    model: aiConfig.model || 'gpt-4o-mini',
    max_tokens: 1,
    messages: [{ role: 'user', content: 'ping' }]
  };

  try {
    const resp = await fetch(normalizeBaseUrl(aiConfig.baseUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + aiConfig.apiKey
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    const latency = Date.now() - startTime;

    // 非 2xx：附带 HTTP 状态码和响应摘要，便于定位
    if (!resp.ok) {
      const detail = await safeReadBody(resp);
      return { ok: false, error: 'HTTP ' + resp.status + (detail ? '：' + detail : '') };
    }

    // 成功：返回实测延迟与实际使用的 model
    return { ok: true, latency: latency, model: aiConfig.model || 'gpt-4o-mini' };
  } catch (err) {
    const isTimeout = err && err.name === 'AbortError';
    return {
      ok: false,
      error: isTimeout ? '请求超时（8 秒）' : '网络错误：' + String((err && err.message) || err)
    };
  } finally {
    clearTimeout(timer);
  }
}

// ========== AI 提取常用语（导入入口） ==========

/**
 * 处理 AI_EXTRACT_PHRASES：从自由文本中提取常用语。
 * AI 可用时调用 AI 提取（JSON 字符串数组，保留原文、去重）；
 * AI 未配置 / 请求失败时降级按行拆分（每行一条）。
 * 返回 { fallback, phrases: [{ text, tag }], error? }。
 */
async function handleAIExtractPhrases(payload) {
  const aiConfig = await readAIConfig();
  const text = String((payload && payload.text) || '');
  const lines = text.split('\n').map((s) => s.trim()).filter(Boolean);

  // AI 未配置 / 无 API Key：降级按行拆分
  if (!aiConfig || !aiConfig.apiKey) {
    return { fallback: true, phrases: lines.map((t) => ({ text: t, tag: '' })) };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);

  const body = {
    model: aiConfig.model || 'gpt-4o-mini',
    temperature: 0.3,
    max_tokens: 800,
    messages: [
      {
        role: 'system',
        content:
          '你是常用语整理助手。用户会给你一段自由文本（可能包含多个语义片段）。' +
          '请提取其中可以作为「常用语」使用的短语或句子，保留原文、不要改写，' +
          '去掉重复项后返回 JSON 字符串数组，例如 ["你好","收到，谢谢"]。' +
          '只返回 JSON 数组，不要返回任何其他文字或 markdown。'
      },
      { role: 'user', content: text.slice(0, 4000) }
    ]
  };

  try {
    const resp = await fetch(normalizeBaseUrl(aiConfig.baseUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + aiConfig.apiKey
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    if (!resp.ok) {
      const detail = await safeReadBody(resp);
      throw new Error('AI API HTTP ' + resp.status + ': ' + detail);
    }

    const data = await resp.json();
    const content = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
    const arr = parseTextArray(content);
    if (arr.length > 0) {
      return { fallback: false, phrases: arr.map((t) => ({ text: t, tag: '' })) };
    }
    // AI 未返回有效数组：降级按行拆分
    return { fallback: true, phrases: lines.map((t) => ({ text: t, tag: '' })) };
  } catch (err) {
    console.warn('[QuickPhraseAI] AI extract failed:', err);
    return {
      fallback: true,
      phrases: lines.map((t) => ({ text: t, tag: '' })),
      error: String((err && err.message) || err)
    };
  } finally {
    clearTimeout(timer);
  }
}

/** 容错解析 AI 返回的字符串数组（去除 markdown 围栏、截取 [] 区间、JSON.parse、逐行兜底） */
function parseTextArray(text) {
  if (!text) return [];
  let cleaned = String(text).trim();

  const fence = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) cleaned = fence[1].trim();

  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
  if (start !== -1 && end > start) cleaned = cleaned.slice(start, end + 1);

  try {
    const arr = JSON.parse(cleaned);
    if (Array.isArray(arr)) {
      return arr.filter((x) => typeof x === 'string' && x.trim()).slice(0, 200);
    }
  } catch (e) {
    console.warn('[QuickPhraseAI] text array parse failed, fallback to line scan:', e);
  }

  // 兜底：逐行拆分
  return String(cleaned).split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 200);
}

// ========== AI 静默吸收高频词 ==========

/**
 * 处理 ABSORB_WORD：静默记录用户在输入框写入的词及使用频次。
 * absorbed 数组元素：{ text, tag:'', count, lastUsed }。
 * 同文本再次出现时 count+1；数组上限 500 条（按 lastUsed 保留最近）。
 */
async function handleAbsorbWord(payload) {
  const text = String((payload && payload.text) || '').trim();
  if (!text) return { ok: false, error: 'empty' };

  try {
    const data = await chrome.storage.local.get(['absorbed']);
    const absorbed = Array.isArray(data.absorbed) ? data.absorbed : [];
    const now = Date.now();
    const existing = absorbed.find((a) => a && a.text === text);

    if (existing) {
      existing.count = (existing.count || 0) + 1;
      existing.lastUsed = now;
    } else {
      absorbed.push({ text: text, tag: '', count: 1, lastUsed: now });
    }

    // 按最近使用排序并截断，避免无限膨胀
    absorbed.sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0));
    if (absorbed.length > 500) absorbed.length = 500;

    await chrome.storage.local.set({ absorbed });
    return { ok: true, count: existing ? existing.count : 1 };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/**
 * 处理 ADD_ABSORB_TO_PHRASES：将吸收词加入常用语库。
 * 已存在同文本常用语时忽略（返回 duplicate）；成功则刷新缓存并通知刷新。
 */
async function handleAddAbsorbToPhrases(payload) {
  const text = String((payload && payload.text) || '').trim();
  if (!text) return { ok: false, error: 'empty' };

  try {
    const data = await chrome.storage.local.get(['phrases']);
    const phrases = Array.isArray(data.phrases) ? data.phrases : [];
    const lower = text.toLowerCase();

    if (phrases.some((p) => p && p.text && p.text.toLowerCase() === lower)) {
      return { ok: false, reason: 'duplicate' };
    }

    phrases.push({
      id: 'p_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
      text: text,
      tag: '',
      createdAt: new Date().toISOString()
    });

    await chrome.storage.local.set({ phrases });
    reloadCache();
    // 广播通知（popup 打开时可用于刷新，无监听时无害）
    try { chrome.runtime.sendMessage({ type: 'PHRASES_UPDATED' }); } catch (e) { /* ignore */ }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/**
 * 处理 PHRASE_USED：常用语被填入时将其 useCount +1。
 * 旧数据无 useCount 字段时按 0 起步；storage 更新后自然触发各端缓存刷新。
 * 返回 { ok, useCount }。
 */
async function handlePhraseUsed(payload) {
  const phraseId = String((payload && payload.phraseId) || '');
  if (!phraseId) return { ok: false, error: 'empty' };

  try {
    const data = await chrome.storage.local.get(['phrases']);
    const phrases = Array.isArray(data.phrases) ? data.phrases : [];
    const phrase = phrases.find((p) => p && p.id === phraseId);
    if (!phrase) return { ok: false, error: 'not found' };

    phrase.useCount = (phrase.useCount || 0) + 1;
    await chrome.storage.local.set({ phrases });
    reloadCache();
    return { ok: true, useCount: phrase.useCount };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}
