// content.js — 内容脚本
// 职责：监听 focusin 检测可输入控件，采集上下文信号，向 background 请求 AI 推荐；
//       用 Shadow DOM 渲染轻量浮层，点击候选词以原生 setter 填入并触发 input/change 事件。

(() => {
  'use strict';

  // ========== 配置 ==========
  const DEBOUNCE_MS = 400;      // 输入防抖时间
  const MAX_CANDIDATES = 2;     // 浮层最大候选数
  const LOCAL_TOP_N = 2;        // 本地降级匹配 top N
  const MAX_PARENT_TEXT = 120;  // 父级上下文文本最大截断长度

  // ========== 状态 ==========
  let activeElement = null;     // 当前聚焦的输入控件
  let debounceTimer = null;     // 防抖定时器
  let phrasesCache = [];        // 常用语缓存
  let overlayHost = null;       // Shadow DOM 宿主
  let overlayRoot = null;       // Shadow Root
  let overlayEl = null;         // 浮层容器
  let overlayManual = null;     // 手动拖拽位置 {left, top}；非 null 时浮层不自动跟随输入框
  let dragState = null;         // 拖拽中状态 {startX, startY, origLeft, origTop}

  // ========== 缓存初始化与刷新 ==========
  loadPhrases();

  async function loadPhrases() {
    try {
      const data = await chrome.storage.local.get(['phrases']);
      phrasesCache = Array.isArray(data.phrases) ? data.phrases : [];
    } catch (e) {
      console.warn('[QuickPhraseAI] load phrases failed:', e);
    }
  }

  // storage 变化实时刷新缓存（popup 保存后无需等通知即可生效）
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && changes.phrases) {
      phrasesCache = Array.isArray(changes.phrases.newValue) ? changes.phrases.newValue : [];
    }
  });

  // 显式通知刷新（popup 保存后 sendMessage）
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message && message.type === 'PHRASES_UPDATED') {
      loadPhrases().then(() => sendResponse({ ok: true }));
      return true;
    }
  });

  // ========== 可输入控件识别 ==========
  // 只检测通用文本输入，排除带 datalist 的原生选择菜单输入框（避免浮层遮挡其下拉菜单）
  const INPUT_SELECTOR = [
    'input[type="text"]:not([list])',
    'input[type="search"]:not([list])',
    'input:not([type]):not([list])',
    'textarea',
    '[contenteditable="true"]'
  ].join(',');

  /**
   * 识别可输入控件宿主：直接命中 input/textarea/contenteditable；
   * 若 target 是 contenteditable 内部子元素（如 div>span），向上找最近宿主。
   * 用 isContentEditable 判断，兼容 contenteditable="" 与 plaintext-only。
   */
  function findEditableHost(el) {
    if (!el || !el.isConnected) return null;
    if (el.matches && el.matches(INPUT_SELECTOR)) return el;
    const ce = el.closest && el.closest('[contenteditable]');
    if (ce && ce.isContentEditable) return ce;
    return null;
  }

  // focusin：进入输入控件时触发推荐
  document.addEventListener('focusin', (e) => {
    const host = findEditableHost(e.target);
    if (!host) return;
    activeElement = host;
    console.debug('[QuickPhraseAI] focusin editable:', host.tagName, host.type || '', host.getAttribute('contenteditable') || '');
    scheduleSuggest();
  });

  // focusout：失焦延迟关闭浮层（延迟避免点击候选词时误关）
  document.addEventListener('focusout', () => {
    setTimeout(hideOverlay, 200);
  });

  // 输入防抖：keyup / input 均触发（contenteditable 内部输入时 target 是子元素，用 contains 兼容）
  document.addEventListener('keyup', (e) => {
    if (activeElement && (e.target === activeElement || activeElement.contains(e.target))) scheduleSuggest();
  }, true);

  document.addEventListener('input', (e) => {
    if (activeElement && (e.target === activeElement || activeElement.contains(e.target))) scheduleSuggest();
  }, true);

  // Esc 关闭浮层
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideOverlay();
  }, true);

  // 点击外部关闭：浮层内部点击不关闭（composedPath 可穿透 Shadow DOM 判断）
  document.addEventListener('click', (e) => {
    if (overlayEl && e.composedPath().includes(overlayEl)) return;
    hideOverlay();
  }, true);

  // 拖拽中：移动浮层，限制在视口内
  document.addEventListener('mousemove', (e) => {
    if (!dragState) return;
    const maxLeft = Math.max(window.innerWidth - overlayEl.offsetWidth, 0);
    const maxTop = Math.max(window.innerHeight - overlayEl.offsetHeight, 0);
    const left = Math.min(Math.max(dragState.origLeft + (e.clientX - dragState.startX), 0), maxLeft);
    const top = Math.min(Math.max(dragState.origTop + (e.clientY - dragState.startY), 0), maxTop);
    overlayEl.style.left = left + 'px';
    overlayEl.style.top = top + 'px';
  });

  // 拖拽结束：锁定手动位置，不再自动跟随输入框
  document.addEventListener('mouseup', () => {
    if (!dragState) return;
    const rect = overlayEl.getBoundingClientRect();
    overlayManual = { left: rect.left, top: rect.top };
    dragState = null;
  });

  // 滚动 / 缩放时重定位浮层
  window.addEventListener('scroll', repositionOverlay, true);
  window.addEventListener('resize', repositionOverlay);

  function scheduleSuggest() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(collectAndSuggest, DEBOUNCE_MS);
  }

  // ========== 上下文信号采集 ==========
  function collectContext(el) {
    return {
      inputValue: getInputValue(el),
      placeholder: el.getAttribute('placeholder') || '',
      ariaLabel: el.getAttribute('aria-label') || '',
      label: findLabel(el),
      nameId: [el.name, el.id].filter(Boolean).join('/'),
      parentText: getParentText(el),
      elementType: getElementType(el)
    };
  }

  function getInputValue(el) {
    if (el.isContentEditable) return (el.innerText || '').trim();
    return (el.value || '').trim();
  }

  function getElementType(el) {
    if (el.tagName === 'TEXTAREA') return 'textarea';
    if (el.tagName === 'INPUT') return 'input[type=' + el.type + ']';
    if (el.isContentEditable) return 'contenteditable';
    return el.tagName.toLowerCase();
  }

  /** 关联 label 文本：for= / 包裹 / aria-labelledby 三种方式 */
  function findLabel(el) {
    if (el.id) {
      try {
        const forLabel = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
        if (forLabel) return (forLabel.innerText || '').trim();
      } catch (e) { /* 非法 id 选择器忽略 */ }
    }
    const wrap = el.closest && el.closest('label');
    if (wrap) return (wrap.innerText || '').trim();

    const labelledby = el.getAttribute('aria-labelledby');
    if (labelledby) {
      const texts = labelledby.split(/\s+/).map((id) => {
        const node = document.getElementById(id);
        return node ? ((node.innerText || node.textContent || '').trim()) : '';
      }).filter(Boolean);
      if (texts.length) return texts.join(' ');
    }
    return '';
  }

  /** 父级 2~3 层直接文本（避免深层重复），截断到 MAX_PARENT_TEXT */
  function getParentText(el) {
    const texts = [];
    let node = el.parentElement;
    for (let depth = 0; node && depth < 3; depth++) {
      let t = '';
      for (const child of node.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) t += (child.nodeValue || '');
      }
      t = t.trim();
      if (t) texts.push(t);
      node = node.parentElement;
    }
    return texts.join(' | ').slice(0, MAX_PARENT_TEXT);
  }

  // ========== 本地优先匹配；无命中才调用 AI ==========
  async function collectAndSuggest() {
    if (!activeElement || !activeElement.isConnected) return;

    const context = collectContext(activeElement);

    // 无任何场景信号（输入值/占位符/标签/上下文文本均空）时不弹浮层，避免对无关输入框打扰
    const hasSignal = [
      context.inputValue, context.placeholder, context.ariaLabel,
      context.label, context.nameId, context.parentText
    ].some(Boolean);
    if (!hasSignal) {
      hideOverlay();
      return;
    }

    // 第一步：本地快速匹配（毫秒级，不依赖网络）
    const localCandidates = localMatch(context);
    if (localCandidates.length > 0) {
      console.debug('[QuickPhraseAI] local match hit, skip AI');
      showOverlay(localCandidates, true, '本地匹配');
      return;
    }

    // 第二步：本地无命中，才调用 AI（等待期间先展示 loading，避免“没反应”）
    const payload = {
      context,
      phrases: phrasesCache.map((p) => ({ id: p.id, text: p.text, tag: p.tag || '' }))
    };
    showLoadingOverlay();

    let result = null;
    try {
      console.debug('[QuickPhraseAI] send AI_SUGGEST, context:', context);
      result = await chrome.runtime.sendMessage({ type: 'AI_SUGGEST', payload });
    } catch (e) {
      console.warn('[QuickPhraseAI] sendMessage failed:', e);
      result = { fallback: true };
    }

    let candidates = [];
    let isFallback = true;
    if (result && !result.fallback && Array.isArray(result.candidates) && result.candidates.length > 0) {
      candidates = result.candidates.slice(0, MAX_CANDIDATES);
      isFallback = false;
    }

    if (candidates.length > 0) {
      showOverlay(candidates, isFallback);
    } else if (phrasesCache.length > 0) {
      // AI 无结果且本地无命中：兜底展示按 tag 分组排序的前 3 条常用语，保证有候选可点
      console.debug('[QuickPhraseAI] AI empty, fallback to top phrases');
      showOverlay(fallbackTopPhrases(), true);
    } else {
      // 常用语列表为空：展示引导提示而非静默无反应
      console.debug('[QuickPhraseAI] no phrases, show empty hint');
      showEmptyOverlay();
    }
  }

  function showLoadingOverlay() {
    ensureOverlay();
    overlayEl.innerHTML = '';
    const banner = document.createElement('div');
    banner.className = 'qpa-banner';
    banner.textContent = 'AI 推荐中...';
    overlayEl.appendChild(banner);
    showAndPosition();
  }

  /** 兜底候选：有 tag 的常用语优先，组内按 createdAt 新→旧，取前 LOCAL_TOP_N 条 */
  function fallbackTopPhrases() {
    const byTime = (a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
    const tagged = phrasesCache.filter((p) => p.tag).sort(byTime);
    const untagged = phrasesCache.filter((p) => !p.tag).sort(byTime);
    return tagged.concat(untagged).slice(0, LOCAL_TOP_N)
      .map((p) => ({ phraseId: p.id, reason: '常用语' }));
  }

  /**
   * 本地关键词匹配：以上下文信号分词，与常用语 text+tag 做包含匹配打分，
   * tag 命中加权，取 top 3。
   */
  function localMatch(context) {
    const keywordStr = [
      context.inputValue,
      context.placeholder,
      context.ariaLabel,
      context.label,
      context.nameId,
      context.parentText
    ].filter(Boolean).join(' ').toLowerCase();

    const scored = phrasesCache.map((p) => {
      const haystack = (p.text + ' ' + (p.tag || '')).toLowerCase();
      let score = 0;
      for (const raw of keywordStr.split(/\s+/)) {
        const word = raw.replace(/[^\w\u4e00-\u9fa5]/g, '').toLowerCase();
        if (!word) continue;
        if (haystack.includes(word)) score += word.length;
      }
      if (p.tag && keywordStr.includes(p.tag.toLowerCase())) score += 10;
      return { phraseId: p.id, score };
    });

    return scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, LOCAL_TOP_N)
      .map((s) => ({ phraseId: s.phraseId, reason: '本地匹配' }));
  }

  // ========== Shadow DOM 浮层 ==========
  function ensureOverlay() {
    if (overlayRoot) return;

    overlayHost = document.createElement('div');
    overlayHost.id = 'quick-phrase-ai-host';
    // fixed + 视口原点：浮层坐标系与视口一致，避免文档偏移导致渲染到视口外
    overlayHost.style.cssText = 'all:initial;position:fixed;top:0;left:0;width:0;height:0;display:block;z-index:2147483647;';
    (document.body || document.documentElement).appendChild(overlayHost);

    overlayRoot = overlayHost.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = [
      ':host { all: initial; }',
      '.qpa-overlay {',
      '  position: absolute; width: 300px; max-height: 260px; overflow-y: auto;',
      '  background: #ffffff; border: 1px solid #e3e6eb; border-radius: 8px;',
      '  box-shadow: 0 4px 16px rgba(0,0,0,0.15);',
      '  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;',
      '  font-size: 13px; color: #1f2329; display: none; box-sizing: border-box; padding: 4px 0;',
      '}',
      '.qpa-banner {',
      '  padding: 6px 12px; font-size: 11px; color: #86909c;',
      '  border-bottom: 1px solid #f2f3f5; background: #fafafa;',
      '  cursor: move; user-select: none;',
      '}',
      '.qpa-empty {',
      '  padding: 14px 12px; text-align: center; color: #86909c; font-size: 12px;',
      '}',
      '.qpa-item { padding: 8px 12px; cursor: pointer; border-bottom: 1px solid #f7f8fa; }',
      '.qpa-item:last-child { border-bottom: none; }',
      '.qpa-item:hover { background: #f0f5ff; }',
      '.qpa-text { font-size: 13px; color: #1f2329; word-break: break-all; white-space: pre-wrap; }',
      '.qpa-meta {',
      '  font-size: 11px; color: #86909c; margin-top: 2px;',
      '  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;',
      '}'
    ].join('\n');
    overlayRoot.appendChild(style);

    overlayEl = document.createElement('div');
    overlayEl.className = 'qpa-overlay';
    // 拖拽启动：按住顶部 banner 拖动浮层（事件委托，banner 每次渲染重建也能命中）
    overlayEl.addEventListener('mousedown', (e) => {
      const banner = e.target.closest && e.target.closest('.qpa-banner');
      if (!banner) return;
      e.preventDefault();
      const rect = overlayEl.getBoundingClientRect();
      dragState = { startX: e.clientX, startY: e.clientY, origLeft: rect.left, origTop: rect.top };
    });
    overlayRoot.appendChild(overlayEl);
  }

  function showOverlay(candidates, isFallback, bannerText) {
    ensureOverlay();

    overlayEl.innerHTML = '';

    const banner = document.createElement('div');
    banner.className = 'qpa-banner';
    banner.textContent = bannerText || (isFallback ? 'AI 未配置/不可用，以下为本地匹配' : 'AI 推荐');
    overlayEl.appendChild(banner);

    for (const c of candidates) {
      const phrase = phrasesCache.find((p) => p.id === c.phraseId);
      if (!phrase) continue;

      const item = document.createElement('div');
      item.className = 'qpa-item';

      const main = document.createElement('div');
      main.className = 'qpa-text';
      main.textContent = phrase.text;

      const meta = document.createElement('div');
      meta.className = 'qpa-meta';
      meta.textContent = (phrase.tag || '未分类') + ' · ' + (c.reason || '推荐');

      item.appendChild(main);
      item.appendChild(meta);

      // mousedown 阻止默认行为，避免输入框失焦触发 blur 关闭
      item.addEventListener('mousedown', (e) => e.preventDefault());
      item.addEventListener('click', () => fillPhrase(phrase.text));

      overlayEl.appendChild(item);
    }

    console.debug('[QuickPhraseAI] show overlay, candidates:', candidates.length, 'fallback:', isFallback);
    showAndPosition();
  }

  /** 展示提示型浮层（无候选时引导用户添加常用语） */
  function showEmptyOverlay() {
    ensureOverlay();
    overlayEl.innerHTML = '';

    const banner = document.createElement('div');
    banner.className = 'qpa-banner';
    banner.textContent = '快捷常用语';

    const empty = document.createElement('div');
    empty.className = 'qpa-empty';
    empty.textContent = '暂无常用语，请先在扩展弹窗中添加';

    overlayEl.appendChild(banner);
    overlayEl.appendChild(empty);
    showAndPosition();
  }

  /** 显示浮层并重定位 */
  function showAndPosition() {
    overlayEl.style.display = 'block';
    repositionOverlay();
  }

  /**
   * 浮层定位：输入框下方，横向裁入视口内。
   * overlayHost 已固定于视口原点（fixed + top/left:0），
   * 直接使用 getBoundingClientRect 的视口坐标，无需再叠加 scrollX/scrollY。
   */
  function repositionOverlay() {
    if (!overlayEl) return;
    // 手动拖拽后保持用户放置位置，不自动跟随输入框（避免遮挡输入框自带菜单时被拉回）
    if (overlayManual) {
      overlayEl.style.left = overlayManual.left + 'px';
      overlayEl.style.top = overlayManual.top + 'px';
      return;
    }
    if (!activeElement || !activeElement.isConnected) return;

    const rect = activeElement.getBoundingClientRect();
    const left = Math.min(Math.max(rect.left, 4), window.innerWidth - 320);
    const top = Math.max(rect.bottom + 4, 4);
    overlayEl.style.left = left + 'px';
    overlayEl.style.top = top + 'px';
  }

  function hideOverlay() {
    if (overlayEl) overlayEl.style.display = 'none';
    overlayManual = null;
    dragState = null;
  }

  // ========== 填入文本（原生 setter + 事件派发，确保 React/Vue 感知）==========
  function fillPhrase(text) {
    if (!activeElement) return;
    const el = activeElement;

    // contenteditable：选区插入 / 追加
    if (el.isContentEditable) {
      el.focus();
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0) {
        sel.deleteFromDocument();
        const node = document.createTextNode(text);
        sel.getRangeAt(0).insertNode(node);
        sel.getRangeAt(0).collapse(false);
      } else {
        el.innerText = text;
      }
      el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: text }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      hideOverlay();
      return;
    }

    // input / textarea：原生 setter 绕过框架值代理
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;

    const start = el.selectionStart != null ? el.selectionStart : el.value.length;
    const end = el.selectionEnd != null ? el.selectionEnd : el.value.length;
    setter.call(el, el.value.slice(0, start) + text + el.value.slice(end));

    // 派发事件（React 监听 input，Vue 监听 input/change）
    el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));

    // 光标移到插入文本末尾
    try { el.setSelectionRange(start + text.length, start + text.length); } catch (e) { /* 非文本控件忽略 */ }

    hideOverlay();
  }
})();
