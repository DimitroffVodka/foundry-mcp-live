import test from "node:test";
import assert from "node:assert/strict";

import { PREVIEW_WINDOW_ID, designPreview, validatePreviewParams } from "../../module/scripts/design-preview.js";
import { callPreview } from "../tools/server-local.js";

// Stub just enough of Foundry for the handler: a DialogV2 that records its config,
// the instances map, game, document and window.
function foundryStub({ ready = true } = {}) {
  const made = [], instances = new Map(), styles = new Map();
  class DialogV2 {
    constructor(cfg) { this.cfg = cfg; this.closed = false; made.push(this); }
    async render() {
      this.element = { classList: { added: [], add: (...c) => this.element.classList.added.push(...c) }, style: {} };
      instances.set(this.cfg.id, this);
    }
    async close() { this.closed = true; instances.delete(this.cfg.id); }
  }
  const prev = Object.fromEntries(["foundry", "game", "document", "window"].map((k) => [k, globalThis[k]]));
  globalThis.foundry = { applications: { api: { DialogV2 }, instances } };
  globalThis.game = { ready, i18n: { localize: (k) => `L(${k})` } };
  globalThis.document = {
    createElement: () => ({ set textContent(v) { this._t = v; }, get textContent() { return this._t; } }),
    head: { appendChild: (el) => styles.set(el.id, el) },
    getElementById: (id) => (styles.has(id) ? { remove: () => styles.delete(id) } : null),
  };
  globalThis.window = { innerHeight: 1000 };
  return { made, instances, styles, restore: () => { for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete globalThis[k]; else globalThis[k] = v; } } };
}

test("designPreview opens a DialogV2 with the markup as a STRING, the css, classes and a pinned height", async () => {
  const f = foundryStub();
  try {
    const r = await designPreview({ html: "<p data-action=\"x\">hi</p>", css: ".a{color:red}", title: "T", classes: ["sde-ui", "x"], width: 333 });
    assert.deepEqual(r, { opened: true, id: PREVIEW_WINDOW_ID, title: "T", classes: ["sde-ui", "x"], width: 333 });
    const app = f.made[0];
    assert.equal(typeof app.cfg.content, "string", "a string, so DialogV2 runs it through cleanHTML");
    assert.equal(app.cfg.content, "<p data-action=\"x\">hi</p>");
    assert.equal(app.cfg.id, PREVIEW_WINDOW_ID);
    assert.equal(app.cfg.position.width, 333);
    assert.equal(app.cfg.buttons.length, 1, "DialogV2 refuses to construct without a button");
    assert.deepEqual(app.element.classList.added, ["sde-ui", "x"]);
    assert.equal(app.element.style.height, "auto");
    assert.equal(app.element.style.maxHeight, "850px");
    const css = f.styles.get(`${PREVIEW_WINDOW_ID}-css`).textContent;
    assert.ok(css.startsWith(".a{color:red}") && css.includes(".form-footer { display: none; }"));
  } finally { f.restore(); }
});

test("designPreview replaces an open preview, and close removes the window and its stylesheet", async () => {
  const f = foundryStub();
  try {
    await designPreview({ html: "<p>1</p>", css: "a{}" });
    await designPreview({ html: "<p>2</p>" });
    assert.equal(f.made.length, 2);
    assert.equal(f.made[0].closed, true, "the first window was closed before the second opened");
    assert.equal(f.instances.size, 1);
    assert.deepEqual(await designPreview({ close: true }), { closed: true });
    assert.equal(f.instances.size, 0);
    assert.equal(f.styles.size, 0, "stylesheet removed with the window");
    assert.deepEqual(await designPreview({ close: true }), { closed: false }, "closing nothing is not an error");
  } finally { f.restore(); }
});

test("designPreview refuses bad input and a world that is not ready, without opening anything", async () => {
  const f = foundryStub();
  try {
    for (const bad of [{}, { html: "" }, { html: 5 }, { html: "x".repeat(1_000_001) }, { html: "x", css: 3 }, { html: "x", classes: ["a b"] },
      { html: "x", classes: "sde-ui" }, { html: "x", width: -1 }, { html: "x", title: 9 }]) {
      const r = await designPreview(bad);
      assert.equal(r.opened, false, JSON.stringify(bad).slice(0, 50));
      assert.ok(r.error);
    }
    assert.equal(f.made.length, 0);
  } finally { f.restore(); }
  const notReady = foundryStub({ ready: false });
  try { assert.match((await designPreview({ html: "<p>x</p>" })).error, /game\.ready is false/); } finally { notReady.restore(); }
  assert.equal(validatePreviewParams({ html: "<p>ok</p>", width: "420" }), null, "numeric strings are accepted for width");
});

test("callPreview uses the module handler and unwraps a result envelope", async () => {
  const calls = [];
  const request = async (tool, params, user) => { calls.push([tool, params, user]); return { opened: true }; };
  assert.deepEqual(await callPreview({ html: "x" }, () => { throw new Error("no fallback"); }, "u1", { request }), { opened: true });
  assert.deepEqual(calls, [["design_preview", { html: "x" }, "u1"]]);
  assert.deepEqual(await callPreview({ close: true }, null, "u", { request: async () => ({ result: { closed: true } }) }), { closed: true });
});

test("callPreview falls back to evaluate only for a module that predates the handler, and only if eval is allowed", async () => {
  const seen = [];
  const request = async (tool, params) => {
    seen.push(tool);
    if (tool === "design_preview") throw new Error("Unknown tool: design_preview");
    return { result: { opened: true, via: "evaluate", expression: params.expression } };
  };
  const r = await callPreview({ html: "x" }, () => "EXPR", "u", { request, allowEval: true });
  assert.deepEqual(seen, ["design_preview", "evaluate"]);
  assert.equal(r.expression, "EXPR");
  await assert.rejects(callPreview({ html: "x" }, () => "EXPR", "u", { request, allowEval: false }), /predates the design_preview handler.*deploy the current module/);
  // any other failure is the caller's, not a reason to run client JS
  const boom = async () => { throw new Error("socket closed"); };
  await assert.rejects(callPreview({ html: "x" }, () => "EXPR", "u", { request: boom, allowEval: true }), /socket closed/);
});
