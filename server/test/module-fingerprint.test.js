import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { hashModuleTree, moduleFingerprint } from "../lib/module-hash.js";
import { checkStamp, MODULE_DIR, readStamp, stampModule } from "../../scripts/stamp-module.mjs";
import { deployModule, devVersion } from "../../scripts/deploy-module.mjs";

function tmp() { return mkdtempSync(path.join(os.tmpdir(), "mcp-fingerprint-")); }

function write(dir, rel, body) {
  mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  writeFileSync(path.join(dir, rel), body);
}

/** A minimal module tree, stamped. */
function fakeModule() {
  const dir = tmp();
  write(dir, "module.json", JSON.stringify({
    id: "foundry-mcp-live", version: "1.2.3", esmodules: ["scripts/main.js"],
    manifest: "https://example.invalid/module.json", download: "https://example.invalid/module.zip",
  }));
  write(dir, "scripts/main.js", 'import "./helper.js";\n');
  write(dir, "scripts/helper.js", "export {};\n");
  write(dir, "lib/util.js", "export {};\n");
  write(dir, "scripts/main.js.bak", "old\n");
  stampModule(dir);
  return dir;
}

const deploy = (opts) => deployModule({ stageDir: path.join(tmp(), "stage"), ...opts });

test("hash ignores build-info.js and *.bak, but sees content and paths", () => {
  const dir = fakeModule();
  const base = hashModuleTree(dir);
  write(dir, "scripts/build-info.js", "export const BUILD_INFO = {};\n");
  write(dir, "lib/util.js.bak", "x");
  assert.equal(hashModuleTree(dir), base);

  write(dir, "lib/util.js", "export const x = 1;\n");
  assert.notEqual(hashModuleTree(dir), base);

  const a = tmp(); write(a, "x/a.js", "same");
  const b = tmp(); write(b, "x/b.js", "same");
  assert.notEqual(hashModuleTree(a), hashModuleTree(b));
});

test("moduleFingerprint reports both hashes only when they differ", () => {
  assert.deepEqual(moduleFingerprint("abc", "abc"), { moduleStale: false });
  assert.deepEqual(moduleFingerprint("old", "abc"), { moduleStale: true, moduleHash: "old", serverModuleHash: "abc" });
  // A module that predates the fingerprint sends nothing — that is the stale case.
  assert.deepEqual(moduleFingerprint(undefined, "abc"), { moduleStale: true, moduleHash: null, serverModuleHash: "abc" });
  assert.deepEqual(moduleFingerprint("abc", null), {});
});

test("the committed stamp matches module/ (run scripts/stamp-module.mjs if this fails)", () => {
  assert.equal(checkStamp(MODULE_DIR), null);
});

test("stamp --check logic catches an edit made after stamping", () => {
  const dir = fakeModule();
  assert.equal(checkStamp(dir), null);
  write(dir, "scripts/helper.js", "export const changed = true;\n");
  assert.match(checkStamp(dir), /stale/);
  assert.equal(stampModule(dir).changed, true);
  assert.equal(stampModule(dir).changed, false);
});

test("deploy ships the listed dirs plus lib/, skips .bak, and the target hash matches the stamp", () => {
  const src = fakeModule();
  const target = path.join(tmp(), "foundry-mcp-live");
  const r = deploy({ sourceDir: src, target });
  assert.equal(r.targetHash, readStamp(src).hash);
  assert.ok(existsSync(path.join(target, "scripts/helper.js")), "sibling of the esmodule shipped");
  assert.ok(existsSync(path.join(target, "lib/util.js")));
  assert.ok(!existsSync(path.join(target, "scripts/main.js.bak")));

  // --delete: a stray file in the target goes on the next deploy.
  write(target, "scripts/stray.js", "x");
  deploy({ sourceDir: src, target });
  assert.ok(!existsSync(path.join(target, "scripts/stray.js")));
});

test("--dev strips manifest/download and suffixes the version, code stamp intact", () => {
  const src = fakeModule();
  const target = path.join(tmp(), "foundry-mcp-live");
  const now = new Date("2026-10-21T15:04:05Z");
  const r = deploy({ sourceDir: src, target, dev: true, now });
  const manifest = JSON.parse(readFileSync(path.join(target, "module.json"), "utf8"));
  assert.equal(manifest.version, "1.2.3-dev.20261021150405");
  assert.equal(r.version, manifest.version);
  assert.equal(manifest.manifest, undefined);
  assert.equal(manifest.download, undefined);
  assert.equal(readStamp(target).hash, readStamp(src).hash);
  assert.equal(devVersion("1.0.0", now), "1.0.0-dev.20261021150405");
});

test("deploy refuses a missing esmodule, a stale stamp, unshipped files and a foreign target", () => {
  const missing = fakeModule();
  write(missing, "module.json", JSON.stringify({ id: "foundry-mcp-live", version: "1", esmodules: ["scripts/main.js", "scripts/gone.js"] }));
  stampModule(missing);
  assert.throws(() => deploy({ sourceDir: missing, target: path.join(tmp(), "t") }), /scripts\/gone\.js/);

  const stale = fakeModule();
  write(stale, "scripts/helper.js", "edited after stamping\n");
  assert.throws(() => deploy({ sourceDir: stale, target: path.join(tmp(), "t") }), /stale/);

  const extra = fakeModule();
  write(extra, "templates/x.hbs", "never shipped\n");
  stampModule(extra);
  assert.throws(() => deploy({ sourceDir: extra, target: path.join(tmp(), "t") }), /templates\/x\.hbs/);

  const foreign = tmp();
  write(foreign, "keep.txt", "precious");
  assert.throws(() => deploy({ sourceDir: fakeModule(), target: foreign }), /Refusing/);
  assert.equal(readFileSync(path.join(foreign, "keep.txt"), "utf8"), "precious");
});

test("dry run: deploying this repo's module/ into a scratch dir matches its stamp", () => {
  const target = path.join(tmp(), "foundry-mcp-live");
  const r = deploy({ target });
  assert.equal(r.targetHash, readStamp(MODULE_DIR).hash);
});
