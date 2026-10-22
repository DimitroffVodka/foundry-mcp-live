/**
 * Change log with undo for the AI bridge. Pure: no Foundry globals; bridge.js
 * feeds it from document hooks and hands undo() an adapter, and
 * server/test/change-log.test.js drives it with fakes.
 *
 * One entry per document a call created, updated or deleted, with the
 * document's source before and after. Each bridge tab keeps its own log; on a
 * GM client it is also stored in one hidden JournalEntry (see "Store" below),
 * so it survives a reload of that tab.
 */

export const LOG_LIMIT = 200;
export const MAX_SNAPSHOT_CHARS = 200_000;
// Every client downloads the store when it joins, so it is kept well under 200 full snapshots.
export const MAX_STORE_CHARS = 5_000_000;

// Documents whose changes are logged but never undone.
export const NOT_UNDOABLE = Object.freeze({
  ChatMessage: "chat messages have already been seen; delete one by hand if needed",
  Setting: "settings are not restored by undo",
  User: "user changes are not restored by undo (they can lock people out)",
  Macro: "macros are code; restore one by hand",
});

/** What undo cannot reach at all, because it never becomes a logged document change. */
export const OUTSIDE_THE_LOG = "pause, targeting, canvas view and level, dialogs and clicks on other "
  + "screens, sounds started or stopped, uploaded files, dice already rolled, evaluate jobs that "
  + "finish after their call returns, anything done in another browser tab, anything before this "
  + "tab first loaded the world, and on a player's bridge anything before its last reload";

export function createChangeLog({ limit = LOG_LIMIT, maxChars = MAX_SNAPSHOT_CHARS,
    now = () => new Date().toISOString() } = {}) {
  const entries = [];
  const active = new Map(); // callId -> tool, in start order
  const dirty = new Set();   // entry ids not yet written to the store
  let seq = 0;

  return {
    entries,
    dirty,
    get seq() { return seq; },
    begin(callId, tool) { active.set(callId, tool); },
    end(callId) { active.delete(callId); },
    isActive(callId) { return active.has(callId); },

    /**
     * The call a change starting now belongs to, or null when no call is
     * running. With several running, it cannot be told which one made it.
     */
    attribute() {
      if (!active.size) return null;
      const [callId, tool] = [...active].at(-1);
      return { callId, tool, ambiguous: active.size > 1 };
    },

    /** Add one entry. `before`/`after` are document sources, null for absent. */
    record({ callId, tool = null, ambiguous = false, action, documentName, uuid, name, parentUuid = null,
        pack = null, embedded = [], before = null, after = null }) {
      // An update never restores embedded collections (they log their own
      // entries), so leave them out; that keeps a scene's walls and tokens
      // from pushing an ordinary scene update over the cap.
      if (action === "update") {
        before = omit(before, embedded);
        after = omit(after, embedded);
      }
      let reason = NOT_UNDOABLE[documentName] ?? null;
      // Without it an update would read as a create, and undo would delete the document.
      if (!reason && action !== "create" && !before) reason = "the state before the change was not captured";
      if (!reason && ambiguous) reason = "another call was running at the same time, so it is not certain this call made the change";
      const size = Math.max(JSON.stringify(before ?? null).length, JSON.stringify(after ?? null).length);
      const oversize = size > maxChars;
      if (oversize) reason = `the document is ${size} characters, over the ${maxChars}-character snapshot cap`;
      const entry = {
        id: `c${++seq}`, seq, callId, tool, time: now(), action,
        documentName, uuid, name: name ?? null, parentUuid, pack, embedded,
        changed: oversize ? null : changedPaths(before, after, ["_stats"]).slice(0, 50),
        before: oversize ? null : before,
        after: oversize ? null : after,
        undoable: !reason, reason,
      };
      entries.push(entry);
      dirty.add(entry.id);
      if (entries.length > limit) entries.splice(0, entries.length - limit);
      return entry;
    },

    /** Put back a stored log (oldest first). `storedSeq` is the highest seq ever used, so ids are never reused. */
    load(stored, storedSeq = 0) {
      entries.unshift(...stored.slice(-limit));
      seq = Math.max(seq, storedSeq, ...stored.map(e => e.seq));
    },

    /** Entries an undo request names: one entry, one whole call, or the latest call. */
    select({ entryId, callId } = {}) {
      if (entryId) return entries.filter(e => e.id === entryId);
      const id = callId ?? entries.at(-1)?.callId;
      return id ? entries.filter(e => e.callId === id) : [];
    },
  };
}

