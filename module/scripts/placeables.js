/**
 * Scene placeable authoring — the `placeable` tool.
 *
 *   create / update  — up to MAX_ENTRIES documents of ONE type per call. Every
 *                      entry is validated by Foundry's own data model before
 *                      anything is written, so one bad entry writes nothing.
 *                      The stored documents are read back and any field
 *                      Foundry stored differently from what was sent is
 *                      reported (rounded coordinates, clamped values, …).
 *   delete           — by id, or every document of the type this tool created
 *                      (flags.foundry-mcp-live.createdBy), or just one call's
 *                      (flags.foundry-mcp-live.callId); dryRun lists them.
 *   door             — set walls' door state open/closed/locked.
 *
 * Writes go through runAuditedMutation (audit); the read-only toggle is enforced
 * by bridge.js dispatch() via lib/handler-access.js. The
 * relay's stored-code check (lib/relay-guard.js findStoredCode) sees these
 * params like any other relayed call, so Region executeScript/executeMacro
 * behaviors are refused over the relay unless the world allows evaluate.
 */
import { runAuditedMutation } from "../lib/audit.js";

const MODULE_ID = "foundry-mcp-live";
export const PLACEABLE_TYPES = ["Wall", "AmbientLight", "AmbientSound", "Tile", "Drawing", "Region", "Note"];
export const MAX_ENTRIES = 200;
const MAX_REPORTED = 20;

// Wall fields that take a plain word as well as the CONST number.
const WALL_WORDS = {
  door: "WALL_DOOR_TYPES", ds: "WALL_DOOR_STATES", move: "WALL_MOVEMENT_TYPES",
  sight: "WALL_SENSE_TYPES", light: "WALL_SENSE_TYPES", sound: "WALL_SENSE_TYPES", dir: "WALL_DIRECTIONS",
};

/** One plain word (e.g. "secret", "limited") → its CONST value; numbers pass through. */
export function wordValue(consts, table, field, value) {
  if (typeof value !== "string") return value;
  const n = consts[table]?.[value.trim().toUpperCase()];
  if (n === undefined) {
    throw new Error(`${field} "${value}" is not one of ${Object.keys(consts[table]).map(k => k.toLowerCase()).join("|")}`);
  }
  return n;
}

/** A wall entry with its plain-word fields mapped to CONST values. */
export function mapWallWords(entry, consts) {
  const out = { ...entry };
  for (const [field, table] of Object.entries(WALL_WORDS)) {
    if (field in out) out[field] = wordValue(consts, table, field, out[field]);
  }
  return out;
}

/**
 * Fields of `sent` that `stored` holds a different value for. Walks only the
 * keys that were sent, so defaults Foundry fills in are not reported.
 */
export function storedDifferently(sent, stored, path = "") {
  if (sent === null || typeof sent !== "object") {
    return sent === stored ? [] : [{ field: path, sent, stored: stored ?? null }];
  }
  if (Array.isArray(sent) && (!Array.isArray(stored) || stored.length !== sent.length)) {
    return [{ field: path, sent, stored: stored ?? null }];
  }
  const out = [];
  for (const [k, v] of Object.entries(sent)) {
    out.push(...storedDifferently(v, stored?.[k], path ? `${path}.${k}` : k));
  }
  return out;
}

function refuse(problems, total) {
  const shown = problems.slice(0, MAX_REPORTED).join("; ");
  const more = problems.length > MAX_REPORTED ? ` (+${problems.length - MAX_REPORTED} more)` : "";
  return new Error(`Nothing written: ${problems.length} of ${total} entries are invalid — ${shown}${more}`);
}

function differences(sentEntries, docs) {
  const out = [];
  docs.forEach((doc, i) => {
    if (!doc) return;
    const sent = foundry.utils.expandObject(sentEntries[i]);
    delete sent._id;
    for (const d of storedDifferently(sent, doc.toObject())) out.push({ index: i, id: doc.id, ...d });
  });
  return out;
}

