// background.js — Service Worker
// 职责：接收 content.js 的 AI_SUGGEST 请求，调用 AI API 获取候选词并做容错解析；
//       接收 PHRASES_UPDATED 通知刷新常用语缓存。

'use strict';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

// 常用语 / AI 配置缓存（PHRASES_UPDATED 时刷新）
let phrasesCache = [];
let aiConfigCache = null;

reloadCache();
chrome.runtime.onInstalled.addListener(reloadCache);
chrome.runtime.onStartup && chrome.runtime.onStartup.addListener(reloadCache);

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

// ========== 消息入口 ==========
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return;

  // AI 推荐请求：异步处理，保持消息通道开启
  if (message.type === 'AI_SUGGEST') {
    handleAISuggest(message.payload || {}).then(sendResponse);
    return true;
  }

  // 常用语更新通知：刷新缓存后回执
  if (message.type === 'PHRASES_UPDATED') {
    reloadCache().then(() => sendResponse({ ok: true }));
    return true;
  }

  // AI 连通性测试：异步处理，保持消息通道开启
  if (message.type === 'AI_TEST') {
    handleAITest().then(sendResponse);
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
    ? phrases.map((p, i) => (i + 1) + '. [id=' + p.id + '] text=' + p.text + ' tag=' + (p.tag || '')).join('\n')
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
