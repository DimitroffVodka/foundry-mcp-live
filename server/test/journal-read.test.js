import test from "node:test";
import assert from "node:assert/strict";

import { htmlToMarkdown, listJournals, getJournal, jsonSafe, derivedView } from "../../module/scripts/journal-read.js";

// A DOM just big enough for the walker: text nodes and elements with attributes.
const txt = (s) => ({ nodeType: 3, textContent: s });
const el = (tag, attrs = {}, ...children) => ({
  nodeType: 1, tagName: tag.toUpperCase(),
  getAttribute: (k) => attrs[k] ?? null,
  childNodes: children.map((c) => (typeof c === "string" ? txt(c) : c)),
});
const body = (...c) => el("body", {}, ...c);

test("htmlToMarkdown: headings, inline marks keep their spacing, links, images", () => {
  const md = htmlToMarkdown(body(
    el("h2", {}, "The ", el("em", {}, "Crypt")),
    el("p", {}, "A", el("strong", {}, " big "), "door and ", el("a", { href: "https://x.test/a" }, "a link"), "."),
    el("p", {}, el("a", { class: "content-link", "data-uuid": "Actor.abc" }, el("i", { class: "fas fa-user" }), "Goblin"),
      " rolls ", el("a", { class: "inline-roll", "data-formula": "1d6" }, "1d6")),
    el("img", { src: "maps/a.webp", alt: "map" }),
  ));
  assert.equal(md, "## The *Crypt*\n\nA **big** door and [a link](https://x.test/a).\n\n@UUID[Actor.abc]{Goblin} rolls 1d6\n\n![map](maps/a.webp)");
});

test("htmlToMarkdown: nested lists, ordered lists and tables (pipes escaped, ragged rows padded)", () => {
  const md = htmlToMarkdown(body(
    el("ul", {}, el("li", {}, "one", el("ul", {}, el("li", {}, "sub"))), el("li", {}, "two")),
    el("ol", {}, el("li", {}, "first"), el("li", {}, "second")),
    el("table", {}, el("thead", {}, el("tr", {}, el("th", {}, "d6"), el("th", {}, "Result"))),
      el("tbody", {}, el("tr", {}, el("td", {}, "1"), el("td", {}, "a | b")), el("tr", {}, el("td", {}, "2")))),
  ));
  assert.equal(md, [
    "- one", "  - sub", "- two", "",
    "1. first", "2. second", "",
    "| d6 | Result |", "| --- | --- |", "| 1 | a \\| b |", "| 2 |  |",
  ].join("\n"));
});

test("htmlToMarkdown: secret sections are dropped unless asked for; scripts never appear", () => {
  const tree = () => body(el("p", {}, "open"), el("section", { class: "secret", id: "s1" }, el("p", {}, "the GM knows")), el("script", {}, "alert(1)"));
  assert.equal(htmlToMarkdown(tree()), "open");
  assert.equal(htmlToMarkdown(tree(), { secrets: true }), "open\n\n> **Secret:** the GM knows");
});

test("htmlToMarkdown: pre keeps whitespace, br breaks lines", () => {
  assert.equal(htmlToMarkdown(body(el("pre", {}, el("code", {}, "a  b\n  c")), el("p", {}, "x", el("br"), "y"))),
    "```\na  b\n  c\n```\n\nx\ny");
});

// --- journal handlers against a stubbed game -------------------------------------------

function stubGame({ entries, user = { isGM: true } }) {
  const prev = Object.fromEntries(["game", "DOMParser", "foundry"].map((k) => [k, globalThis[k]]));
  const enrichCalls = [];
  globalThis.game = {
    user,
    journal: { contents: entries, get: (id) => entries.find((e) => e.id === id), getName: (n) => entries.find((e) => e.name === n) },
    packs: { get: () => null },
  };
  // The "HTML" in these stubs is plain text: the walker is covered above, here it is pagination.
  globalThis.DOMParser = class { parseFromString(html) { return { body: body(el("p", {}, html)) }; } };
  globalThis.foundry = { applications: { ux: { TextEditor: { implementation: {
    enrichHTML: async (html, opts) => { enrichCalls.push(opts); return html.toUpperCase(); },
  } } } } };
  return { enrichCalls, restore: () => { for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete globalThis[k]; else globalThis[k] = v; } } };
}

