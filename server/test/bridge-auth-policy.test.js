import test from "node:test";
import assert from "node:assert/strict";

import { isLoopbackAddress, isTrustedLocalPeer } from "../lib/bridges.js";

// The bridge token guards the port that FOUNDRY_WS_HOST opens to the LAN. A
// client on this machine is already running as this user, so requiring it to
// paste a secret into every world bought nothing and broke every new world.
// These tests pin the two halves of the replacement: who counts as local, and
// why "on loopback" alone is not enough to be trusted.

test("loopback is recognised in every form ws reports it", () => {
  // v4-mapped is what arrives when the server is bound to `::` — the LAN-bind
  // case, which is exactly when the token is set and the distinction matters.
  for (const addr of ["127.0.0.1", "127.1.2.3", "::1", "::ffff:127.0.0.1", "::FFFF:127.0.0.1", "localhost"]) {
    assert.equal(isLoopbackAddress(addr), true, addr);
  }
});

test("routable addresses are not loopback", () => {
  for (const addr of ["192.168.1.50", "10.0.0.4", "203.0.113.7", "128.0.0.1", "1270.0.0.1", "", null, undefined]) {
    assert.equal(isLoopbackAddress(addr), false, String(addr));
  }
});

test("a Foundry client on this machine needs no token", () => {
  assert.equal(
    isTrustedLocalPeer({ remoteAddress: "::ffff:127.0.0.1", origin: "http://localhost:30000" }),
    true
  );
  assert.equal(
    isTrustedLocalPeer({ remoteAddress: "127.0.0.1", origin: "http://127.0.0.1:30000" }),
    true
  );
});

test("a hostile page in the user's browser does not", () => {
  // The whole reason this needs an origin check: CORS does not apply to
  // WebSockets, so any site the user visits can open a socket to 127.0.0.1.
  // The peer address is genuinely loopback here — only Origin separates it
  // from the real client.
  assert.equal(
    isTrustedLocalPeer({ remoteAddress: "127.0.0.1", origin: "https://evil.example" }),
    false
  );
});

test("DNS rebinding does not launder the origin", () => {
  // evil.example resolving to 127.0.0.1 makes the peer look local, but the
  // page's origin stays evil.example — which is the point of checking it.
  assert.equal(
    isTrustedLocalPeer({ remoteAddress: "127.0.0.1", origin: "http://evil.example:30000" }),
    false
  );
});

test("Origin: null is refused, not treated as absent", () => {
  // A sandboxed iframe or file:// page sends the literal string "null". A
  // hostile page can arrange that deliberately, so it must not fall into the
  // "no Origin, therefore not a browser" branch.
  assert.equal(isTrustedLocalPeer({ remoteAddress: "127.0.0.1", origin: "null" }), false);
  assert.equal(isTrustedLocalPeer({ remoteAddress: "127.0.0.1", origin: "NULL" }), false);
});

test("a non-browser client on loopback is allowed", () => {
  // No Origin header at all means no browser is involved — a script or test
  // harness, which on loopback already runs with this user's privileges.
  assert.equal(isTrustedLocalPeer({ remoteAddress: "127.0.0.1" }), true);
  assert.equal(isTrustedLocalPeer({ remoteAddress: "127.0.0.1", origin: "" }), true);
});

test("a remote peer is never local, whatever origin it claims", () => {
  assert.equal(
    isTrustedLocalPeer({ remoteAddress: "192.168.1.50", origin: "http://localhost:30000" }),
    false
  );
  assert.equal(isTrustedLocalPeer({ remoteAddress: "192.168.1.50" }), false);
});

test("a proxied request is never local", () => {
  // Behind a reverse proxy every peer address is 127.0.0.1. Trusting that
  // would hand local trust to the entire internet.
  assert.equal(
    isTrustedLocalPeer({ remoteAddress: "127.0.0.1", origin: "http://localhost:30000", forwarded: true }),
    false
  );
});

test("explicit allowlist entries are honoured, exactly", () => {
  const allowedOrigins = ["http://foundry.lan:30000"];
  assert.equal(
    isTrustedLocalPeer({ remoteAddress: "127.0.0.1", origin: "http://foundry.lan:30000", allowedOrigins }),
    true
  );
  // Trailing slash and case are normalised; a different port is a different
  // origin and must not match.
  assert.equal(
    isTrustedLocalPeer({ remoteAddress: "127.0.0.1", origin: "HTTP://Foundry.LAN:30000/", allowedOrigins }),
    true
  );
  assert.equal(
    isTrustedLocalPeer({ remoteAddress: "127.0.0.1", origin: "http://foundry.lan:31000", allowedOrigins }),
    false
  );
  // An allowlist entry never rescues a remote peer.
  assert.equal(
    isTrustedLocalPeer({ remoteAddress: "10.0.0.9", origin: "http://foundry.lan:30000", allowedOrigins }),
    false
  );
});

test("a malformed origin fails closed", () => {
  for (const origin of ["not a url", "http://", "://x", "javascript:alert(1)"]) {
    assert.equal(isTrustedLocalPeer({ remoteAddress: "127.0.0.1", origin }), false, origin);
  }
});

test("no arguments at all is not trusted", () => {
  assert.equal(isTrustedLocalPeer(), false);
  assert.equal(isTrustedLocalPeer({}), false);
});
