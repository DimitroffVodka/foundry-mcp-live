/**
 * Live-play surface: what a GM does at the table that used to need `evaluate`.
 *
 *   - event log   — a ring buffer of chat messages (and the answers to `ask`)
 *                   with a monotonic seq, so an agent can read "what happened
 *                   since I last looked" and block until a player replies.
 *                   Unlike `trace` (a one-shot window opened on demand), it is
 *                   always recording, so nothing is missed between calls.
 *   - waitDialog  — DialogV2.wait raced against a timeout; used by `ask` and
 *                   by request_roll.
 *   - stage       — show a journal, share an image, pause, pull users to a
 *                   scene, play/stop a playlist. All native Foundry calls.
 */
import { runAuditedMutation } from "../lib/audit.js";

export const EVENT_LOG_SIZE = 300;
const MAX_WAIT_MS = 40_000;

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------------------------------------------------------------------------
// Event log
// ---------------------------------------------------------------------------

export function createEventLog(size = EVENT_LOG_SIZE) {
  const events = [];
  const waiters = new Set();
  let seq = 0;

  // A reload restarts seq at 0; a cursor from before it would otherwise match nothing forever.
  const cursor = (sinceSeq) => ((sinceSeq ?? 0) > seq ? { from: 0, reset: true } : { from: sinceSeq ?? 0, reset: false });

  return {
    record(entry) {
      const ev = { seq: ++seq, at: new Date().toISOString(), ...entry };
      events.push(ev);
      if (events.length > size) events.shift();
      for (const w of waiters) w(ev);
      return ev;
    },
    read({ sinceSeq, limit = 50, match } = {}) {
      const { from, reset } = cursor(sinceSeq);
      const hits = events.filter((e) => e.seq > from && (!match || match(e)));
      return {
        latestSeq: seq,
        // the cursor fell off the ring: events between it and the oldest kept one are gone
        ...(events.length && from < events[0].seq - 1 ? { dropped: true } : {}),
        ...(reset ? { reset: true } : {}),
        events: hits.slice(-limit),
      };
    },
    // Resolve with the first event after sinceSeq that matches, already buffered or yet to come.
    // Without sinceSeq it waits for the next new event, ignoring what is already buffered.
    wait({ sinceSeq, match = () => true, timeoutMs = 30_000 } = {}) {
      const { from, reset } = sinceSeq == null ? { from: seq, reset: false } : cursor(sinceSeq);
      const done = (status, event) => ({ status, latestSeq: seq, ...(reset ? { reset: true } : {}), ...(event ? { event } : {}) });
      const hit = events.find((e) => e.seq > from && match(e));
      if (hit) return Promise.resolve(done("matched", hit));
      return new Promise((resolve) => {
        const finish = (r) => { clearTimeout(timer); waiters.delete(onEvent); resolve(r); };
        const onEvent = (ev) => { if (match(ev)) finish(done("matched", ev)); };
        const timer = setTimeout(() => finish(done("timeout")), Math.min(Math.max(0, timeoutMs), MAX_WAIT_MS));
        waiters.add(onEvent);
      });
    },
  };
}

/** Compact, JSON-safe view of a ChatMessage for the event log. */
export function chatEvent(msg) {
  const rolls = (msg.rolls ?? []).map((r) => ({ formula: r.formula, total: r.total }));
  const text = String(msg.content ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  return {
    kind: rolls.length ? "roll" : "chat",
    messageId: msg.id,
    user: msg.author?.name ?? null,
    userId: msg.author?.id ?? null,
    speaker: msg.speaker?.alias ?? null,
    actorId: msg.speaker?.actor ?? null,
    ...(msg.flavor ? { flavor: String(msg.flavor).replace(/<[^>]*>/g, " ").trim().slice(0, 200) } : {}),
    content: text.slice(0, 500),
    ...(rolls.length ? { rolls } : {}),
    whisper: !!msg.whisper?.length,
  };
}

/**
 * Filter for read/wait. Every given field must match: kind exact; user and
 * speaker match a name or id case-insensitively; contains is a case-insensitive
 * substring of content/flavor.
 */
export function eventMatcher({ kind, user, speaker, contains } = {}) {
  const eq = (a, b) => a != null && String(a).toLowerCase() === String(b).toLowerCase();
  const needle = contains?.toLowerCase();
  return (e) => (!kind || e.kind === kind)
    && (!user || eq(e.user, user) || eq(e.userId, user))
    && (!speaker || eq(e.speaker, speaker) || eq(e.actorId, speaker))
    && (!needle || `${e.content ?? ""} ${e.flavor ?? ""}`.toLowerCase().includes(needle));
}

// ---------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------

/**
 * DialogV2.wait raced against a timeout. Returns { status: "answered", value }
 * (value = the clicked button's callback result, or its action), "dismissed"
 * (closed without a button) or "timeout" (the dialog is closed for them).
 */
export async function waitDialog(config, timeoutSeconds) {
  const DialogV2 = foundry.applications.api.DialogV2;
  let dialog, timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ status: "timeout" }), timeoutSeconds * 1000);
  });
  const answer = DialogV2.wait({ ...config, rejectClose: false, render: (_e, d) => { dialog = d; } })
    .then((value) => (value === null ? { status: "dismissed" } : { status: "answered", value }));
  const result = await Promise.race([answer, timeout]);
  clearTimeout(timer);
  if (result.status === "timeout") { try { await dialog?.close(); } catch { /* already gone */ } }
  return result;
}

