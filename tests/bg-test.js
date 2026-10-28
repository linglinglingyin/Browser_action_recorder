'use strict';

/* 用模拟的 chrome API 在 Node 里跑 background.js，验证录制/存储/回放的状态机 */

const vm = require('vm');
const fs = require('fs');
const path = require('path');

const BG = path.join(__dirname, '..', 'background.js');

const store = {};
const broadcasts = [];
const tabMessages = [];
const messageListeners = [];
const tabUpdated = [];
const tabRemoved = [];

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond });
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (detail ? '   [' + detail + ']' : ''));
}

const chrome = {
  runtime: {
    onMessage: { addListener: (fn) => messageListeners.push(fn) },
    onInstalled: { addListener: () => {} },
    sendMessage: (m) => {
      broadcasts.push(m);
      return Promise.resolve({ ok: true });
    }
  },
  tabs: {
    query: async () => [{ id: 7, url: 'https://example.com/page', title: 'Example Page' }],
    get: async (id) => ({ id, url: 'https://example.com/page', title: 'Example Page' }),
    sendMessage: async (tabId, msg) => {
      tabMessages.push({ tabId, msg });
      if (contentBehavior) return contentBehavior(msg);
      return { ok: true };
    },
    onUpdated: { addListener: (fn) => tabUpdated.push(fn) },
    onRemoved: { addListener: (fn) => tabRemoved.push(fn) }
  },
  scripting: { executeScript: async () => [{ result: null }] },
  storage: {
    local: {
      get: async (keys) => {
        if (keys == null) return Object.assign({}, store);
        if (typeof keys === 'string') return { [keys]: store[keys] };
        if (Array.isArray(keys)) {
          const o = {};
          for (const k of keys) o[k] = store[k];
          return o;
        }
        return Object.assign({}, keys);
      },
      set: async (obj) => Object.assign(store, obj)
    }
  },
  action: {
    setBadgeText: () => {},
    setBadgeBackgroundColor: () => {}
  }
};

let contentBehavior = null;

const sandbox = {
  chrome,
  console,
  setTimeout,
  clearTimeout,
  Promise,
  Date,
  Math,
  JSON,
  Object,
  Array,
  String,
  Number,
  Boolean,
  URL,
  RegExp,
  Error
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(BG, 'utf8'), sandbox, { filename: 'background.js' });

function sendToBg(msg, sender) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    for (const fn of messageListeners) {
      try {
        fn(msg, sender || {}, done);
      } catch (e) {
        done({ ok: false, error: String(e) });
      }
    }
    setTimeout(() => done({ ok: false, error: 'timeout' }), 4000);
  });
}

