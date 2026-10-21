/**
 * Browser-side mutation audit engine for the Foundry MCP bridge.
 */

// Keys filtered before diffing because they're auto-mutated by Foundry on
// every update (timestamps, edit metadata) and would otherwise dominate
// every audit block.
//
// `_id` is INTENTIONALLY NOT included — deepDiff uses _id for stable
// array-matching of embedded documents (items, effects, etc.). Stripping
// _id forces id-matching to fall back to positional matching, which
// produces noisy "every index changed" diffs when an item is inserted or
// reordered. _id will appear as a stable key in change paths, never as a
// noisy "changed" leaf in practice.
const NOISY_KEYS = new Set([
  "_stats", "modifiedTime", "lastModifiedBy", "sort", "_at"
]);

/**
 * Filter metadata from a change object to keep the audit clean.
 */
function isNoisy(key) {
  return NOISY_KEYS.has(key);
}

/**
 * Filter metadata from an object recursively.
 */
export function filterMetadata(val) {
  if (val === null || typeof val !== "object") return val;
  if (Array.isArray(val)) return val.map(filterMetadata);
  
  const out = {};
  for (const [k, v] of Object.entries(val)) {
    if (isNoisy(k)) continue;
    out[k] = filterMetadata(v);
  }
  return out;
}

/**
 * Recursive structural diff between two objects.
 * Handles ID-based array matching for Foundry documents.
 */
export function deepDiff(a, b, path = "") {
  const changes = [];
  if (a === b) return changes;

  if (a === undefined || a === null) {
    changes.push({ path, op: "added", after: filterMetadata(b) });
    return changes;
  }
  if (b === undefined || b === null) {
    changes.push({ path, op: "removed", before: filterMetadata(a) });
    return changes;
  }

  const ta = typeof a, tb = typeof b;
  const isObjA = ta === "object" && a !== null;
  const isObjB = tb === "object" && b !== null;

  if (!isObjA || !isObjB || Array.isArray(a) !== Array.isArray(b)) {
    if (a !== b) {
      changes.push({ path, op: "changed", before: filterMetadata(a), after: filterMetadata(b) });
    }
    return changes;
  }

  if (Array.isArray(a)) {
    const aHasIds = a.length > 0 && a.every(e => e && typeof e === "object" && "_id" in e);
    const bHasIds = b.length > 0 && b.every(e => e && typeof e === "object" && "_id" in e);
    if (aHasIds && bHasIds) {
      const aMap = new Map(a.map(e => [e._id, e]));
      const bMap = new Map(b.map(e => [e._id, e]));
      const ids = new Set([...aMap.keys(), ...bMap.keys()]);
      for (const id of ids) {
        changes.push(...deepDiff(aMap.get(id), bMap.get(id), `${path}[#${id}]`));
      }
      return changes;
    }
    const max = Math.max(a.length, b.length);
    for (let i = 0; i < max; i++) {
      changes.push(...deepDiff(a[i], b[i], `${path}[${i}]`));
    }
    return changes;
  }

  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if (isNoisy(k)) continue;
    changes.push(...deepDiff(a[k], b[k], path ? `${path}.${k}` : k));
  }
  return changes;
}

/**
 * Safe serializer for hook arguments (documents, circular refs, deep trees)
 */
export function safeSerializeHookArg(val, depth = 0, maxDepth = 3) {
  if (val === null || val === undefined)    return val;
  const t = typeof val;
  if (t === "string" || t === "number" || t === "boolean") return val;
  if (t === "function") return `[Function ${val.name || "anon"}]`;
  if (depth >= maxDepth) return "[max depth]";

  if (val instanceof Error) {
    const out = {
      _type:   "Error",
      name:    val.name,
      message: val.message,
      stack:   val.stack
    };
    if (val.cause !== undefined) {
      try { out.cause = safeSerializeHookArg(val.cause, depth + 1, maxDepth); }
      catch { out.cause = "[unserializable]"; }
    }
    return out;
  }

  // Foundry documents — summarise
  if (val?.documentName) {
    return {
      _document: val.documentName,
      id:   val.id   ?? null,
      name: val.name ?? null,
      uuid: val.uuid ?? null
    };
  }

  // Foundry placeables (Token, Tile, Template, …) — the canvas object wraps a
  // document. Summarise to the underlying document; the PIXI internals
  // (transform, _bounds, _events, …) are pure noise in a hook trace. Common in
  // Midi-QOL hook args, where the workflow carries the attacker token.
  if (val?.document?.documentName) {
    const d = val.document;
    return {
      _placeable: d.documentName,
      id:   d.id   ?? null,
      name: d.name ?? null,
      uuid: d.uuid ?? null
    };
  }

  // Bare PIXI display objects (anything with a transform + bounds) — never
  // useful in a trace; collapse to a tag rather than dumping the scene graph.
  if (val?.transform && val?._bounds !== undefined) {
    return `[PIXI ${val.constructor?.name || "DisplayObject"}]`;
  }

  let valToSerialize = val;
  if (val instanceof Map) valToSerialize = Object.fromEntries(val);
  else if (val instanceof Set) valToSerialize = Array.from(val);

  if (Array.isArray(valToSerialize)) {
    return valToSerialize.slice(0, 10).map(v => safeSerializeHookArg(v, depth + 1, maxDepth));
  }

  if (typeof valToSerialize === "object") {
    const out = {};
    const keys = Object.keys(valToSerialize).slice(0, 25);
    for (const k of keys) {
      try { out[k] = safeSerializeHookArg(valToSerialize[k], depth + 1, maxDepth); }
      catch { out[k] = "[unserializable]"; }
    }
    return out;
  }
  return String(valToSerialize);
}