function label(doc) {
  return doc.name || doc.text || (doc.c ? doc.c.join(",") : null);
}

// The Level id `ref` (id or name) names, or null for none given.
function levelId(scene, ref) {
  if (ref === undefined) return null;
  const level = scene.levels?.get(ref) ?? scene.levels?.getName?.(ref);
  if (!level) throw new Error(`level "${ref}" is not a Level of scene "${scene.name}"`);
  return level.id;
}

async function create(scene, type, entries, { level, callId }) {
  const cls = CONFIG[type].documentClass;
  const defaultLevel = levelId(scene, level);
  // An empty `levels` puts a placeable on every Level, so on a multi-level
  // scene leaving it out is refused rather than silently meaning "all".
  const levelNames = (scene.levels?.size ?? 0) > 1 ? scene.levels.map(l => l.name).join(", ") : null;
  const sent = [];
  const problems = [];
  entries.forEach((entry, i) => {
    try {
      const data = type === "Wall" ? mapWallWords(entry, CONST) : { ...entry };
      delete data._id;
      if (!("levels" in data)) {
        if (defaultLevel) data.levels = [defaultLevel];
        else if (levelNames) throw new Error(`scene has Levels (${levelNames}): pass level, or levels on the entry ([] for every Level)`);
      }
      new cls(foundry.utils.deepClone(data), { parent: scene, strict: true }); // Foundry validates (and cleans its argument in place)
      sent.push(data);
    } catch (err) {
      problems.push(`[${i}] ${err.message}`);
    }
  });
  if (problems.length) throw refuse(problems, entries.length);
  // Ids chosen here so each stored document can be matched to its entry:
  // createEmbeddedDocuments does not return them in input order.
  const ids = sent.map(() => foundry.utils.randomID());
  const flagged = sent.map((d, i) => foundry.utils.mergeObject(foundry.utils.deepClone(d),
    { _id: ids[i], flags: { [MODULE_ID]: { createdBy: "placeable", callId } } }));
  await scene.createEmbeddedDocuments(type, flagged, { keepId: true });
  const collection = scene.getEmbeddedCollection(type);
  const docs = ids.map(id => collection.get(id));
  // Another module's preCreate hook can veto a document; report it rather than throw after the rest were written.
  const notCreated = docs.flatMap((d, i) => (d ? [] : [i]));
  const made = docs.filter(Boolean);
  const diffs = differences(sent, docs);
  return { sceneId: scene.id, type, callId, created: made.length, ids: made.map(d => d.id),
    ...(notCreated.length && { notCreated }), ...(diffs.length && { storedDifferently: diffs }) };
}

async function update(scene, type, entries) {
  const collection = scene.getEmbeddedCollection(type);
  const sent = [];
  const problems = [];
  entries.forEach((entry, i) => {
    try {
      const doc = collection.get(entry?._id);
      if (!doc) throw new Error(`no ${type} with _id "${entry?._id}" on scene "${scene.name}"`);
      const data = type === "Wall" ? mapWallWords(entry, CONST) : { ...entry };
      doc.clone({}, { keepId: true }).updateSource(foundry.utils.deepClone(data)); // validates, touches nothing stored
      sent.push(data);
    } catch (err) {
      problems.push(`[${i}] ${err.message}`);
    }
  });
  if (problems.length) throw refuse(problems, entries.length);
  await scene.updateEmbeddedDocuments(type, sent);
  const docs = sent.map(d => collection.get(d._id));
  const diffs = differences(sent, docs);
  return { sceneId: scene.id, type, updated: docs.length, ids: docs.map(d => d.id), ...(diffs.length && { storedDifferently: diffs }) };
}

