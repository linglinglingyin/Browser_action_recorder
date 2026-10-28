'use strict';

/* ------------------------------------------------------------------
 * 内容脚本：录制鼠标 / 滚动 / 键盘输入，并在页面内回放
 * ------------------------------------------------------------------ */

(() => {
  if (window.__MRR_ACTIVE__) return;
  window.__MRR_ACTIVE__ = true;

  const HOST_ATTR = 'data-mrr-ui';
  const MOVE_INTERVAL = 24;   // 鼠标移动采样间隔(ms)
  const SCROLL_INTERVAL = 60; // 滚动采样间隔(ms)
  const MAX_TEXT = 5000;

  let mode = 'idle';      // idle | recording | playing
  let rec = null;
  let pb = null;
  let ui = null;
  let listeners = [];
  let flushTimer = null;
  let lastHover = null;
  let lastReport = 0;

  const now = () => performance.now();
  const round = (n) => Math.round(n * 10) / 10;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function send(msg) {
    try {
      const p = chrome.runtime.sendMessage(msg);
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch (e) {
      /* 扩展被重新加载后上下文失效 */
    }
  }

  function fmtTime(sec) {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  }

  /* ============================ DOM 工具 ============================ */

  const cssEscape = (s) =>
    window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/[^\w-]/g, '\\$&');

  function uniqueId(el) {
    if (!el.id) return false;
    if (!/^[A-Za-z][\w:.-]*$/.test(el.id)) return false;
    try {
      return document.querySelectorAll('#' + cssEscape(el.id)).length === 1;
    } catch (e) {
      return false;
    }
  }

  function selectorFor(el) {
    if (!el || el.nodeType !== 1) return null;
    if (el === document.documentElement) return 'html';
    if (el === document.body) return 'body';
    if (uniqueId(el)) return '#' + cssEscape(el.id);

    const parts = [];
    let node = el;
    let depth = 0;
    let partial = false;

    while (node && node.nodeType === 1) {
      if (node === document.body) {
        parts.unshift('body');
        break;
      }
      if (node === document.documentElement) {
        parts.unshift('html');
        break;
      }
      if (uniqueId(node)) {
        parts.unshift('#' + cssEscape(node.id));
        break;
      }
      const tag = node.tagName.toLowerCase();
      let i = 1;
      let sib = node;
      while ((sib = sib.previousElementSibling)) {
        if (sib.tagName === node.tagName) i++;
      }
      parts.unshift(tag + ':nth-of-type(' + i + ')');
      if (++depth >= 12) {
        partial = true;
        break;
      }
      node = node.parentElement;
    }

    if (!parts.length) return null;
    const path = parts.join(' > ');
    return partial && path.indexOf('body') !== 0 && path.indexOf('html') !== 0 ? 'body ' + path : path;
  }

  function q(sel) {
    if (!sel) return null;
    try {
      return document.querySelector(sel);
    } catch (e) {
      return null;
    }
  }

  function drillShadow(el, x, y) {
    let cur = el;
    for (let i = 0; i < 8; i++) {
      if (!cur || !cur.shadowRoot) break;
      const inner = cur.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === cur) break;
      cur = inner;
    }
    return cur;
  }

  function isUiNode(node) {
    return !!(node && node.nodeType === 1 && node.hasAttribute && node.hasAttribute(HOST_ATTR));
  }

  function elementAt(x, y) {
    let list = [];
    try {
      list = document.elementsFromPoint(x, y) || [];
    } catch (e) {
      list = [];
    }
    for (let i = 0; i < list.length; i++) {
      if (isUiNode(list[i])) continue;
      return drillShadow(list[i], x, y);
    }
    const one = document.elementFromPoint(x, y);
    if (one && !isUiNode(one)) return drillShadow(one, x, y);
    return document.body || document.documentElement;
  }

  function focusEl(el) {
    if (!el || typeof el.focus !== 'function') return;
    try {
      el.focus({ preventScroll: true });
    } catch (e) {
      try {
        el.focus();
      } catch (e2) {
        /* ignore */
      }
    }
  }

  /* ============================ 悬浮提示 ============================ */

  function ensureOverlay() {
    if (ui && ui.host && ui.host.isConnected) return ui;

    const host = document.createElement('div');
    host.setAttribute(HOST_ATTR, '1');
    host.style.cssText =
      'all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;';

    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        .wrap{position:fixed;top:18px;right:18px;pointer-events:none;
              font:12px/1 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;}
        .box{display:flex;align-items:center;gap:10px;padding:8px 10px 8px 12px;border-radius:999px;
             background:rgba(18,20,26,.94);color:#fff;border:1px solid rgba(255,255,255,.14);
             box-shadow:0 10px 28px rgba(0,0,0,.38);pointer-events:none;backdrop-filter:blur(8px);}
        .dot{width:8px;height:8px;border-radius:50%;background:#e5484d;flex:0 0 auto;
             animation:pulse 1.2s ease-in-out infinite;}
        .box[data-kind="playing"] .dot{background:#3b82f6;animation-duration:.9s;}
        .title{font-weight:600;letter-spacing:.2px;}
        .meta{color:rgba(255,255,255,.62);font-variant-numeric:tabular-nums;}
        .btn{pointer-events:auto;cursor:pointer;border:0;border-radius:999px;padding:5px 11px;
             font:inherit;background:rgba(255,255,255,.15);color:#fff;}
        .btn:hover{background:rgba(255,255,255,.28);}
        @keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.35;transform:scale(.82)}}
      </style>
      <div class="wrap">
        <div class="box" data-kind="recording">
          <span class="dot"></span>
          <span class="title">录制中</span>
          <span class="meta">00:00 · 0 事件</span>
          <button class="btn" type="button">停止</button>
        </div>
      </div>`;

    (document.body || document.documentElement).appendChild(host);

    const btn = root.querySelector('.btn');
    btn.addEventListener(
      'click',
      (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (mode === 'recording') stopRecording('user');
        else if (mode === 'playing') stopPlayback();
      },
      true
    );

    ui = {
      host,
      root,
      btn,
      boxEl: root.querySelector('.box'),
      titleEl: root.querySelector('.title'),
      metaEl: root.querySelector('.meta'),
      kind: 'recording',
      timer: null
    };
    return ui;
  }

  function showOverlay(kind) {
    const o = ensureOverlay();
    o.kind = kind;
    o.boxEl.dataset.kind = kind;
    o.host.style.display = 'block';
    o.titleEl.textContent = kind === 'recording' ? '录制中' : '回放中';
    o.btn.textContent = kind === 'recording' ? '停止录制' : '停止回放';
    o.metaEl.textContent = kind === 'recording' ? '00:00 · 0 事件' : '准备中…';
    updateOverlay();
    clearInterval(o.timer);
    o.timer = setInterval(updateOverlay, 200);
  }

  function updateOverlay() {
    if (!ui) return;
    if (ui.kind === 'recording') {
      const sec = rec ? Math.floor((now() - rec.t0) / 1000) : 0;
      ui.metaEl.textContent = fmtTime(sec) + ' · ' + (rec ? rec.count : 0) + ' 事件';
    } else if (pb) {
      const pct = pb.total ? Math.round((pb.done / pb.total) * 100) : 0;
      ui.metaEl.textContent = pct + '% · ' + pb.done + '/' + pb.total;
    }
  }

  function hideOverlay() {
    if (!ui) return;
    clearInterval(ui.timer);
    ui.timer = null;
    if (ui.host && ui.host.parentNode) ui.host.parentNode.removeChild(ui.host);
    ui = null;
  }

  /* ============================ 录制 ============================ */

  const KEY_WHITELIST = new Set([
    'Enter', 'Tab', 'Backspace', 'Delete',
    'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
    'Home', 'End', 'PageUp', 'PageDown'
  ]);

  function isUiEvent(e) {
    if (!e) return false;
    if (typeof e.composedPath === 'function') {
      const path = e.composedPath();
      for (let i = 0; i < path.length; i++) {
        if (isUiNode(path[i])) return true;
      }
      return false;
    }
    return isUiNode(e.target);
  }

  function mouseInfo(type, e) {
    const out = {
      type,
      t: Math.round(now() - rec.t0),
      x: round(e.clientX),
      y: round(e.clientY)
    };
    const el = e.target && e.target.nodeType === 1 ? e.target : null;
    if (el) {
      const sel = selectorFor(el);
      if (sel) out.sel = sel;
      const r = el.getBoundingClientRect();
      if (r.width > 1 && r.height > 1) {
        out.rx = Math.round(((e.clientX - r.left) / r.width) * 1000) / 1000;
        out.ry = Math.round(((e.clientY - r.top) / r.height) * 1000) / 1000;
        out.rw = Math.round(r.width);
        out.rh = Math.round(r.height);
      }
    }
    return out;
  }

  function push(ev) {
    if (!rec) return;
    rec.events.push(ev);
    rec.count++;
  }

  function onMove(e) {
    if (mode !== 'recording' || !rec || isUiEvent(e)) return;
    const t = now();
    if (t - rec.lastMove < MOVE_INTERVAL) return;
    rec.lastMove = t;
    push(mouseInfo('move', e));
  }

  function onDown(e) {
    if (mode !== 'recording' || isUiEvent(e)) return;
    push(Object.assign(mouseInfo('down', e), {
      button: e.button,
      buttons: e.buttons,
      detail: e.detail
    }));
  }

  function onUp(e) {
    if (mode !== 'recording' || isUiEvent(e)) return;
    push(Object.assign(mouseInfo('up', e), {
      button: e.button,
      buttons: e.buttons,
      detail: e.detail
    }));
  }

  function onClick(e) {
    if (mode !== 'recording' || isUiEvent(e)) return;
    push(Object.assign(mouseInfo('click', e), {
      button: e.button,
      detail: e.detail
    }));
  }

  function onDblClick(e) {
    if (mode !== 'recording' || isUiEvent(e)) return;
    push(Object.assign(mouseInfo('dblclick', e), {
      button: e.button,
      detail: e.detail
    }));
  }

  function onContext(e) {
    if (mode !== 'recording' || isUiEvent(e)) return;
    push(Object.assign(mouseInfo('contextmenu', e), {
      button: e.button,
      buttons: e.buttons
    }));
  }

  function onWheel(e) {
    if (mode !== 'recording' || isUiEvent(e)) return;
    push({
      type: 'wheel',
      t: Math.round(now() - rec.t0),
      x: round(e.clientX),
      y: round(e.clientY),
      dx: round(e.deltaX),
      dy: round(e.deltaY),
      dm: e.deltaMode
    });
  }

  function onScroll(e) {
    if (mode !== 'recording' || !rec || isUiEvent(e)) return;
    const target = e.target;
    const isWin =
      target === document ||
      target === window ||
      target === document.documentElement ||
      target === document.body;
    const key = isWin ? '__win__' : target;

    const build = () => {
      const t = Math.round(now() - rec.t0);
      if (isWin) {
        return { type: 'scroll', t, x: round(window.scrollX), y: round(window.scrollY), sel: null };
      }
      return {
        type: 'scroll',
        t,
        x: round(target.scrollLeft),
        y: round(target.scrollTop),
        sel: selectorFor(target)
      };
    };

    const t = now();
    let s = rec.scrollState.get(key);
    if (!s) {
      s = { lastEmit: 0, timer: null };
      rec.scrollState.set(key, s);
    }
    if (t - s.lastEmit >= SCROLL_INTERVAL) {
      s.lastEmit = t;
      push(build());
    } else {
      clearTimeout(s.timer);
      s.timer = setTimeout(() => {
        if (mode !== 'recording' || !rec) return;
        s.lastEmit = now();
        push(build());
      }, 110);
    }
  }

  function onKeyDown(e) {
    if (mode !== 'recording' || !rec || isUiEvent(e)) return;
    if (!rec.keys) return;
    const special = KEY_WHITELIST.has(e.key) || e.ctrlKey || e.metaKey || e.altKey;
    if (!special) return;
    if (e.key === 'Escape') return;
    push({
      type: 'key',
      t: Math.round(now() - rec.t0),
      key: e.key,
      code: e.code,
      kc: e.keyCode,
      ctrl: e.ctrlKey,
      shift: e.shiftKey,
      alt: e.altKey,
      meta: e.metaKey,
      sel: e.target && e.target.nodeType === 1 ? selectorFor(e.target) : null
    });
  }

  function textValueOf(el) {
    const tag = el.tagName ? el.tagName.toLowerCase() : '';
    if (tag === 'input' || tag === 'textarea') return String(el.value || '');
    return String(el.innerText || el.textContent || '');
  }

  function onInput(e) {
    if (mode !== 'recording' || !rec || isUiEvent(e) || !rec.keys) return;
    const el = e.target;
    if (!el || el.nodeType !== 1) return;
    const tag = (el.tagName || '').toLowerCase();
    if (tag === 'input') {
      const type = (el.type || 'text').toLowerCase();
      if (['checkbox', 'radio', 'file', 'range', 'color', 'submit', 'button', 'reset'].includes(type)) return;
    } else if (tag !== 'textarea' && !el.isContentEditable) {
      return;
    }
    push({
      type: 'input',
      t: Math.round(now() - rec.t0),
      sel: selectorFor(el),
      value: textValueOf(el).slice(0, MAX_TEXT),
      ss: typeof el.selectionStart === 'number' ? el.selectionStart : null,
      se: typeof el.selectionEnd === 'number' ? el.selectionEnd : null,
      it: e.inputType || 'insertText',
      ce: !!el.isContentEditable
    });
  }

  function onChange(e) {
    if (mode !== 'recording' || !rec || isUiEvent(e) || !rec.keys) return;
    const el = e.target;
    if (!el || el.nodeType !== 1) return;
    const tag = (el.tagName || '').toLowerCase();
    const t = Math.round(now() - rec.t0);
    if (tag === 'select') {
      push({ type: 'select', t, sel: selectorFor(el), value: el.value, idx: el.selectedIndex });
    } else if (tag === 'input' && (el.type === 'checkbox' || el.type === 'radio')) {
      push({ type: 'check', t, sel: selectorFor(el), checked: !!el.checked, value: el.value });
    }
  }

  const L = [];

  function add(target, type, fn, opts) {
    target.addEventListener(type, fn, opts);
    L.push([target, type, fn, opts]);
  }

  function installListeners() {
    add(window, 'mousemove', onMove, { capture: true, passive: true });
    add(window, 'mousedown', onDown, true);
    add(window, 'mouseup', onUp, true);
    add(window, 'click', onClick, true);
    add(window, 'dblclick', onDblClick, true);
    add(window, 'contextmenu', onContext, true);
    add(window, 'wheel', onWheel, { capture: true, passive: true });
    add(window, 'scroll', onScroll, { capture: true, passive: true });
    add(window, 'keydown', onKeyDown, true);
    add(window, 'input', onInput, true);
    add(window, 'change', onChange, true);
  }

  function removeListeners() {
    while (L.length) {
      const [t, ty, fn, o] = L.pop();
      try {
        t.removeEventListener(ty, fn, o);
      } catch (e) {
        /* ignore */
      }
    }
  }

  function flushBatch() {
    if (!rec || !rec.events.length) return;
    const batch = rec.events.splice(0, rec.events.length);
    send({ type: 'EVENTS_BATCH', events: batch });
  }

  function startRecording(options) {
    if (mode === 'playing') stopPlayback();
    if (mode === 'recording') return { ok: true, mode: 'recording' };

    rec = {
      t0: now(),
      events: [],
      count: 0,
      lastMove: 0,
      keys: !(options && options.keys === false),
      scrollState: new Map(),
      meta: {
        initialScroll: { x: Math.round(window.scrollX), y: Math.round(window.scrollY) },
        viewport: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio || 1 },
        url: location.href,
        title: document.title,
        userAgent: navigator.userAgent
      }
    };
    mode = 'recording';
    lastHover = null;
    installListeners();
    showOverlay('recording');
    flushTimer = setInterval(flushBatch, 700);
    return { ok: true, mode: 'recording' };
  }

  function stopRecording(reason) {
    if (mode !== 'recording' || !rec) return { ok: false };
    const r = rec;
    mode = 'idle';
    clearInterval(flushTimer);
    flushTimer = null;
    removeListeners();
    flushBatch();
    send({ type: 'RECORD_STOPPED', reason: reason || 'stop', meta: r.meta });
    hideOverlay();
    rec = null;
    lastHover = null;
    return { ok: true };
  }

  /* ============================ 回放 ============================ */

  function maskFor(button) {
    if (button === 1) return 4;
    if (button === 2) return 2;
    return 1;
  }

  function sizeMatches(ev, r) {
    if (!ev.rw || !ev.rh) return true;
    const dx = Math.abs(r.width - ev.rw) / Math.max(ev.rw, 1);
    const dy = Math.abs(r.height - ev.rh) / Math.max(ev.rh, 1);
    return dx < 0.5 && dy < 0.5;
  }

  function resolvePoint(ev, ensureVisible) {
    let x = ev.x;
    let y = ev.y;
    if (ev.sel && typeof ev.rx === 'number' && typeof ev.ry === 'number') {
      const el = q(ev.sel);
      if (el) {
        let r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0 && sizeMatches(ev, r)) {
          x = r.left + ev.rx * r.width;
          y = r.top + ev.ry * r.height;
          if (ensureVisible && (x < 1 || y < 1 || x > window.innerWidth - 1 || y > window.innerHeight - 1)) {
            try {
              el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
            } catch (e) {
              /* ignore */
            }
            r = el.getBoundingClientRect();
            x = r.left + ev.rx * r.width;
            y = r.top + ev.ry * r.height;
          }
        }
      }
    }
    return {
      x: clamp(x, 0, Math.max(0, window.innerWidth - 1)),
      y: clamp(y, 0, Math.max(0, window.innerHeight - 1))
    };
  }

  function fire(el, type, init) {
    if (!el || !el.isConnected) el = document.body || document.documentElement;
    const base = { bubbles: true, cancelable: true, composed: true, view: window };
    const o = Object.assign(base, init || {});
    let ev;
    if (type.indexOf('pointer') === 0) {
      ev = new PointerEvent(
        type,
        Object.assign(
          { pointerId: 1, pointerType: 'mouse', isPrimary: true, width: 1, height: 1 },
          o
        )
      );
    } else if (type === 'wheel') {
      ev = new WheelEvent(type, o);
    } else {
      ev = new MouseEvent(type, o);
    }
    el.dispatchEvent(ev);
    return ev;
  }

  function fireKey(type, k) {
    const el = document.activeElement || document.body || document.documentElement;
    const init = {
      key: k.key || '',
      code: k.code || '',
      ctrlKey: !!k.ctrl,
      shiftKey: !!k.shift,
      altKey: !!k.alt,
      metaKey: !!k.meta,
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window
    };
    const e = new KeyboardEvent(type, init);
    try {
      Object.defineProperty(e, 'keyCode', { get: () => k.kc || 0 });
      Object.defineProperty(e, 'which', { get: () => k.kc || 0 });
    } catch (err) {
      /* ignore */
    }
    el.dispatchEvent(e);
  }

  function ancestorsOf(el) {
    const arr = [];
    let n = el;
    while (n) {
      arr.push(n);
      n = n.parentElement || (n.parentNode && n.parentNode.host) || null;
    }
    return arr;
  }

  function hoverTo(el, x, y) {
    if (!el || el === lastHover) return;
    const prev = lastHover;
    lastHover = el;
    const base = { clientX: x, clientY: y, bubbles: true, cancelable: true, composed: true, view: window };

    if (prev && prev.isConnected) {
      fire(prev, 'pointerout', Object.assign({}, base, { relatedTarget: el }));
      fire(prev, 'mouseout', Object.assign({}, base, { relatedTarget: el }));
      fire(prev, 'pointerleave', Object.assign({}, base, { bubbles: false, relatedTarget: el }));
      fire(prev, 'mouseleave', Object.assign({}, base, { bubbles: false, relatedTarget: el }));
      // 让祖先容器也能收到 leave（下拉菜单常见）
      const prevAnc = ancestorsOf(prev);
      const nextAnc = new Set(ancestorsOf(el));
      for (const a of prevAnc) {
        if (!nextAnc.has(a) && a !== prev) {
          fire(a, 'mouseleave', Object.assign({}, base, { bubbles: false, relatedTarget: el }));
        }
      }
    }

    const nextAnc = ancestorsOf(el);
    const prevAnc = new Set(prev ? ancestorsOf(prev) : []);
    for (const a of nextAnc) {
      if (!prevAnc.has(a) && a !== el) {
        fire(a, 'mouseenter', Object.assign({}, base, { bubbles: false, relatedTarget: prev }));
      }
    }
    fire(el, 'pointerover', Object.assign({}, base, { relatedTarget: prev }));
    fire(el, 'mouseover', Object.assign({}, base, { relatedTarget: prev }));
    fire(el, 'pointerenter', Object.assign({}, base, { bubbles: false, relatedTarget: prev }));
    fire(el, 'mouseenter', Object.assign({}, base, { bubbles: false, relatedTarget: prev }));
  }

  function applyEvent(ev) {
    if (!ev || !ev.type) return;
    switch (ev.type) {
      case 'move': {
        const p = resolvePoint(ev, false);
        const el = elementAt(p.x, p.y);
        hoverTo(el, p.x, p.y);
        fire(el, 'pointermove', { clientX: p.x, clientY: p.y, buttons: 0, button: -1 });
        fire(el, 'mousemove', { clientX: p.x, clientY: p.y, buttons: 0, button: -1 });
        break;
      }
      case 'down': {
        const p = resolvePoint(ev, true);
        const el = elementAt(p.x, p.y);
        hoverTo(el, p.x, p.y);
        const button = ev.button | 0;
        const buttons = ev.buttons != null ? ev.buttons : maskFor(button);
        fire(el, 'pointerdown', { clientX: p.x, clientY: p.y, button, buttons });
        fire(el, 'mousedown', { clientX: p.x, clientY: p.y, button, buttons, detail: ev.detail || 1 });
        break;
      }
      case 'up': {
        const p = resolvePoint(ev, true);
        const el = elementAt(p.x, p.y);
        const button = ev.button | 0;
        const buttons = ev.buttons != null ? ev.buttons : 0;
        fire(el, 'pointerup', { clientX: p.x, clientY: p.y, button, buttons });
        fire(el, 'mouseup', { clientX: p.x, clientY: p.y, button, buttons, detail: ev.detail || 1 });
        break;
      }
      case 'click': {
        const p = resolvePoint(ev, true);
        const el = elementAt(p.x, p.y);
        hoverTo(el, p.x, p.y);
        focusEl(el);
        fire(el, 'click', {
          clientX: p.x,
          clientY: p.y,
          button: ev.button | 0,
          buttons: 0,
          detail: ev.detail || 1
        });
        break;
      }
      case 'dblclick': {
        const p = resolvePoint(ev, true);
        const el = elementAt(p.x, p.y);
        fire(el, 'dblclick', {
          clientX: p.x,
          clientY: p.y,
          button: ev.button | 0,
          buttons: 0,
          detail: ev.detail || 2
        });
        break;
      }
      case 'contextmenu': {
        const p = resolvePoint(ev, true);
        const el = elementAt(p.x, p.y);
        hoverTo(el, p.x, p.y);
        focusEl(el);
        fire(el, 'contextmenu', {
          clientX: p.x,
          clientY: p.y,
          button: 2,
          buttons: ev.buttons != null ? ev.buttons : 2,
          detail: 1
        });
        break;
      }
      case 'wheel': {
        const p = resolvePoint(ev, false);
        const el = elementAt(p.x, p.y);
        fire(el, 'wheel', {
          clientX: p.x,
          clientY: p.y,
          deltaX: ev.dx || 0,
          deltaY: ev.dy || 0,
          deltaMode: ev.dm || 0,
          button: 0,
          buttons: 0
        });
        break;
      }
      case 'scroll': {
        if (!ev.sel) {
          try {
            window.scrollTo({ top: ev.y, left: ev.x, behavior: 'instant' });
          } catch (e) {
            window.scrollTo(ev.x || 0, ev.y || 0);
          }
        } else {
          const el = q(ev.sel);
          if (el) {
            try {
              el.scrollTo({ top: ev.y, left: ev.x, behavior: 'instant' });
            } catch (e) {
              el.scrollTop = ev.y;
              el.scrollLeft = ev.x;
            }
          }
        }
        break;
      }
      case 'key': {
        const target = q(ev.sel);
        if (target) focusEl(target);
        fireKey('keydown', ev);
        fireKey('keyup', ev);
        break;
      }
      case 'input': {
        const el = q(ev.sel) || document.activeElement;
        if (!el || el === document.body) break;
        focusEl(el);
        if (el.isContentEditable || ev.ce) {
          const sel = window.getSelection();
          const range = document.createRange();
          range.selectNodeContents(el);
          sel.removeAllRanges();
          sel.addRange(range);
          try {
            document.execCommand('insertText', false, ev.value || '');
          } catch (e) {
            el.textContent = ev.value || '';
          }
        } else if ('value' in el) {
          setNativeValue(el, ev.value == null ? '' : ev.value);
          if (typeof ev.ss === 'number') {
            try {
              el.setSelectionRange(ev.ss, typeof ev.se === 'number' ? ev.se : ev.ss);
            } catch (e) {
              /* ignore */
            }
          }
          try {
            el.dispatchEvent(
              new InputEvent('input', {
                bubbles: true,
                composed: true,
                inputType: ev.it || 'insertText',
                data: null
              })
            );
          } catch (e) {
            el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
          }
        }
        break;
      }
      case 'select': {
        const el = q(ev.sel);
        if (el && 'value' in el) {
          el.value = ev.value;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
        break;
      }
      case 'check': {
        const el = q(ev.sel);
        if (el) {
          el.checked = !!ev.checked;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
        break;
      }
      default:
        break;
    }
  }

  function setNativeValue(el, value) {
    const proto =
      el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : el instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
  }

  async function waitUntil(target, session) {
    for (;;) {
      if (session.cancelled) return false;
      const d = target - performance.now();
      if (d <= 0) return true;
      if (d > 120) await sleep(100);
      else if (d > 20) await sleep(d - 10);
      else await sleep(0);
    }
  }

  function report(session) {
    const t = Date.now();
    if (t - lastReport < 120 && session.done < session.total) return;
    lastReport = t;
    send({
      type: 'PLAYBACK_STATE',
      state: 'playing',
      progress: session.done,
      total: session.total
    });
    updateOverlay();
  }

  function scrollToStart(meta) {
    if (!meta || !meta.initialScroll) return;
    try {
      window.scrollTo({ top: meta.initialScroll.y, left: meta.initialScroll.x, behavior: 'instant' });
    } catch (e) {
      window.scrollTo(meta.initialScroll.x || 0, meta.initialScroll.y || 0);
    }
  }

  async function runPlayback(session, events, meta) {
    await sleep(450);
    for (let loop = 0; loop < session.loops; loop++) {
      if (session.cancelled) return;
      if (loop > 0) {
        scrollToStart(meta);
        await sleep(400);
      }
      const t0 = performance.now();
      for (let i = 0; i < events.length; i++) {
        if (session.cancelled) return;
        const ev = events[i];
        const target = t0 + (ev.t || 0) / session.speed;
        const ok = await waitUntil(target, session);
        if (!ok) return;
        try {
          applyEvent(ev);
        } catch (err) {
          console.warn('[鼠标回放] 执行失败', ev && ev.type, err);
        }
        session.done = i + 1;
        report(session);
      }
    }
    if (pb === session && mode === 'playing') {
      mode = 'idle';
      pb = null;
      lastHover = null;
      hideOverlay();
      send({ type: 'PLAYBACK_STATE', state: 'finished', progress: session.total, total: session.total });
    }
  }

  function startPlayback(events, options, meta) {
    if (mode === 'recording') return { ok: false, error: '请先停止录制' };
    if (!Array.isArray(events) || !events.length) return { ok: false, error: '没有可回放的操作' };
    if (mode === 'playing') stopPlayback();

    const session = {
      cancelled: false,
      total: events.length,
      done: 0,
      speed: clamp(Number(options && options.speed) || 1, 0.1, 8),
      loops: clamp(parseInt(options && options.loops, 10) || 1, 1, 100)
    };

    pb = session;
    mode = 'playing';
    lastHover = null;
    lastReport = 0;
    showOverlay('playing');
    scrollToStart(meta);

    runPlayback(session, events, meta).catch((err) => {
      console.warn('[鼠标回放] 回放异常', err);
      if (pb === session) {
        mode = 'idle';
        pb = null;
        hideOverlay();
        send({ type: 'PLAYBACK_STATE', state: 'stopped' });
      }
    });

    return { ok: true, total: events.length };
  }

  function stopPlayback() {
    if (pb) pb.cancelled = true;
    const was = mode === 'playing';
    mode = 'idle';
    pb = null;
    lastHover = null;
    hideOverlay();
    if (was) send({ type: 'PLAYBACK_STATE', state: 'stopped' });
    return { ok: true };
  }

  /* ============================ 消息 ============================ */

  window.addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'Escape' || mode === 'idle') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (mode === 'recording') stopRecording('esc');
      else stopPlayback();
    },
    true
  );

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    const type = msg && msg.type;
    try {
      switch (type) {
        case 'PING':
          sendResponse({ ok: true, mode });
          return false;
        case 'START_RECORD':
          sendResponse(startRecording(msg.options));
          return false;
        case 'STOP_RECORD':
          sendResponse(stopRecording('user'));
          return false;
        case 'PLAY':
          sendResponse(startPlayback(msg.events, msg.options, msg.meta));
          return false;
        case 'STOP_PLAY':
          sendResponse(stopPlayback());
          return false;
        default:
          sendResponse({ ok: false, error: '未知消息' });
          return false;
      }
    } catch (err) {
      sendResponse({ ok: false, error: String((err && err.message) || err) });
      return false;
    }
  });

  window.addEventListener('pagehide', () => {
    if (mode === 'recording') {
      try {
        flushBatch();
      } catch (e) {
        /* ignore */
      }
      mode = 'idle';
      removeListeners();
      clearInterval(flushTimer);
      send({ type: 'RECORD_STOPPED', reason: 'pagehide', meta: rec ? rec.meta : {} });
    }
  });
})();
