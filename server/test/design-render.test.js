import test from "node:test";
import assert from "node:assert/strict";
import { homedir, tmpdir } from "node:os";
import fs from "node:fs";
import path from "node:path";

import {
  designHarnessDir,
  designHarnessReady,
  designRenderTarget,
  buildDesignRenderInvocation,
  validateDesignTarget,
  fetchFixtureFragment,
  renderFixtureReport,
  buildPreviewOpenExpression,
  buildPreviewCloseExpression,
  PREVIEW_WINDOW_ID,
} from "../tools/server-local.js";

// `render_fixture` shells out to a design harness on the server host; these
// cover the pure path/arg decisions. The spawn-and-render path is exercised
// against a real harness outside CI (see the tool's TOOLS.md section).

function withEnv(value, fn) {
  const prev = process.env.FOUNDRY_DESIGN_HARNESS;
  try {
    if (value === undefined) delete process.env.FOUNDRY_DESIGN_HARNESS;
    else process.env.FOUNDRY_DESIGN_HARNESS = value;
    return fn();
  } finally {
    if (prev === undefined) delete process.env.FOUNDRY_DESIGN_HARNESS;
    else process.env.FOUNDRY_DESIGN_HARNESS = prev;
  }
}

test("designHarnessDir honours FOUNDRY_DESIGN_HARNESS, else the default path", () => {
  withEnv("/x/custom-harness", () => {
    assert.equal(designHarnessDir(), "/x/custom-harness");
  });
  withEnv(undefined, () => {
    assert.equal(
      designHarnessDir(),
      path.join(homedir(), "git", "shadowdark-enhancer", "tools", "design-harness")
    );
  });
});

test("designHarnessReady is false when shot.mjs is absent", () => {
  withEnv(path.join(tmpdir(), `missing-harness-${Date.now()}`), () => {
    assert.equal(designHarnessReady(), false);
  });
});

test("designRenderTarget defaults to the harness's own module and resolves overrides", () => {
  withEnv("/x/mod/tools/design-harness", () => {
    const def = designRenderTarget({ fixture: "party" });
    assert.equal(def.moduleDir, "/x/mod");
    assert.equal(def.fixtureFile, "/x/mod/tools/design-harness/fixtures/party.mjs");
  });
  const over = designRenderTarget({ fixture: "crawl-tracker", module: "/other/mod" });
  assert.equal(over.moduleDir, "/other/mod");
  assert.equal(over.fixtureFile, "/other/mod/tools/design-harness/fixtures/crawl-tracker.mjs");
});

test("buildDesignRenderInvocation builds flags, MODULE_DIR and a private PORT", () => {
  withEnv("/x/mod/tools/design-harness", () => {
    const bare = buildDesignRenderInvocation({ fixture: "party" }, "/tmp/out.png");
    assert.deepEqual(bare.args, ["/x/mod/tools/design-harness/shot.mjs", "party", "/tmp/out.png"]);
    assert.equal(bare.env.MODULE_DIR, undefined);
    const port = Number(bare.env.PORT);
    assert.ok(Number.isInteger(port) && port >= 41000 && port < 49000, `PORT out of range: ${bare.env.PORT}`);

    const full = buildDesignRenderInvocation(
      { fixture: "party", module: "/other/mod", theme: "light", width: 420, state: "items" },
      "/tmp/out.png"
    );
    assert.deepEqual(full.args.slice(2), ["/tmp/out.png", "--theme=light", "--w=420", "--state=items"]);
    assert.equal(full.env.MODULE_DIR, "/other/mod");
  });
});

test("validateDesignTarget reports a missing module checkout", () => {
  const t = validateDesignTarget({ fixture: "party", module: "/nonexistent-module-dir" });
  assert.match(t.error, /no module\.json under/);
});