const contentSender = { tab: { id: 7 } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  /* ---------- 1. 开始录制 ---------- */
  contentBehavior = async (msg) => {
    if (msg.type === 'PING') return { ok: true, mode: 'idle' };
    if (msg.type === 'START_RECORD') return { ok: true };
    if (msg.type === 'STOP_RECORD') {
      // 真实 content.js 只会上报尚未发送的尾部事件
      await sendToBg(
        { type: 'EVENTS_BATCH', events: [{ type: 'scroll', t: 100, x: 0, y: 200, sel: null }] },
        contentSender
      );
      await sendToBg(
        {
          type: 'RECORD_STOPPED',
          reason: 'user',
          meta: { initialScroll: { x: 0, y: 0 }, viewport: { w: 1200, h: 900 } }
        },
        contentSender
      );
      return { ok: true };
    }
    if (msg.type === 'PLAY') return { ok: true, total: msg.events.length };
    if (msg.type === 'STOP_PLAY') return { ok: true };
    return { ok: true };
  };

  const started = await sendToBg({ type: 'START_RECORD' });
  check('START_RECORD 返回成功', started.ok === true);
  check('向页面下发了 START_RECORD', tabMessages.some((m) => m.msg.type === 'START_RECORD'));

  const st1 = await sendToBg({ type: 'GET_STATE' });
  check('状态切换为录制中', st1.state.recording === true, JSON.stringify(st1.state));

  /* ---------- 2. 事件分批上报 ---------- */
  const batch = [
    { type: 'move', t: 10, x: 100, y: 120 },
    { type: 'down', t: 40, x: 100, y: 120, button: 0, buttons: 1 },
    { type: 'up', t: 80, x: 100, y: 120, button: 0, buttons: 0 },
    { type: 'click', t: 85, x: 100, y: 120, button: 0, detail: 1 }
  ];
  await sendToBg({ type: 'EVENTS_BATCH', events: batch.slice(0, 2) }, contentSender);
  await sendToBg({ type: 'EVENTS_BATCH', events: batch.slice(2) }, contentSender);

  const st2 = await sendToBg({ type: 'GET_STATE' });
  check('累加事件计数', st2.state.eventCount === 4, 'count=' + st2.state.eventCount);

  /* ---------- 3. 停止录制并保存 ---------- */
  const stopped = await sendToBg({ type: 'STOP_RECORD' });
  check('STOP_RECORD 返回已保存的录制', stopped.ok && stopped.recording, JSON.stringify(stopped.recording));
  check(
    '录制名称包含页面标题',
    !!(stopped.recording && stopped.recording.name.indexOf('Example Page') === 0),
    stopped.recording && stopped.recording.name
  );

  const list = store['mrr.recordings'] || [];
  check('写入 chrome.storage.local', list.length === 1 && list[0].events.length === 5, 'records=' + list.length);
  check('保存了元数据', !!(list[0].meta && list[0].meta.viewport && list[0].meta.viewport.w === 1200));
  check('录制结束后清空缓冲区', (await sendToBg({ type: 'GET_STATE' })).state.eventCount === 0);

  /* ---------- 4. 回放 ---------- */
  const rec = list[0];
  const played = await sendToBg({ type: 'PLAY', id: rec.id, options: { speed: 2, loops: 1 } });
  check('PLAY 返回成功', played.ok === true, JSON.stringify(played));
  const playMsg = tabMessages.filter((m) => m.msg.type === 'PLAY').pop();
  check('向页面下发了完整事件', !!playMsg && playMsg.msg.events.length === 5);
  check('下发了回放参数', !!playMsg && playMsg.msg.options.speed === 2);

  await sendToBg({ type: 'PLAYBACK_STATE', state: 'playing', progress: 2, total: 5 }, contentSender);
  const st3 = await sendToBg({ type: 'GET_STATE' });
  check('回放进度可查询', st3.state.playing === true && st3.state.progress === 2, JSON.stringify(st3.state));

  await sendToBg({ type: 'PLAYBACK_STATE', state: 'finished' }, contentSender);
  const st4 = await sendToBg({ type: 'GET_STATE' });
  check('回放结束后状态复位', st4.state.playing === false);

  /* ---------- 5. 录制中页面跳转自动收尾 ---------- */
  await sendToBg({ type: 'START_RECORD' });
  await sendToBg({ type: 'EVENTS_BATCH', events: [{ type: 'move', t: 5, x: 1, y: 1 }] }, contentSender);
  tabUpdated.forEach((fn) => fn(7, { status: 'loading', url: 'https://example.com/next' }));
  await sleep(80);
  const list2 = store['mrr.recordings'] || [];
  check('页面跳转时自动保存已录内容', list2.length === 2, 'records=' + list2.length);
  check('跳转后不再处于录制状态', (await sendToBg({ type: 'GET_STATE' })).state.recording === false);

  /* ---------- 6. 页面关闭 ---------- */
  await sendToBg({ type: 'START_RECORD' });
  await sendToBg({ type: 'EVENTS_BATCH', events: [{ type: 'move', t: 5, x: 2, y: 2 }] }, contentSender);
  tabRemoved.forEach((fn) => fn(7));
  await sleep(80);
  check('标签页关闭时自动保存', (store['mrr.recordings'] || []).length === 3);

  /* ---------- 7. 异常路径 ---------- */
  const badPlay = await sendToBg({ type: 'PLAY', id: 'not-exist' });
  check('回放不存在的录制时报错', badPlay.ok === false && !!badPlay.error, badPlay.error);

  const stopIdle = await sendToBg({ type: 'STOP_RECORD' });
  check('未录制时停止给出提示', stopIdle.ok === false, stopIdle.error);

  /* ---------- 8. 注入失败 ---------- */
  chrome.scripting.executeScript = async () => {
    throw new Error('Cannot access a chrome:// URL');
  };
  contentBehavior = async () => {
    throw new Error('no receiver');
  };
  const failed = await sendToBg({ type: 'START_RECORD' });
  check('无法注入时返回友好错误', failed.ok === false && /注入|页面/.test(failed.error || ''), failed.error);

  const failedList = results.filter((r) => !r.ok);
  console.log(`\n==== ${results.length - failedList.length}/${results.length} 通过 ====`);
  if (failedList.length) {
    console.log('失败项: ' + failedList.map((f) => f.name).join(', '));
    process.exit(1);
  }
})().catch((e) => {
  console.error('测试异常:', e);
  process.exit(2);
});
