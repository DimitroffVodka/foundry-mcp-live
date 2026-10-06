import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

import { buildGalleryHtml, checkSummary, writeGallery } from "../lib/design-gallery.js";
import { encodePng } from "../lib/png-diff.js";
import { renderGalleryReport } from "../tools/server-local.js";

const png = (r) => encodePng(8, 8, 3, Buffer.alloc(8 * 8 * 3, r));
const run = (r, check = "visible buttons: 2   primary: 0\nno layout problems found") => ({ png: png(r), check, error: null });

test("checkSummary: clean, counted issue lines, and failures", () => {
  assert.equal(checkSummary(run(1)), "clean");
  assert.equal(checkSummary(run(1, "visible buttons: 2\nwindow scrolls sideways\nsticks out: button.x")), "2 issue lines");
  assert.equal(checkSummary(run(1, "visible buttons: 2\nwindow scrolls sideways")), "1 issue line");
  assert.equal(checkSummary({ png: null, check: null, error: "boom" }), "render failed");
});

test("buildGalleryHtml inlines images, escapes text, and shows base/head/diff plus a summary row", () => {
  const html = buildGalleryHtml({
    title: "mod: <b>x</b>", moduleDir: "/m", againstDir: "/base", width: 420,
    entries: [
      { fixture: "alpha", newInHead: false, themes: [{ theme: "dark", head: run(10, "visible <buttons>"), base: run(20),
        verdict: { text: "5 px changed (1.00%); layout check unchanged", highlight: png(255) } }] },
      { fixture: "beta", newInHead: true, themes: [{ theme: "light", head: run(30) }] },
    ],
  });
  assert.equal((html.match(/<img src="data:image\/png;base64,/g) ?? []).length, 4, "base+head+diff for alpha, head for beta");
  assert.ok(html.includes("mod: &lt;b&gt;x&lt;/b&gt;"), "title escaped");
  assert.ok(html.includes("visible &lt;buttons&gt;"), "check text escaped");
  assert.ok(!html.includes("<b>x</b>"));
  assert.match(html, /<th>Versus base<\/th>/);
  assert.match(html, /5 px changed \(1\.00%\)/);
  assert.match(html, /new in head/);
  assert.match(html, /compared against \/base — 420px/);
  assert.match(html, /prefers-color-scheme:dark/);
});

test("writeGallery keeps only the newest files", async () => {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "gal-"));
  try {
    // Not ours: must survive the prune even though they are .html and older than everything.
    for (const f of ["notes.html", "index.html", "report-final.html", "a-1.txt"]) fs.writeFileSync(path.join(dir, f), "keep me");
    for (const f of ["notes.html", "index.html", "report-final.html", "a-1.txt"]) fs.utimesSync(path.join(dir, f), new Date(2000, 0, 1), new Date(2000, 0, 1));
    const made = [];
    for (let i = 0; i < 4; i++) {
      made.push(writeGallery("<p>x</p>", "a b/c", { dir, keep: 2 }));
      fs.utimesSync(made[i], new Date(2026, 0, 1, 0, 0, i), new Date(2026, 0, 1, 0, 0, i));
      await new Promise((r) => setTimeout(r, 5));
    }
    const left = fs.readdirSync(dir);
    const ours = left.filter((f) => /^a_b_c-\d+\.html$/.test(f));
    assert.equal(ours.length, 2, "newest two of ours kept, name sanitised");
    assert.deepEqual(left.filter((f) => !ours.includes(f)).sort(), ["a-1.txt", "index.html", "notes.html", "report-final.html"],
      "files the tool did not write are never pruned");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// A fake harness (see design-render.test.js): shot.mjs writes the module's look.txt
// as the PNG and prints it as the check; a "b64:" look is decoded to real PNG bytes.
function rig(looks) {
  const root = fs.mkdtempSync(path.join(tmpdir(), "gal-rig-"));
  const mk = (name, fixtures) => {
    const dir = path.join(root, name);
    fs.mkdirSync(path.join(dir, "tools", "design-harness", "fixtures"), { recursive: true });
    fs.writeFileSync(path.join(dir, "module.json"), "{}");
    for (const [f, look] of Object.entries(fixtures)) {
      fs.writeFileSync(path.join(dir, "tools", "design-harness", "fixtures", `${f}.mjs`), "");
      fs.writeFileSync(path.join(dir, `look-${f}.txt`), look);
    }
    return dir;
  };
  const head = mk("head", looks.head), base = mk("base", looks.base ?? {});
  fs.writeFileSync(path.join(head, "tools", "design-harness", "shot.mjs"), `
    import fs from "node:fs"; import path from "node:path";
    const dir = process.env.MODULE_DIR ?? path.resolve(import.meta.dirname, "../..");
    const look = fs.readFileSync(path.join(dir, "look-" + process.argv[2] + ".txt"), "utf8");
    fs.writeFileSync(process.argv[3], look.startsWith("b64:") ? Buffer.from(look.slice(4), "base64") : look);
    console.log("design harness: fake"); console.log(process.argv[3]); console.log(look.startsWith("b64:") ? "visible buttons: 1\\nno layout problems found" : look);`);
  return { root, head, base, harness: path.join(head, "tools", "design-harness"), gallery: path.join(root, "out") };
}
async function withGalleryEnv(r, fn) {
  const prev = [process.env.FOUNDRY_DESIGN_HARNESS, process.env.FOUNDRY_MCP_GALLERY_DIR];
  process.env.FOUNDRY_DESIGN_HARNESS = r.harness; process.env.FOUNDRY_MCP_GALLERY_DIR = r.gallery;
  try { return await fn(); } finally {
    for (const [i, k] of ["FOUNDRY_DESIGN_HARNESS", "FOUNDRY_MCP_GALLERY_DIR"].entries()) {
      if (prev[i] === undefined) delete process.env[k]; else process.env[k] = prev[i];
    }
  }
}
const b64 = (r) => "b64:" + png(r).toString("base64");

test("renderGalleryReport renders every variant and writes one gallery page with the diff", async () => {
  const r = rig({ head: { a: b64(250), b: b64(40) }, base: { a: b64(40), b: b64(40) } });
  try {
    const out = await withGalleryEnv(r, () => renderGalleryReport({ fixtures: ["a", "b"], against: r.base }));
    assert.equal(out.content.filter((c) => c.type === "image").length, 3, "a head + a diff + b head (b did not move)");
    const final = out.content.at(-1).text;
    assert.match(final, /Rendered 2 variant\(s\)/);
    assert.match(final, /a \[dark\]: clean \| \d+ px changed/);
    assert.match(final, /b \[dark\]: clean \| pixels identical/);
    const file = final.match(/self-contained\): (\S+\.html)/)[1];
    const html = fs.readFileSync(file, "utf8");
    assert.ok(file.startsWith(r.gallery));
    assert.equal((html.match(/<img /g) ?? []).length, 5, "a: base+head+diff, b: base+head");
    assert.match(html, /id="a"/); assert.match(html, /id="b"/);
  } finally { fs.rmSync(r.root, { recursive: true, force: true }); }
});

test("renderGalleryReport validates all variants before rendering, and bounds the count", async () => {
  const r = rig({ head: { a: "x" } });
  try {
    const typo = await withGalleryEnv(r, () => renderGalleryReport({ fixtures: ["a", "nope"] }));
    assert.match(typo.content[0].text, /^nope: Error: no fixture `nope`/);
    assert.ok(!fs.existsSync(r.gallery), "nothing rendered or written");
    const many = await withGalleryEnv(r, () => renderGalleryReport({ fixtures: Array.from({ length: 9 }, (_, i) => `f${i}`) }));
    assert.match(many.content[0].text, /at most 8 variants/);
    const rel = await withGalleryEnv(r, () => renderGalleryReport({ fixtures: ["a"], against: "rel" }));
    assert.match(rel.content[0].text, /^a: against: Error: `module` must be an absolute path/);
  } finally { fs.rmSync(r.root, { recursive: true, force: true }); }
});

test("renderGalleryReport without against shows head only and marks nothing new", async () => {
  const r = rig({ head: { a: b64(90), b: b64(91) } });
  try {
    const out = await withGalleryEnv(r, () => renderGalleryReport({ fixtures: ["a", "a", "b"], theme: "both" }));
    assert.equal(out.content.filter((c) => c.type === "image").length, 4, "2 variants (dedup) x 2 themes");
    const file = out.content.at(-1).text.match(/(\S+\.html)$/)[1];
    const html = fs.readFileSync(file, "utf8");
    assert.ok(!html.includes("new in head") && !html.includes("Versus base"));
  } finally { fs.rmSync(r.root, { recursive: true, force: true }); }
});
