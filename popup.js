'use strict';

const KEY = 'mrr.recordings';
const SKEY = 'mrr.settings';

const $ = (id) => document.getElementById(id);

const els = {
  status: $('status'),
  btnRecord: $('btn-record'),
  recLabel: $('rec-label'),
  speed: $('speed'),
  loops: $('loops'),
  keys: $('keys'),
  progress: $('progress'),
  barFill: $('bar-fill'),
  progressText: $('progress-text'),
  list: $('list'),
  empty: $('empty'),
  count: $('count'),
  btnImport: $('btn-import'),
  btnClear: $('btn-clear'),
  file: $('file'),
  toast: $('toast')
};

let state = { recording: false, playing: false, eventCount: 0, progress: 0, total: 0, elapsed: 0 };
let recordings = [];
let settings = { speed: 1, loops: 1, keys: true };
let pendingDelete = null;
let playingId = null;
let lastSavedId = null;
let clearArmed = false;
let toastTimer = null;
let pollTimer = null;

/* ---------------------------- 工具 ---------------------------- */

function bg(msg) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (res) => {
        const err = chrome.runtime.lastError;
        if (err) resolve({ ok: false, error: err.message });
        else resolve(res || { ok: false, error: '扩展无响应' });
      });
    } catch (e) {
      resolve({ ok: false, error: String(e && e.message ? e.message : e) });
    }
  });
}

