import test from "node:test";
import assert from "node:assert/strict";

import { createEventLog, chatEvent, eventMatcher, requestAsk, stage, waitDialog }
  from "../../module/scripts/live-play.js";

// ---------------------------------------------------------------------------
// Event log
// ---------------------------------------------------------------------------

test("event log: monotonic seq, read since a cursor, ring drops the oldest", () => {
  const log = createEventLog(3);
  for (const n of [1, 2, 3, 4]) log.record({ kind: "chat", content: `m${n}` });
  const all = log.read({});
  assert.equal(all.latestSeq, 4);
  assert.deepEqual(all.events.map((e) => e.seq), [2, 3, 4]);
  assert.equal(all.dropped, true, "seq 1 fell off the ring");
  const since = log.read({ sinceSeq: 3 });
  assert.deepEqual(since.events.map((e) => e.content), ["m4"]);
  assert.equal(since.dropped, undefined);
  assert.deepEqual(log.read({ limit: 1 }).events.map((e) => e.seq), [4], "limit keeps the newest");
});

test("event log: a cursor past latestSeq (client reloaded) reads from the start and says reset", () => {
  const log = createEventLog();
  log.record({ kind: "chat" });
  const r = log.read({ sinceSeq: 250 });
  assert.equal(r.reset, true);
  assert.equal(r.events.length, 1);
});

test("event log wait: returns a buffered match after sinceSeq at once", async () => {
  const log = createEventLog();
  log.record({ kind: "chat", user: "Alice", content: "hi" });
  const r = await log.wait({ sinceSeq: 0, match: eventMatcher({ user: "alice" }), timeoutMs: 50 });
  assert.equal(r.status, "matched");
  assert.equal(r.event.seq, 1);
});

test("event log wait: without sinceSeq ignores the buffer and resolves on the next match", async () => {
  const log = createEventLog();
  log.record({ kind: "chat", user: "Alice", content: "old" });
  const p = log.wait({ match: eventMatcher({ user: "Alice", contains: "YES" }), timeoutMs: 1000 });
  log.record({ kind: "chat", user: "Bob", content: "yes" });
  log.record({ kind: "chat", user: "Alice", content: "I say yes" });
  const r = await p;
  assert.equal(r.status, "matched");
  assert.equal(r.event.content, "I say yes");
  assert.equal(r.event.seq, 3);
});

test("event log wait: times out with the latest seq, and the timeout is capped at 40 s", async () => {
  const log = createEventLog();
  const r = await log.wait({ timeoutMs: 10 });
  assert.deepEqual(r, { status: "timeout", latestSeq: 0 });

  const realSetTimeout = globalThis.setTimeout;
  let asked;
  globalThis.setTimeout = (fn, ms) => { asked = ms; return realSetTimeout(fn, 0); };
  try { await log.wait({ timeoutMs: 120_000 }); } finally { globalThis.setTimeout = realSetTimeout; }
  assert.equal(asked, 40_000);
});

test("eventMatcher: every given filter must match; names and ids case-insensitive", () => {
  const ev = { kind: "roll", user: "Alice", userId: "u1", speaker: "Grimm", actorId: "a1", content: "Attack!", flavor: "Longsword" };
  assert.ok(eventMatcher({})(ev));
  assert.ok(eventMatcher({ kind: "roll", user: "U1", speaker: "grimm", contains: "longsword" })(ev));
  assert.ok(eventMatcher({ speaker: "a1" })(ev));
  assert.ok(!eventMatcher({ kind: "chat" })(ev));
  assert.ok(!eventMatcher({ user: "Bob" })(ev));
});

test("chatEvent: strips HTML, flags rolls and whispers", () => {
  const ev = chatEvent({
    id: "m1", author: { id: "u1", name: "Alice" }, speaker: { alias: "Grimm", actor: "a1" },
    content: "<p>I <b>attack</b></p>", flavor: "<i>Longsword</i>",
    rolls: [{ formula: "1d20+5", total: 17 }], whisper: ["gm"],
  });
  assert.deepEqual(ev, {
    kind: "roll", messageId: "m1", user: "Alice", userId: "u1", speaker: "Grimm", actorId: "a1",
    flavor: "Longsword", content: "I attack", rolls: [{ formula: "1d20+5", total: 17 }], whisper: true,
  });
  assert.equal(chatEvent({ id: "m2", content: "hi" }).kind, "chat");
});

