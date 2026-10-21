import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyBridgeStatus,
  diagnoseBridgeStatus,
  normalizeFoundryOrigin,
} from "../lib/bridge-status.js";
import { moduleFingerprint } from "../lib/module-hash.js";

test("connected bridges take precedence over REST probe state", () => {
  const result = classifyBridgeStatus({
    bridges: [{ userName: "Gamemaster", origin: "http://localhost:30000" }],
    probes: [{ origin: "http://localhost:30000", reachable: true, users: 1 }],
  });

  assert.equal(result.classification, "bridge-connected");
});

test("reachable Foundry with active users but no bridge is diagnosed precisely", () => {
  const result = classifyBridgeStatus({
    bridges: [],
    probes: [{ origin: "http://localhost:30000", reachable: true, users: 1 }],
  });

  assert.equal(result.classification, "foundry-up-no-bridge");
});

test("reachable Foundry with zero users is distinguished from a down server", () => {
  const result = classifyBridgeStatus({
    bridges: [],
    probes: [{ origin: "http://localhost:30000", reachable: true, users: 0 }],
  });

  assert.equal(result.classification, "foundry-up-no-users");
});

test("failed probes classify Foundry as down", () => {
  const result = classifyBridgeStatus({
    bridges: [],
    probes: [{ origin: "http://localhost:30000", reachable: false, error: "fetch failed" }],
  });

  assert.equal(result.classification, "foundry-down");
});

test("Foundry origins reject credentials and non-http protocols", () => {
  assert.equal(normalizeFoundryOrigin("localhost:30000"), "http://localhost:30000");
  assert.equal(normalizeFoundryOrigin("https://foundry.example.com/game"), "https://foundry.example.com");
  assert.equal(normalizeFoundryOrigin("http://user:pass@localhost:30000"), null);
  assert.equal(normalizeFoundryOrigin("file:///tmp/foundry"), null);
});

test("a bridge running different module files is reported stale with both hashes", async () => {
  const bridge = (userId, hash) => ({ userId, userName: userId, isGM: true, fingerprint: moduleFingerprint(hash, "srv") });
  const result = await diagnoseBridgeStatus({
    bridges: [bridge("fresh", "srv"), bridge("stale", "old")],
    lastSeenBridges: [],
    fetchImpl: null,
  });
  const [fresh, stale] = result.bridges;
  assert.equal(fresh.moduleStale, false);
  assert.equal(fresh.moduleHash, undefined);
  assert.equal(stale.moduleStale, true);
  assert.equal(stale.moduleHash, "old");
  assert.equal(stale.serverModuleHash, "srv");
});
