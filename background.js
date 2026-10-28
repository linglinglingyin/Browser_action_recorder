'use strict';

/* ------------------------------------------------------------------
 * 后台服务：录制缓冲区、存储、标签页注入、状态广播
 * ------------------------------------------------------------------ */

const STORAGE_KEY = 'mrr.recordings';
const SETTINGS_KEY = 'mrr.settings';
const MAX_RECORDINGS = 60;

const state = {
  recording: false,
  tabId: null,
  startedAt: 0,
  url: '',
  title: '',
  events: [],
  count: 0,
  playing: false,
  playTabId: null,
  progress: 0,
  total: 0,
  lastSavedId: null,
  finalizing: false
};

let stopWaiter = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------------------- 小工具 ---------------------------- */

function setBadge(text, color) {
  try {
    chrome.action.setBadgeText({ text: text || '' });
    if (text) chrome.action.setBadgeBackgroundColor({ color: color || '#e5484d' });
  } catch (e) {
    /* ignore */
  }
}

function broadcast(msg) {
  try {
    const p = chrome.runtime.sendMessage(msg);
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch (e) {
    /* 没有接收方时忽略 */
  }
}

function publicState() {
  return {
    recording: state.recording,
    playing: state.playing,
    eventCount: state.count,
    progress: state.progress,
    total: state.total,
    tabId: state.tabId,
    lastSavedId: state.lastSavedId,
    elapsed: state.recording ? Date.now() - state.startedAt : 0
  };
}

function summarize(rec) {
  return {
    id: rec.id,
    name: rec.name,
    count: rec.events.length,
    duration: rec.duration,
    createdAt: rec.createdAt
  };
}

function autoName(title, url) {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  let host = '';
  try {
    host = new URL(url).hostname.replace(/^www\./, '');
  } catch (e) {
    host = '';
  }
  const t = (title || host || '页面').slice(0, 24);
  return `${t} · ${stamp}`;
}

async function getRecordings() {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  const list = data[STORAGE_KEY];
  return Array.isArray(list) ? list : [];
}

async function saveRecordings(list) {
  await chrome.storage.local.set({ [STORAGE_KEY]: list.slice(0, MAX_RECORDINGS) });
}

/* ------------------------- 内容脚本注入 ------------------------- */

async function ensureContent(tabId) {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: 'PING' });
    if (res && res.ok) return true;
  } catch (e) {
    /* 尚未注入 */
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  } catch (err) {
    throw new Error('无法在当前页面注入脚本（浏览器内置页面 / 应用商店页面不支持）');
  }
  await sleep(80);
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: 'PING' });
    if (res && res.ok) return true;
  } catch (e) {
    /* ignore */
  }
  throw new Error('脚本注入失败，请刷新页面后重试');
}

async function activeTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs && tabs[0] ? tabs[0] : null;
}

/* ---------------------------- 录制 ---------------------------- */

async function startRecording(tabId) {
  if (state.playing) await stopPlayback(true);

  const tab = tabId != null ? await chrome.tabs.get(tabId) : await activeTab();
  if (!tab || tab.id == null) throw new Error('找不到当前标签页');

  await ensureContent(tab.id);

  if (state.recording) await finalize('restart');

  state.recording = true;
  state.tabId = tab.id;
  state.startedAt = Date.now();
  state.url = tab.url || '';
  state.title = tab.title || '';
  state.events = [];
  state.count = 0;
  state.finalizing = false;

  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  const settings = stored[SETTINGS_KEY] || {};

  const res = await chrome.tabs.sendMessage(tab.id, {
    type: 'START_RECORD',
    options: { keys: settings.keys !== false }
  });
  if (!res || !res.ok) {
    state.recording = false;
    state.tabId = null;
    throw new Error((res && res.error) || '该页面无法开始录制');
  }

  setBadge('REC', '#e5484d');
  broadcast({ type: 'STATE_CHANGED' });
  return { ok: true, state: publicState() };
}

async function finalize(reason, meta) {
  if (!state.recording || state.finalizing) return null;
  state.finalizing = true;
  state.recording = false;
  setBadge('');

  const events = state.events;
  const count = state.count;
  const url = state.url;
  const title = state.title;
  state.events = [];
  state.count = 0;
  state.tabId = null;

  let saved = null;
  if (events.length) {
    const duration = events[events.length - 1].t || 0;
    saved = {
      id: 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      name: autoName(title, url),
      createdAt: Date.now(),
      url,
      title,
      duration,
      events,
      meta: Object.assign({ reason: reason || 'stop', count }, meta || {})
    };
    const list = await getRecordings();
    list.unshift(saved);
    await saveRecordings(list);
    state.lastSavedId = saved.id;
  }

  state.finalizing = false;
  if (stopWaiter) {
    const fn = stopWaiter;
    stopWaiter = null;
    fn(saved);
  }
  broadcast({ type: 'STATE_CHANGED', saved: saved ? summarize(saved) : null });
  return saved;
}