/**
 * Extract a minimal reference from a Foundry document.
 */
export function extractDocRef(doc) {
  if (!doc) return null;
  return {
    documentName: doc.documentName ?? doc.constructor?.name ?? "Object",
    id: doc.id ?? doc._id,
    name: doc.name,
    uuid: doc.uuid
  };
}

/**
 * Truncate long lists of snapshots to save tokens.
 */
function truncateSnapshots(data, limit = 10) {
  if (!data || typeof data !== "object") return { data, truncated: false };
  
  if (Array.isArray(data) && data.length > limit) {
    return {
      data: data.slice(0, limit),
      truncated: { fullLimit: limit, summarized: data.length - limit }
    };
  }
  
  const keys = Object.keys(data);
  if (keys.length > limit) {
    const subset = {};
    for (let i = 0; i < limit; i++) subset[keys[i]] = data[keys[i]];
    return {
      data: subset,
      truncated: { fullLimit: limit, summarized: keys.length - limit }
    };
  }

  return { data, truncated: false };
}

/**
 * Build dry undo instructions based on the observed change.
 */
function buildUndo(toolName, before, after, diff) {
  if (toolName.startsWith("create_")) {
    return {
      action: "delete",
      note: `Delete the created document(s) to undo.`
    };
  }

  if (toolName.startsWith("delete_")) {
    return {
      action: "recreate",
      note: "Manual recreation from the 'before' snapshot is required.",
      data: before
    };
  }

  const MUTATORS = ["update_", "move_", "target", "toggle_token_condition", "apply_damage", "set_actor_ownership"];
  if (MUTATORS.some(m => toolName.startsWith(m))) {
    const rollback = {};
    for (const change of diff) {
      if (change.op === "changed" || change.op === "removed") {
        rollback[change.path] = change.before;
      }
    }
    return {
      action: "update",
      note: "Apply the 'rollback' data to the target document(s) to undo.",
      rollback
    };
  }

  return { note: "Undo instructions not available for this tool type." };
}

/**
 * The main mutation wrapper.
 */
export async function runAuditedMutation(toolName, params, capturePlan, executeFn) {
  // The "Allow AI to modify the world" gate is not here: bridge.js dispatch()
  // enforces it for every handler from lib/handler-access.js, wrapped or not.
  // The always-on change log (lib/change-log.js) is separate too; this block
  // is the per-call `audit: true` view.

  // Audit must be opt-in; check this BEFORE any logging or work. Earlier
  // builds logged here unconditionally and spammed Foundry's console on
  // every non-audited mutation.
  if (params.audit !== true) return executeFn();

  const startedAt = new Date().toISOString();
  let beforeStateRaw = null;
  const auditWarnings = [];

  try {
    beforeStateRaw = await capturePlan.before(params);
  } catch (e) {
    auditWarnings.push(`Before-capture failed: ${e.message}`);
  }

  // Execute the real mutation — must succeed or fail on its own terms.
  // Nothing below this line is allowed to mask the mutation's outcome.
  const result = await executeFn();
  const finishedAt = new Date().toISOString();

  // Everything that follows (capture-after, filter, diff, truncate, undo)
  // runs inside a single try/catch. If any step fails, we still return the
  // mutation result and a partial audit block — the mutation must never be
  // turned into a failure by an audit bug.
  try {
    let afterStateRaw = null;
    try {
      afterStateRaw = await capturePlan.after(params, result);
    } catch (e) {
      auditWarnings.push(`After-capture failed: ${e.message}`);
    }

    const beforeState = filterMetadata(beforeStateRaw);
    const afterState  = filterMetadata(afterStateRaw);

    const changes = deepDiff(beforeState, afterState);

    const { data: bSub, truncated: bTrunc } = truncateSnapshots(beforeState);
    const { data: aSub, truncated: aTrunc } = truncateSnapshots(afterState);

    const audit = {
      tool: toolName,
      startedAt,
      finishedAt,
      before: bSub,
      after: aSub,
      diff: {
        total: changes.length,
        summary: {
          added:   changes.filter(c => c.op === "added").length,
          removed: changes.filter(c => c.op === "removed").length,
          changed: changes.filter(c => c.op === "changed").length,
        },
        changes: changes.length > 50 ? changes.slice(0, 50) : changes
      },
      undo: buildUndo(toolName, beforeState, afterState, changes),
      warnings: auditWarnings.length > 0 ? auditWarnings : undefined
    };

    if (changes.length > 50) {
      audit.diff.truncated = { total: changes.length, returned: 50 };
    }
    if (bTrunc || aTrunc) {
      audit.truncated = { before: bTrunc, after: aTrunc };
    }

    return { ...result, audit };
  } catch (e) {
    // Audit machinery itself broke. Return the mutation result with a
    // partial audit so the caller still gets the successful outcome.
    return {
      ...result,
      audit: {
        tool: toolName,
        startedAt,
        finishedAt,
        partial: true,
        error: e.message,
        warnings: auditWarnings.length > 0 ? auditWarnings : undefined
      }
    };
  }
}