function deletionTargets(scene, type, params) {
  const collection = scene.getEmbeddedCollection(type);
  if (params.createdByMcp || params.callId) {
    if (params.ids) throw new Error("Nothing deleted: pass ids, or createdByMcp/callId, not both");
    return collection.filter(d => {
      const f = d.flags?.[MODULE_ID];
      return f?.createdBy && (!params.callId || f.callId === params.callId);
    });
  }
  const missing = params.ids.filter(id => !collection.has(id));
  if (missing.length) throw new Error(`Nothing deleted: no ${type} with id ${missing.join(", ")} on scene "${scene.name}"`);
  return params.ids.map(id => collection.get(id));
}

async function setDoors(scene, params) {
  const state = wordValue(CONST, "WALL_DOOR_STATES", "state", params.state);
  if (!Object.values(CONST.WALL_DOOR_STATES).includes(state)) throw new Error(`state ${params.state} is not a door state`);
  const problems = [];
  for (const id of params.ids) {
    const wall = scene.walls.get(id);
    if (!wall) problems.push(`${id}: no such wall`);
    else if (wall.door === CONST.WALL_DOOR_TYPES.NONE) problems.push(`${id}: not a door`);
  }
  if (problems.length) throw refuse(problems, params.ids.length);
  await scene.updateEmbeddedDocuments("Wall", params.ids.map(_id => ({ _id, ds: state })));
  return { sceneId: scene.id, updated: params.ids.length, ids: params.ids, ds: state };
}

// Audit snapshots: the documents of `type` named by the call (before) or the result (after).
function capturePlan(scene, type) {
  const grab = (ids) => ids.map(id => scene.getEmbeddedCollection(type).get(id)?.toObject()).filter(Boolean);
  return {
    before: async (p) => grab(p.ids ?? (p.entries ?? []).map(e => e?._id).filter(Boolean)),
    after: async (_p, res) => grab(res?.ids ?? []),
  };
}

/**
 * @param {object} params  the tool params
 * @param {{callId?: string}} [ctx]  the dispatcher's call id, when it assigns one
 */
export async function placeable(params = {}, ctx = {}) {
  const { action } = params;
  const type = action === "door" ? "Wall" : params.type;
  if (!PLACEABLE_TYPES.includes(type)) throw new Error(`type must be one of ${PLACEABLE_TYPES.join(", ")}`);
  const scene = params.sceneId ? game.scenes.get(params.sceneId) : game.scenes.active;
  if (!scene) throw new Error(params.sceneId ? `Scene not found: ${params.sceneId}` : "No active scene; pass sceneId");

  const list = action === "create" || action === "update" ? params.entries : params.ids;
  const listName = action === "create" || action === "update" ? "entries" : "ids";
  if (!(action === "delete" && (params.createdByMcp || params.callId))) {
    if (!Array.isArray(list) || list.length === 0) throw new Error(`placeable ${action} needs a non-empty ${listName} array`);
    if (list.length > MAX_ENTRIES) throw new Error(`${list.length} ${listName}; at most ${MAX_ENTRIES} per call`);
  }

  if (action === "delete") {
    const docs = deletionTargets(scene, type, params);
    const listed = docs.map(d => ({ id: d.id, label: label(d) }));
    if (params.dryRun) return { sceneId: scene.id, type, dryRun: true, wouldDelete: listed.length, documents: listed };
    const ids = docs.map(d => d.id);
    return runAuditedMutation("delete_placeables", { ...params, ids }, capturePlan(scene, type), async () => {
      await scene.deleteEmbeddedDocuments(type, ids);
      return { sceneId: scene.id, type, deleted: listed.length, documents: listed };
    });
  }
  if (action === "create") return runAuditedMutation("create_placeables", params, capturePlan(scene, type), () => create(scene, type, params.entries, {
    level: params.level, callId: ctx.callId ?? `placeable-${foundry.utils.randomID(8)}` }));
  if (action === "update") return runAuditedMutation("update_placeables", params, capturePlan(scene, type), () => update(scene, type, params.entries));
  if (action === "door") return runAuditedMutation("update_doors", params, capturePlan(scene, type), () => setDoors(scene, params));
  throw new Error(`Unknown placeable action "${action}"; use create|update|delete|door`);
}
