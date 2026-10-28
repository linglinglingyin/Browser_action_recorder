'use strict';

/**
 * 生成扩展图标（无第三方依赖，纯手写 PNG 编码 + 4x4 超采样抗锯齿）
 * 用法: node tools/make-icons.js
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/* ---------------- PNG 编码 ---------------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePNG(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* ---------------- 图形 ---------------- */

function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  return Math.min(Math.max(qx, qy), 0) + outside - r;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function mix(c1, c2, t) {
  return [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)];
}

function render(size) {
  const S = size;
  const buf = Buffer.alloc(S * S * 4);
  const SUB = 4;
  const samples = SUB * SUB;

  const cx = S / 2;
  const cy = S / 2;
  const pad = S * 0.045;
  const hw = S / 2 - pad;
  const hh = S / 2 - pad;
  const radius = S * 0.26;

  const dotR = S * 0.245;
  const dotCy = cy;

  const bgTop = [42, 47, 60];
  const bgBottom = [16, 18, 24];
  const dotTop = [240, 90, 95];
  const dotBottom = [200, 52, 58];

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;

      for (let sy = 0; sy < SUB; sy++) {
        for (let sx = 0; sx < SUB; sx++) {
          const px = x + (sx + 0.5) / SUB;
          const py = y + (sy + 0.5) / SUB;

          const dBg = sdRoundRect(px, py, cx, cy, hw, hh, radius);
          if (dBg > 0) continue; // 圆角外透明

          let col = mix(bgTop, bgBottom, py / S);

          const dDot = Math.hypot(px - cx, py - dotCy) - dotR;
          if (dDot <= 0) {
            col = mix(dotTop, dotBottom, (py - (dotCy - dotR)) / (dotR * 2));
            // 中心高光
            const hi = Math.max(0, 1 - Math.hypot(px - cx, py - (dotCy - dotR * 0.35)) / (dotR * 1.1));
            col = mix(col, [255, 150, 154], hi * 0.35);
          }

          r += col[0];
          g += col[1];
          b += col[2];
          a += 255;
        }
      }

      const i = (y * S + x) * 4;
      const n = samples;
      const alpha = a / n;
      if (alpha > 0) {
        // 颜色按已覆盖样本数平均（未覆盖样本按 0 计，避免边缘发黑时改用 alpha 加权）
        const cov = a / 255;
        buf[i] = Math.round(r / cov);
        buf[i + 1] = Math.round(g / cov);
        buf[i + 2] = Math.round(b / cov);
        buf[i + 3] = Math.round(alpha);
      }
    }
  }

  return encodePNG(S, S, buf);
}

const outDir = path.join(__dirname, '..', 'icons');
fs.mkdirSync(outDir, { recursive: true });

for (const size of [16, 32, 48, 128]) {
  const png = render(size);
  const file = path.join(outDir, `icon${size}.png`);
  fs.writeFileSync(file, png);
  console.log(`wrote ${file} (${png.length} bytes)`);
}
