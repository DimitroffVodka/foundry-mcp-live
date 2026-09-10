/**
 * Shared helpers used across the tools/ modules.
 *
 *   - `TARGET_USER_DESC` — single source of truth for the targetUser
 *     describer string. Used by both `registerRoutedTool` (which auto-
 *     injects targetUser into schemas) and any Type-B tool that builds
 *     its schema manually.
 *
 *   - `registerRoutedTool(mcp, name, desc, schema, bridgeTool?)` — the
 *     standard registration helper for tools that proxy directly to the
 *     Foundry bridge. Auto-injects targetUser into the schema and
 *     forwards via `callFoundry`. Hot-reload-aware: re-calling with the
 *     same name updates the existing tool (description, schema, handler)
 *     in place rather than throwing.
 *
 *   - `registerRawTool(mcp, name, desc, schema, callback)` — for Type-B
 *     tools that build their own schema (image returns, server-local
 *     orchestration). Same upsert semantics. Pass the schema with
 *     `targetUser` already on it if the tool needs routing.
 */
import { z }                                from "zod";
import { callFoundry }                      from "../lib/foundry-rpc.js";
import { upsertTool, noteTrackedTool }      from "../lib/hot-reload.js";

export const TARGET_USER_DESC =
  'Foundry user to route to. Omit for the GM (default); use '
  + 'list_connected_bridges for valid names.';

export const AUDIT_DESC =
  'Return an audit block with before/after diffs and undo instructions.';

/**
 * Register a tool that proxies to the Foundry-side bridge handler with
 * automatic `targetUser` routing. Adds `targetUser?: string` to the
 * tool's schema so the MCP client can target a specific user; the
 * default route is the GM.
 *
 * @param {McpServer} mcp        per-session MCP server instance
 * @param {string}    name       MCP tool name (and bridge-side handler name)
 * @param {string}    desc       tool description shown to the LLM
 * @param {object}    schema     zod schema map for the tool's params
 *                               (without targetUser — added automatically)
 * @param {string}    [bridgeTool=name]  bridge-side tool name to proxy to
 */
export function registerRoutedTool(mcp, name, desc, schema, bridgeTool = name) {
  const augmentedSchema = {
    ...schema,
    targetUser: z.string().optional().describe(TARGET_USER_DESC),
  };
  noteTrackedTool(mcp, name);
  return upsertTool(mcp, name, desc, augmentedSchema, async (params) => {
    const { targetUser, ...toolParams } = params;
    return callFoundry(bridgeTool, toolParams, targetUser);
  });
}

/**
 * Register a Type-B tool — builds its own schema (and may inject
 * targetUser via TARGET_USER_DESC manually) and provides its own
 * callback. Used for image-returning tools and server-local tools.
 */
export function registerRawTool(mcp, name, desc, schema, callback) {
  noteTrackedTool(mcp, name);
  return upsertTool(mcp, name, desc, schema, callback);
}

/**
 * Register a tool that merges several same-domain bridge handlers behind one
 * discriminator enum. Dispatches to the existing bridge handler named in
 * actionMap. Server-side only — the bridge handlers are unchanged.
 *
 * @param {string} [key="action"]  the param used as the discriminator. The
 *   forwarded `rest` strips this key plus `targetUser`. Defaults to "action"
 *   so existing callers that omit it are unaffected.
 * @param {Object<string,string[]>} [requiredByAction={}]  per-discriminator
 *   list of param names that are required for that mode. A flat merged schema
 *   can't mark a param required for only some actions, so those params are
 *   `.optional()` at the schema level; this restores strict validation by
 *   rejecting an action that's missing its required params with a clear
 *   tool-level error (instead of a murkier bridge-layer error later).
 */
export function registerMergedTool(mcp, name, desc, schema, actionMap, key = "action", requiredByAction = {}) {
  const augmented = { ...schema, targetUser: z.string().optional().describe(TARGET_USER_DESC) };
  noteTrackedTool(mcp, name);
  return upsertTool(mcp, name, desc, augmented, async (params) => {
    const { [key]: discriminator, targetUser, ...rest } = params;
    const bridgeTool = actionMap[discriminator];
    if (!bridgeTool) {
      return { content: [{ type: "text", text:
        `Error: unknown ${key} "${discriminator}" for ${name}. Valid: ${Object.keys(actionMap).join(", ")}.` }] };
    }
    const missing = (requiredByAction[discriminator] || []).filter(p => rest[p] === undefined || rest[p] === null);
    if (missing.length) {
      return { content: [{ type: "text", text:
        `Error: ${name} ${key}="${discriminator}" requires: ${missing.join(", ")}.` }] };
    }
    return callFoundry(bridgeTool, rest, targetUser);
  });
}
