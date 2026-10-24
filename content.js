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
  const MIN_ABSORB_LEN = 2;     // 静默吸收词最短长度（字符）
  const MAX_ABSORB_LEN = 50;    // 静默吸收词最长长度（字符）

  // ========== 多标签工具（兼容旧数据单标签字符串） ==========
  /** 标签分隔符：中英文逗号 / 顿号 / 分号 / 空白 */
  const TAG_SEP = /[,，、;；\s]+/;

  /** 将多标签字符串拆分为去重后的标签数组（兼容分隔格式） */
  function splitTags(input) {
    if (Array.isArray(input)) {
      return input.map((t) => String(t || '').trim()).filter(Boolean);
    }
    const raw = String(input || '').trim();
    if (!raw) return [];
    return raw.split(TAG_SEP).map((s) => s.trim()).filter(Boolean);
  }

  /** 获取常用语标签数组：优先 tags 数组，旧数据 tag 字符串按分隔符拆分 */
  function getTags(p) {
    if (!p) return [];
    const list = splitTags(p.tags);
    if (list.length > 0) return list;
    return splitTags(p.tag);
  }

  /** 标签展示文本（顿号连接） */
  function getTagText(p) {
    return getTags(p).join('、');
  }

  // ========== 小型本地匹配 AI：标签模糊匹配引擎（无需外部 API） ==========
  /** Levenshtein 编辑距离（迭代实现，避免递归深度问题） */
  function levenshtein(a, b) {
    const s = String(a || '');
    const t = String(b || '');
    const m = s.length;
    const n = t.length;
    if (!m) return n;
    if (!n) return m;
    let prev = new Array(n + 1);
    let cur = new Array(n + 1);
    for (let j = 0; j <= n; j++) prev[j] = j;
    for (let i = 1; i <= m; i++) {
      cur[0] = i;
      for (let j = 1; j <= n; j++) {
        const cost = s[i - 1] === t[j - 1] ? 0 : 1;
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      }
      const tmp = prev;
      prev = cur;
      cur = tmp;
    }
    return prev[n];
  }

  /**
   * 标签模糊相似度（0~1）：
   * 1) 完全相等 = 1；2) 子串命中（标签含关键词 = 0.9，关键词含标签 = 0.8）；
   * 3) 编辑距离容错（短词 1 字符差异、长词 ≤40% 长度差异，按距离衰减）；
   * 4) 字符重合覆盖度 ≥50% 的部分命中。
   */
  function labelSimilarity(keyword, label) {
    const kw = String(keyword || '').toLowerCase();
    const lb = String(label || '').toLowerCase();
    if (!kw || !lb) return 0;
    if (kw === lb) return 1;
    if (lb.includes(kw)) return 0.9;
    if (kw.includes(lb)) return 0.8;

    const maxLen = Math.max(kw.length, lb.length);
    const dist = levenshtein(kw, lb);
    const threshold = Math.max(1, Math.floor(maxLen * 0.4));
    if (dist > 0 && dist <= threshold) {
      return Math.max(0.1, (1 - dist / maxLen) * 0.7);
    }

    const uniqueKw = new Set(kw.split(''));
    const common = [...uniqueKw].filter((ch) => lb.includes(ch)).length;
    const cover = common / Math.max(uniqueKw.size, 1);
    if (cover >= 0.5) return 0.4 * cover;
    return 0;
  }

  /** 标签集合 × 关键词集合的最优模糊评分（任一标签与任一关键词的最高相似度） */
  function fuzzyTagScore(tags, keywords) {
    let best = 0;
    for (const tag of tags) {
      for (const kw of keywords) {
        const s = labelSimilarity(kw, tag);
        if (s > best) best = s;
      }
    }
    return best;
  }

  // ========== 状态 ==========
  let activeElement = null;     // 当前聚焦的输入控件
  let debounceTimer = null;     // 防抖定时器
  let phrasesCache = [];        // 常用语缓存
  let absorbedCache = [];       // AI 静默吸收词缓存 [{text, tag, count, lastUsed}]
  let overlayHost = null;       // Shadow DOM 宿主
  let overlayRoot = null;       // Shadow Root
  let overlayEl = null;         // 浮层容器
  let overlayManual = null;     // 手动拖拽位置 {left, top}；非 null 时浮层不自动跟随输入框
  let dragState = null;         // 拖拽中状态 {startX, startY, origLeft, origTop}
  let overlayItems = [];        // 当前浮层候选项 [{el, candidate}]
  let selectedIndex = -1;       // 键盘导航高亮索引（-1 表示无高亮）
  let userNavigated = false;    // 用户是否已用 ↑/↓ 切换过高亮（Enter 优先填候选而非补全虚影）
  let ghostEl = null;           // 虚影元素（Shadow DOM 内 .qpa-ghost）
  let ghostCandidate = null;    // 当前虚影候选 {phraseId?, text, tag, reason, absorbCount?}
  let ghostPrefix = '';         // 触发虚影时输入框已输入前缀
  let ghostMeasureCtx = null;   // canvas 2d 上下文（测量输入前缀像素宽度）

  // ========== 缓存初始化与刷新 ==========
  loadPhrases();

  async function loadPhrases() {
    try {
      const data = await chrome.storage.local.get(['phrases', 'absorbed']);
      phrasesCache = Array.isArray(data.phrases) ? data.phrases : [];
      absorbedCache = Array.isArray(data.absorbed) ? data.absorbed : [];
    } catch (e) {
      console.warn('[QuickPhraseAI] load phrases failed:', e);
    }
  }

  // storage 变化实时刷新缓存（popup 保存后无需等通知即可生效）
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    if (changes.phrases) {
      phrasesCache = Array.isArray(changes.phrases.newValue) ? changes.phrases.newValue : [];
    }
    if (changes.absorbed) {
      absorbedCache = Array.isArray(changes.absorbed.newValue) ? changes.absorbed.newValue : [];
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

  // focusout：失焦时静默记录用户输入词（AI 吸收），延迟关闭浮层（避免点击候选词时误关）。
  // 手动拖拽锁定位置后（overlayManual 非 null），失焦也不自动关闭，需点 X / Esc / 选中候选。
  document.addEventListener('focusout', (e) => {
    absorbInputWord(e.target);
    if (overlayManual) {
      hideGhost(); // 手动锁定浮层时浮层保持，但虚影失焦即隐藏
      return;
    }
    setTimeout(hideOverlay, 200);
  });

  /**
   * AI 静默吸收：输入框失焦时，若内容非空且长度 2~50 字符，
   * 静默通知 background 记录该词及使用频次（absorbed 数组）。
   * 吸收词 count 达 2 次以上才会进入候选展示。
   */
  function absorbInputWord(target) {
    const host = findEditableHost(target);
    if (!host) return;
    const text = host.isContentEditable ? (host.innerText || '').trim() : (host.value || '').trim();
    if (text.length < MIN_ABSORB_LEN || text.length > MAX_ABSORB_LEN) return;
    try {
      chrome.runtime.sendMessage({ type: 'ABSORB_WORD', text }).catch(() => {});
    } catch (e) { /* 静默记录失败不影响主流程 */ }
  }

  // 输入防抖：keyup / input 均触发（contenteditable 内部输入时 target 是子元素，用 contains 兼容）
  document.addEventListener('keyup', (e) => {
    if (activeElement && (e.target === activeElement || activeElement.contains(e.target))) scheduleSuggest();
  }, true);

  document.addEventListener('input', (e) => {
    if (activeElement && (e.target === activeElement || activeElement.contains(e.target))) scheduleSuggest();
  }, true);

  // 键盘导航（浮层可见或存在虚影时）：
  // ↑/↓ 切换候选高亮（初始高亮第一项，鼠标悬停同步高亮）；
  // Enter 补全虚影（未用 ↑/↓ 导航过时）；用户导航过则 Enter 填入当前高亮候选；
  // Tab 在虚影存在时补全虚影，否则浮层可见时不移动焦点并填入当前高亮候选；
  // Esc 关闭浮层并清除虚影。
  document.addEventListener('keydown', (e) => {
    const visible = overlayEl && overlayEl.style.display === 'block' && overlayItems.length > 0;
    const ghostVisible = !!ghostCandidate;

    if (e.key === 'Escape') {
      hideOverlay();
      return;
    }

    if (!visible && !ghostVisible) return;

    if (e.key === 'ArrowDown') {
      if (!visible) return;
      e.preventDefault();
      e.stopPropagation();
      userNavigated = true;
      const next = selectedIndex < 0 ? 0 : (selectedIndex + 1) % overlayItems.length;
      applySelected(next);
      return;
    }

    if (e.key === 'ArrowUp') {
      if (!visible) return;
      e.preventDefault();
      e.stopPropagation();
      userNavigated = true;
      const next = selectedIndex < 0 ? overlayItems.length - 1 : (selectedIndex - 1 + overlayItems.length) % overlayItems.length;
      applySelected(next);
      return;
    }

    if (e.key === 'Enter' || e.key === 'Tab') {
      // 虚影优先：Tab 始终补全虚影；Enter 仅在用户未导航过时补全虚影
      const takeGhost = ghostVisible && (e.key === 'Tab' || !userNavigated);
      if (takeGhost) {
        e.preventDefault();
        e.stopPropagation();
        applyGhost();
        return;
      }
      if (!visible) return;
      e.preventDefault();
      e.stopPropagation();
      const idx = selectedIndex < 0 ? 0 : selectedIndex;
      const item = overlayItems[idx];
      if (item) fillCandidate(item.candidate);
    }
  }, true);

  // 点击处理（捕获）：
  // - 浮层内部点击不关闭（composedPath 可穿透 Shadow DOM 判断）；
  // - 点击到可编辑输入框：修复「输入框已聚焦时点击不触发 focusin、浮层不再出现」的 bug——
  //   直接重新调度推荐并保持 activeElement，而不关闭浮层；
  // - 点击外部空白：手动拖拽锁定位置后（overlayManual 非 null）不再自动关闭，
  //   否则关闭浮层。
  document.addEventListener('click', (e) => {
    if (overlayEl && e.composedPath().includes(overlayEl)) return;

    const host = findEditableHost(e.target);
    if (host) {
      activeElement = host;
      const visible = overlayEl && overlayEl.style.display === 'block';
      if (visible && activeElement === host) {
        repositionOverlay(); // 已在同一输入框内点击，仅校正位置
      } else {
        scheduleSuggest();
      }
      return;
    }

    if (overlayManual) return;
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
      hideGhost();
      showOverlay(localCandidates, true, '本地匹配');
      return;
    }

    // 第二步：前缀匹配虚影（输入内容长度 >= 3 且命中常用语/吸收词前缀）。
    // 单行 input 显示虚影（可能性最高的一条），其余同前缀候选进候选框；
    // textarea / contenteditable 不进虚影，前缀匹配结果直接进候选框。
    // 前缀命中即视为本地检索有结果，不调 AI。
    const prefixMatches = prefixMatch(context.inputValue);
    if (prefixMatches && prefixMatches.length > 0) {
      console.debug('[QuickPhraseAI] prefix match hit, skip AI:', prefixMatches.length);
      const isSingleLineInput = activeElement.tagName === 'INPUT' &&
        (activeElement.type === 'text' || activeElement.type === 'search' || !activeElement.type);
      if (isSingleLineInput) {
        showGhost(prefixMatches[0], context.inputValue);
        const rest = prefixMatches.slice(1, MAX_CANDIDATES + 1);
        if (rest.length > 0) {
          showOverlay(rest, true, '前缀匹配');
        } else {
          hideOverlay(); // 仅虚影、无候选框条目时不弹空浮层
        }
      } else {
        showOverlay(prefixMatches.slice(0, MAX_CANDIDATES), true, '前缀匹配');
      }
      return;
    }
    hideGhost();

    // 第三步：前两级本地均无命中，才调用 AI（等待期间先展示 loading，避免“没反应”）
    const payload = {
      context,
      phrases: phrasesCache.map((p) => ({ id: p.id, text: p.text, tag: getTagText(p) }))
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
    // 合并 AI 静默吸收词（count>=2，按 count 降序参与排序），保证高频输入内容优先展示
    candidates = mergeAbsorbed(candidates);

    if (candidates.length > 0) {
      showOverlay(candidates, isFallback);
    } else if (phrasesCache.length > 0 || eligibleAbsorbed().length > 0) {
      // AI 无结果且本地无命中：兜底展示常用语 + 吸收词，保证有候选可点
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
    overlayItems = [];
    selectedIndex = -1;
    overlayEl.appendChild(makeBanner('AI 推荐中...'));
    showAndPosition();
  }

  /** 兜底候选：有 tag 的常用语优先，组内按 createdAt 新→旧，再合并吸收词（count 降序优先），取前 LOCAL_TOP_N 条 */
  function fallbackTopPhrases() {
    const byTime = (a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
    const tagged = phrasesCache.filter((p) => getTags(p).length > 0).sort(byTime);
    const untagged = phrasesCache.filter((p) => getTags(p).length === 0).sort(byTime);
    const phrases = tagged.concat(untagged)
      .map((p) => ({ phraseId: p.id, reason: '常用语' }));
    return mergeAbsorbed(phrases).slice(0, LOCAL_TOP_N);
  }

  /** 可参与候选的吸收词：count >= 2，按 count 降序（频次越高越靠前） */
  function eligibleAbsorbed() {
    return absorbedCache
      .filter((a) => a && a.text && a.count >= 2)
      .sort((a, b) => (b.count || 0) - (a.count || 0));
  }

  /**
   * 合并吸收词候选：吸收词（count 降序）排在 AI/常用语候选之后，
   * 一起截取到 MAX_CANDIDATES；吸收词标记 reason='AI吸收·高频'。
   * 同一网页多账号输入的不同内容，按频繁程度（count）排序展示。
   */
  function mergeAbsorbed(candidates) {
    const absorbed = eligibleAbsorbed()
      .map((a) => ({ text: a.text, tag: '', reason: 'AI吸收·高频', absorbCount: a.count || 0 }));
    return candidates.concat(absorbed).slice(0, MAX_CANDIDATES);
  }

  /**
   * 本地关键词匹配：以上下文信号分词，与常用语/吸收词 text+tag 做包含匹配打分，
   * tag 命中加权；吸收词同分时按 count 降序（高频优先），取 top LOCAL_TOP_N。
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

    const wordList = keywordStr.split(/\s+/)
      .map((raw) => raw.replace(/[^\w\u4e00-\u9fa5]/g, '').toLowerCase())
      .filter(Boolean);

    const scoreText = (text, tags) => {
      const haystack = (text + ' ' + tags.join(' ')).toLowerCase();
      let score = 0;
      for (const word of wordList) {
        if (!word) continue;
        if (haystack.includes(word)) score += word.length;
      }
      // 标签模糊匹配：小型本地匹配 AI 评分（子串 / 编辑距离容错 / 部分命中），
      // 替代原「keywordStr 精确包含 tag 才 +10」的精准匹配
      const tagScore = fuzzyTagScore(tags, wordList);
      if (tagScore > 0) score += 10 * tagScore;
      return score;
    };

    const scored = [];
    for (const p of phrasesCache) {
      const score = scoreText(p.text, getTags(p));
      if (score > 0) scored.push({ phraseId: p.id, text: p.text, tag: getTagText(p), score, count: 0 });
    }
    // 吸收词参与本地匹配：命中即按 count 降序参与排序（频次高排前面）
    for (const a of eligibleAbsorbed()) {
      const score = scoreText(a.text, '');
      if (score > 0) scored.push({ text: a.text, tag: '', score, count: a.count || 0 });
    }

    return scored
      .sort((a, b) => (b.score - a.score) || (b.count - a.count))
      .slice(0, LOCAL_TOP_N)
      .map((s) => s.phraseId
        ? { phraseId: s.phraseId, reason: '本地匹配' }
        : { text: s.text, tag: '', reason: 'AI吸收·高频', absorbCount: s.count });
  }

  // ========== 前缀匹配虚影（微信输入法常用语仿制） ==========
  /**
   * 前缀匹配：输入内容（trim 后）长度 >= 3 时，扫描常用语与吸收词（count>=2），
   * 命中 text.startsWith(inputValue) 的条目。
   * 排序统一：常用语按 useCount 降序 → createdAt 降序，其后吸收词按 count 降序；
   * 返回 null 表示无命中（不进入前缀模式）。
   */
  function prefixMatch(inputValue) {
    const prefix = (inputValue || '').trim();
    if (prefix.length < 3) return null;

    const byUse = (a, b) =>
      (b.useCount || 0) - (a.useCount || 0) ||
      String(b.createdAt || '').localeCompare(String(a.createdAt || ''));

    const phraseMatches = phrasesCache
      .filter((p) => p && p.text && p.text.startsWith(prefix))
      .sort(byUse)
      .map((p) => ({ phraseId: p.id, text: p.text, tag: getTagText(p), reason: '前缀匹配' }));

    const absorbMatches = eligibleAbsorbed()
      .filter((a) => a.text && a.text.startsWith(prefix))
      .sort((a, b) => (b.count || 0) - (a.count || 0))
      .map((a) => ({ text: a.text, tag: '', reason: 'AI吸收·高频', absorbCount: a.count || 0 }));

    const all = phraseMatches.concat(absorbMatches);
    return all.length > 0 ? all : null;
  }

  /** canvas 测量输入前缀的像素宽度（font 用输入框计算样式，保证与渲染一致） */
  function measureTextWidth(text, font) {
    if (!ghostMeasureCtx) {
      ghostMeasureCtx = document.createElement('canvas').getContext('2d');
    }
    if (font) ghostMeasureCtx.font = font;
    return ghostMeasureCtx.measureText(text || '').width;
  }

  /**
   * 显示虚影：仅单行 input。虚影文本 = 完整常用语减去已输入前缀的剩余部分，
   * 起点 = 输入框 rect 左上角 + border-left + padding-left + 前缀像素宽度 - scrollLeft。
   */
  function showGhost(candidate, prefix) {
    ensureOverlay();
    const el = activeElement;
    if (!el || el.tagName !== 'INPUT') return;

    const computed = getComputedStyle(el);
    ghostEl.textContent = String(candidate.text || '').slice(String(prefix || '').length);
    ghostEl.style.font = computed.font || '13px sans-serif';
    ghostCandidate = candidate;
    ghostPrefix = String(prefix || '').trim();
    positionGhost();
    ghostEl.style.display = 'block';
  }

  /** 虚影定位：跟随输入框（滚动 / 拖拽浮层 / 输入内容变化时调用） */
  function positionGhost() {
    if (!ghostCandidate || !activeElement || !activeElement.isConnected) return;
    const el = activeElement;
    const computed = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    const borderLeft = parseFloat(computed.borderLeftWidth) || 0;
    const paddingLeft = parseFloat(computed.paddingLeft) || 0;
    const borderTop = parseFloat(computed.borderTopWidth) || 0;
    const paddingTop = parseFloat(computed.paddingTop) || 0;
    const prefixWidth = measureTextWidth(ghostPrefix, computed.font);

    ghostEl.style.left = Math.max(rect.left + borderLeft + paddingLeft + prefixWidth - el.scrollLeft, 0) + 'px';
    ghostEl.style.top = Math.max(rect.top + borderTop + paddingTop, 0) + 'px';
  }

  /** 隐藏虚影 */
  function hideGhost() {
    if (ghostEl) ghostEl.style.display = 'none';
    ghostCandidate = null;
    ghostPrefix = '';
  }

  /** 补全虚影：填入完整常用语（已输入前缀 + 虚影剩余），等效微信输入法 Tab/Enter 补全 */
  function applyGhost() {
    if (!ghostCandidate) return;
    const text = ghostCandidate.text;
    const phraseId = ghostCandidate.phraseId || null;
    hideGhost();
    fillPhrase(text, phraseId);
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
      '.qpa-ghost {',
      '  position: fixed; top: 0; left: 0; pointer-events: none;',
      '  color: #c0c4cc; white-space: pre; display: none;',
      '  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;',
      '  z-index: 1;',
      '}',
      '.qpa-overlay {',
      '  position: absolute; width: 300px; max-height: 260px; overflow-y: auto;',
      '  background: #ffffff; border: 1px solid #e3e6eb; border-radius: 8px;',
      '  box-shadow: 0 4px 16px rgba(0,0,0,0.15);',
      '  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;',
      '  font-size: 13px; color: #1f2329; display: none; box-sizing: border-box; padding: 4px 0;',
      '}',
      '.qpa-banner {',
      '  display: flex; align-items: center; justify-content: space-between; gap: 8px;',
      '  padding: 6px 12px; font-size: 11px; color: #86909c;',
      '  border-bottom: 1px solid #f2f3f5; background: #fafafa;',
      '  user-select: none;',
      '}',
      '.qpa-banner-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: move; }',
      '.qpa-close {',
      '  flex-shrink: 0; width: 16px; height: 16px; line-height: 16px; text-align: center;',
      '  border-radius: 4px; color: #86909c; cursor: pointer; font-size: 12px;',
      '}',
      '.qpa-close:hover { background: #ffeceb; color: #f53f3f; }',
      '.qpa-empty {',
      '  padding: 14px 12px; text-align: center; color: #86909c; font-size: 12px;',
      '}',
      '.qpa-item { padding: 8px 12px; cursor: pointer; border-bottom: 1px solid #f7f8fa; }',
      '.qpa-item:last-child { border-bottom: none; }',
      '.qpa-item:hover { background: #f0f5ff; }',
      '.qpa-item-selected { background: #e8f0fe; }',
      '.qpa-text { font-size: 13px; color: #1f2329; word-break: break-all; white-space: pre-wrap; }',
      '.qpa-meta {',
      '  font-size: 11px; color: #86909c; margin-top: 2px;',
      '  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;',
      '}'
    ].join('\n');
    overlayRoot.appendChild(style);

    // 虚影元素：独立于候选浮层，位于浮层下层（z-index:1），不拦截点击
    ghostEl = document.createElement('div');
    ghostEl.className = 'qpa-ghost';
    overlayRoot.appendChild(ghostEl);

    overlayEl = document.createElement('div');
    overlayEl.className = 'qpa-overlay';
    // 拖拽启动：按住顶部 banner 标题区拖动浮层（事件委托，banner 每次渲染重建也能命中）。
    // 仅 .qpa-banner-title 可拖动，点右侧 X 不会触发拖拽。
    overlayEl.addEventListener('mousedown', (e) => {
      const title = e.target.closest && e.target.closest('.qpa-banner-title');
      if (!title) return;
      e.preventDefault();
      const rect = overlayEl.getBoundingClientRect();
      dragState = { startX: e.clientX, startY: e.clientY, origLeft: rect.left, origTop: rect.top };
    });
    overlayRoot.appendChild(overlayEl);
  }

  function showOverlay(candidates, isFallback, bannerText) {
    ensureOverlay();

    overlayEl.innerHTML = '';
    overlayItems = [];
    selectedIndex = -1;
    userNavigated = false;

    overlayEl.appendChild(makeBanner(bannerText || (isFallback ? 'AI 未配置/不可用，以下为本地匹配' : 'AI 推荐')));

    for (const c of candidates) {
      // 吸收词候选自带 text；常用语候选从 phrasesCache 取 text/tag
      const phrase = c.phraseId ? phrasesCache.find((p) => p.id === c.phraseId) : null;
      if (c.phraseId && !phrase) continue;
      const text = phrase ? phrase.text : c.text;
      if (!text) continue;
      const tag = phrase ? (getTagText(phrase) || '未分类') : 'AI吸收';

      const item = document.createElement('div');
      item.className = 'qpa-item';

      const main = document.createElement('div');
      main.className = 'qpa-text';
      main.textContent = text;

      const meta = document.createElement('div');
      meta.className = 'qpa-meta';
      meta.textContent = tag + ' · ' + (c.reason || '推荐') + (c.absorbCount ? '（' + c.absorbCount + '次）' : '');

      item.appendChild(main);
      item.appendChild(meta);

      // mousedown 阻止默认行为，避免输入框失焦触发 blur 关闭
      item.addEventListener('mousedown', (e) => e.preventDefault());
      item.addEventListener('click', () => fillCandidate(c));

      const itemIndex = overlayItems.length;
      // 鼠标悬停同步键盘高亮（按当前项索引）
      item.addEventListener('mouseover', () => applySelected(itemIndex));

      overlayItems.push({ el: item, candidate: c });
      overlayEl.appendChild(item);
    }

    // 初始高亮第一项，便于 Enter/Tab 直接选择
    if (overlayItems.length > 0) applySelected(0);

    console.debug('[QuickPhraseAI] show overlay, candidates:', candidates.length, 'fallback:', isFallback);
    showAndPosition();
  }

  /** 更新键盘/悬停高亮索引（-1 清除所有高亮） */
  function applySelected(index) {
    if (!overlayItems.length) return;
    const safe = Math.max(0, Math.min(index, overlayItems.length - 1));
    overlayItems.forEach((item, i) => {
      item.el.classList.toggle('qpa-item-selected', i === safe);
    });
    selectedIndex = safe;
  }

  /** 展示提示型浮层（无候选时引导用户添加常用语） */
  function showEmptyOverlay() {
    ensureOverlay();
    overlayEl.innerHTML = '';
    overlayItems = [];
    selectedIndex = -1;

    overlayEl.appendChild(makeBanner('快捷常用语'));

    const empty = document.createElement('div');
    empty.className = 'qpa-empty';
    empty.textContent = '暂无常用语，请先在扩展弹窗中添加';

    overlayEl.appendChild(empty);
    showAndPosition();
  }

  /**
   * 构造浮层顶部 banner：flex 布局，左侧可拖动文字，右侧 X 关闭按钮。
   * X 的 mousedown 不触发拖拽（仅 .qpa-banner-title 区域可拖动）。
   */
  function makeBanner(titleText) {
    const banner = document.createElement('div');
    banner.className = 'qpa-banner';

    const title = document.createElement('span');
    title.className = 'qpa-banner-title';
    title.textContent = titleText || '快捷常用语';

    const close = document.createElement('span');
    close.className = 'qpa-close';
    close.textContent = '✕';
    close.title = '关闭（Esc）';
    close.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation(); // 阻止冒泡到 overlayEl 的拖拽 mousedown
    });
    close.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      hideOverlay();
    });

    banner.appendChild(title);
    banner.appendChild(close);
    return banner;
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
      positionGhost();
      return;
    }
    if (!activeElement || !activeElement.isConnected) return;

    const rect = activeElement.getBoundingClientRect();
    const left = Math.min(Math.max(rect.left, 4), window.innerWidth - 320);
    const top = Math.max(rect.bottom + 4, 4);
    overlayEl.style.left = left + 'px';
    overlayEl.style.top = top + 'px';
    positionGhost();
  }

  function hideOverlay() {
    if (overlayEl) overlayEl.style.display = 'none';
    overlayManual = null;
    dragState = null;
    overlayItems = [];
    selectedIndex = -1;
    userNavigated = false;
    hideGhost();
  }

  // ========== 候选选中（吸收词先询问是否入库，再统一填入）==========
  /**
   * 选中候选：AI 吸收词（reason='AI吸收·高频'）先 confirm 询问是否加入常用语；
   * 确认则通知 background 写入常用语库并刷新缓存，取消则仅填充不入库。
   * 随后统一调用 fillPhrase 填入文本。
   */
  function fillCandidate(c) {
    if (!c) return;
    const text = c.phraseId ? (phrasesCache.find((p) => p.id === c.phraseId) || {}).text : c.text;
    if (!text) return;

    if (c.reason === 'AI吸收·高频') {
      const ok = window.confirm('是否将「' + text + '」加入常用语？');
      if (ok) {
        try {
          chrome.runtime.sendMessage({ type: 'ADD_ABSORB_TO_PHRASES', text })
            .then((res) => {
              if (res && res.ok) loadPhrases(); // 常用语库已更新，刷新本地缓存
            })
            .catch(() => {});
        } catch (e) { /* 忽略 */ }
      }
    }

    fillPhrase(text, c.phraseId || null);
  }

  // ========== 填入文本（原生 setter + 事件派发，确保 React/Vue 感知）==========
  function fillPhrase(text, phraseId) {
    if (!activeElement) return;
    const el = activeElement;

    // 常用语被使用：异步上报 background 累加 useCount（旧数据无 useCount 字段时按 0 起步）
    if (phraseId) {
      try {
        chrome.runtime.sendMessage({ type: 'PHRASE_USED', phraseId })
          .then((res) => {
            if (res && res.ok) loadPhrases(); // 使用计数已更新，刷新本地缓存
          })
          .catch(() => {});
      } catch (e) { /* 忽略 */ }
    }

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
