/**
 * Minimal PNG decode + pixel diff, so a render compare can say how much
 * changed instead of whether the bytes match. Two renders of the same window
 * differ by a few ±1 pixels at anti-aliased corners, which byte equality
 * reports as a change.
 *
 * Handles what Chromium screenshots are: 8-bit RGB / RGBA, non-interlaced.
 * Anything else decodes to null and the caller falls back to byte equality.
 * Chunk CRCs are not checked — the bytes come straight from our own render.
 */
import { inflateSync } from "node:zlib";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function paeth(a, b, c) {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** @returns {{width:number,height:number,channels:number,data:Buffer}|null} data is row-major, filter bytes removed. */
export function decodePng(buf) {
  if (buf.length < 33 || !buf.subarray(0, 8).equals(SIGNATURE)) return null;
  let width, height, channels;
  const idat = [];
  for (let pos = 8; pos + 8 <= buf.length;) {
    const len = buf.readUInt32BE(pos), type = buf.toString("latin1", pos + 4, pos + 8);
    const body = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      const [depth, colorType, , , interlace] = [body[8], body[9], body[10], body[11], body[12]];
      if (depth !== 8 || interlace !== 0 || (colorType !== 2 && colorType !== 6)) return null;
      width = body.readUInt32BE(0); height = body.readUInt32BE(4); channels = colorType === 6 ? 4 : 3;
    } else if (type === "IDAT") idat.push(body);
    else if (type === "IEND") break;
    pos += 12 + len;
  }
  if (!width || !idat.length) return null;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  if (raw.length !== height * (stride + 1)) return null;
  const data = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)], src = y * (stride + 1) + 1, dst = y * stride;
    for (let i = 0; i < stride; i++) {
      const left = i >= channels ? data[dst + i - channels] : 0;
      const up = y ? data[dst - stride + i] : 0;
      const upLeft = y && i >= channels ? data[dst - stride + i - channels] : 0;
      const x = raw[src + i];
      data[dst + i] = filter === 0 ? x
        : filter === 1 ? x + left
        : filter === 2 ? x + up
        : filter === 3 ? x + ((left + up) >> 1)
        : filter === 4 ? x + paeth(left, up, upLeft)
        : x; // unknown filter byte: leave the row as-is
    }
  }
  return { width, height, channels, data };
}

/**
 * Compare two PNG buffers. A pixel counts as changed when any channel moves by
 * more than `threshold` (of 255); the default ignores anti-aliasing noise.
 * @returns {{sizeChanged:true,a:string,b:string}
 *          |{sizeChanged:false,changed:number,total:number,bbox:{x:number,y:number,w:number,h:number}|null}
 *          |null} null when either image is not a PNG this module can decode.
 */
export function diffPng(bufA, bufB, { threshold = 8 } = {}) {
  const a = decodePng(bufA), b = decodePng(bufB);
  if (!a || !b) return null;
  if (a.width !== b.width || a.height !== b.height) {
    return { sizeChanged: true, a: `${a.width}x${a.height}`, b: `${b.width}x${b.height}` };
  }
  const { width, height, channels } = a;
  let changed = 0, minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * channels;
      let moved = false;
      for (let c = 0; c < channels; c++) if (Math.abs(a.data[o + c] - b.data[o + c]) > threshold) { moved = true; break; }
      if (!moved) continue;
      changed++;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  return {
    sizeChanged: false, changed, total: width * height,
    bbox: changed ? { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 } : null,
  };
}
