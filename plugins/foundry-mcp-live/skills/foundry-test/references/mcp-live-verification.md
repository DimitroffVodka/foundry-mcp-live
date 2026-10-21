# Foundry MCP Live Verification — Reference

Use the MCP bridge to drive the *currently running* world from outside the client: verify a fix,
inspect real state, reproduce a one-off. It proves what happened **now**; it is not a reusable suite.
Once a live check confirms behavior, capture the durable version as a Quench or `node:test`.

## Preflight (do this before trusting any live tool)

- `bridge_status` — is Foundry up, and is a bridge connected?
- `list_connected_bridges` — connected users/clients and routable `targetUser` names.
- `list` type `module` — confirm the bridge module *and* the module under test are active.
- `get_game_info` / `get_debug_snapshot` — Foundry/system/world/user context.

If nothing is connected: start the world, enable the bridge module in Manage Modules, reload the
browser client, then retry. Skipping preflight turns every later call into a confusing failure.

## Surviving a client crash (unattended / away-from-desk)

The bridge routes every call through a **logged-in, foreground browser tab**. Two consequences:

- **`reload_foundry` cannot rescue a *crashed* tab** — it needs a live tab to send the reload to. If
  Foundry crashes the browser (common with heavy WebGL scenes), the bridge is down until a human
  reopens the tab. There is no in-MCP way out of this circular dependency.
- **For unattended resilience, run a *dedicated* supervised client**, separate from the human's
  browser: a headless Chromium logged in as its **own** GM user (avoids Foundry's one-connection-per-
  user contention), under a process supervisor (e.g. `systemd --user`, `Restart=always`) that respawns
  it on crash and re-joins via `POST /join` (form-encoded `action=join&userid=&password=` →
  `{status:"success",redirect:"/game"}`). A browser crash then no longer stops the work.

**Headless software-WebGL CPU trap.** A headless client has no GPU, so Chromium falls back to
SwiftShader and rasterizes the Foundry **canvas on the CPU** — easily 10+ cores on a live scene, plus
~2 cores compositing Foundry's paused-pulse / module CSS animations. A bridge client rarely needs the
canvas, so neutralize both: set client-scoped **`core.noCanvas=true`** (kills the PIXI render loop) and
inject **`*{animation:none;transition:none}`** (kills animation compositing) → ~0% idle CPU. Two
caveats: a canvas-less client can't serve canvas ops (`screenshot`, `scene_read` placeables
coordinates) — route those to a canvas-enabled client; and you cannot fully `--disable-gpu`, or
Foundry never reaches `game.ready` (it needs a WebGL context even in noCanvas mode).

## Tool naming across clients

Use **bare logical names** in notes and recipes: `get_game_info`, `reload_foundry`, `evaluate`,
`scene_read`, `get_console_errors`. The host wraps them differently:

- Claude-style surface: `mcp__foundry-vtt__get_game_info`
- Some other hosts: `mcp_foundry-vtt_get_game_info`

Select the tool that's actually present by name/description. Never hand-type a third, invented
spelling.

## Common reads

- `get_debug_snapshot` — one-call situational awareness.
- `get_game_info` — Foundry version, system, world, connected users.
- `scene_read` — active scene, grid, token overview; action `placeables` for walls, doors, templates,
  regions, drawings, notes, lights, tiles.
- Scene Levels (v14) have no dedicated read: project `game.scenes.get(id).levels` via `evaluate`.
- `get_settings` — registered settings and values.
- `get_console_errors` — recent warnings/errors.
- `screenshot` — canvas / DOM / coordinate-grid capture when visual evidence helps.

## Common actions (mutations — clean up after)

- `reload_foundry` — reload the client and wait for bridge/game ready.
- `evaluate` — bounded JS in the client; return plain JSON.
- `job_result` — read results from a backgrounded `evaluate`.
- `scene`, `token`, `actor_write`, `combat` — persistent world
  mutations; use only when the check requires them and plan the cleanup up front.

## Live debugging tools (beyond reads)

`get_*` tools show **state**; this family shows **behavior** — what fired, what synced, what an action
actually did. Reach for them when a live bug is "the thing isn't happening" and the end-state read
tells you nothing about *why*. **Bridge-specific:** confirm via your tool list / preflight that your
bridge exposes them — not every MCP bridge does. Still a probe, not a suite: once a trace pins the
cause, capture the regression as Quench or `node:test`.