async function stopRecording() {
  if (!state.recording) return { ok: false, error: '当前没有在录制' };
  const tabId = state.tabId;
  const beforeCount = (await getRecordings()).length;

  let resolveWaiter = null;
  const waited = new Promise((r) => (resolveWaiter = r));
  stopWaiter = resolveWaiter;

  try {
    await chrome.tabs.sendMessage(tabId, { type: 'STOP_RECORD' });
  } catch (e) {
    /* 页面可能已经跳转 */
  }

  const result = await Promise.race([waited, sleep(2500).then(() => null)]);
  let saved = result;
  if (!saved && state.recording) saved = await finalize('timeout');

  if (!saved) {
    // 可能被「页面跳转 / 关闭」的自动收尾抢先保存了
    const list = await getRecordings();
    if (list.length > beforeCount) saved = list[0];
  }

  if (!saved) return { ok: true, recording: null, error: '没有捕获到任何操作' };
  return { ok: true, recording: summarize(saved), state: publicState() };
}

/* ---------------------------- 回放 ---------------------------- */

async function playRecording(recordingId, options) {
  if (state.recording) throw new Error('请先停止录制');
  const list = await getRecordings();
  const rec = list.find((r) => r.id === recordingId);
  if (!rec) throw new Error('找不到这条录制记录');
  if (!rec.events || !rec.events.length) throw new Error('该录制没有可回放的事件');

  const tab = await activeTab();
  if (!tab || tab.id == null) throw new Error('找不到当前标签页');
  await ensureContent(tab.id);

  if (state.playing) await stopPlayback(true);

  state.playing = true;
  state.playTabId = tab.id;
  state.progress = 0;
  state.total = rec.events.length;
  setBadge('PLAY', '#2f81f7');

  const res = await chrome.tabs.sendMessage(tab.id, {
    type: 'PLAY',
    events: rec.events,
    options: options || {},
    meta: rec.meta || {}
  });

  if (!res || !res.ok) {
    state.playing = false;
    setBadge('');
    throw new Error((res && res.error) || '回放启动失败');
  }
  broadcast({ type: 'STATE_CHANGED' });
  return { ok: true, state: publicState() };
}

async function stopPlayback(silent) {
  const tabId = state.playTabId;
  state.playing = false;
  state.progress = 0;
  state.playTabId = null;
  setBadge('');
  if (tabId != null) {
    try {
      await chrome.tabs.sendMessage(tabId, { type: 'STOP_PLAY' });
    } catch (e) {
      /* ignore */
    }
  }
  if (!silent) broadcast({ type: 'STATE_CHANGED' });
  return { ok: true };
}

/* ---------------------------- 消息 ---------------------------- */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const type = msg && msg.type;

  // ---- 来自内容脚本 ----
  if (type === 'EVENTS_BATCH') {
    if (state.recording && sender.tab && sender.tab.id === state.tabId) {
      const batch = Array.isArray(msg.events) ? msg.events : [];
      if (batch.length) {
        state.events.push(...batch);
        state.count += batch.length;
      }
    }
    sendResponse({ ok: true });
    return false;
  }

  if (type === 'RECORD_STOPPED') {
    finalize(msg.reason || 'stop', msg.meta || {}).then((rec) => {
      sendResponse({ ok: true, recording: rec ? summarize(rec) : null });
    });
    return true;
  }

  if (type === 'PLAYBACK_STATE') {
    if (msg.state === 'playing') {
      state.playing = true;
      state.progress = msg.progress || 0;
      state.total = msg.total || 0;
      broadcast({ type: 'STATE_CHANGED' });
    } else {
      state.playing = false;
      state.progress = 0;
      state.playTabId = null;
      setBadge('');
      broadcast({ type: 'STATE_CHANGED' });
    }
    sendResponse({ ok: true });
    return false;
  }

  // ---- 来自 popup ----
  (async () => {
    try {
      switch (type) {
        case 'GET_STATE':
          sendResponse({ ok: true, state: publicState() });
          break;

        case 'START_RECORD':
          sendResponse(await startRecording(msg.tabId));
          break;

        case 'STOP_RECORD':
          sendResponse(await stopRecording());
          break;

        case 'PLAY':
          sendResponse(await playRecording(msg.id, msg.options));
          break;

        case 'STOP_PLAY':
          sendResponse(await stopPlayback());
          break;

        case 'SAVE_RECORDING': {
          const rec = msg.recording;
          if (!rec || !Array.isArray(rec.events)) throw new Error('数据无效');
          const list = await getRecordings();
          list.unshift(rec);
          await saveRecordings(list);
          broadcast({ type: 'STATE_CHANGED' });
          sendResponse({ ok: true });
          break;
        }

        case 'DELETE_RECORDING': {
          const list = (await getRecordings()).filter((r) => r.id !== msg.id);
          await saveRecordings(list);
          broadcast({ type: 'STATE_CHANGED' });
          sendResponse({ ok: true });
          break;
        }

        case 'CLEAR_RECORDINGS':
          await saveRecordings([]);
          state.lastSavedId = null;
          broadcast({ type: 'STATE_CHANGED' });
          sendResponse({ ok: true });
          break;

        default:
          sendResponse({ ok: false, error: '未知消息: ' + type });
      }
    } catch (err) {
      sendResponse({ ok: false, error: String((err && err.message) || err) });
    }
  })();
  return true;
});

/* ------------------ 页面跳转 / 关闭时收尾 ------------------ */

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!state.recording || tabId !== state.tabId) return;
  if (changeInfo.status === 'loading' && changeInfo.url) {
    finalize('navigate');
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (state.recording && tabId === state.tabId) finalize('tab-closed');
  if (state.playing && tabId === state.playTabId) {
    state.playing = false;
    state.playTabId = null;
    setBadge('');
  }
});

chrome.runtime.onInstalled.addListener(() => {
  setBadge('');
});
