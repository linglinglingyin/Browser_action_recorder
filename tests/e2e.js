'use strict';

const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const EXT = path.join(__dirname, '..');
const PAGE = 'file:///' + path.join(__dirname, 'test-page.html').replace(/\\/g, '/');

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond });
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (detail ? '   [' + detail + ']' : ''));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', '--window-size=1200,900']
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 900 });

  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push('console: ' + m.text());
  });

  await page.goto(PAGE);
  await sleep(200);

  // 注入 chrome API 桩，再把 content.js 作为页面脚本注入
  await page.evaluate(() => {
    window.__msgs = [];
    window.__listener = null;
    window.chrome = {
      runtime: {
        sendMessage: (m) => {
          window.__msgs.push(JSON.parse(JSON.stringify(m)));
          return Promise.resolve({ ok: true });
        },
        onMessage: {
          addListener: (fn) => {
            window.__listener = fn;
          }
        }
      }
    };
  });

  const contentSrc = fs.readFileSync(path.join(EXT, 'content.js'), 'utf8');
  await page.addScriptTag({ content: contentSrc });
  await sleep(100);

  const hasListener = await page.evaluate(() => typeof window.__listener === 'function');
  check('content.js 注入并注册消息监听', hasListener);

  /* ------------------------- 录制 ------------------------- */
  await page.evaluate(
    () => new Promise((res) => window.__listener({ type: 'START_RECORD' }, {}, res))
  );
  await sleep(120);

  const overlayShown = await page.evaluate(
    () => !!document.querySelector('[data-mrr-ui]')
  );
  check('录制时显示悬浮提示条', overlayShown);

  const btnPos = await page.$eval('#btn', (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  const inputPos = await page.$eval('#text', (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left + 30, y: r.top + r.height / 2 };
  });

  await page.mouse.move(300, 400, { steps: 5 });
  await page.mouse.move(btnPos.x, btnPos.y, { steps: 10 });
  await page.mouse.click(btnPos.x, btnPos.y);
  await sleep(180);
  await page.mouse.click(inputPos.x, inputPos.y);
  await sleep(80);
  await page.keyboard.type('hello world', { delay: 22 });
  await sleep(120);
  await page.mouse.move(600, 620, { steps: 8 });
  await page.mouse.wheel({ deltaY: 500 });
  await sleep(450);
  await page.mouse.move(660, 520, { steps: 5 });
  await sleep(250);

  await page.evaluate(
    () => new Promise((res) => window.__listener({ type: 'STOP_RECORD' }, {}, res))
  );
  await sleep(150);

  const collected = await page.evaluate(() => window.__msgs);
  const events = [];
  let meta = {};
  let stopMsg = null;
  for (const m of collected) {
    if (m.type === 'EVENTS_BATCH' && Array.isArray(m.events)) events.push(...m.events);
    if (m.type === 'RECORD_STOPPED') {
      meta = m.meta || {};
      stopMsg = m;
    }
  }

  check('录制结束后上报 RECORD_STOPPED', !!stopMsg, `reason=${stopMsg && stopMsg.reason}`);
  check('捕获到事件', events.length > 20, `events=${events.length}`);

  const byType = events.reduce((acc, e) => {
    acc[e.type] = (acc[e.type] || 0) + 1;
    return acc;
  }, {});
  console.log('       事件分布:', JSON.stringify(byType));

  const recClick = events.find((e) => e.type === 'click' && e.sel === '#btn');
  check('点击事件记录了元素选择器', !!recClick, recClick ? recClick.sel : '未找到');
  check('点击事件记录了相对锚点', !!(recClick && typeof recClick.rx === 'number'));

  const inputEv = events.filter((e) => e.type === 'input').pop();
  check('记录了输入框最终内容', inputEv && inputEv.value === 'hello world', inputEv && inputEv.value);

  const scrollEv = events.filter((e) => e.type === 'scroll').pop();
  check('记录了页面滚动位置', scrollEv && scrollEv.y > 100, scrollEv ? 'y=' + scrollEv.y : '无');
  check('记录了初始滚动与视口信息', !!(meta.initialScroll && meta.viewport), JSON.stringify(meta.viewport));

  const overlayHidden = await page.evaluate(() => !document.querySelector('[data-mrr-ui]'));
  check('停止录制后移除悬浮条', overlayHidden);

  /* ------------------------- 回放 ------------------------- */
  await page.evaluate(() => {
    window.__msgs = [];
    window.__log = [];
    window.__clicks = 0;
    window.__moves = 0;
    document.getElementById('btn').textContent = '点我';
    document.getElementById('text').value = '';
    document.getElementById('box').scrollTop = 0;
    window.scrollTo(0, 0);
  });
  await sleep(150);

  const before = await page.evaluate(() => ({
    scrollY: window.scrollY,
    btn: document.getElementById('btn').textContent
  }));
  check('回放前状态已重置', before.scrollY === 0 && before.btn === '点我');

  const t0 = Date.now();
  await page.evaluate(
    (evs, m) =>
      new Promise((res) =>
        window.__listener({ type: 'PLAY', events: evs, options: { speed: 2, loops: 1 }, meta: m }, {}, res)
      ),
    events,
    meta
  );

  await page.waitForFunction(
    () => window.__msgs.some((m) => m.type === 'PLAYBACK_STATE' && m.state === 'finished'),
    { timeout: 60000 }
  );
  const elapsed = Date.now() - t0;
  const duration = events[events.length - 1].t;
  console.log(`       回放耗时 ${elapsed}ms（原始时长 ${duration}ms，2× 速度）`);
  check('回放完成并上报 finished', true);

  const after = await page.evaluate(() => ({
    btn: document.getElementById('btn').textContent,
    clicks: window.__clicks,
    value: document.getElementById('text').value,
    scrollY: window.scrollY,
    moves: window.__moves,
    log: window.__log
  }));

  check('按钮被点击（业务逻辑触发）', after.clicks === 1, 'clicks=' + after.clicks);
  check('输入框内容被复刻', after.value === 'hello world', JSON.stringify(after.value));
  check('页面滚动位置被复刻', after.scrollY > 100, 'scrollY=' + after.scrollY);
  check('鼠标移动被复刻', after.moves > 5, 'moves=' + after.moves);

  const replayedClick = after.log.find((e) => e.type === 'click' && e.target === 'btn');
  check('回放触发了按钮 click 事件', !!replayedClick);
  if (replayedClick && recClick) {
    const dx = Math.abs(replayedClick.x - recClick.x);
    const dy = Math.abs(replayedClick.y - recClick.y);
    check('点击坐标一致（误差 ≤ 2px）', dx <= 2 && dy <= 2, `记录(${recClick.x},${recClick.y}) 回放(${replayedClick.x},${replayedClick.y})`);
  }

  const order = after.log.map((e) => e.type);
  const downIdx = order.indexOf('mousedown');
  const upIdx = order.indexOf('mouseup');
  const clickIdx = order.indexOf('click');
  check('事件顺序正确 (down → up → click)', downIdx >= 0 && downIdx < upIdx && upIdx < clickIdx, order.join(','));

  const overlayGone = await page.evaluate(() => !document.querySelector('[data-mrr-ui]'));
  check('回放结束后移除悬浮条', overlayGone);

  /* ------------------------- 中止回放 ------------------------- */
  await page.evaluate(
    (evs, m) =>
      new Promise((res) =>
        window.__listener({ type: 'PLAY', events: evs, options: { speed: 0.5, loops: 3 }, meta: m }, {}, res)
      ),
    events,
    meta
  );
  await sleep(600);
  await page.evaluate(() => new Promise((res) => window.__listener({ type: 'STOP_PLAY' }, {}, res)));
  const stopped = await page.evaluate(
    () => window.__msgs.filter((m) => m.type === 'PLAYBACK_STATE').map((m) => m.state)
  );
  check('可中途停止回放', stopped.includes('stopped'), stopped.join(','));

  check('页面无 JS 报错', errors.length === 0, errors.slice(0, 3).join(' | '));

  await browser.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n==== ${results.length - failed.length}/${results.length} 通过 ====`);
  if (failed.length) {
    console.log('失败项: ' + failed.map((f) => f.name).join(', '));
    process.exit(1);
  }
})().catch((e) => {
  console.error('测试异常:', e);
  process.exit(2);
});
