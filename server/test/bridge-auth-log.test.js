import test from "node:test";
import assert from "node:assert/strict";

import { describeUnauthedHello, explainTokenRejection } from "../lib/bridges.js";

// These two helpers exist because a bridge rejected for auth is invisible from
// the server side: the client sees a 1008 and reconnect-loops, and the log used
// to say only "invalid or missing token". The cases below are the ones that
// need *different* operator advice, so they must stay distinguishable.

test("nothing sent is reported as nothing sent, not as a bad token", () => {
  // The case that misdirects: a world whose "MCP bridge token" setting was
  // never filled in sends no token at all. Telling the operator the token is
  // "invalid" sends them to re-check a value they never set.
  for (const sent of [undefined, null, ""]) {
    const why = explainTokenRejection(sent, "s3cret");
    assert.match(why, /no token sent/);
    assert.match(why, /MCP bridge token/);
  }
});

test("a whitespace-only difference says so", () => {
  // The classic paste failure: a trailing newline from `echo` into the env
  // file, or quotes around the value. Byte-unequal, visually identical.
  const why = explainTokenRejection("s3cret\n", "s3cret");
  assert.match(why, /whitespace/);
  assert.match(why, /trailing newline/);
});

test("a genuinely different token reports both lengths", () => {
  // Lengths are the cheap tell for a truncated paste without logging secrets.
  const why = explainTokenRejection("nope", "s3cret");
  assert.match(why, /does not match/);
  assert.match(why, /sent 4 chars/);
  assert.match(why, /expected 6/);
});

test("a non-string token field is named as such", () => {
  assert.match(explainTokenRejection(12345, "s3cret"), /token field was number/);
  assert.match(explainTokenRejection({}, "s3cret"), /token field was object/);
});

test("no explanation ever contains either token value", () => {
  // The whole point of reporting lengths instead of values. A log line that
  // quotes the expected token hands the secret to anyone reading journald.
  const expected = "correct-horse-battery-staple";
  for (const sent of [undefined, "", "wrong-value-here", `  ${expected}  `, 7]) {
    const why = explainTokenRejection(sent, expected);
    assert.ok(!why.includes(expected), `leaked expected token: ${why}`);
    if (typeof sent === "string" && sent.trim()) {
      assert.ok(!why.includes(sent.trim()), `leaked sent token: ${why}`);
    }
  }
});

test("the rejected peer is identified by user, origin and world", () => {
  assert.equal(
    describeUnauthedHello({
      userName: "Gamemaster",
      origin:   "http://localhost:30000",
      host:     "localhost:30000",
      worldId:  "crow-test",
    }),
    `Gamemaster @ http://localhost:30000 (world "crow-test")`
  );
});

test("identity degrades field by field instead of printing undefined", () => {
  assert.equal(describeUnauthedHello({ userName: "Bob", host: "lan:30000" }), "Bob @ lan:30000");
  assert.equal(describeUnauthedHello({ worldId: "w" }), `unidentified client (world "w")`);
  assert.equal(describeUnauthedHello({}), "unidentified client");
  assert.equal(describeUnauthedHello(), "unidentified client");
});

test("a rejected peer cannot forge log lines through the fields we echo", () => {
  // Everything in an unauthenticated hello is attacker-controlled. A newline
  // in userName would otherwise let anything that can reach the port write
  // arbitrary lines into the server log.
  const forged = describeUnauthedHello({ userName: "evil\nBridge registered: Gamemaster (GM)" });
  assert.ok(!forged.includes("\n"), `newline survived: ${JSON.stringify(forged)}`);
  assert.match(forged, /^evilBridge registered/);
});

test("echoed fields are capped so a rejected peer cannot flood the log", () => {
  const out = describeUnauthedHello({ userName: "A".repeat(5000), worldId: "B".repeat(5000) });
  assert.ok(out.length < 200, `unbounded log line: ${out.length} chars`);
});