function fmtMs(ms) {
  const total = Math.max(0, Math.round((ms || 0) / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m + ':' + String(s).padStart(2, '0');
}

function dateStr(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function toast(msg, isError) {
  els.toast.textContent = msg;
  els.toast.classList.remove('hidden');
  els.toast.classList.toggle('err', !!isError);
  requestAnimationFrame(() => els.toast.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    els.toast.classList.remove('show');
    setTimeout(() => els.toast.classList.add('hidden'), 220);
  }, 2200);
}

async function persist() {
  await chrome.storage.local.set({ [KEY]: recordings });
  render();
}

/* ---------------------------- 状态 ---------------------------- */

function renderStatus() {
  const rec = state.recording;
  const play = state.playing;

  els.btnRecord.classList.toggle('active', !!rec);
  els.recLabel.textContent = rec ? '停止' : '录制';
  els.btnRecord.disabled = !!play;

  if (rec) {
    els.status.textContent = `录制中 · ${state.eventCount} 个事件 · ${fmtMs(state.elapsed)}`;
    els.status.className = 'status on';
  } else if (play) {
    const pct = state.total ? Math.round((state.progress / state.total) * 100) : 0;
    els.status.textContent = `回放中 · ${state.progress}/${state.total}`;
    els.status.className = 'status play';
  } else {
    els.status.textContent = '就绪';
    els.status.className = 'status';
  }

  if (play) {
    const pct = state.total ? Math.round((state.progress / state.total) * 100) : 0;
    els.progress.classList.remove('hidden');
    els.barFill.style.width = pct + '%';
    els.progressText.textContent = pct + '%';
  } else {
    els.progress.classList.add('hidden');
    els.barFill.style.width = '0%';
    if (!rec) playingId = null;
  }
}

async function refresh() {
  const res = await bg({ type: 'GET_STATE' });
  if (res && res.ok && res.state) {
    state = res.state;
    if (state.lastSavedId !== lastSavedId) {
      lastSavedId = state.lastSavedId;
      await loadRecordings();
    }
  }
  renderStatus();
}

async function loadRecordings() {
  const data = await chrome.storage.local.get(KEY);
  recordings = Array.isArray(data[KEY]) ? data[KEY] : [];
  render();
}

/* ---------------------------- 渲染 ---------------------------- */

function render() {
  els.count.textContent = String(recordings.length);
  els.empty.classList.toggle('hidden', recordings.length > 0);
  els.list.textContent = '';

  for (const r of recordings) {
    const li = document.createElement('li');
    li.className = 'item';
    li.dataset.id = r.id;
    if (playingId === r.id) li.classList.add('playing');
    if (pendingDelete === r.id) li.classList.add('pending');

    const main = document.createElement('div');
    main.className = 'item-main';

    const name = document.createElement('div');
    name.className = 'item-name';
    name.textContent = r.name || '未命名';
    name.title = `${r.name || ''}\n${r.url || ''}`;

    const meta = document.createElement('div');
    meta.className = 'item-meta';
    const evCount = r.events ? r.events.length : 0;
    meta.textContent = `${evCount} 事件 · ${fmtMs(r.duration)} · ${dateStr(r.createdAt)}`;

    main.append(name, meta);

    const actions = document.createElement('div');
    actions.className = 'item-actions';
    const defs = [
      ['play', playingId === r.id ? '■' : '▶', '回放'],
      ['rename', '✎', '重命名'],
      ['export', '⤓', '导出 JSON'],
      ['delete', '✕', pendingDelete === r.id ? '确认删除' : '删除']
    ];
    for (const [act, label, title] of defs) {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.act = act;
      b.textContent = label;
      b.title = title;
      actions.appendChild(b);
    }

    li.append(main, actions);
    els.list.appendChild(li);
  }
}

/* ---------------------------- 操作 ---------------------------- */

async function toggleRecord() {
  if (state.recording) {
    const res = await bg({ type: 'STOP_RECORD' });
    if (!res.ok) toast(res.error || '停止失败', true);
    else if (res.error) toast(res.error, true);
    else toast('已保存录制');
    await refresh();
    await loadRecordings();
    return;
  }

  const res = await bg({ type: 'START_RECORD' });
  if (!res.ok) {
    toast(res.error || '无法开始录制', true);
    await refresh();
    return;
  }

  await refresh();
  toast('开始录制，按 Esc 结束');
  // 开始录制后自动收起弹窗，方便直接在页面上操作
  setTimeout(() => {
    try {
      window.close();
    } catch (e) {
      /* ignore */
    }
  }, 200);
}

async function playRecording(rec) {
  if (state.playing) {
    await bg({ type: 'STOP_PLAY' });
    if (playingId === rec.id) {
      playingId = null;
      render();
      await refresh();
      return;
    }
  }
  const options = {
    speed: Number(els.speed.value) || 1,
    loops: Math.max(1, Math.min(99, parseInt(els.loops.value, 10) || 1))
  };
  const res = await bg({ type: 'PLAY', id: rec.id, options });
  if (!res.ok) {
    toast(res.error || '回放失败', true);
    return;
  }
  playingId = rec.id;
  render();
  toast('开始回放，按 Esc 可中止');
  await refresh();
}

function startRename(li, rec) {
  const nameEl = li.querySelector('.item-name');
  if (!nameEl || nameEl.querySelector('input')) return;

  const input = document.createElement('input');
  input.type = 'text';
  input.maxLength = 80;
  input.value = rec.name || '';
  nameEl.textContent = '';
  nameEl.appendChild(input);
  input.focus();
  input.select();

  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    const v = input.value.trim();
    if (save && v && v !== rec.name) {
      rec.name = v;
      await persist();
    } else {
      render();
    }
  };

  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      finish(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      finish(false);
    }
  });
  input.addEventListener('blur', () => finish(true), { once: true });
}