const page = (id, name, content, extra = {}) => ({ id, name, type: "text", sort: 0, text: { content }, ...extra });
const entry = (id, name, pages, extra = {}) => ({ id, uuid: `JournalEntry.${id}`, name, documentName: "JournalEntry", folder: null, pages: { contents: pages }, ...extra });

test("getJournal paginates pages and says what was left out", async () => {
  const pages = ["a", "b", "c"].map((n, i) => page(`p${n}`, `Page ${n}`, `text ${n}`, { sort: i }));
  const s = stubGame({ entries: [entry("j1", "Adventure", pages)] });
  try {
    const r = await getJournal({ name: "Adventure", limit: 2 });
    assert.equal(r.total, 3); assert.equal(r.count, 2); assert.equal(r.offset, 0);
    assert.deepEqual(r.items.map((i) => i.markdown), ["text a", "text b"]);
    assert.equal(r.truncated, true); assert.equal(r.nextOffset, 2); assert.match(r.note, /offset=2/);
    const last = await getJournal({ id: "j1", offset: 2 });
    assert.equal(last.count, 1); assert.equal(last.truncated, false); assert.equal(last.note, undefined);
  } finally { s.restore(); }
});

test("getJournal cuts a page that alone overflows maxChars and resumes with textOffset", async () => {
  const long = "x".repeat(700) + "END";
  const s = stubGame({ entries: [entry("j1", "Big", [page("p1", "Long", long), page("p2", "Next", "short")])] });
  try {
    const r = await getJournal({ id: "j1", maxChars: 500 });
    assert.equal(r.count, 1);
    assert.equal(r.items[0].markdown.length, 500); assert.equal(r.items[0].cut, true); assert.equal(r.items[0].chars, 703);
    assert.equal(r.truncated, true); assert.match(r.note, /page="p1", textOffset=500/);
    const rest = await getJournal({ id: "j1", page: "p1", textOffset: 500 });
    assert.equal(rest.items[0].markdown, "x".repeat(200) + "END"); assert.equal(rest.truncated, false);
  } finally { s.restore(); }
});

test("getJournal stops before a page that does not fit once something was returned", async () => {
  const s = stubGame({ entries: [entry("j1", "Two", [page("p1", "A", "a".repeat(400)), page("p2", "B", "b".repeat(400))])] });
  try {
    const r = await getJournal({ id: "j1", maxChars: 500 });
    assert.equal(r.count, 1); assert.equal(r.items[0].cut, undefined);
    assert.equal(r.truncated, true); assert.match(r.note, /before page "B".*offset=1/);
  } finally { s.restore(); }
});

test("getJournal enrich passes secrets and the page to enrichHTML; unseen pages are hidden", async () => {
  const hidden = page("p2", "GM only", "nope", { testUserPermission: () => false });
  const s = stubGame({ entries: [entry("j1", "E", [page("p1", "P", "hello"), hidden])] });
  try {
    const r = await getJournal({ id: "j1", enrich: true });
    assert.deepEqual(r.items.map((i) => i.markdown), ["HELLO"]);
    assert.equal(r.total, 1);
    assert.equal(s.enrichCalls[0].secrets, false);
    assert.equal(s.enrichCalls[0].relativeTo.id, "p1");
    assert.match((await getJournal({ id: "nope" })).error, /not found/);
    assert.match((await getJournal({})).error, /needs `id` or `name`/);
  } finally { s.restore(); }
});

test("listJournals: plain listing is paginated; query matches page text with a snippet and entry names", async () => {
  const s = stubGame({ entries: [
    entry("j1", "Village", [page("p1", "Inn", "The innkeeper hides a silver key under the bar.")]),
    entry("j2", "Silver Mine", [page("p2", "Entrance", "Dark.")]),
    entry("j3", "Other", [page("p3", "X", "nothing here")]),
  ] });
  try {
    const all = await listJournals({ limit: 2 });
    assert.equal(all.total, 3); assert.equal(all.count, 2); assert.equal(all.truncated, true);
    assert.deepEqual(all.items[0].pages, [{ id: "p1", name: "Inn", type: "text" }]);
    const hits = await listJournals({ query: "SILVER" });
    assert.deepEqual(hits.items.map((i) => i.id), ["j1", "j2"]);
    assert.match(hits.items[0].matches[0].snippet, /silver key/);
    assert.deepEqual(hits.items[1].matches, []);
    assert.equal(hits.truncated, false);
  } finally { s.restore(); }
});