- **`trace` action `hooks`** — record which hooks fire (order + args) over a window. This is the live
  counterpart to the v14 gotcha that `Object.keys(Hooks.events)` is empty: you can't enumerate hooks
  statically, so trace what *actually* fires. First reach when a hook "isn't firing" or fires out of
  order.
- **`trace` action `socket`** — GM↔player socket messages. For multiplayer **desync** bugs where one client's
  state diverges from another's.
- **`trace` action `workflow`** — follow an action / roll / item-use across the hook chain end-to-end, instead
  of guessing the path from source.
- **`snapshot` actions `take` + `diff`** — capture actor state before an action and diff after. Turns
  "did that change anything?" into a concrete delta you can assert on, not two reads eyeballed.
- **`interact` action `dialog`** — answer a module dialog programmatically so an interactive flow runs
  unattended (pairs with the dedicated supervised client for away-from-desk runs).

**Discipline:** traces are verbose. Scope the window tightly — start the trace, trigger the **one**
action, stop and read — and project the result to plain JSON like any other `evaluate` payload.

## Verification loop

1. Capture baseline (`get_debug_snapshot`, `scene_read`, relevant placeables/settings).
2. Trigger the module action.
3. Read **structured** state back — not just a screenshot.
4. Read recent console errors/warnings.
5. Delete what you created, by exact id.
6. Report exactly what you observed.

> For a module that claims to build *playable* maps, an image-only scene is not proof. Verify walls,
> doors, and regions (`scene_read` placeables, Levels via `evaluate`) — the geometry, not just existence.

## Running Quench through MCP

```js
await game.settings.set("quench", "autoShowQuenchWindow", true);
const r = await quench.runBatches(["my-module.feature"], { json: true });
return {
  stats: r.stats,
  failures: r.failures?.map(f => ({ title: f.title, error: String(f.err || f) })),
};
```

If it wedges, `reload_foundry` before another attempt.

## `evaluate` payload discipline

- Return plain objects/arrays/scalars — not raw Foundry documents (they serialize poorly).
- Project the fields you need: `game.scenes.map(s => ({ id: s.id, name: s.name }))`.
- Use `.toObject()` only when you truly need the whole source document.
- Large results may be truncated or handed back via a job handle — select narrowly.

## `evaluate` introspection gotchas (v14)

- **`Object.keys(Hooks.events)` returns `[]`** in FVTT 14.x — the keys are non-enumerable. To confirm a
  hook is registered, access it directly: `Hooks.events.renderChatMessageHTML?.length`. An empty
  `Object.keys` is a false negative, not "no hooks registered".
- **Hand-rolled UI may be plain DOM, not ApplicationV2.** A module that injects a `<div>` into the
  interface won't appear in `foundry.applications.instances`; verify it with a DOM query
  (`document.getElementById(...)`), not the app registry.
- Prefer the v14 hook **`renderChatMessageHTML`** over legacy `renderChatMessage`; grep the source to
  confirm no legacy hook remains, and count live callbacks via `Hooks.events.renderChatMessageHTML`.

## Testing v14 token movement (path segmentation)

Foundry v14 decomposes a token move into **path segments** and fires `preUpdateToken` once per segment.
A single large programmatic `tokenDoc.update({x})` spanning several cells is therefore *not* one atomic
move — a per-segment budget/collision veto blocks only the over-budget segment, leaving the token
**partially moved**. That looks like a module bug when it's really the segmentation. To test movement
enforcement deterministically, drive **one cell at a time** with
`update({x: x + scene.grid.size}, {teleport:true, animate:false})` (move by `scene.grid.size` so one
update is one segment, sidestepping any px-per-cell ambiguity).

## Hidden-tab / render-loop gotcha

A hidden or backgrounded Foundry page can pause `requestAnimationFrame`, so Pixi/WebGL/OpenFL
canvases and animations may not repaint. If you're verifying anything render-driven, either run with
the window visible, force a synchronous paint if the engine allows, or move the check to headed
Playwright (see `playwright-foundry-e2e.md`). This is the most common reason a "live verification"
silently sees a stale frame.

## Main-thread-blocking gotcha

Heavy synchronous work blocks the browser event loop, so a poll loop *inside one* `evaluate` never
ticks. Instead:

1. Start the work fire-and-forget.
2. Store progress/result on a namespaced global, e.g. `window.__myModuleTest`.
3. Poll with separate, immediate `evaluate` calls.

## Cleanup

Track created ids and delete by exact id. If you use name prefixes for test docs, make them unique
and module-scoped (`Test my-module import <timestamp>`). Never broad-delete every doc whose name
starts with `Test` against a shared world — only against a world dedicated to the suite.