/** Summary of an entry for listing; snapshots only when asked for. */
export function describeEntry(e, full = false) {
  const { before, after, embedded, seq, ...rest } = e;
  return full ? { ...rest, before, after } : rest;
}

/**
 * Check every selected entry, then reverse them, newest first. Nothing is
 * written unless every step passes. Steps work per document: each one goes
 * back to its state before the earliest selected entry.
 *
 * @param {object} log           a createChangeLog() instance
 * @param {object[]} selected     entries to undo, oldest first
 * @param {object} env
 * @param {string} env.callId     this undo's own call id (marks the entries undone)
 * @param {string[]} [env.refuseTools]  tools whose changes may not be undone here
 * @param {(uuid) => Promise<object|null>} env.current   a document's source now
 * @param {(step) => Promise<string|null>} env.permission  why this user may not do a step
 * @param {(step) => Promise<void>} env.apply
 */
export async function undo(log, selected, env) {
  if (!selected.length) return { ok: false, problems: ["nothing in the change log matches"] };
  // Chat, settings, users and macros are never undone. Undoing a whole call
  // leaves them alone and says so; selected on their own, they are refused below.
  const leftAlone = selected.filter(e => NOT_UNDOABLE[e.documentName]);
  if (leftAlone.length === selected.length) leftAlone.length = 0;
  else selected = selected.filter(e => !NOT_UNDOABLE[e.documentName]);
  const left = leftAlone.length
    ? { leftAlone: leftAlone.map(e => ({ id: e.id, documentName: e.documentName, reason: e.reason })) } : {};
  // Entries an earlier (possibly interrupted) undo already reversed are skipped,
  // so retrying a half-finished undo resumes instead of repeating a write.
  const done = selected.filter(e => e.undoneBy);
  selected = selected.filter(e => !e.undoneBy);
  if (!selected.length) {
    return { ok: false, problems: [`already undone by call ${done[0].undoneBy}; to put it back, undo that call`] };
  }
  const problems = [];
  const ids = new Set(selected.map(e => e.id));
  const refuse = new Set(env.refuseTools ?? []);

  const byDoc = new Map();
  for (const e of selected) {
    if (!e.undoable) problems.push(`${tag(e)}: ${e.reason}`);
    if (refuse.has(e.tool)) problems.push(`${tag(e)}: undoing ${e.tool} needs FOUNDRY_MCP_ALLOW_WRITE=1 on the server, like ${e.tool} itself`);
    if (!byDoc.has(e.uuid)) byDoc.set(e.uuid, []);
    byDoc.get(e.uuid).push(e);
  }

  const steps = [];
  const recreating = new Set();
  for (const [uuid, es] of byDoc) {
    const first = es[0], last = es.at(-1);
    const later = log.entries.find(x => x.uuid === uuid && x.seq > last.seq && !ids.has(x.id));
    if (later) problems.push(`${tag(last)}: changed again afterwards by ${tag(later)} in call ${later.callId}; undo that first`);
    if (!es.every(e => e.undoable)) continue;

    const target = first.before, expected = last.after;
    if (!target && !expected) continue; // created and deleted inside the selection
    const skip = target && expected ? ["_stats", ...last.embedded] : ["_stats"];
    const cur = await env.current(uuid);
    if (!expected && cur) problems.push(`${tag(last)}: ${uuid} exists again; someone recreated it`);
    if (expected && !cur) problems.push(`${tag(last)}: ${uuid} no longer exists`);
    if (expected && cur) {
      const was = expected._stats?.modifiedTime, now = cur._stats?.modifiedTime;
      if (was !== undefined && now !== undefined && now !== was) {
        problems.push(`${tag(last)}: modified at ${new Date(now).toISOString()}, after the recorded change`);
      } else {
        const drift = changedPaths(expected, cur, skip);
        if (drift.length) problems.push(`${tag(last)}: differs from the recorded state at ${drift.slice(0, 5).join(", ")}`);
      }
    }

    const base = { uuid, documentName: last.documentName, name: last.name, seq: last.seq, entries: es.map(e => e.id) };
    let step;
    if (!target) step = { ...base, op: "delete" };
    else if (!expected) {
      // An update's snapshot leaves out embedded collections; the delete's has them.
      const data = first.action === "update" ? { ...target, ...pick(last.before, last.embedded) } : target;
      step = { ...base, op: "create", parentUuid: first.parentUuid, pack: first.pack, data };
      recreating.add(uuid);
    } else {
      const update = cur ? restoreUpdate(target, cur, skip) : {};
      if (!Object.keys(update).length) continue;
      step = { ...base, op: "update", update, skip };
    }
    steps.push(step);
  }

  steps.sort((a, b) => b.seq - a.seq);
  for (const s of steps) {
    if (s.op === "create" && s.parentUuid && !recreating.has(s.parentUuid) && !(await env.current(s.parentUuid))) {
      problems.push(`${s.uuid}: its parent ${s.parentUuid} is gone`);
      continue;
    }
    const why = await env.permission(s);
    if (why) problems.push(`${s.uuid}: ${why}`);
  }
  if (problems.length) return { ok: false, problems, wouldRun: steps.map(stepSummary), ...left };
  // The steps that run are logged under this undo's own call, so an undo with no
  // ids would now pick this undo as the latest call and redo instead of resuming.
  const retry = selected.length === 1 ? { entryId: selected[0].id } : { callId: selected[0].callId };

  const applied = [];
  for (const s of steps) {
    try { await env.apply(s); }
    catch (err) {
      return { ok: false, problems: [`${s.op} ${s.uuid} failed: ${err?.message ?? err}; the steps before it `
        + `stay applied; undo again with ${JSON.stringify(retry)} to resume from here`],
        retry, applied, notRun: steps.slice(applied.length).map(stepSummary), ...left };
    }
    for (const id of s.entries) { log.entries.find(e => e.id === id).undoneBy = env.callId; log.dirty?.add(id); }
    const after = await env.current(s.uuid);
    const target = s.op === "delete" ? null : s.data ?? selected.find(e => e.uuid === s.uuid).before;
    const mismatch = !target ? (after ? ["(still exists)"] : [])
      : !after ? ["(missing)"] : changedPaths(target, after, s.skip ?? ["_stats"]);
    applied.push({ ...stepSummary(s), readBack: mismatch.length ? { ok: false, paths: mismatch.slice(0, 20) } : { ok: true } });
  }
  for (const e of selected) { e.undoneBy = env.callId; log.dirty?.add(e.id); } // includes steps that needed no write
  return { ok: true, undoCallId: env.callId, applied, ...(done.length ? { skipped: done.map(e => e.id) } : {}), ...left };
}

