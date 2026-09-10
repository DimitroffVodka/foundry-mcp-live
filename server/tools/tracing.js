/**
 * Tracing — runtime diagnostics. One merged `trace` tool:
 *
 *   action 'hooks'    — trace_hooks (multi-hook timeline, single window)
 *   action 'socket'   — trace_socket (game.socket tap, in/out events)
 *   action 'workflow' — trace_workflow (preset-driven full-workflow investigation)
 */
import { z }                     from "zod";
import { registerRawTool }       from "./_helpers.js";
import { requestFoundry, callFoundry } from "../lib/foundry-rpc.js";
import { diffProjections }       from "../lib/snapshot-store.js";
import { WORKFLOW_PRESETS, PRESET_KEYS, presetCatalogue }
                                 from "../lib/workflow-presets.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function registerTracingTools(mcp) {
  registerRawTool(mcp, "trace",
    "Runtime diagnostics with three modes. "
    + "'hooks' — listen on multiple Foundry hooks at once and return one time-ordered timeline: "
    + "{at, dt, hook, args} where dt is ms since first firing. Diagnose hook-order bugs. "
    + "'socket' — tap game.socket for a window: in/out events {at, dt, dir: 'in'|'out', event, args}; "
    + "optional substring filter on event name. Don't run two socket traces in parallel. "
    + "'workflow' — one-call investigation: expands a named PRESET into the exact hook list (Foundry "
    + "has no wildcard hook matching), opens a trace window, optionally snapshots `watch` actors "
    + "before/after with a structural diff, and optionally fires `trigger` (any bridge tool) inside "
    + "the window. For Midi presets the trigger MUST be `use_item` (calls item.use() through Midi), "
    + "NOT request_item_use (bypasses Midi).\n\n"
    + "Presets:\n  " + presetCatalogue(),
    {
      action: z.enum(["hooks", "socket", "workflow"]).describe("Trace mode."),
      // hooks / socket
      hooks:   z.array(z.string()).optional().describe("[hooks] Hook names to listen on simultaneously."),
      filter:  z.string().optional().describe("[socket] Only record events whose name contains this substring (e.g. 'module.vagabond-crawler')."),
      count:   z.number().optional().describe("[hooks/socket/workflow] Max firings/events. Default 50 (hooks) / 100 (socket) / 200 (workflow)."),
      timeoutMs: z.number().optional().describe("[hooks/socket/workflow] Window length ms (100–30000). Default 5000 (hooks/socket) / 8000 (workflow)."),
      until:   z.string().optional().describe("[hooks/workflow] Stop as soon as this hook fires (must be in the hook list)."),
      // workflow
      preset:        z.enum(PRESET_KEYS).optional().describe("[workflow] Which workflow preset to trace."),
      watch:         z.union([z.string(), z.array(z.string())]).optional().describe("[workflow] Actor id(s)/name(s) to snapshot before and after, then diff. Omit to only collect the hook timeline."),
      select:        z.array(z.string()).optional().describe("[workflow] Override the preset's default snapshot selectors."),
      extraHooks:    z.array(z.string()).optional().describe("[workflow] Additional hook names merged into the preset's list."),
      trigger:       z.object({
                       tool:   z.string().describe("Bridge tool to fire mid-window, e.g. 'request_item_use'."),
                       params: z.record(z.any()).optional().describe("Params for that tool."),
                     }).optional().describe("[workflow] Fire this bridge tool inside the trace window so its hooks are captured."),
      triggerDelayMs: z.number().optional().describe("[workflow] Delay before firing `trigger`, to let listeners register (default 150)."),
      targetUser:    z.string().optional().describe("Foundry user to route to. Omit for GM (default)."),
    },
    async (args) => {
      const { action, targetUser } = args;
      try {
        if (action === "hooks") {
          const { hooks, count, timeoutMs, until } = args;
          return callFoundry("trace_hooks",
            { hooks, count, timeoutMs, until }, targetUser,
            Math.max(15_000, (timeoutMs ?? 5_000) + 5_000));
        }
        if (action === "socket") {
          const { filter, count, timeoutMs } = args;
          return callFoundry("trace_socket",
            { filter, count, timeoutMs }, targetUser,
            Math.max(15_000, (timeoutMs ?? 5_000) + 5_000));
        }
        if (action !== "workflow") {
          return { content: [{ type: "text", text:
            `Error: unknown action "${action}" for trace. Valid: hooks, socket, workflow.` }] };
        }

        // ---- workflow (trace_workflow behaviour, unchanged server-side orchestration) ----
        const { preset, watch, select, extraHooks, trigger,
                triggerDelayMs, count, timeoutMs, until } = args;

        const def = WORKFLOW_PRESETS[preset];
        if (!def) {
          return { content: [{ type: "text", text:
            `Error: unknown preset "${preset}". Known: ${PRESET_KEYS.join(", ")}.` }] };
        }

        const hooks = [...new Set([...def.hooks, ...(extraHooks || [])])];
        const watchRefs = watch == null ? [] : (Array.isArray(watch) ? watch : [watch]);
        const effSelect = select ?? def.select ?? undefined;
        const traceParams = {
          hooks,
          count:     count ?? 200,
          timeoutMs: timeoutMs ?? 8000,
          until:     until ?? def.until ?? undefined,
        };
        // The server→Foundry RPC default timeout (15s) must outlast the trace window.
        const rpcTimeout = traceParams.timeoutMs + 5000;

        let before = null;
        if (watchRefs.length) {
          const snap = await requestFoundry(
            "snapshot_actors", { actors: watchRefs, select: effSelect }, targetUser);
          if (snap?.error) {
            return { content: [{ type: "text", text: `Error (snapshot before): ${snap.error}` }] };
          }
          before = snap.actors || {};
        }

        const tracePromise = requestFoundry("trace_hooks", traceParams, targetUser, rpcTimeout);

        let triggerError = null;
        if (trigger?.tool) {
          await sleep(Math.max(0, triggerDelayMs ?? 150));
          try {
            const tRes = await requestFoundry(trigger.tool, trigger.params || {}, targetUser, rpcTimeout);
            if (tRes?.error) triggerError = tRes.error;
          } catch (err) {
            triggerError = err.message;
          }
        }

        const traceResult = await tracePromise;
        if (traceResult?.error) {
          return { content: [{ type: "text", text: `Error (trace): ${traceResult.error}` }] };
        }

        let diff = null, summary = null;
        if (watchRefs.length) {
          const snap2 = await requestFoundry(
            "snapshot_actors", { actors: watchRefs, select: effSelect }, targetUser);
          if (snap2?.error) {
            return { content: [{ type: "text", text: `Error (snapshot after): ${snap2.error}` }] };
          }
          const after = snap2.actors || {};
          const changes = [];
          for (const id of new Set([...Object.keys(before), ...Object.keys(after)])) {
            if (!after[id])  { changes.push({ actorId: id, op: "actorMissing" }); continue; }
            if (!before[id]) { changes.push({ actorId: id, op: "actorAdded"   }); continue; }
            changes.push(...diffProjections(before[id], after[id], id));
          }
          summary = {};
          for (const c of changes) summary[c.op] = (summary[c.op] || 0) + 1;
          diff = changes;
        }

        return { content: [{ type: "text", text: JSON.stringify({
          preset,
          hooks,
          reason:   traceResult.reason,
          timeline: traceResult.timeline,
          ...(diff    ? { diff, summary } : {}),
          ...(triggerError ? { triggerError } : {}),
        }, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    });
}