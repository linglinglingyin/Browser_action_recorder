'use strict';

/* jsdom 环境下验证 popup.js 的渲染与交互逻辑 */

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const DIR = path.join(__dirname, '..');

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond });
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (detail ? '   [' + detail + ']' : ''));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const recordings = [
  {
    id: 'r1',
    name: '测试录制一',
    createdAt: Date.now() - 60000,
    duration: 4200,
    url: 'https://example.com',
    title: 'Example',
    events: [{ type: 'move', t: 0, x: 1, y: 1 }, { type: 'click', t: 100, x: 5, y: 5 }],
    meta: {}
  },
  {
    id: 'r2',
    name: '测试录制二',
    createdAt: Date.now() - 120000,
    duration: 1500,
    url: 'https://example.org',
    title: 'Org',
    events: [{ type: 'move', t: 0, x: 2, y: 2 }],
    meta: {}
  }
];

const store = { 'mrr.recordings': JSON.parse(JSON.stringify(recordings)), 'mrr.settings': { speed: 2, loops: 3, keys: true } };
const sent = [];
let runtimeState = { recording: false, playing: false, eventCount: 0, progress: 0, total: 0, elapsed: 0, lastSavedId: null };

const chromeMock = {
  runtime: {
    lastError: null,
    onMessage: { addListener: () => {} },
    sendMessage: (msg, cb) => {
      sent.push(msg);
      let res = { ok: true };
      if (msg.type === 'GET_STATE') res = { ok: true, state: Object.assign({}, runtimeState) };
      if (msg.type === 'START_RECORD') {
        runtimeState = Object.assign({}, runtimeState, { recording: true, eventCount: 0 });
        res = { ok: true, state: Object.assign({}, runtimeState) };
      }
      if (msg.type === 'STOP_RECORD') {
        runtimeState = Object.assign({}, runtimeState, { recording: false });
        res = { ok: true, recording: { id: 'r3', name: '新录制', count: 3, duration: 900, createdAt: Date.now() } };
      }
      if (msg.type === 'PLAY') {
        runtimeState = Object.assign({}, runtimeState, { playing: true, progress: 0, total: 2 });
        res = { ok: true, state: Object.assign({}, runtimeState) };
      }
      setTimeout(() => cb(res), 0);
    }
  },
  storage: {
    local: {
      get: (keys) => {
        const arr = Array.isArray(keys) ? keys : [keys];
        const out = {};
        for (const k of arr) out[k] = store[k];
        return Promise.resolve(out);
      },
      set: (obj) => {
        Object.assign(store, obj);
        return Promise.resolve();
      }
    }
  },
  downloads: { download: () => Promise.resolve(1) }
};

(async () => {
  const html = fs.readFileSync(path.join(DIR, 'popup.html'), 'utf8');
  const errors = [];

  const dom = new JSDOM(html, {
    url: 'chrome-extension://test/popup.html',
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    beforeParse(window) {
      window.chrome = chromeMock;
      window.close = () => {
        window.__closed = true;
      };
      window.addEventListener('error', (e) => errors.push(String(e.message || e.error)));
    }
  });

  const { window } = dom;
  const doc = window.document;

  // 手动注入 popup.js（jsdom 的 file 资源加载依赖路径解析，这里直接执行）
  const script = doc.createElement('script');
  script.textContent = fs.readFileSync(path.join(DIR, 'popup.js'), 'utf8');
  doc.body.appendChild(script);

  await sleep(300);

  const items = doc.querySelectorAll('#list .item');
  check('列表渲染出全部录制', items.length === 2, 'items=' + items.length);
  check('计数正确', doc.getElementById('count').textContent === '2');
  check('列表项显示事件数与时长', /2 事件 · 0:04/.test(items[0].textContent), items[0].textContent.replace(/\s+/g, ' ').trim());
  check('设置项从存储恢复', doc.getElementById('speed').value === '2' && doc.getElementById('loops').value === '3');

  // 点击录制
  doc.getElementById('btn-record').click();
  await sleep(350);
  check('点击录制发送 START_RECORD', sent.some((m) => m.type === 'START_RECORD'));
  check('录制中按钮变为停止', doc.getElementById('rec-label').textContent === '停止');
  check('录制中状态文案更新', /录制中/.test(doc.getElementById('status').textContent), doc.getElementById('status').textContent);
  check('开始录制后自动收起弹窗', window.__closed === true);

  // 再点一次停止
  doc.getElementById('btn-record').click();
  await sleep(120);
  check('再次点击发送 STOP_RECORD', sent.some((m) => m.type === 'STOP_RECORD'));
  check('停止后按钮恢复', doc.getElementById('rec-label').textContent === '录制');

  // 回放
  const playBtn = doc.querySelector('#list .item[data-id="r1"] button[data-act="play"]');
  playBtn.click();
  await sleep(150);
  const playMsg = sent.filter((m) => m.type === 'PLAY').pop();
  check('点击播放发送 PLAY', !!playMsg && playMsg.id === 'r1');
  check('回放参数取自设置项', playMsg && playMsg.options.speed === 2 && playMsg.options.loops === 3, JSON.stringify(playMsg && playMsg.options));
  check('回放中显示进度条', !doc.getElementById('progress').classList.contains('hidden'));

  // 重命名
  const renameBtn = doc.querySelector('#list .item[data-id="r2"] button[data-act="rename"]');
  renameBtn.click();
  await sleep(50);
  const input = doc.querySelector('#list .item[data-id="r2"] .item-name input');
  check('重命名进入编辑态', !!input);
  if (input) {
    input.value = '改过的名字';
    const ev = new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true });
    input.dispatchEvent(ev);
    await sleep(120);
    const saved = store['mrr.recordings'].find((r) => r.id === 'r2');
    check('回车保存新名称', saved && saved.name === '改过的名字', saved && saved.name);
  }

  // 删除（两步确认）
  const delBtn = doc.querySelector('#list .item[data-id="r1"] button[data-act="delete"]');
  delBtn.click();
  await sleep(60);
  check('第一次点击进入确认态', doc.querySelector('#list .item[data-id="r1"]').classList.contains('pending'));
  doc.querySelector('#list .item[data-id="r1"] button[data-act="delete"]').click();
  await sleep(120);
  check('第二次点击真正删除', doc.querySelectorAll('#list .item').length === 1);
  check('删除已写回存储', store['mrr.recordings'].length === 1 && store['mrr.recordings'][0].id === 'r2');

  // 清空（两步）
  doc.getElementById('btn-clear').click();
  await sleep(50);
  check('清空需要二次确认', doc.getElementById('btn-clear').textContent === '确认清空');
  doc.getElementById('btn-clear').click();
  await sleep(120);
  check('清空后列表为空', doc.querySelectorAll('#list .item').length === 0);
  check('清空后显示空状态', !doc.getElementById('empty').classList.contains('hidden'));

  check('弹窗脚本无运行时错误', errors.length === 0, errors.slice(0, 3).join(' | '));

  window.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n==== ${results.length - failed.length}/${results.length} 通过 ====`);
  if (failed.length) {
    console.log('失败项: ' + failed.map((f) => f.name).join(', '));
  }
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error('测试异常:', e);
  process.exit(2);
});
