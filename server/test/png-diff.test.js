import test from "node:test";
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";

import { decodePng, diffPng } from "../lib/png-diff.js";
import { compareVerdict } from "../tools/server-local.js";

// Encoder for tests only. The decoder never checks CRCs, so they are zeroed.
const paeth = (a, b, c) => {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};
function chunk(type, body) {
  const head = Buffer.alloc(8); head.writeUInt32BE(body.length, 0); head.write(type, 4, "latin1");
  return Buffer.concat([head, body, Buffer.alloc(4)]);
}
/** px(x, y) -> [r,g,b(,a)]; filterFor(y) picks the filter byte per row. */
function encodePng(w, h, channels, px, filterFor = () => 0, colorType = channels === 4 ? 6 : 2) {
  const stride = w * channels, rows = [];
  const pix = Array.from({ length: h }, (_, y) => Buffer.from(Array.from({ length: w }, (_, x) => px(x, y)).flat()));
  for (let y = 0; y < h; y++) {
    const f = filterFor(y), out = Buffer.alloc(stride + 1); out[0] = f;
    for (let i = 0; i < stride; i++) {
      const left = i >= channels ? pix[y][i - channels] : 0, up = y ? pix[y - 1][i] : 0;
      const upLeft = y && i >= channels ? pix[y - 1][i - channels] : 0;
      const pred = [0, left, up, (left + up) >> 1, paeth(left, up, upLeft)][f];
      out[i + 1] = (pix[y][i] - pred) & 255;
    }
    rows.push(out);
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = colorType;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.concat(rows))), chunk("IEND", Buffer.alloc(0))]);
}

const gradient = (x, y) => [(x * 37 + y * 11) & 255, (x * 5 + y * 91) & 255, (x ^ y) * 13 & 255];

test("decodePng round-trips every filter type, RGB and RGBA", () => {
  for (const channels of [3, 4]) {
    const px = (x, y) => (channels === 4 ? [...gradient(x, y), (x + y * 3) & 255] : gradient(x, y));
    const want = Buffer.from(Array.from({ length: 5 * 7 }, (_, i) => px(i % 5, Math.floor(i / 5))).flat());
    for (const f of [0, 1, 2, 3, 4]) {
      const d = decodePng(encodePng(5, 7, channels, px, () => f));
      assert.equal(d.channels, channels);
      assert.ok(d.data.equals(want), `filter ${f}, ${channels} channels`);
    }
    // Chromium mixes filters row by row.
    assert.ok(decodePng(encodePng(5, 7, channels, px, y => y % 5)).data.equals(want));
  }
});

test("diffPng ignores anti-aliasing noise and counts real movement with its bounding box", () => {
  const base = encodePng(20, 10, 3, () => [40, 40, 40]);
  const noisy = encodePng(20, 10, 3, (x, y) => (x === 0 && y === 0 ? [41, 39, 40] : [40, 40, 40]));
  assert.deepEqual(diffPng(base, noisy), { sizeChanged: false, changed: 0, total: 200, bbox: null });
  assert.equal(diffPng(base, noisy, { threshold: 0 }).changed, 1);

  const moved = encodePng(20, 10, 3, (x, y) => (x >= 5 && x < 8 && y >= 2 && y < 4 ? [200, 40, 40] : [40, 40, 40]));
  assert.deepEqual(diffPng(base, moved), { sizeChanged: false, changed: 6, total: 200, bbox: { x: 5, y: 2, w: 3, h: 2 } });
});

test("diffPng reports a size change and returns null for what it cannot decode", () => {
  const a = encodePng(20, 10, 3, () => [0, 0, 0]), b = encodePng(20, 12, 3, () => [0, 0, 0]);
  assert.deepEqual(diffPng(a, b), { sizeChanged: true, a: "20x10", b: "20x12" });
  assert.equal(diffPng(Buffer.from("not a png"), a), null);
  assert.equal(diffPng(a, encodePng(2, 2, 1, () => [0], () => 0, 3)), null); // palette PNG
});

test("compareVerdict reads noise as identical and real movement as a changed-pixel count", () => {
  const side = (png, check = "visible buttons: 3") => ({ png, check, error: null });
  const flat = encodePng(100, 100, 3, () => [40, 40, 40]);
  const noisy = encodePng(100, 100, 3, (x, y) => (x === 0 && y === 0 ? [41, 40, 40] : [40, 40, 40]));
  const block = encodePng(100, 100, 3, (x, y) => (x < 10 && y < 10 ? [250, 0, 0] : [40, 40, 40]));
  assert.equal(compareVerdict(side(flat), side(flat)), "pixels identical; layout check unchanged");
  assert.equal(compareVerdict(side(flat), side(noisy)), "pixels identical (within anti-aliasing noise); layout check unchanged");
  assert.equal(compareVerdict(side(flat), side(block)),
    "100 px changed (1.00%), in a 10x10 area at 0,0; layout check unchanged");
  assert.match(compareVerdict(side(flat), side(encodePng(100, 90, 3, () => [40, 40, 40]))), /^size changed 100x100 -> 100x90;/);
  assert.match(compareVerdict(side(flat, "a"), side(flat, "b")), /layout check CHANGED\n  base: a\n  head: b$/);
  assert.match(compareVerdict(side(flat), { png: null, check: null, error: "x" }), /not comparable/);
});
