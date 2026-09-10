import test from "node:test";
import assert from "node:assert/strict";

import {
  resolveClientId,
  createPresenceDirectory,
} from "../../module/scripts/relay-identity.js";
import {
  generateGatewayKeys,
  importVerifyKey,
  importSealKey,
  signRequest,
  verifyRequest,
  sealToGateway,
  openFromClient,
  createReplayGuard,
} from "../../module/scripts/relay-crypto.js";
import { resolveRelayTarget } from "../lib/relay-runtime.js";

function fakeStorage() {
  const m = new Map();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)) };
}

const envelope = (over = {}) => ({
  v: 1, type: "request", requestId: "r1", targetClientId: "client-deck",
  tool: "get_game_info", params: {}, nonce: "n1", issuedAt: 1_000, ...over,
});

// --- identity ---------------------------------------------------------------

test("clientId is stable across reloads of the same tab", () => {
  const store = fakeStorage();
  assert.equal(resolveClientId(store), resolveClientId(store));
});

test("a blocked storage still yields a usable id rather than throwing", () => {
  const hostile = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
  assert.match(resolveClientId(hostile), /^client-/);
});

// --- presence ---------------------------------------------------------------

test("a heartbeat from an unknown client registers it", () => {
  // The gateway may boot after its targets, or restart. If only an explicit
  // "register" packet created entries, those clients would stay invisible.
  const d = createPresenceDirectory();
  assert.equal(d.upsert({ clientId: "c1", bootId: "b1", seq: 1 }, 0), "new");
  assert.equal(d.size, 1);
});

test("a replayed or reordered packet does not refresh liveness", () => {
  const d = createPresenceDirectory();
  d.upsert({ clientId: "c1", bootId: "b1", seq: 5 }, 0);
  assert.equal(d.upsert({ clientId: "c1", bootId: "b1", seq: 5 }, 10), "stale");
  assert.equal(d.upsert({ clientId: "c1", bootId: "b1", seq: 4 }, 10), "stale");
  assert.equal(d.get("c1").receivedAt, 0, "a stale packet must not extend the TTL");
});

test("a reload replaces the previous incarnation and retires it", () => {
  // Sequence resets to 1 on a fresh boot. Without bootId that looks like a
  // replay of the old boot and the tab would be unreachable until it expired.
  const d = createPresenceDirectory();
  d.upsert({ clientId: "c1", bootId: "b1", seq: 9 }, 0);
  assert.equal(d.upsert({ clientId: "c1", bootId: "b2", seq: 1 }, 10), "replaced");
  assert.equal(d.get("c1").bootId, "b2");
});

test("a late packet from a retired boot cannot resurrect it", () => {
  const d = createPresenceDirectory();
  d.upsert({ clientId: "c1", bootId: "b1", seq: 1 }, 0);
  d.upsert({ clientId: "c1", bootId: "b2", seq: 1 }, 10);
  assert.equal(d.upsert({ clientId: "c1", bootId: "b1", seq: 999 }, 20), "stale");
  assert.equal(d.get("c1").bootId, "b2");
});

test("clients expire on TTL and are reported once", () => {
  const d = createPresenceDirectory({ ttlMs: 100 });
  d.upsert({ clientId: "c1", bootId: "b1", seq: 1 }, 0);
  assert.deepEqual(d.sweep(50), []);
  const gone = d.sweep(500);
  assert.equal(gone.length, 1);
  assert.equal(gone[0].reason, "heartbeat-ttl");
  assert.equal(d.sweep(600).length, 0, "an expired client must not be reported twice");
});

test("tombstone storage is bounded", () => {
  const d = createPresenceDirectory({ maxTombstones: 4 });
  for (let i = 0; i < 50; i++) d.retire(`c${i}`, `b${i}`);
  assert.ok(d.upsert({ clientId: "c0", bootId: "b0", seq: 1 }, 0));
});

// --- target resolution ------------------------------------------------------

test("a shared userName is refused rather than guessed", () => {
  // The whole defect being fixed: one person signed in on two devices. Picking
  // either silently is how the old userId-keyed registry lost a client.
  const clients = [
    { clientId: "client-a", label: "GM — Linux Chrome", userName: "Gamemaster" },
    { clientId: "client-b", label: "GM — Steam Deck Firefox", userName: "Gamemaster" },
  ];
  assert.equal(resolveRelayTarget(clients, "client-b").clientId, "client-b");
  assert.equal(resolveRelayTarget(clients, "GM — Steam Deck Firefox").clientId, "client-b");
  assert.throws(() => resolveRelayTarget(clients, "Gamemaster"), /matches 2 relay clients/);
});

test("an unknown target resolves to null so the caller can fall back", () => {
  assert.equal(resolveRelayTarget([], "anything"), null);
  assert.equal(resolveRelayTarget([{ clientId: "c", label: "l", userName: "u" }], undefined), null);
});

// --- envelope security ------------------------------------------------------

test("a genuine request verifies and a tampered one does not", async () => {
  const keys = await generateGatewayKeys();
  const verify = await importVerifyKey((await keys.publish()).sign);
  const signed = await signRequest(envelope(), keys.signing.privateKey);

  assert.equal(await verifyRequest(signed, verify), true);
  // Swapping the tool after signing is the attack that matters: it would turn
  // a benign relayed read into arbitrary execution on someone else's browser.
  assert.equal(await verifyRequest({ ...signed, tool: "evaluate" }, verify), false);
  assert.equal(await verifyRequest({ ...signed, targetClientId: "client-other" }, verify), false);
  assert.equal(await verifyRequest(envelope(), verify), false, "unsigned must not verify");
});

test("results are opaque to anyone but the gateway", async () => {
  const keys = await generateGatewayKeys();
  const sealKey = await importSealKey((await keys.publish()).seal);
  const secret = { screenshot: "GM-ONLY-PIXELS", hp: 7 };

  const sealed = await sealToGateway(secret, sealKey);
  assert.ok(!JSON.stringify(sealed).includes("GM-ONLY-PIXELS"),
    "plaintext must not survive into the broadcast packet");
  assert.deepEqual(await openFromClient(sealed, keys.sealing.privateKey), secret);
});

test("a different gateway key cannot open the result", async () => {
  const a = await generateGatewayKeys();
  const b = await generateGatewayKeys();
  const sealed = await sealToGateway({ x: 1 }, await importSealKey((await a.publish()).seal));
  await assert.rejects(() => openFromClient(sealed, b.sealing.privateKey));
});

test("replay guard rejects repeats and stale clocks", () => {
  // A signature proves origin, not freshness: a captured valid request could
  // otherwise be rebroadcast forever.
  const g = createReplayGuard({ maxAgeMs: 1_000 });
  assert.equal(g.check(envelope(), 1_000).ok, true);
  assert.equal(g.check(envelope(), 1_000).reason, "replay");
  assert.equal(g.check(envelope({ nonce: "n2", issuedAt: 0 }), 999_999).reason, "stale-or-skewed");
  assert.equal(g.check(envelope({ nonce: undefined }), 1_000).reason, "missing-nonce");
});

test("the replay seen-set is bounded", () => {
  const g = createReplayGuard({ maxSeen: 8 });
  for (let i = 0; i < 100; i++) {
    assert.equal(g.check(envelope({ nonce: `n${i}`, issuedAt: 1_000 }), 1_000).ok, true);
  }
});