async function exportRecording(rec) {
  const payload = {
    format: 'mouse-recorder-extension',
    version: 1,
    name: rec.name,
    createdAt: rec.createdAt,
    url: rec.url,
    title: rec.title,
    duration: rec.duration,
    events: rec.events,
    meta: rec.meta
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const safe = String(rec.name || 'recording')
    .replace(/[\\/:*?"<>|\s]+/g, '_')
    .slice(0, 40);
  try {
    await chrome.downloads.download({
      url,
      filename: `mouse-recording/${safe || 'recording'}.json`,
      saveAs: true
    });
    toast('已导出');
  } catch (e) {
    toast('导出失败：' + (e.message || e), true);
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
}

async function importFile(file) {
  const text = await file.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    toast('JSON 解析失败', true);
    return;
  }
  const items = Array.isArray(data) ? data : [data];
  let added = 0;
  for (const it of items) {
    if (!it || !Array.isArray(it.events) || !it.events.length) continue;
    recordings.unshift({
      id: 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      name: it.name || file.name.replace(/\.json$/i, ''),
      createdAt: it.createdAt || Date.now(),
      url: it.url || '',
      title: it.title || '',
      duration: it.duration || (it.events[it.events.length - 1] || {}).t || 0,
      events: it.events,
      meta: it.meta || {}
    });
    added++;
  }
  if (!added) {
    toast('文件里没有可用的录制数据', true);
    return;
  }
  await persist();
  toast(`已导入 ${added} 条录制`);
}

/* ---------------------------- 事件绑定 ---------------------------- */

function bind() {
  els.btnRecord.addEventListener('click', toggleRecord);

  els.list.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const li = btn.closest('.item');
    const rec = recordings.find((r) => r.id === li.dataset.id);
    if (!rec) return;
    const act = btn.dataset.act;

    if (act === 'play') {
      await playRecording(rec);
    } else if (act === 'rename') {
      startRename(li, rec);
    } else if (act === 'export') {
      await exportRecording(rec);
    } else if (act === 'delete') {
      if (pendingDelete !== rec.id) {
        pendingDelete = rec.id;
        render();
        setTimeout(() => {
          if (pendingDelete === rec.id) {
            pendingDelete = null;
            render();
          }
        }, 3000);
        return;
      }
      pendingDelete = null;
      recordings = recordings.filter((r) => r.id !== rec.id);
      await persist();
      toast('已删除');
    }
  });

  els.speed.addEventListener('change', () => {
    settings.speed = Number(els.speed.value) || 1;
    chrome.storage.local.set({ [SKEY]: settings });
  });

  els.loops.addEventListener('change', () => {
    const v = Math.max(1, Math.min(99, parseInt(els.loops.value, 10) || 1));
    els.loops.value = String(v);
    settings.loops = v;
    chrome.storage.local.set({ [SKEY]: settings });
  });

  els.keys.addEventListener('change', () => {
    settings.keys = els.keys.checked;
    chrome.storage.local.set({ [SKEY]: settings });
  });

  els.btnImport.addEventListener('click', () => els.file.click());

  els.file.addEventListener('change', async () => {
    const f = els.file.files && els.file.files[0];
    els.file.value = '';
    if (f) await importFile(f);
  });

  els.btnClear.addEventListener('click', async () => {
    if (!clearArmed) {
      clearArmed = true;
      els.btnClear.textContent = '确认清空';
      setTimeout(() => {
        clearArmed = false;
        els.btnClear.textContent = '清空';
      }, 3000);
      return;
    }
    clearArmed = false;
    els.btnClear.textContent = '清空';
    recordings = [];
    await persist();
    await bg({ type: 'CLEAR_RECORDINGS' });
    toast('已清空全部录制');
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'STATE_CHANGED') refresh();
  });
}

/* ---------------------------- 启动 ---------------------------- */

(async function init() {
  const data = await chrome.storage.local.get([KEY, SKEY]);
  recordings = Array.isArray(data[KEY]) ? data[KEY] : [];
  if (data[SKEY]) settings = Object.assign(settings, data[SKEY]);

  els.speed.value = String(settings.speed || 1);
  els.loops.value = String(settings.loops || 1);
  els.keys.checked = settings.keys !== false;

  render();
  bind();

  await refresh();
  renderStatus();

  pollTimer = setInterval(refresh, 500);
  window.addEventListener('unload', () => clearInterval(pollTimer));
})();
