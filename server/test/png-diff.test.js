import test from "node:test";
import assert from "node:assert/strict";
import * as zlib from "node:zlib";
import { deflateSync } from "node:zlib";

import { cropToContent, decodePng, diffPng, encodePng as libEncodePng } from "../lib/png-diff.js";
import { compareVerdict, compareRuns } from "../tools/server-local.js";

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

test("encodePng writes a valid PNG: it decodes back and every chunk CRC is right", () => {
  const data = Buffer.from(Array.from({ length: 6 * 4 }, (_, i) => [i * 10 & 255, i * 7 & 255, 200, 255]).flat());
  const png = libEncodePng(6, 4, 4, data);
  const d = decodePng(png);
  assert.deepEqual([d.width, d.height, d.channels], [6, 4, 4]);
  assert.ok(d.data.equals(data));
  if (typeof zlib.crc32 === "function") {
    for (let pos = 8; pos < png.length;) {
      const len = png.readUInt32BE(pos);
      assert.equal(png.readUInt32BE(pos + 8 + len), zlib.crc32(png.subarray(pos + 4, pos + 8 + len)), png.toString("latin1", pos + 4, pos + 8));
      pos += 12 + len;
    }
  }
});

test("diffPng highlight marks changed pixels red, outlines their box, dims the rest", () => {
  const base = encodePng(20, 10, 3, () => [40, 40, 40]);
  const moved = encodePng(20, 10, 3, (x, y) => (x >= 5 && x < 8 && y >= 2 && y < 4 ? [200, 40, 40] : [40, 40, 40]));
  assert.equal("highlight" in diffPng(base, moved), false, "off unless asked for");
  const d = diffPng(base, moved, { highlight: true });
  assert.equal(d.changed, 6);
  const h = decodePng(d.highlight), at = (x, y) => [...h.data.subarray((y * 20 + x) * 3, (y * 20 + x) * 3 + 3)];
  assert.deepEqual(at(5, 2), [255, 0, 60]);   // a changed pixel
  assert.deepEqual(at(3, 0), [255, 214, 0]);  // box corner: bbox 5,2 3x2 padded by 2
  assert.deepEqual(at(9, 5), [255, 214, 0]);  // opposite corner
  assert.deepEqual(at(15, 8), [14, 14, 14]);  // untouched pixel, dimmed to 35%
  assert.equal("highlight" in diffPng(base, base, { highlight: true }), false, "nothing changed, nothing to show");
});

test("compareRuns carries the highlight only when pixels really moved", () => {
  const side = (png) => ({ png, check: "c", error: null });
  const flat = encodePng(30, 30, 3, () => [40, 40, 40]);
  const block = encodePng(30, 30, 3, (x, y) => (x < 4 && y < 4 ? [250, 0, 0] : [40, 40, 40]));
  const noisy = encodePng(30, 30, 3, (x, y) => (!x && !y ? [41, 40, 40] : [40, 40, 40]));
  assert.ok(Buffer.isBuffer(compareRuns(side(flat), side(block)).highlight));
  assert.equal(compareRuns(side(flat), side(noisy)).highlight, undefined);
  assert.equal(compareRuns(side(flat), side(flat)).highlight, undefined);
});

test("cropToContent crops to the window plus a margin and ignores the check-overlay corner", () => {
  const bg = [30, 30, 30], win = [13, 12, 20], overlay = [0, 0, 0];
  const page = (px) => encodePng(500, 300, 3, px);
  const base = (x, y) => (x >= 50 && x < 80 && y >= 40 && y < 70 ? win : x >= 400 && y >= 250 ? overlay : bg);
  const shifted = (x, y) => (x >= 60 && x < 100 && y >= 40 && y < 70 ? win : x >= 400 && y >= 250 ? overlay : bg);
  const [a, b] = cropToContent([page(base), page(shifted)]);
  const da = decodePng(a), db = decodePng(b);
  // union of both windows (x 50..99, y 40..69) + 12px margin; overlay at x>=400,y>=250 ignored
  assert.deepEqual([da.width, da.height], [74, 54]);
  assert.deepEqual([db.width, db.height], [74, 54]);
  assert.deepEqual([...da.data.subarray(0, 3)], bg);
  assert.deepEqual([...da.data.subarray(((12 * 74) + 12) * 3, ((12 * 74) + 12) * 3 + 3)], win); // window's top-left sits at the margin
});

test("cropToContent measures only the indices asked for, so a dimmed diff image does not widen the crop", () => {
  const win = (x, y) => (x >= 50 && x < 80 && y >= 40 && y < 70 ? [200, 20, 20] : [30, 30, 30]);
  const dimmed = (x, y) => (x >= 50 && x < 80 && y >= 40 && y < 70 ? [70, 7, 7] : [10, 10, 10]); // background no longer gray
  const [head, diff] = cropToContent([encodePng(500, 300, 3, win), encodePng(500, 300, 3, dimmed)], { measure: [0] });
  assert.deepEqual([decodePng(head).width, decodePng(head).height], [54, 54]);
  assert.deepEqual([decodePng(diff).width, decodePng(diff).height], [54, 54]);
  const [, wide] = cropToContent([encodePng(500, 300, 3, win), encodePng(500, 300, 3, dimmed)]);
  assert.equal(decodePng(wide).width, 500 - 0, "unmeasured default would have kept the whole page");
});

test("cropToContent passes through what it cannot crop", () => {
  const flat = encodePng(40, 40, 3, () => [30, 30, 30]);
  assert.deepEqual(cropToContent([flat, null]), [flat, null], "all background: nothing to crop to");
  assert.deepEqual(cropToContent([Buffer.from("nope")]), [Buffer.from("nope")]);
  const other = encodePng(40, 30, 3, () => [200, 0, 0]);
  assert.deepEqual(cropToContent([encodePng(40, 40, 3, () => [200, 0, 0]), other]).length, 2, "mixed sizes pass through");
});
