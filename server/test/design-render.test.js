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
  assert.ok(src.includes("html2canvas fallback — text baselines approximate"));
});