test("validateDesignTarget reports a module without a harness", () => {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "vh-target-"));
  fs.writeFileSync(path.join(dir, "module.json"), "{}");
  try {
    const t = validateDesignTarget({ fixture: "party", module: dir });
    assert.match(t.error, /no design harness in/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("preview expressions carry the fixture safely and share one window id", () => {
  const open = buildPreviewOpenExpression({
    html: '<div data-application-part="body">hi</div>',
    css: ".x { color: red; }",
    title: 'Say "hi"\nnow',
    classes: ["sde-ui", "sheet"],
    width: 333,
  });
  assert.ok(open.includes(PREVIEW_WINDOW_ID));
  assert.ok(open.includes(JSON.stringify('<div data-application-part="body">hi</div>')));
  assert.ok(open.includes(JSON.stringify('Say "hi"\nnow')));
  assert.ok(open.includes('["sde-ui","sheet"]'));
  assert.ok(open.includes("width: 333"));
  assert.ok(open.includes("DialogV2"));
  assert.ok(open.includes('action: "close"'));
  assert.ok(open.includes('style.height = "auto"'));
  assert.ok(open.includes("form-footer"));
  const close = buildPreviewCloseExpression();
  assert.ok(close.includes(PREVIEW_WINDOW_ID));
  assert.ok(!close.includes("DialogV2"));
});

test("the preview capture prefers CDP real pixels and flags the html2canvas fallback", () => {
  const src = fs.readFileSync(new URL("../tools/server-local.js", import.meta.url), "utf8");
  assert.ok(src.includes("cdpScreenshot(`#${PREVIEW_WINDOW_ID}`"));
  assert.ok(src.includes("userId: targetUserId"));
  assert.ok(src.includes("html2canvas fallback — text baselines approximate"));
});

test("cdpScreenshot with userId only attaches to the page logged in as that user", async () => {
  const { createServer } = await import("node:http");
  const { WebSocketServer } = await import("ws");
  const { cdpScreenshot } = await import("../lib/cdp-screenshot.js");
  const attached = [];
  const http = createServer();
  const wss = new WebSocketServer({ server: http });
  await new Promise(r => http.listen(0, "127.0.0.1", r));
  const port = http.address().port;
  const users = { "/a": "userA", "/b": "userB" };
  http.on("request", (req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(["/a", "/b"].map(p => ({
      type: "page", url: "http://foundry/game",
      webSocketDebuggerUrl: `ws://127.0.0.1:${port}${p}` }))));
  });
  wss.on("connection", (ws, req) => ws.on("message", raw => {
    const { id, params } = JSON.parse(raw);
    if (params.expression === "game?.user?.id ?? null") {
      return ws.send(JSON.stringify({ id, result: { result: { value: users[req.url] } } }));
    }
    attached.push(req.url); // the capture's own evaluate reached this page
    ws.send(JSON.stringify({ id, result: { result: { value: { error: "stop here" } } } }));
  }));
  try {
    const hit = await cdpScreenshot("#x", { userId: "userB", ports: [port] });
    assert.equal(hit.error, "stop here");
    assert.deepEqual(attached, ["/b"]);
    await assert.rejects(cdpScreenshot("#x", { userId: "nobody", ports: [port] }), /logged in as bridge user nobody/);
  } finally {
    wss.close();
    http.close();
  }
});

test("validateDesignTarget lists fixtures when none is named and rejects a relative module", () => {
  const root = fs.mkdtempSync(path.join(tmpdir(), "dh-"));
  try {
    fs.writeFileSync(path.join(root, "module.json"), "{}");
    const fx = path.join(root, "tools", "design-harness", "fixtures");
    fs.mkdirSync(fx, { recursive: true });
    for (const f of ["alpha.mjs", "beta.mjs", "_helper.mjs"]) fs.writeFileSync(path.join(fx, f), "");
    const none = validateDesignTarget({ module: root });
    assert.match(none.error, /Pass a `fixture`/);
    assert.match(none.error, /Available: alpha, beta\./);
    assert.ok(!none.error.includes("_helper"));
    assert.match(validateDesignTarget({ fixture: "alpha", module: "relative/dir" }).error, /absolute path/);
    assert.ok(validateDesignTarget({ fixture: "alpha", module: root }).fixtureFile.endsWith("alpha.mjs"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("fetchFixtureFragment fails fast with the harness's stderr when serve.mjs cannot start", async () => {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "dh-"));
  try {
    fs.writeFileSync(path.join(dir, "serve.mjs"), 'console.error("boom: bad config"); process.exit(3);');
    const t0 = Date.now();
    await withEnv(dir, () => assert.rejects(
      fetchFixtureFragment({ fixture: "x" }, { timeoutMs: 10_000 }),
      /exited with code 3[\s\S]*boom: bad config/));
    assert.ok(Date.now() - t0 < 5_000, "should not wait out the full startup timeout");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// withEnv restores synchronously, before an async render has read the env again.
async function withEnvAsync(value, fn) {
  const prev = process.env.FOUNDRY_DESIGN_HARNESS;
  process.env.FOUNDRY_DESIGN_HARNESS = value;
  try { return await fn(); }
  finally { if (prev === undefined) delete process.env.FOUNDRY_DESIGN_HARNESS; else process.env.FOUNDRY_DESIGN_HARNESS = prev; }
}

// A fake harness: shot.mjs writes "the look" of whichever module it renders
// (MODULE_DIR, else its own checkout) as the PNG and the check, so compare
// verdicts are testable without chromium.
function fakeCompareRig({ headLook, baseLook, baseHasFixture = true }) {
  const root = fs.mkdtempSync(path.join(tmpdir(), "dh-cmp-"));
  const mk = (name, look, withFixture) => {
    const dir = path.join(root, name);
    fs.mkdirSync(path.join(dir, "tools", "design-harness", "fixtures"), { recursive: true });
    fs.writeFileSync(path.join(dir, "module.json"), "{}");
    fs.writeFileSync(path.join(dir, "look.txt"), look);
    if (withFixture) fs.writeFileSync(path.join(dir, "tools", "design-harness", "fixtures", "a.mjs"), "");
    return dir;
  };
  const head = mk("head", headLook, true);
  const base = mk("base", baseLook, baseHasFixture);
  fs.writeFileSync(path.join(head, "tools", "design-harness", "shot.mjs"), `
    import fs from "node:fs"; import path from "node:path";
    const dir = process.env.MODULE_DIR ?? path.resolve(import.meta.dirname, "../..");
    const look = fs.readFileSync(path.join(dir, "look.txt"), "utf8");
    fs.writeFileSync(process.argv[3], look);
    console.log("design harness: fake");
    console.log(process.argv[3]);
    console.log("check: " + look);`);
  return { root, head, base, harness: path.join(head, "tools", "design-harness") };
}

test("renderFixtureReport compare: reports changed pixels and a changed layout check", async () => {
  const rig = fakeCompareRig({ headLook: "wide", baseLook: "narrow" });
  try {
    const out = await withEnvAsync(rig.harness, () => renderFixtureReport({ fixture: "a", against: rig.base }));
    assert.equal(out.content.filter(c => c.type === "image").length, 2);
    const t = out.content.at(-1).text;
    assert.match(t, /\[dark\] base check: narrow/);
    assert.match(t, /\[dark\] head check: wide/);
    assert.match(t, /pixels differ; layout check CHANGED/);
  } finally { fs.rmSync(rig.root, { recursive: true, force: true }); }
});

test("renderFixtureReport compare: identical renders say so", async () => {
  const rig = fakeCompareRig({ headLook: "same", baseLook: "same" });
  try {
    const out = await withEnvAsync(rig.harness, () => renderFixtureReport({ fixture: "a", against: rig.base, theme: "both" }));
    assert.equal(out.content.filter(c => c.type === "image").length, 4);
    assert.equal((out.content.at(-1).text.match(/pixels identical; layout check unchanged/g) ?? []).length, 2);
  } finally { fs.rmSync(rig.root, { recursive: true, force: true }); }
});

test("renderFixtureReport compare: a fixture absent from the base is new, a bad base is an error", async () => {
  const rig = fakeCompareRig({ headLook: "x", baseLook: "y", baseHasFixture: false });
  try {
    const out = await withEnvAsync(rig.harness, () => renderFixtureReport({ fixture: "a", against: rig.base }));
    assert.equal(out.content.filter(c => c.type === "image").length, 1);
    assert.match(out.content.at(-1).text, /does not exist in .*base — new in head/);
    const bad = await withEnvAsync(rig.harness, () => renderFixtureReport({ fixture: "a", against: path.join(rig.root, "nope") }));
    assert.match(bad.content[0].text, /^against: Error: no module\.json/);
    const rel = await withEnvAsync(rig.harness, () => renderFixtureReport({ fixture: "a", against: "rel/dir" }));
    assert.match(rel.content[0].text, /^against: Error: `module` must be an absolute path/);
  } finally { fs.rmSync(rig.root, { recursive: true, force: true }); }
});

test("renderFixtureReport without against keeps the plain single-render shape", async () => {
  const rig = fakeCompareRig({ headLook: "solo", baseLook: "unused" });
  try {
    const out = await withEnvAsync(rig.harness, () => renderFixtureReport({ fixture: "a" }));
    assert.deepEqual(out.content.map(c => c.type), ["text", "image", "text"]);
    assert.equal(out.content[0].text, "[dark]");
    assert.match(out.content.at(-1).text, /^Rendered `a` from .*head \(dark\) — 1 image/);
  } finally { fs.rmSync(rig.root, { recursive: true, force: true }); }
});
