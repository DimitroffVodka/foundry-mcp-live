import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadOrCreateWsToken, bridgeTokenPath, defaultConfigDir } from "../lib/bridge-token-store.js";

const freshDir = () => mkdtempSync(join(tmpdir(), "fml-token-"));

// The token exists to guard an off-loopback bridge. Making the operator
// produce one by hand (openssl → env file → restart → paste into Foundry) was
// four terminal steps in a tool people install by clicking a button, so the
// server makes its own. These tests pin when it does and — more importantly —
// when it does NOT.

test("an explicitly configured token wins and is never written to disk", () => {
  const dir = freshDir();
  const out = loadOrCreateWsToken({ configured: "  operator-chosen  ", exposed: true, dir });
  assert.equal(out.token, "operator-chosen");
  assert.equal(out.source, "env");
  // Copying the operator's value into a second location just creates a way for
  // the two to disagree later.
  assert.throws(() => readFileSync(bridgeTokenPath(dir), "utf8"));
});

test("a loopback-only bridge gets no token at all", () => {
  const dir = freshDir();
  const out = loadOrCreateWsToken({ exposed: false, dir });
  assert.equal(out.token, "");
  assert.equal(out.source, "none");
  // A secret that exists is one that can go stale or leak. The plain local
  // setup should not have one.
  assert.throws(() => readFileSync(bridgeTokenPath(dir), "utf8"));
});

test("an exposed bridge with no configured token generates and persists one", () => {
  const dir = freshDir();
  const notices = [];
  const out = loadOrCreateWsToken({ exposed: true, dir, onNotice: (m) => notices.push(m) });

  assert.equal(out.source, "generated");
  assert.match(out.token, /^[0-9a-f]{48}$/);
  assert.equal(readFileSync(bridgeTokenPath(dir), "utf8").trim(), out.token);
  assert.equal(notices.length, 1);
  assert.match(notices[0], /Generated a bridge token/);
});

test("the generated token is reused on the next start", () => {
  const dir = freshDir();
  const first = loadOrCreateWsToken({ exposed: true, dir });
  const second = loadOrCreateWsToken({ exposed: true, dir });

  // Regenerating on each restart would invalidate every world setting holding it.
  assert.equal(second.token, first.token);
  assert.equal(second.source, "file");
});

test("a persisted token survives trailing whitespace from an editor", () => {
  const dir = freshDir();
  writeFileSync(bridgeTokenPath(dir), "  hand-edited-value \n\n");
  assert.equal(loadOrCreateWsToken({ exposed: true, dir }).token, "hand-edited-value");
});

test("an empty token file is replaced, not returned", () => {
  const dir = freshDir();
  writeFileSync(bridgeTokenPath(dir), "\n  \n");
  const out = loadOrCreateWsToken({ exposed: true, dir });
  assert.equal(out.source, "generated");
  assert.ok(out.token.length > 0);
});

test("the token file is not world-readable", { skip: process.platform === "win32" }, () => {
  const dir = freshDir();
  loadOrCreateWsToken({ exposed: true, dir });
  // The token is equivalent to GM access; other local users should not get it
  // for free from a mode-644 file.
  assert.equal(statSync(bridgeTokenPath(dir)).mode & 0o077, 0);
});

test("an unwritable config dir still yields a working token", () => {
  const dir = freshDir();
  const notices = [];
  // A directory where the token path is already a directory: the write fails,
  // but refusing to start would be a worse outcome than a per-restart token.
  mkdirSync(bridgeTokenPath(dir), { recursive: true });

  const out = loadOrCreateWsToken({ exposed: true, dir, onNotice: (m) => notices.push(m) });
  assert.equal(out.source, "memory");
  assert.match(out.token, /^[0-9a-f]{48}$/);
  assert.match(notices.join(" "), /could not persist/i);
});

test("the config dir follows platform convention", () => {
  assert.equal(
    defaultConfigDir({ env: {}, platform: "linux", home: "/home/x" }),
    "/home/x/.config/foundry-mcp-live"
  );
  assert.equal(
    defaultConfigDir({ env: { XDG_CONFIG_HOME: "/cfg" }, platform: "linux", home: "/home/x" }),
    "/cfg/foundry-mcp-live"
  );
  assert.equal(
    defaultConfigDir({ env: { APPDATA: "C:\\Users\\x\\AppData\\Roaming" }, platform: "win32", home: "C:\\Users\\x" }),
    join("C:\\Users\\x\\AppData\\Roaming", "foundry-mcp-live")
  );
});
