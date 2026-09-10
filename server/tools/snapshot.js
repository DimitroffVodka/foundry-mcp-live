/**
 * Snapshot + diff — one merged `snapshot` tool (2026-08-19):
 *
 *   action 'take' — capture structured projections of actors at selector
 *                   paths, with optional server-side storage under storeId
 *   action 'diff' — re-snapshot and diff against a stored snapshotId OR an
 *                   inline `snapshot` payload
 *
 * Server-side orchestration (storeId persistence + diff) lives here.
 */
import { z }                                from "zod";
import { registerRawTool }                  from "./_helpers.js";
import { requestFoundry }                   from "../lib/foundry-rpc.js";
import { snapshotStore, pruneSnapshotStore, diffProjections } from "../lib/snapshot-store.js";

export function registerSnapshotTools(mcp) {
  registerRawTool(mcp, "snapshot",
    "Actor-state snapshots for before/after verification. "
    + "action 'take' — capture structured projections of one or more actors at selector paths "
    + "(faster and more focused than full actor reads; walks the LIVE document so derived data "
    + "like statuses and Active-Effect-modified stats surface). Pass `storeId` to persist "
    + "server-side (~30 min TTL, LRU 50) so a later diff reuses it. "
    + "action 'diff' — re-snapshots the live game and computes per-path changes. Uses a stored "
    + "`storeId` (reuses its actors/select/targetUser automatically) OR an inline `snapshot` "
    + "payload (requires matching `actors`+`select`). Returns "
    + "{changes: [{actorId, path, op, before, after}], summary}.\n\n"
    + "Selector grammar: dot paths plus array wildcards — 'system.health.value', "
    + "'effects[*].name', 'items[2].name', 'flags.vagabond', 'statuses' (getter-only Set).\n\n"
    + "Omit `select` to capture the full actor.toObject() under a `_full` key — note that path "
    + "is the persisted source and does NOT include derived data.",
    {
      action:   z.enum(["take", "diff"]).describe("Snapshot operation."),
      actors:   z.union([z.string(), z.array(z.string())]).optional().describe(
        "[take] Actor id(s) or name(s). [diff/inline] The same actor list to re-snapshot."
      ),
      select:   z.array(z.string()).optional().describe(
        "Selector paths (dot paths + array wildcards). Omit to capture full actor.toObject()."
      ),
      storeId:  z.string().optional().describe(
        "[take] Store server-side under this ID (~30 min TTL). "
        + "[diff] ID of a stored snapshot to diff against (mutually exclusive with `snapshot`)."
      ),
      snapshot: z.any().optional().describe(
        "[diff] Inline `actors` payload returned by a prior take. Mutually exclusive with `storeId`."
      ),
      targetUser: z.string().optional().describe(
        "Foundry user to route to. Omit for GM (default); stored diffs reuse their original user."
      ),
    },
    async ({ action, actors, select, storeId, snapshot, targetUser }) => {
      // ---------- action 'take' (snapshot_actors behaviour) ----------
      if (action === "take") {
        let bridgeResult;
        try {
          bridgeResult = await requestFoundry("snapshot_actors", { actors, select }, targetUser);
        } catch (err) {
          return { content: [{ type: "text", text: `Error: ${err.message}` }] };
        }
        if (bridgeResult?.error) {
          return { content: [{ type: "text", text: `Error: ${bridgeResult.error}` }] };
        }
        if (storeId) {
          pruneSnapshotStore();
          snapshotStore.set(storeId, {
            actors:    bridgeResult.actors,
            select:    select || null,
            actorRefs: Array.isArray(actors) ? actors : [actors],
            takenAt:   bridgeResult.takenAt,
            targetUser: targetUser || null,
          });
        }
        return { content: [{ type: "text", text: JSON.stringify({
          snapshotId: storeId || null,
          takenAt:    new Date(bridgeResult.takenAt).toISOString(),
          actors:     bridgeResult.actors,
          ...(bridgeResult.errors ? { errors: bridgeResult.errors } : {}),
        }, null, 2) }] };
      }

      // ---------- action 'diff' (diff_with behaviour) ----------
      if (action === "diff") {
        let beforeActors, beforeSelect, beforeActorRefs;
        if (storeId) {
          const stored = snapshotStore.get(storeId);
          if (!stored) {
            const known = [...snapshotStore.keys()].join(", ") || "(none)";
            return { content: [{ type: "text", text:
              `Error: No snapshot stored under "${storeId}". Available IDs: ${known}.`
            }] };
          }
          beforeActors    = stored.actors;
          beforeSelect    = stored.select;
          beforeActorRefs = stored.actorRefs;
          if (!targetUser) targetUser = stored.targetUser;
        } else if (snapshot) {
          beforeActors    = snapshot;
          beforeSelect    = select || null;
          beforeActorRefs = actors ? (Array.isArray(actors) ? actors : [actors]) : Object.keys(beforeActors);
          if (beforeActorRefs.length === 0) {
            return { content: [{ type: "text", text:
              "Error: inline `snapshot` mode requires non-empty `actors` (or a snapshot with at least one actor key)."
            }] };
          }
        } else {
          return { content: [{ type: "text", text:
            "Error: provide either `storeId` (from a stored take) or `snapshot` (inline)."
          }] };
        }

        let currentResult;
        try {
          currentResult = await requestFoundry("snapshot_actors",
            { actors: beforeActorRefs, select: beforeSelect }, targetUser);
        } catch (err) {
          return { content: [{ type: "text", text: `Error: ${err.message}` }] };
        }
        if (currentResult?.error) {
          return { content: [{ type: "text", text: `Error: ${currentResult.error}` }] };
        }
        const currentActors = currentResult.actors || {};

        const changes = [];
        const allActorIds = new Set([...Object.keys(beforeActors), ...Object.keys(currentActors)]);
        for (const actorId of allActorIds) {
          const before = beforeActors[actorId];
          const after  = currentActors[actorId];
          if (!after)  { changes.push({ actorId, op: "actorMissing" }); continue; }
          if (!before) { changes.push({ actorId, op: "actorAdded"   }); continue; }
          changes.push(...diffProjections(before, after, actorId));
        }

        const summary = { added: 0, removed: 0, changed: 0, actorAdded: 0, actorMissing: 0 };
        for (const c of changes) summary[c.op] = (summary[c.op] || 0) + 1;

        return { content: [{ type: "text", text: JSON.stringify({
          storeId: storeId || null,
          takenAt: new Date(currentResult.takenAt).toISOString(),
          changes,
          summary,
        }, null, 2) }] };
      }

      return { content: [{ type: "text", text:
        `Error: unknown action "${action}" for snapshot. Valid: take, diff.` }] };
    });
}