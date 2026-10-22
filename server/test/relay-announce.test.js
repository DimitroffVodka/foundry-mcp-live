import test from "node:test";
import assert from "node:assert/strict";

import { relayAnnouncement } from "../../module/scripts/relay-announce.js";

// Freezes the decision behind the relay's world-load notice. The regression
// this pins down: the relay runs on every client (that is deliberate — a remote
// device can never open the direct socket), but the *notice* used to fire on
// every client too, on every world load. A world whose gateway lives elsewhere
// therefore warned "no MCP gateway is running for this world yet" at a desktop
// the MCP server could already drive through the direct bridge.

const LABEL = "Gamemaster — Linux Firefox 2560x1440";

test("a directly bridged device says nothing about the relay", () => {
  // The false alarm. Reachability is the direct bridge's business; the relay is
  // one route among several, not news.
  assert.equal(relayAnnouncement({ directBridgeOpen: true, label: LABEL }), null);
  assert.equal(relayAnnouncement({ directBridgeOpen: true, gatewayReady: true, label: LABEL }), null);
  assert.equal(relayAnnouncement({ directBridgeOpen: true, gatewayReady: false, label: LABEL }), null);
});

test("notices switched off stay silent regardless of state", () => {
  assert.equal(relayAnnouncement({ enabled: false, label: LABEL }), null);
  assert.equal(relayAnnouncement({ enabled: false, gatewayReady: true, label: LABEL }), null);
});

test("a relay-only device with a gateway is told it is addressable", () => {
  const notice = relayAnnouncement({ gatewayReady: true, label: LABEL });
  assert.equal(notice.level, "info");
  assert.match(notice.text, /available to the MCP server/);
  assert.ok(notice.text.includes(LABEL), "the notice must name the device");
});

test("a relay-only device with no gateway is warned, with the reason", () => {
  // The case the warning was written for: a tablet/Deck on a world whose
  // gateway has not been started. Nothing else can reach it.
  const notice = relayAnnouncement({ label: LABEL });
  assert.equal(notice.level, "warn");
  assert.match(notice.text, /no MCP gateway is running for this world yet/);
  assert.ok(notice.text.includes(LABEL));
});

test("defaults are the conservative ones", () => {
  // Called with nothing: no settings read yet, nothing known to be published,
  // and no reason to believe a direct bridge exists — so warn, do not claim the
  // device is available.
  const notice = relayAnnouncement();
  assert.equal(notice.level, "warn");
  assert.match(notice.text, /"unknown device"/);
});