function tag(e) {
  return `${e.id} (${e.tool ?? "?"} ${e.action} ${e.documentName} "${e.name ?? e.uuid}")`;
}

function stepSummary({ op, uuid, documentName, name, entries, update }) {
  return { op, uuid, documentName, name, entries, ...(update ? { fields: Object.keys(update) } : {}) };
}

// ---------------------------------------------------------------------------
// Store: one JournalEntry with default ownership NONE, flagged
// flags.foundry-mcp-live.changeStore. Every entry is one JSON string under
// flags.foundry-mcp-live.entries, keyed `${ms}_${tab}_${id}`, so a write sends
// only the entries that changed and two bridge tabs never overwrite each other.
// `seq.<tab>` keeps each tab's highest seq after its entries are pruned.
// ---------------------------------------------------------------------------

export const STORE_FLAG = "changeStore";
export const STORE_OPTION = "mcpChangeStore"; // operation option: a store write, never logged

export const isChangeStore = doc => !!doc?.flags?.["foundry-mcp-live"]?.[STORE_FLAG];

const keyOf = (tab, e) => `${Date.parse(e.time) || 0}_${tab}_${e.id}`;
const parseKey = k => { const [ms, tab, id] = k.split("_"); return { ms: +ms, tab, seq: +id.slice(1) }; };
const byAge = (a, b) => { const x = parseKey(a), y = parseKey(b); return x.ms - y.ms || x.seq - y.seq; };

/**
 * What to write for `tab`: its `dirty` entries, then the whole store pruned,
 * oldest first (other tabs' entries included), to `limit` entries and
 * `maxChars` characters. The newest entry is always kept.
 * @param {Record<string,string>} stored flags.foundry-mcp-live.entries now
 * @returns {{ set: Record<string,string>, drop: string[] }}
 */