// ---------------------------------------------------------------------------
// Dialogs — a DialogV2 stub whose wait() the test answers
// ---------------------------------------------------------------------------

function dialogStub(behave) {
  const made = [];
  class DialogV2 {
    static wait(config) {
      const d = { config, closed: false, close: async () => { d.closed = true; } };
      made.push(d);
      config.render?.({}, d);
      return behave(d);
    }
  }
  const prev = { foundry: globalThis.foundry, game: globalThis.game };
  globalThis.foundry = { applications: { api: { DialogV2 } } };
  globalThis.game = { user: { id: "u1", name: "Alice" } };
  return { made, restore: () => Object.assign(globalThis, prev) };
}

test("ask: question escaped, title and labels raw, index actions, answer recorded in the log", async () => {
  const f = dialogStub(async (d) => {
    const btn = d.config.buttons[1];
    return btn.callback({}, { form: { elements: { answer: { value: "because" } } } });
  });
  const log = createEventLog();
  try {
    const r = await requestAsk({ question: "<b>Fight</b> & flee?", title: "Tom & Jerry", choices: ["Fight & win", "Flee"], freeText: true }, log);
    assert.deepEqual(r, { status: "answered", user: "Alice", question: "<b>Fight</b> & flee?", choice: "Flee", index: 1, text: "because" });
    const cfg = f.made[0].config;
    assert.ok(cfg.content.includes("&lt;b&gt;Fight&lt;/b&gt; &amp; flee?"));
    assert.ok(cfg.content.includes('name="answer"'));
    assert.equal(cfg.window.title, "Tom & Jerry", "ApplicationV2 sets the title with innerText");
    assert.deepEqual(cfg.buttons.map((b) => [b.action, b.label]), [["choice0", "Fight & win"], ["choice1", "Flee"]]);
    assert.equal(cfg.rejectClose, false);
    const [ev] = log.read({}).events;
    assert.equal(ev.kind, "ask");
    assert.equal(ev.choice, "Flee");
  } finally { f.restore(); }
});

test("ask: default Yes/No buttons; closing without a button is dismissed", async () => {
  const f = dialogStub(async () => null);
  try {
    const r = await requestAsk({ question: "Ready?" });
    assert.equal(r.status, "dismissed");
    assert.deepEqual(f.made[0].config.buttons.map((b) => b.label), ["Yes", "No"]);
  } finally { f.restore(); }
});

test("ask: requires a question and at most 8 choices", async () => {
  await assert.rejects(requestAsk({}), /question/);
  await assert.rejects(requestAsk({ question: "?", choices: Array.from({ length: 9 }, (_, i) => `c${i}`) }), /8/);
});

test("waitDialog: on timeout the dialog is closed and the status is timeout", async () => {
  const f = dialogStub(() => new Promise(() => {})); // never answered
  try {
    const r = await waitDialog({ window: { title: "t" }, content: "", buttons: [{ action: "ok", label: "OK" }] }, 0.01);
    assert.deepEqual(r, { status: "timeout" });
    assert.equal(f.made[0].closed, true);
  } finally { f.restore(); }
});

// ---------------------------------------------------------------------------
// Stage
// ---------------------------------------------------------------------------

function collection(docs) {
  const c = [...docs];
  c.get = (id) => docs.find((d) => d.id === id);
  c.getName = (n) => docs.find((d) => d.name === n);
  c.contents = docs;
  return c;
}

function stageStub({ mutations = true } = {}) {
  const emitted = [];
  const users = [
    { id: "gm", name: "GM", active: true },
    { id: "u1", name: "Alice", active: true },
    { id: "u2", name: "Bob", active: false },
  ];
  const prev = { game: globalThis.game };
  globalThis.game = {
    user: users[0],
    paused: false,
    users: collection(users),
    scenes: collection([{ id: "s1", name: "Cave" }]),
    socket: { emit: (...a) => emitted.push(a) },
    settings: { get: () => mutations },
    togglePause(p, opts) { this.pausedWith = opts; this.paused = p; return p; },
  };
  game.user.isGM = true;
  return { emitted, restore: () => Object.assign(globalThis, prev) };
}

