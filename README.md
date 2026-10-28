# 鼠标录制回放（浏览器扩展）

一个 Chrome / Edge 扩展：把你在一页网页上的**鼠标移动、点击、右键、滚轮、页面滚动**（可选键盘输入）录下来，
之后按**原始时间线**在页面上自动复刻一遍，支持调速与循环。

纯本地运行，不联网、不上传任何数据。

---

## 安装（加载已解压的扩展）

1. 打开 `chrome://extensions/`（Edge 为 `edge://extensions/`）
2. 右上角打开 **开发者模式**
3. 点击 **加载已解压的扩展程序**，选择本目录 `mouse-recorder-extension`
4. 建议把扩展图标固定到工具栏

> 想在 `file://` 本地网页上使用，需要在扩展详情里打开 **允许访问文件网址**。

## 使用

1. 打开要操作的网页，点击工具栏里的扩展图标
2. 点击 **录制**（弹窗会自动收起），页面右上角出现红色悬浮条
3. 正常操作页面：移动、点击、滚动、输入
4. 结束录制：按 **Esc**，或点悬浮条上的 **停止录制**
5. 再次打开弹窗，在列表里点 **▶** 回放

**回放设置**

| 设置 | 说明 |
| --- | --- |
| 速度 | 0.5× ~ 3×，按比例压缩/放慢整条时间线 |
| 循环 | 1 ~ 99 次，每次循环前回到录制起始滚动位置 |
| 键盘输入 | 关闭后只记录鼠标与滚动 |

**其他操作**

- `▶` 回放 / `■` 中途停止（回放中再次点击即停止，或按 Esc）
- `✎` 重命名，回车保存、Esc 取消
- `⤓` 导出为 JSON 文件（可分享、可导入到另一台机器）
- `✕` 删除（需点两次确认）
- **导入**：读取导出的 JSON
- **清空**：删除全部录制（需点两次确认）

**边界行为**

- 录制过程中切换页面 / 刷新，会自动把**已录到的部分**保存下来并结束录制
- 录制中关闭标签页同样会保存
- 浏览器内置页面（`chrome://`、扩展商店）无法注入脚本，会提示不支持

## 回放是怎么“复刻”的

回放不是简单的坐标点击，而是：

1. **元素锚点**：每个事件除了记录视口坐标，还记录了目标元素的选择器，以及鼠标在该元素矩形内的相对位置（0~1）。
   回放时优先按「元素当前矩形 + 相对位置」重新计算坐标，因此窗口大小变化、页面轻微改版后仍能点中同一个按钮。
2. **选择器回退**：元素找不到或尺寸变化过大时，退回使用录制的绝对坐标。
3. **完整事件序列**：点击会依次派发 `pointerdown → mousedown → focus → pointerup → mouseup → click`，
   与真实浏览器一致；点击前还会补发 `pointerover / mouseover / mouseenter`，让依赖悬停的下拉菜单先展开。
4. **滚动**：滚轮事件用于触发页面自己的 wheel 逻辑，实际位置由录制的 `scroll` 事件直接设定。
5. **时间线**：按 `t / 速度` 精确调度，误差控制在约 5~10ms。

## 已知限制

| 限制 | 说明 |
| --- | --- |
| CSS `:hover` | 浏览器不允许脚本触发纯 CSS 悬停效果。已补发 hover 系列事件，**JS 驱动**的菜单正常，**纯 CSS** 的悬停菜单可能不展开 |
| 原生拖拽 | HTML5 `draggable` 拖放、文件拖入无法复刻；JS 自己实现的拖拽（如滑块）可以 |
| 文件选择框 | 出于安全无法自动选择文件 |
| `isTrusted` | 合成事件的 `isTrusted` 为 `false`，少数强校验的站点（支付、验证码、部分网银）会忽略 |
| iframe | 只录制顶层文档，跨域 iframe 内部的操作不录制（顶层可滚动容器正常） |
| 页面结构大改 | 选择器按 `tag:nth-of-type` 路径生成，DOM 结构变化过大时只能按绝对坐标回退 |
| 输入长度 | 单个输入框的值最多记录 5000 字符 |
| 存储上限 | `chrome.storage.local` 约 10MB，最多保留 60 条录制；鼠标移动按 24ms 采样，长录制体积较大 |

