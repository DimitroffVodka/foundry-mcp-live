/**
 * Minimal PNG decode + pixel diff, so a render compare can say how much
 * changed instead of whether the bytes match. Two renders of the same window
 * differ by a few ±1 pixels at anti-aliased corners, which byte equality
 * reports as a change.
 *
 * It can also write a highlight image (the head render dimmed, changed pixels
 * in red, their bounding box outlined) so a reader can see WHERE it moved.
 *
 * Handles what Chromium screenshots are: 8-bit RGB / RGBA, non-interlaced.
 * Anything else decodes to null and the caller falls back to byte equality.
 * Chunk CRCs are not checked — the bytes come straight from our own render.
 */
import { deflateSync, inflateSync } from "node:zlib";

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

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, body) {
  const out = Buffer.alloc(12 + body.length);
  out.writeUInt32BE(body.length, 0);
  out.write(type, 4, "latin1");
  body.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length);
  return out;
}
/** Encode 8-bit RGB (channels 3) or RGBA (4) pixel data as a PNG, filter 0. */
export function encodePng(width, height, channels, data) {
  const stride = width * channels, rows = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) data.copy(rows, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = channels === 4 ? 6 : 2;
  return Buffer.concat([SIGNATURE, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}

// The head render at 35% brightness so the changed pixels stand out, changed
// pixels in red, and a 2px-padded yellow box round the lot (single pixels are
// otherwise invisible in a downscaled view).
function highlight(head, mask, bbox) {
  const { width, height, channels, data } = head;
  const out = Buffer.from(data);
  for (let o = 0; o < out.length; o += channels) {
    out[o] = out[o] * 0.35; out[o + 1] = out[o + 1] * 0.35; out[o + 2] = out[o + 2] * 0.35;
  }
  const put = (x, y, r, g, b) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const o = (y * width + x) * channels;
    out[o] = r; out[o + 1] = g; out[o + 2] = b;
  };
  const x0 = bbox.x - 2, y0 = bbox.y - 2, x1 = bbox.x + bbox.w + 1, y1 = bbox.y + bbox.h + 1;
  for (let x = x0; x <= x1; x++) { put(x, y0, 255, 214, 0); put(x, y1, 255, 214, 0); }
  for (let y = y0; y <= y1; y++) { put(x0, y, 255, 214, 0); put(x1, y, 255, 214, 0); }
  for (let i = 0; i < mask.length; i++) if (mask[i]) put(i % width, Math.floor(i / width), 255, 0, 60);
  return encodePng(width, height, channels, out);
}

/**
 * Compare two PNG buffers. A pixel counts as changed when any channel moves by
 * more than `threshold` (of 255); the default ignores anti-aliasing noise.
 * With `highlight: true` a result that has changed pixels also carries `highlight`, a PNG buffer.
 * @returns {{sizeChanged:true,a:string,b:string}
 *          |{sizeChanged:false,changed:number,total:number,bbox:{x:number,y:number,w:number,h:number}|null,highlight?:Buffer}
 *          |null} null when either image is not a PNG this module can decode.
 */
export function diffPng(bufA, bufB, { threshold = 8, highlight: wantHighlight = false } = {}) {
  const a = decodePng(bufA), b = decodePng(bufB);
  if (!a || !b) return null;
  if (a.width !== b.width || a.height !== b.height) {
    return { sizeChanged: true, a: `${a.width}x${a.height}`, b: `${b.width}x${b.height}` };
  }
  const { width, height, channels } = a;
  let changed = 0, minX = width, minY = height, maxX = -1, maxY = -1;
  const mask = wantHighlight ? new Uint8Array(width * height) : null;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * channels;
      let moved = false;
      for (let c = 0; c < channels; c++) if (Math.abs(a.data[o + c] - b.data[o + c]) > threshold) { moved = true; break; }
      if (!moved) continue;
      changed++;
      if (mask) mask[y * width + x] = 1;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  const bbox = changed ? { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 } : null;
  const result = { sizeChanged: false, changed, total: width * height, bbox };
  if (mask && changed) result.highlight = highlight(b, mask, bbox);
  return result;
}

// The harness page's background is a neutral gray texture (r=g=b, luminance
// ~26-38, measured); a window never is. The check overlay sits bottom-right.
const isBackground = (r, g, b) => Math.max(r, g, b) - Math.min(r, g, b) <= 1 && r >= 22 && r <= 42;

/**
 * Crop same-sized harness renders to the window: the union of every image's
 * non-background area (the check overlay corner ignored) plus a margin.
 * Returns the originals when an image cannot be decoded or has no content.
 * @param {Buffer[]} pngs  renders of one fixture, same dimensions (null entries pass through)
 * @param {number[]} [opts.measure]  which indices define the crop (default all); the rest are cropped
 *   to the same rectangle — a dimmed diff image must not be measured, its background is no longer gray
 */
export function cropToContent(pngs, { margin = 12, overlayW = 376, overlayH = 160, measure } = {}) {
  const decoded = pngs.map((b) => (b ? decodePng(b) : null));
  const real = decoded.filter(Boolean);
  if (!real.length || real.some((d) => d.width !== real[0].width || d.height !== real[0].height)) return pngs;
  const { width, height, channels } = real[0];
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (const d of decoded.filter((d, i) => d && (!measure || measure.includes(i)))) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (x >= width - overlayW && y >= height - overlayH) continue;
        const o = (y * width + x) * channels;
        if (isBackground(d.data[o], d.data[o + 1], d.data[o + 2])) continue;
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return pngs;
  x0 = Math.max(0, x0 - margin); y0 = Math.max(0, y0 - margin);
  x1 = Math.min(width - 1, x1 + margin); y1 = Math.min(height - 1, y1 + margin);
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  return decoded.map((d, i) => {
    if (!d) return pngs[i];
    const out = Buffer.alloc(w * h * channels);
    for (let y = 0; y < h; y++) d.data.copy(out, y * w * channels, ((y0 + y) * width + x0) * channels, ((y0 + y) * width + x0 + w) * channels);
    return encodePng(w, h, channels, out);
  });
}