test("stage pullToScene: emits pullToScene for active users other than the caller", async () => {
  const f = stageStub();
  try {
    const r = await stage({ action: "pullToScene", scene: "Cave" });
    assert.deepEqual(r, { scene: "Cave", sceneId: "s1", pulled: ["Alice"] });
    assert.deepEqual(f.emitted, [["pullToScene", "s1", "u1"]]);
  } finally { f.restore(); }
});

test("stage pause: toggles with broadcast", async () => {
  const f = stageStub();
  try {
    assert.deepEqual(await stage({ action: "pause" }), { paused: true });
    assert.deepEqual(game.pausedWith, { broadcast: true });
    assert.deepEqual(await stage({ action: "pause", paused: false }), { paused: false });
  } finally { f.restore(); }
});

test("stage: unknown action, unknown user, and the read-only toggle all refuse", async () => {
  const f = stageStub();
  try {
    await assert.rejects(stage({ action: "nope" }), /Unknown stage action/);
    await assert.rejects(stage({ action: "pullToScene", scene: "Cave", users: ["Zed"] }), /User "Zed" not found/);
  } finally { f.restore(); }
  const g = stageStub({ mutations: false });
  try {
    await assert.rejects(stage({ action: "pause" }), /World mutations are disabled/);
  } finally { g.restore(); }
});

// ---------------------------------------------------------------------------
// Server dispatch — a fake bridge socket answers every request
// ---------------------------------------------------------------------------

for (const gate of ["EVAL", "WRITE"]) process.env[`FOUNDRY_MCP_ALLOW_${gate}`] = "1";
const { registerTools } = await import("../tools/index.js");
const { bridges } = await import("../lib/bridges.js");
const { pendingRequests } = await import("../lib/foundry-rpc.js");

const TOOLS = new Map();
await registerTools({ tool: (name, _d, _s, cb) => { TOOLS.set(name, cb); return {}; } });

async function dispatch(tool, params) {
  const sent = [];
  bridges.set("gm-test", { userId: "gm-test", userName: "GM", isGM: true, socket: {
    readyState: 1,
    send(json) {
      const msg = JSON.parse(json);
      const p = pendingRequests.get(msg.id);
      sent.push({ ...msg, timerMs: p.timer._idleTimeout });
      clearTimeout(p.timer); pendingRequests.delete(msg.id); p.resolve({ ok: true });
    },
  } });
  try { const reply = await TOOLS.get(tool)(params); return { sent, reply }; }
  finally { bridges.delete("gm-test"); }
}

test("roll with table dispatches draw_table; without formula or table it errors", async () => {
  const { sent } = await dispatch("roll", { table: "Loot", rig: [3], displayChat: false });
  assert.deepEqual(sent.map((s) => [s.tool, s.params]), [["draw_table", { table: "Loot", rig: [3], displayChat: false }]]);
  const { sent: none, reply } = await dispatch("roll", {});
  assert.equal(none.length, 0);
  assert.match(reply.content[0].text, /formula.*table/);
});

test("request ask and chat wait get an RPC timeout longer than their own", async () => {
  const ask = await dispatch("request", { action: "ask", question: "Ready?", timeoutSeconds: 20 });
  assert.equal(ask.sent[0].tool, "request_ask");
  assert.equal(ask.sent[0].timerMs, 25_000);
  const wait = await dispatch("chat", { action: "wait", user: "Alice", timeoutSeconds: 35 });
  assert.equal(wait.sent[0].tool, "events_wait");
  assert.equal(wait.sent[0].timerMs, 40_000);
  const events = await dispatch("chat", { action: "events", sinceSeq: 4 });
  assert.deepEqual([events.sent[0].tool, events.sent[0].params], ["events_read", { sinceSeq: 4 }]);
});

test("stage checks the action's required param before reaching Foundry", async () => {
  const { sent, reply } = await dispatch("stage", { action: "showJournal" });
  assert.equal(sent.length, 0);
  assert.match(reply.content[0].text, /requires journal/);
  const ok = await dispatch("stage", { action: "playlist", playlist: "Battle", play: false });
  assert.deepEqual(ok.sent[0].params, { action: "playlist", playlist: "Battle", play: false });
});