## 隐私

- 所有录制数据只保存在浏览器本地 `chrome.storage.local`，不会上传
- **密码框、隐私字段的输入内容同样会被记录**，请勿在敏感页面录制，或先关闭「键盘输入」
- 导出的 JSON 含完整操作轨迹与输入内容，分享前请自行检查

## 目录结构

```
mouse-recorder-extension/
├── manifest.json      # MV3 清单
├── background.js      # 后台：录制缓冲区、存储、标签页注入、状态广播
├── content.js         # 内容脚本：事件采集 + 回放引擎 + 页面悬浮条
├── popup.html/css/js  # 弹窗：录制控制、设置、录制列表管理
├── icons/             # 图标（由 tools/make-icons.js 生成）
├── tools/make-icons.js
└── tests/             # 自动化测试（见下）
```

## 数据格式（导出 JSON）

```jsonc
{
  "format": "mouse-recorder-extension",
  "version": 1,
  "name": "页面标题 · 2026-10-27 14:32:10",
  "createdAt": 1793065931041,
  "url": "https://example.com/page",
  "duration": 8420,                       // 毫秒
  "events": [
    { "type": "move",  "t": 12,  "x": 320, "y": 210, "sel": "#submit", "rx": 0.5, "ry": 0.5, "rw": 96, "rh": 32 },
    { "type": "down",  "t": 340, "x": 320, "y": 210, "button": 0, "buttons": 1, "detail": 1 },
    { "type": "up",    "t": 420, "x": 320, "y": 210, "button": 0, "buttons": 0, "detail": 1 },
    { "type": "click", "t": 425, "x": 320, "y": 210, "button": 0, "detail": 1 },
    { "type": "wheel", "t": 900, "x": 600, "y": 400, "dx": 0, "dy": 120, "dm": 0 },
    { "type": "scroll","t": 940, "x": 0,   "y": 120, "sel": null },
    { "type": "input", "t": 1200, "sel": "#email", "value": "a@b.com", "ss": 7, "se": 7, "it": "insertText" }
  ],
  "meta": { "initialScroll": { "x": 0, "y": 0 }, "viewport": { "w": 1512, "h": 860, "dpr": 2 } }
}
```

事件类型：`move` `down` `up` `click` `dblclick` `contextmenu` `wheel` `scroll` `key` `input` `select` `check`

## 自动化测试

测试需要两个开发依赖（不是运行时依赖）：

```bash
cd mouse-recorder-extension
npm i --no-save puppeteer-core jsdom
```

| 命令 | 覆盖内容 |
| --- | --- |
| `node tests/bg-test.js` | 用模拟 chrome API 跑 background.js：录制缓冲、保存、回放、跳转/关闭收尾、异常路径（20 项） |
| `node tests/popup-test.js` | jsdom 跑 popup.js：列表渲染、录制/停止、回放参数、重命名、两步删除、清空（22 项） |
| `node tests/e2e.js` | 真实 Chrome 里录制一次「移动→点击→输入→滚动」再回放，校验业务逻辑、坐标一致性、事件顺序（22 项） |

`e2e.js` 默认使用 `C:\Program Files\Google\Chrome\Application\chrome.exe`，可用环境变量 `CHROME_PATH` 覆盖。

## 二次开发提示

- 想增加**键盘快捷键录制**：在 `content.js` 的 `onKeyDown` 里放开 `KEY_WHITELIST` 限制（注意普通字符已由 `input` 事件覆盖，重复记录会产生双份输入）
- 想支持**跨页面录制**：需要把 `state` 落到 `chrome.storage.session`，并在 `chrome.tabs.onUpdated` 后重新注入并继续录制
- 想支持**多标签页批量回放**：在 background 里对多个 `tabId` 依次调用 `PLAY`