export function storeDelta(stored, tab, dirty, { limit = LOG_LIMIT, maxChars = MAX_STORE_CHARS } = {}) {
  stored ??= {};
  const set = Object.fromEntries(dirty.map(e => [keyOf(tab, e), JSON.stringify(e)]));
  const merged = { ...stored, ...set };
  const all = Object.keys(merged).sort(byAge);
  let cut = Math.max(0, all.length - limit);
  let chars = all.slice(cut).reduce((n, k) => n + merged[k].length, 0);
  while (cut < all.length - 1 && chars > maxChars) chars -= merged[all[cut++]].length;
  const drop = all.slice(0, cut);
  for (const k of drop) delete set[k];
  return { set, drop: drop.filter(k => k in stored) };
}

/** This tab's stored entries, oldest first, from the store's flags.foundry-mcp-live.entries. */
export function loadStored(stored, tab) {
  return Object.keys(stored ?? {}).filter(k => parseKey(k).tab === tab).sort(byAge)
    .map(k => JSON.parse(stored[k]));
}

// ---------------------------------------------------------------------------
// Field-level helpers
// ---------------------------------------------------------------------------

const isObj = v => v !== null && typeof v === "object" && !Array.isArray(v);
const pick = (obj, keys) => Object.fromEntries(keys.filter(k => isObj(obj) && k in obj).map(k => [k, obj[k]]));
const omit = (obj, keys) => (isObj(obj) ? Object.fromEntries(Object.entries(obj).filter(([k]) => !keys.includes(k))) : obj);

function same(a, b) {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every(k => same(a[k], b[k]));
}

/** Dotted leaf paths; arrays and empty objects are leaves. */
function flatten(obj, prefix = "", out = {}) {
  for (const [k, v] of Object.entries(obj ?? {})) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (isObj(v) && Object.keys(v).length) flatten(v, p, out);
    else out[p] = v;
  }
  return out;
}

function at(obj, parts) {
  let v = obj;
  for (const p of parts) {
    if (!isObj(v) || !(p in v)) return { found: false };
    v = v[p];
  }
  return { found: true, value: v };
}

// Drop top-level `keys`, and _stats at every depth below.
function without(obj, keys) {
  if (!isObj(obj)) return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (!keys.includes(k)) out[k] = dropStats(v);
  return out;
}

function dropStats(v) {
  if (Array.isArray(v)) return v.map(dropStats);
  if (!isObj(v)) return v;
  const out = {};
  for (const [k, x] of Object.entries(v)) if (k !== "_stats") out[k] = dropStats(x);
  return out;
}

/** Paths whose values differ between two sources, ignoring top-level `skip` keys and every _stats. */
export function changedPaths(a, b, skip = []) {
  const fa = flatten(without(a, skip)), fb = flatten(without(b, skip));
  return [...new Set([...Object.keys(fa), ...Object.keys(fb)])].filter(k => !same(fa[k], fb[k]));
}

/**
 * The update key and value that delete `key` under the dotted `path` ("" for top level).
 * V14 deprecates the `-=key: null` form (removed in 16) for its ForcedDeletion operator; V13 has only `-=`.
 */
export function forcedDeletion(path, key) {
  const Del = globalThis.foundry?.data?.operators?.ForcedDeletion;
  const prefix = path ? `${path}.` : "";
  return Del ? [prefix + key, new Del()] : [`${prefix}-=${key}`, null];
}

/**
 * The update that takes `current` back to `target` field by field: old values
 * set again, keys that were added removed with forcedDeletion(). Top-level
 * `skip` keys (embedded collections, _stats) are left alone.
 */
export function restoreUpdate(target, current, skip = ["_stats"]) {
  const t = without(target, skip), c = without(current, skip);
  const update = {};
  for (const [k, v] of Object.entries(flatten(t))) {
    const cur = at(c, k.split("."));
    if (cur.found && isObj(v) && isObj(cur.value)) continue; // children handled as removals
    if (!cur.found || !same(v, cur.value)) update[k] = v;
  }
  for (const k of Object.keys(flatten(c))) {
    const parts = k.split(".");
    for (let i = 1; i <= parts.length; i++) {
      const p = at(t, parts.slice(0, i));
      if (p.found && isObj(p.value)) continue;
      if (!p.found) {
        const [key, value] = forcedDeletion(parts.slice(0, i - 1).join("."), parts[i - 1]);
        update[key] = value;
      }
      break; // a non-object in target is set wholesale above
    }
  }
  return update;
}