// --- derived data -------------------------------------------------------------------------

test("jsonSafe: cycles, Sets/Maps, nested documents, functions, DataModels walked by own props", () => {
  const a = { name: "a", tags: new Set(["x"]), m: new Map([["k", 1]]), fn() {} };
  a.self = a;
  const doc = { documentName: "Item", uuid: "Actor.1.Item.2", huge: "…" };
  class Model { constructor() { this.mod = 3; Object.defineProperty(this, "_source", { value: { raw: 1 } }); } toJSON() { return this._source; } }
  assert.deepEqual(jsonSafe({ a, doc, model: new Model(), parent: { no: 1 }, list: [() => 1] }), {
    a: { name: "a", tags: ["x"], m: { k: 1 }, self: "[Circular]" },
    doc: "Actor.1.Item.2",
    model: { mod: 3 },
    list: [null],
  });
  const shared = { v: 1 };
  assert.deepEqual(jsonSafe({ x: shared, y: shared }), { x: { v: 1 }, y: { v: 1 } }, "shared (non-cyclic) refs are kept");
});

test("derivedView returns prepared system, applied effects and roll data", () => {
  const actor = {
    id: "a1", uuid: "Actor.a1", name: "Hero", type: "character", img: "h.png",
    toObject: (source) => ({ system: source === false ? { hp: { max: 15 } } : { hp: { max: 10 } } }),
    appliedEffects: [{ id: "e1", name: "Bless", origin: null, statuses: new Set(["blessed"]), changes: [{ key: "system.hp.max", value: "5" }] }],
    getRollData: () => ({ abilities: { str: { value: 16, mod: 3 } } }),
  };
  assert.deepEqual(derivedView(actor), {
    id: "a1", uuid: "Actor.a1", name: "Hero", type: "character", img: "h.png",
    system: { hp: { max: 15 } },
    appliedEffects: [{ id: "e1", name: "Bless", origin: null, statuses: ["blessed"], changes: [{ key: "system.hp.max", value: "5" }] }],
    rollData: { abilities: { str: { value: 16, mod: 3 } } },
  });
  const item = { id: "i1", toObject: () => ({ system: {} }) };
  assert.equal("appliedEffects" in derivedView(item), false);
  assert.equal(derivedView(item).rollData, null);
});

// --- server routing: the merged tools send the new modes to the new handlers ---------------

test("list type 'journal' and document action 'journal' / derived route to the bridge handlers", async () => {
  const { bridges } = await import("../lib/bridges.js");
  const { pendingRequests } = await import("../lib/foundry-rpc.js");
  const { registerWorldTools } = await import("../tools/world.js");
  const handlers = {};
  registerWorldTools({ tool: (name, _d, _s, handler) => { handlers[name] = handler; return {}; } });
  const sent = [];
  bridges.set("test-gm", { userId: "test-gm", userName: "TestGM", isGM: true, socket: { readyState: 1, send: (raw) => {
    const m = JSON.parse(raw); sent.push(m); pendingRequests.get(m.id).resolve({ ok: true });
  } } });
  try {
    await handlers.list({ type: "journal", query: "key", offset: 5 });
    await handlers.document({ action: "journal", name: "Adventure", page: "p1", enrich: true, maxChars: 900 });
    await handlers.document({ action: "actor", id: "a1", derived: true });
    assert.deepEqual(sent.map((m) => [m.tool, m.params]), [
      ["list_journals", { query: "key", offset: 5 }],
      ["get_journal", { name: "Adventure", page: "p1", enrich: true, maxChars: 900 }],
      ["get_actor", { id: "a1", derived: true }],
    ]);
  } finally { bridges.delete("test-gm"); }
});
