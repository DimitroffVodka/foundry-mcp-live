/**
 * Server `instructions` — returned in the MCP `initialize` handshake and
 * injected by clients into the model's context, like a per-server system
 * prompt (MCP spec: "MAY be added to the system prompt").
 *
 * This is the ONLY guidance channel that reaches a pure MCP client. Such a
 * client never sees AGENTS.md or TOOLS.md — only `tools/list` plus these
 * instructions. So the "prefer dedicated tools over evaluate" steering lives
 * HERE, where every connected agent actually reads it at connect time.
 *
 * Without it, a fresh model sees one generically-powerful tool (`evaluate`,
 * "run any JavaScript") next to ~30 specific ones and defaults to the hammer
 * it understands — which is the exact failure this orientation prevents.
 *
 * Keep it tight: it costs context on every session. Orientation + the
 * tool-selection policy + routing/gates, nothing more. The matching test in
 * test/server-instructions.test.js bounds the length and asserts the policy
 * stays in.
 */
export const SERVER_INSTRUCTIONS = `This MCP server controls a LIVE Foundry VTT tabletop game. Tool calls act on the real, running world that GMs and players are looking at — reads are safe, writes are visible to everyone immediately.

ORIENT FIRST
- Call \`get_debug_snapshot\` for one-shot situational awareness (world, system, active scene, selected token, targets, combat, recent errors, modules), or \`list_connected_bridges\` to see which Foundry users are connected.
- Everything is exposed as TOOLS — there are no MCP resources or prompts, so don't look for them. \`tools/list\` is authoritative.

CHOOSING A TOOL — prefer dedicated tools, NOT \`evaluate\`
- ~30 dedicated tools cover actors, tokens, scenes, combat, items, dice rolls, journals, compendiums, chat, and debugging. Use them.
- \`evaluate\` runs arbitrary JavaScript and is a LAST RESORT — only when no dedicated tool fits. The dedicated tools encode system correctness that hand-written JS gets subtly wrong: \`apply_damage\` clamps HP, \`token\` move routes around walls, \`use_item\` runs the system's attack/crit logic — and the write tools carry audit/undo. Defaulting to \`evaluate\` produces wrong state (negative HP, tokens teleporting through walls) and skips the audit log.
- Related operations are merged behind one tool with an \`action\` (or \`phase\`) parameter — e.g. \`actor_write\`, \`token\`, \`request\`, \`combat\`, \`scene\`. Read the tool's schema; its \`action\` enum lists the valid modes.

ROUTING & GATES
- If more than one bridge is connected, pass the \`targetUser\` value from \`list_connected_bridges\` on every call — don't trust the default GM route.
- Writes can be gated (a read-only world toggle, or the server's write env). If a write tool is missing or refuses, tell the user — do NOT fall back to \`evaluate\` to force it.`;
