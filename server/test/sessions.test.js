import test from "node:test";
import assert from "node:assert/strict";

import { sessionsToEvict } from "../lib/sessions.js";
import { tokenMatches } from "../lib/bridges.js";

const map = (entries) => new Map(entries.map(([id, lastActive]) => [id, { lastActive }]));

test("sessionsToEvict: idle sessions go, active ones stay", () => {
  const s = map([["old", 0], ["fresh", 50]]);
  assert.deepEqual(sessionsToEvict(s, { now: 100, idleMs: 60, max: 10 }), ["old"]);
  assert.deepEqual(sessionsToEvict(s, { now: 55, idleMs: 60, max: 10 }), []);
});

test("sessionsToEvict: over the cap, the least recently active close first", () => {
  const s = map([["b", 20], ["a", 10], ["c", 30]]);
  assert.deepEqual(sessionsToEvict(s, { now: 31, idleMs: 1000, max: 3 }), []);
  assert.deepEqual(sessionsToEvict(s, { now: 31, idleMs: 1000, max: 3, room: 1 }), ["a"]);
  assert.deepEqual(sessionsToEvict(s, { now: 31, idleMs: 1000, max: 1 }), ["a", "b"]);
});

test("tokenMatches: equal strings only, length mismatch and non-strings rejected", () => {
  assert.equal(tokenMatches("s3cret", "s3cret"), true);
  assert.equal(tokenMatches("s3cres", "s3cret"), false);
  assert.equal(tokenMatches("s3cret ", "s3cret"), false);
  assert.equal(tokenMatches("", "s3cret"), false);
  assert.equal(tokenMatches(undefined, "s3cret"), false);
  assert.equal(tokenMatches(123, "123"), false);
});
