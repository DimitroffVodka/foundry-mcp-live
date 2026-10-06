/**
 * A self-contained HTML gallery of design-harness renders: every variant, every
 * theme, base / head / diff side by side, with the layout checks. Images are
 * inlined as data URIs so the file can be opened from disk or sent as-is.
 *
 * Pure except for writeGallery. `entries` is
 *   [{ fixture, newInHead, themes: [{ theme, head, base?, verdict? }] }]
 * where head/base are { png: Buffer|null, check: string|null, error: string|null }
 * and verdict is { text, highlight?: Buffer } (see compareRuns in tools/server-local.js).
 */
import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const uri = (png) => `data:image/png;base64,${png.toString("base64")}`;

export function galleryDir() {
  return process.env.FOUNDRY_MCP_GALLERY_DIR ?? path.join(homedir(), ".cache", "foundry-mcp", "design-gallery");
}

// One line a reader can scan: is the layout check clean, or how many lines of trouble.
export function checkSummary(run) {
  if (!run || run.error) return "render failed";
  if (!run.check) return "no check";
  if (/no layout problems found/.test(run.check)) return "clean";
  const n = run.check.split("\n").slice(1).filter((l) => l.trim()).length;
  return `${n} issue line${n === 1 ? "" : "s"}`;
}

function figure(label, run, extra = "") {
  const img = run?.png
    ? `<img src="${uri(run.png)}" alt="${esc(label)}" loading="lazy">`
    : `<div class="missing">${esc(run?.error ?? "not rendered")}</div>`;
  return `<figure><figcaption>${esc(label)}${extra}</figcaption>${img}</figure>`;
}

export function buildGalleryHtml({ title, moduleDir, againstDir, width, entries, when = new Date() }) {
  const rows = [];
  const sections = entries.map((e) => {
    const themes = e.themes.map((t) => {
      const verdict = t.verdict?.text ?? (e.newInHead ? "new in head" : "");
      rows.push(`<tr><td><a href="#${esc(e.fixture)}">${esc(e.fixture)}</a></td><td>${esc(t.theme)}</td>`
        + `<td>${esc(checkSummary(t.head))}</td><td>${esc(verdict)}</td></tr>`);
      const figs = [
        t.base ? figure(`base — ${t.theme}`, t.base) : "",
        figure(`head — ${t.theme}`, t.head),
        t.verdict?.highlight ? figure(`diff — ${t.theme}`, { png: t.verdict.highlight }, " <small>changed pixels red, box yellow</small>") : "",
      ].join("");
      const check = t.head?.check ? `<pre>${esc(t.head.check)}</pre>` : "";
      const note = verdict ? `<p class="verdict">${esc(verdict)}</p>` : "";
      return `<div class="theme"><h3>${esc(t.theme)}</h3>${note}<div class="row">${figs}</div>${check}</div>`;
    }).join("");
    return `<section id="${esc(e.fixture)}"><h2>${esc(e.fixture)}</h2>${themes}</section>`;
  }).join("");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
:root{--bg:#f6f6f4;--fg:#1c1c1c;--muted:#666;--card:#fff;--line:#d8d8d4;--accent:#b3261e}
@media (prefers-color-scheme:dark){:root{--bg:#161616;--fg:#e8e8e6;--muted:#9a9a96;--card:#202020;--line:#383838;--accent:#ff6b5e}}
body{margin:0;padding:16px;background:var(--bg);color:var(--fg);font:15px/1.45 system-ui,sans-serif}
h1{margin:0 0 4px;font-size:22px}h2{margin:28px 0 8px;font-size:18px}h3{margin:14px 0 4px;font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
.meta{color:var(--muted);margin:0 0 16px;word-break:break-all}
table{border-collapse:collapse;width:100%;max-width:900px;background:var(--card)}
td,th{padding:6px 10px;border:1px solid var(--line);text-align:left;vertical-align:top}
a{color:var(--accent)}
section{padding-bottom:8px;border-bottom:1px solid var(--line)}
.row{display:flex;flex-wrap:wrap;gap:12px;align-items:flex-start}
figure{margin:0;max-width:100%;overflow-x:auto;background:var(--card);border:1px solid var(--line);border-radius:6px;padding:8px}
figcaption{font-size:12px;color:var(--muted);margin:0 0 6px}
img{display:block;max-width:100%;height:auto}
pre{margin:8px 0 0;padding:8px 10px;background:var(--card);border:1px solid var(--line);border-radius:6px;white-space:pre-wrap;font-size:12px}
.verdict{margin:0 0 6px;font-weight:600}.missing{padding:20px;color:var(--accent)}
</style></head><body>
<h1>${esc(title)}</h1>
<p class="meta">${esc(moduleDir)}${againstDir ? ` — compared against ${esc(againstDir)}` : ""}${width ? ` — ${esc(width)}px` : ""} — ${esc(when.toISOString())}</p>
<table><thead><tr><th>Variant</th><th>Theme</th><th>Layout check</th><th>${againstDir ? "Versus base" : "Note"}</th></tr></thead><tbody>${rows.join("")}</tbody></table>
${sections}
</body></html>
`;
}

/** Write the gallery under galleryDir(), keeping only the newest `keep` files. Returns the file path. */
export function writeGallery(html, name, { dir = galleryDir(), keep = 10 } = {}) {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name.replace(/[^\w.-]+/g, "_")}-${Date.now()}.html`);
  writeFileSync(file, html);
  const old = readdirSync(dir).filter((f) => f.endsWith(".html"))
    .map((f) => ({ f, t: statSync(path.join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t).slice(keep);
  for (const { f } of old) { try { unlinkSync(path.join(dir, f)); } catch { /* already gone */ } }
  return file;
}