/**
 * Ask the user at this client a question. `choices` become buttons; with
 * `freeText` a text box is shown and its value returned with the button.
 * Title and labels are passed raw: ApplicationV2 sets the title and DialogV2
 * sets button labels with innerText, so escaping them here would show "&amp;".
 * The question goes into HTML content, so it is escaped.
 */
export async function requestAsk(params = {}, log) {
  const { question, title = "A question from the GM", choices, freeText = false, timeoutSeconds = 30 } = params;
  if (!question || typeof question !== "string") throw new Error("`question` is required.");
  const labels = Array.isArray(choices) && choices.length ? choices.map(String) : (freeText ? ["Answer"] : ["Yes", "No"]);
  if (labels.length > 8) throw new Error("At most 8 choices.");

  // Index-based actions: DialogV2 looks buttons up with a [data-action="…"] selector, so labels can't be actions.
  const buttons = labels.map((label, i) => ({
    action: `choice${i}`, label, default: i === 0,
    callback: (_event, button) => ({ choice: label, index: i,
      ...(freeText ? { text: String(button.form?.elements?.answer?.value ?? "") } : {}) }),
  }));
  const content = `<p>${escapeHtml(question)}</p>`
    + (freeText ? `<input type="text" name="answer" autofocus>` : "");

  const result = await waitDialog({ window: { title }, content, buttons }, timeoutSeconds);
  const out = { status: result.status, user: game.user.name, question,
    ...(result.status === "answered" ? result.value : {}) };
  // The answer also lands in this client's event log, so one that arrives after the MCP call gave up is not lost.
  log?.record({ kind: "ask", user: game.user.name, userId: game.user.id, ...out });
  return out;
}

// ---------------------------------------------------------------------------
// Stage
// ---------------------------------------------------------------------------

const NO_CAPTURE = { before: async () => null, after: async () => null };

function byRef(collection, ref, what) {
  if (!ref) throw new Error(`\`${what}\` is required.`);
  const doc = collection.get(ref) ?? collection.getName(ref)
    ?? collection.find((d) => d.name?.toLowerCase() === String(ref).toLowerCase());
  if (!doc) throw new Error(`${what} "${ref}" not found.`);
  return doc;
}

/** User names/ids → ids of users that exist. Empty/omitted → [] (= everyone). */
function userIds(users) {
  if (users == null) return [];
  return (Array.isArray(users) ? users : [users]).map((u) => {
    const user = game.users.get(u) ?? game.users.getName(u);
    if (!user) throw new Error(`User "${u}" not found.`);
    return user.id;
  });
}

const STAGE_ACTIONS = {
  async showJournal({ journal, page, users, force = true }) {
    const entry = byRef(game.journal, journal, "journal");
    const doc = page ? byRef(entry.pages, page, "page") : entry;
    const ids = userIds(users);
    await foundry.documents.collections.Journal.show(doc, { force, users: ids });
    return { shown: doc.uuid, name: doc.name, users: ids.length ? ids.map((id) => game.users.get(id).name) : "all" };
  },

  async shareImage({ image, title, caption, users }) {
    if (!image) throw new Error("`image` (a path or URL) is required.");
    const ids = userIds(users);
    const ImagePopout = foundry.applications.apps.ImagePopout;
    new ImagePopout({ src: image, caption, window: { title: title ?? "" } })
      .shareImage({ title, caption, ...(ids.length ? { users: ids } : {}) });
    return { shared: image, users: ids.length ? ids.map((id) => game.users.get(id).name) : "all" };
  },

  async pause({ paused }) {
    if (!game.user.isGM) throw new Error("Only a GM can pause the game for everyone.");
    const now = game.togglePause(paused ?? !game.paused, { broadcast: true });
    return { paused: now };
  },

  async pullToScene({ scene, users }) {
    if (!game.user.isGM) throw new Error("Only a GM can pull users to a scene.");
    const target = byRef(game.scenes, scene, "scene");
    const ids = userIds(users);
    const pulled = (ids.length ? ids.map((id) => game.users.get(id)) : game.users.contents)
      .filter((u) => u.active && u.id !== game.user.id);
    // what Scene#pullUsers emits; called directly so v13 and v14 behave the same
    for (const u of pulled) game.socket.emit("pullToScene", target.id, u.id);
    return { scene: target.name, sceneId: target.id, pulled: pulled.map((u) => u.name) };
  },

  async playlist({ playlist, sound, play = true }) {
    const list = byRef(game.playlists, playlist, "playlist");
    const track = sound ? byRef(list.sounds, sound, "sound") : null;
    if (play) await (track ? list.playSound(track) : list.playAll());
    else await (track ? list.stopSound(track) : list.stopAll());
    return { playlist: list.name, ...(track ? { sound: track.name } : {}),
      playing: list.sounds.filter((s) => s.playing).map((s) => s.name) };
  },
};

export async function stage(params = {}) {
  const fn = STAGE_ACTIONS[params.action];
  if (!fn) throw new Error(`Unknown stage action "${params.action}". Valid: ${Object.keys(STAGE_ACTIONS).join(", ")}.`);
  return runAuditedMutation(`stage_${params.action}`, params, NO_CAPTURE, () => fn(params));
}
