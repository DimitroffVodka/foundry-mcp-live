# Foundry MCP Tools — Detailed Reference

All tools route: MCP client → `server.js` (HTTP) → WebSocket → `bridge.js` (inside Foundry). Each connected Foundry tab registers its user identity with the server; tool calls route to the GM by default and can be targeted at any connected user via `targetUser`.

Token references (the `tokenName` param on `token` actions details/move/update/toggleCondition) accept the **document id**, the **token name**, or the **linked actor name** — `_findToken(scene, ref)` resolves in that order.

Actor/item lookups by name require an **exact match** unless noted.

Most tools are **merged**: one tool with an `action` (or `type`) discriminator selects the operation. Read the action enum in the tool's own schema — the modes listed there are the live truth.

---

## Universal parameters

### `targetUser` (optional, every routed tool)

Every tool that proxies to the Foundry bridge accepts an optional `targetUser` parameter to route the call to a specific Foundry user. The bridge runs in that user's browser context, so the call sees what *they* see and runs with *their* permissions.

- **Omitted** / `"GM"` / `"self"` → routes to the GM (default).
- **A user name string** (e.g. `"Sassafrass"`, or the GM's actual user name like `"Gamemaster"`) → routes to that user's bridge.

If the named user isn't connected, the tool errors with `"No bridge connected for user 'X'. Connected: ..."` (the connected list helps you self-correct). Use `list_connected_bridges` to discover available targets.

**Why it matters:** testing module behavior from a player's perspective without losing the GM session. A GM-side `evaluate` won't surface permission-gated bugs the way a player-side one will.

### `audit` (optional, mutating tools only)

Every tool that modifies the Foundry world (creates, updates, or deletes documents) accepts an optional `audit: true` parameter. When set, the tool returns an `audit` block containing a flight recorder of the mutation.

- **`audit.before`** — snapshot of the affected document(s) *before* the change.
- **`audit.after`** — snapshot *after* the change.
- **`audit.diff`** — structured delta of what actually changed. Noisy metadata (timestamps, stats, IDs) is automatically filtered.
- **`audit.undo`** — dry instructions for how to revert the change (e.g. rollback data or a delete command).

**Efficiency Note:** Full snapshots are limited to 10 documents per call to keep context window usage low. If more are affected, the audit will note the truncation. Use this to self-verify your work in an **Act -> Validate** loop.

The server-local tools are `list_connected_bridges`, `bridge_status`,
`reload_foundry`, and the opt-in `relaunch_client`. They inspect or
orchestrate the bridge process directly instead of proxying a normal tool
call through Foundry.

## Write compatibility audit

The released module manifest currently requires Foundry v14. The v13 column
documents retained compatibility paths in the bridge; it is static-only and
is not a promise of full v13 module support.

| Write surface | Foundry v13 | Foundry v14 |
|---|---|---|
| Actors, embedded Items, folders, journals/pages, tokens, combat, chat, templates | Native document create/update/delete APIs | Same APIs; no schema translation required |
| Actor ownership | Friendly level names are resolved to numeric ownership levels before update | Same; avoids writing role names or raw user-facing labels into the document |
| Scene background/foreground/fog | Legacy Scene fields (`background`, `backgroundColor`, `foreground`, `fogExploration`) | `background`/`foreground`/level fog map to the default embedded Level; exploration maps to `Scene.fog.mode` |
| Scene Levels | Not available; level-only inputs error clearly | Native embedded `Level` CRUD |
| Regions | Passed through to the core Region schema | Passed through to the core Region schema, including level membership |
| RollTable results | No dedicated authoring tool; legacy `.text` is not written | `self_test` validates `TableResult.description` |
| Compendium configuration | No write tool calls `pack.configure`; label/ownership schema drift is therefore not exposed | Same |
| Snapshots/diffs | Read-only | Read-only |

The guarded `self_test` provides the runtime check for representative Actor,
JournalEntry/Page, RollTable/TableResult, and Scene/Level writes after a
Foundry core update.

Note: several former dedicated write tools (folders, journals, regions, scene
levels, actor items/ownership, measured templates) were removed in the
2026-08 reduction; those operations are now done via `evaluate` against the
same document APIs this table describes.

---

## Game info

### `get_game_info`
Liveness check + environment snapshot. Use this first to confirm the bridge is responsive and to learn what system you're in.

- **Params**: none
- **Returns**:
  - `system` — `{ id, title, version }` of the game system module. Determines what fields exist on actors/items elsewhere.
  - `world` — `{ id, title }` of the loaded world.
  - `foundryVersion` — use this to branch logic that differs across Foundry major versions.
  - `users` — `[{ name, role, active }]`. `role` is an integer: 0=None, 1=Player, 2=Trusted, 3=Assistant, 4=Gamemaster. `active: true` means connected right now.

  Note: `users` lists everyone logged in to Foundry, whether or not they have the `foundry-mcp-live` module connected. For the list of users actually reachable as a `targetUser`, use `list_connected_bridges`.

---

## Bridge discovery

### `list_connected_bridges`
List all Foundry users currently connected via the bridge module. Use the `targetUser` field directly as the `targetUser` parameter on other tools — it already handles host disambiguation when the same user name is connected from multiple worlds. The GM is the default target and need not be specified.

This is a **server-local** tool — it doesn't proxy through any bridge — so it works even when no bridges are connected (returns empty list).

- **Params**: none
- **Returns**:
  - `bridges` — array of `{ userId, userName, host, isGM, connectedAt, targetUser }`, sorted GM-first then alphabetical by `userName`.
    - `userName` — Foundry user name (e.g. `"Gamemaster"`).
    - `host` — the Foundry server this bridge came from (e.g. `"localhost:30000"`).
    - `targetUser` — the canonical routing value to pass to other tools. Equal to `userName` when unambiguous, or `userName@host` when the same name is connected from multiple worlds. `userId` is also accepted as an unambiguous escape hatch.
  - `legacyBridgeConnected` — `true` if a pre-multi-user bridge is also attached (only present when applicable).
  - `note` — when `legacyBridgeConnected` is set, a human-readable explanation.

### `bridge_status`
Diagnose the full connection chain even when no Foundry bridge is currently
connected. Combines current and last-seen bridge metadata with REST probes of
known Foundry `/api/status` endpoints.

- **Params**: none.
- **Returns**:
  - `classification` — one of `bridge-connected`,
    `foundry-up-no-bridge`, `foundry-up-no-users`, `foundry-down`, or
    `unknown`.
  - `bridges` — currently connected identified bridges.
  - `lastSeenBridges` — retained metadata from bridges seen since server start.
  - `probes` — REST status or error details for each known Foundry origin.
- **Restart-safe targets**: set `FOUNDRY_URLS` to a comma-separated list such
  as `http://localhost:30000,https://foundry.example.com`. This lets the server
  diagnose Foundry before any bridge has connected after a server restart.

### `reload_foundry`
Reload a targeted Foundry browser tab, wait for the same user bridge to
reconnect, then poll until `game.ready === true`.

Two reload modes:
- **Soft** (default, `hardReload: false`): cache-busting `location.replace()`
  with a query param — busts the HTML cache but **not** the service-worker or
  Cache API caches. Fast (~5-10s). Use for scene/actor changes.
- **Hard** (`hardReload: true`): clears all Cache API caches, unregisters
  service workers for the origin, then does `window.location.reload()`.
  Slower (20-40s, service worker re-registration) but guarantees Foundry
  loads fresh JS/CSS. **Use this after editing bridge.js or module code.**

- **Params**: `targetUser?`, `hardReload?` (default false), `timeoutMs?` (default 30000, bump to 60000 for hard reloads).
- **Failure behavior**: routing and reconnect failures return the same
  structured diagnosis as `bridge_status`, alongside the reload error.

### `relaunch_client` (opt-in)
Recover from a discarded or closed GM browser tab by launching the explicitly
configured Chrome executable, opening `/join`, selecting the configured GM,
submitting the environment-only password, and waiting for the bridge.

- **Gate**: absent unless `FOUNDRY_RELAUNCH_ENABLED=1`.
- **Required config**: `FOUNDRY_RELAUNCH_URL`,
  `FOUNDRY_RELAUNCH_GM_USER`, and `FOUNDRY_CHROME_PATH`.
- **Optional config**: `FOUNDRY_RELAUNCH_GM_PASSWORD`,
  `FOUNDRY_CHROME_USER_DATA_DIR`, `FOUNDRY_RELAUNCH_ALLOW_REMOTE=1`, and
  `FOUNDRY_RELAUNCH_HEADLESS=1` — run the recovery client headless. A headless
  client has no GPU, so it also disables the Foundry canvas (`core.noCanvas`,
  pre-seeded before `/game` loads) and strips CSS animations, otherwise software
  WebGL (SwiftShader) pegs the CPU. Trade-off: a headless client can't serve
  canvas ops (`screenshot`, scene placeable coordinates) — route those to a
  canvas-enabled client.
- **Network policy**: the Foundry URL must use localhost, `127.0.0.1`, or
  `[::1]` unless remote relaunch is explicitly enabled.
- **Credential policy**: passwords are never accepted as tool parameters and
  are redacted from errors.
- **Params**: `timeoutMs?` (5000-120000, default 30000).
- **Already connected**: returns immediately without launching Chrome when
  the configured GM bridge is already present.

### Autonomous relaunch supervision (opt-in)
With `FOUNDRY_RELAUNCH_AUTO=1` the server watches for the configured GM bridge
dropping and invokes the same relaunch handler automatically — so a crashed or
closed tab recovers with no operator action (the "away from desk" case). It
shares the single relaunch handler with `relaunch_client`, so the supervisor and
the tool can never double-launch a browser.

- **Gate**: `FOUNDRY_RELAUNCH_AUTO=1`, plus a valid relaunch config
  (`FOUNDRY_RELAUNCH_ENABLED=1` + URL/GM/Chrome). If the config is invalid it
  logs why and stays idle.
- **Tuning**: `FOUNDRY_RELAUNCH_AUTO_INTERVAL_MS` (poll interval, default 15000)
  and `FOUNDRY_RELAUNCH_AUTO_MAX_BACKOFF_MS` (default 300000). A failed relaunch
  backs off exponentially up to the cap so a down Foundry can't trigger a
  Chrome-launch storm; backoff resets the moment the GM reconnects.

---

## World reads

### `list`
List world collections. The `type` discriminator picks the collection.

- **Discriminator**: `type` — `"actor"`, `"scene"`, `"module"`, `"rollTable"`, or `"compendium"` (required).
- **Params**:
  - `filter?` **[actor]** — actor subtype (e.g. `"character"`, `"npc"`). **[compendium]** — document type (e.g. `"Actor"`, `"Item"`).
  - `folder?` **[actor]** — filter by sidebar folder name (exact match).
  - `activeOnly?` **[module]** — default `true`; `false` includes inactive modules.
- **Returns**:
  - `actor`: `[{ id, name, type, folder, img }]`
  - `scene`: `[{ id, name, active, folder }]`
  - `module`: `[{ id, title, version, active }]`
  - `rollTable`: `[{ id, name, formula, results }]` (`results` is the entry count; there's no table-rolling tool — use `evaluate` with `game.tables.get(id).draw()`.)
  - `compendium`: `[{ id, label, type, system, count }]` — `id` is the collection path (e.g. `"vagabond.monsters"`); use it as `pack` in `search_compendium` / `document`.

### `document`
Read one document. The `action` discriminator picks the kind.

- **Discriminator**: `action` — `"actor"`, `"item"`, `"compendium"`, or `"actorItems"`.
- **Params**:
  - `id?` / `name?` **[actor/item]** — one of them (exact name match).
  - `pack` **[compendium, required]**, `id?` / `name?` **[compendium]** — fetch one entry from a pack.
  - `actorId` **[actorItems, required]** — actor id or exact name; `filter?` — item type (e.g. `"weapon"`).
- **Returns**:
  - `actor` — full `actor.toObject()`: `_id, name, type, img, system, items, effects, prototypeToken, folder, sort, ownership, flags`. **Heavy.**
  - `item` — `item.toObject()`.
  - `compendium` — full `toObject()` of the entry (or `{ error: "Document not found in <pack>" }`).
  - `actorItems` — `[{ id, name, type, img, system }]` — much smaller than a full actor read.

### `search_compendium`
Name-substring search within one pack. Loads the index on demand.

- **Params**:
  - `pack` (required) — the pack id from `list {type:"compendium"}`.
  - `query?` — case-insensitive substring match against entry names. Omit to return all.
  - `full?` — if true **and result count ≤ 20**, returns full documents instead of index entries.
- **Returns**: without `full`: `[{ _id, name, type, img }]` capped at 50. With `full`: `[{ full document toObject() }]`.

### `get_data_model`
System-defined schema for a document type. Use this to know what `system.*` fields are valid before you try `token` update or `actor_write` create / writing code via `evaluate`.

- **Params**: `type?` (`"Actor"` or `"Item"`, default `"Actor"`), `subtype?` (e.g. `"character"`, `"monster"`).
- **Returns**: the system template object, or `{ _sampleFrom: name, system: {...} }` if no template is registered.

### `get_settings`
Read Foundry settings in three modes.

- **Params**: `moduleId?`, `key?`.
- **Modes**:
  - no args → catalog of every registered `(namespace, key)` pair, without values.
  - `moduleId` only → all settings for that namespace, with current values.
  - `moduleId` + `key` → just that one setting's value.

### `get_debug_snapshot`
One-call situational awareness aggregator: game/world/system info, active scene, selected token, current targets, combat state, recent console errors, recent chat, and the active module list. The default "what's going on?" tool — replaces 8+ individual reads with a single round trip.

- **Params**: none.

### `call_module_api`
Call a function exposed on `game.modules.get(moduleId).api` — an allowlist-style, safer alternative to `evaluate`: only functions a module deliberately puts on its `.api` surface are reachable. Lets agents drive third-party integrations (shadowdark-extras dungeon generation, mythic-gme-tools, etc.) without opening the arbitrary-code surface of `evaluate`.

- **Params**: `moduleId` (required), `fn?` (function name; **omit to discover** the available list), `args?` (positional, default `[]`).
- **Returns**: the JSON-serialised result (or the function list when `fn` is omitted).

---

## Scene

### `scene_read`
Read the active scene. The `action` discriminator picks the depth.

- **Discriminator**: `action?` — `"summary"` (default) or `"placeables"`.
- **Params**:
  - `sceneId?` — target scene. Default: active scene.
  - `type?` **[placeables]** — one of `Token`, `MeasuredTemplate`, `Region`, `Wall`, `AmbientLight`, `AmbientSound`, `Drawing`, `Note`, `Tile` (default `Token`).
  - `select?` **[placeables]** — array of dotted field paths to keep (e.g. `['_id','name','behaviors.type']`); drastically cuts payload size.
- **`action: "summary"`** — your go-to "what's happening right now" call. Returns:
  - `id, name` — scene identity.
  - `dimensions: { width, height }` — total scene size in pixels.
  - `grid: { size, type }` — pixels per grid square; `0` gridless, `1` square, `2–5` hex.
  - `fog: { mode, exploration }` — `mode` `0`/`1`/`2`; `exploration` true when fog exploration is active.
  - `tokens: [{ id, name, actorId, x, y, elevation, hidden, inExplored }]` — every token on the scene; `(x,y)` is top-left in pixels (÷ `grid.size` for grid coords); `inExplored` is true when the token's center is in explored fog territory (always `true` when fog exploration is off).
- **`action: "placeables"`** — the embedded collections `summary` doesn't return. Returns `[document.toObject()]` or the projected subset. On Foundry v14+, `MeasuredTemplate` items come back in the legacy template shape (`t`/`x`/`y`/`distance`/…) but are stored as Region documents under the hood (v14 merged MeasuredTemplate into Region).

### `query_grid`
Query spatial grid state as structured data — the video-game approach to map awareness. Returns per-cell booleans for explored (fog), visible (current line-of-sight), and occupied (token present). Cheaper and more deterministic than screenshots for spatial reasoning.

- **Params** (one of):
  - `cells?` — array of `{gx, gy}` grid coords to query individually.
  - `region?` — `{minGX, minGY, maxGX, maxGY}` bounding box (inclusive). Max 2500 cells.
- **Returns**:
  - `sceneId, gridSize, fogExploration, cellCount`
  - `cells: [{ gx, gy, x, y, explored, visible, occupied, occupiedBy? }]` — `x,y` are pixel centers. `explored` is fog exploration state (always `true` when fog is off). `visible` is current line-of-sight (always `true` for GMs). `occupied` is `true` when a token's center lies in this cell; `occupiedBy` identifies that token.
- **Usage pattern**: `query_grid` with a `region` around a token → find `explored: false` cells → `token {action:"move", onlyUnexplored:true}` to move there.

---

## Tokens

### `token`
All token operations on the active scene. The `action` discriminator selects the operation.

- **Discriminator**: `action` — `details`, `move`, `create`, `update`, `delete`, `toggleCondition`, `target`, or `setLevel`.
- **`action: "details"`** — the most information-dense token query. `tokenName` (required). Returns geometry/state (`x, y, width, height` in grid units, `rotation`, `elevation`, `hidden`, `disposition`, `lockRotation`, `sort`, `img`), `sight` (vision range/angle/mode/tint), `light` (bright/dim radii, animation, darkness range, shader knobs), plus the linked **`actor`** snapshot (full `system` block, `statuses` array, `effects` list).
- **`action: "move"`** — `tokenName`, `x`, `y` (required). `pathed: false` (default) = straight teleport (no wall check; `animate: false` for instant placement). `pathed: true` = **smart move**: A* against scene walls (`pathCost` returned), only the final hop animates, `canOpenDoors: true` opens doors en route (returns `doorsOpened`), `elevation`/`rotation` apply to the final waypoint. `onlyUnexplored: true` rejects fog-explored destinations. A* node cap 2500 — very long paths may fail, retry with a shorter hop.
- **`action: "create"`** — `actorId` (required); `x/y` pixels OR `gridX/gridY` cells (cells win); `hidden`, `name`, `rotation`, `sceneId` optional. Inherits the actor's prototype token (image, scale, vision, disposition).
- **`action: "update"`** — `tokenName`, `updates` (required object). Whitelisted keys only: `x, y, width, height, rotation, hidden, disposition, name, elevation, lockRotation, sort, alpha, tint`. Anything else is silently dropped — `sight`/`light`/vision sub-objects need `evaluate`.
- **`action: "delete"`** — `tokens` array (ids/names/actor names). Permanent; Foundry has no undo. Returns `{ deleted, missing }`.
- **`action: "toggleCondition"`** — `tokenName`, `condition` (required); `active?` forces on/off, omit to toggle. Uses v13+ `Actor.toggleStatusEffect`; valid ids are system-defined (`CONFIG.statusEffects` — inspect via `evaluate`).
- **`action: "target"`** — `tokens` array; `[]` clears. Equivalent to hovering tokens and pressing T. **Call before attacking** so the system computes hits against real defenses. Returns `{ targeted: [{id, name, actor, hp}], missing, total }`.
- **`action: "setLevel"`** — `levelId` OR `elevation` selects the viewed floor of a multi-level scene (v14); `sceneId?` optional. Affects anything reading `canvas.level` (level-aware visibility, wall-height, the shadowdark-extras dungeon painter).
- All mutating actions accept `audit`.

---

## Combat

### `get_combat`
Read-only view of the active combat encounter. Returns `{ active: false }` when no combat is running.

- **Params**: none.
- **Returns** (when active): `id, round, turn, started, sceneId`, `currentCombatant`, and `combatants` — initiative-sorted `{ id, name, tokenId, actorId, initiative, hp, defeated, hidden }`.

### `combat` (write — opt-in)
Control the combat tracker. Merges the old `start_combat` / `advance_combat` / `end_combat` tools.

- **Discriminator**: `action` — `"start"`, `"advance"`, or `"end"`.
- **Params**: `tokenIds?` **[start]** (combatants to add), `rollInitiative?` **[start]** (`true`/`"all"` = everyone, `"npc"` = NPCs only), `direction?` **[advance]** (`"next"` default / `"previous"`), `audit?`.
- **`start`** — creates an encounter on the current scene if none exists. **`advance`** — steps the turn; rounds transition automatically. **`end`** — ends and deletes the active encounter; the scene token roster is unaffected.

---

## Chat

### `chat`
Chat log access. The `action` discriminator selects the operation.

- **Discriminator**: `action` — `"send"` or `"read"`.
- **`action: "read"`** — read history (not gated). Params: `limit?` (default 50, max 500), `since?` (ISO or epoch ms), `speaker?` (by `speaker.alias` or `speaker.actor`), `includeRolls?` (default true), `includeWhispers?` (default false). Returns `{ total, returned, messages: [{ id, timestamp, time, type, speaker, content, isRoll, rolls, whisperTo }] }`.
- **`action: "send"`** — post a message (write-gated at call time: requires `FOUNDRY_MCP_ALLOW_WRITE=1`, otherwise the tool errors without touching Foundry). Speaker defaults to the routed user (GM); `speaker?` display alias; `actorId`/`tokenId` speak as that document; `whisperTo?` userName or array; `type?` `"OOC"` (default) / `"IC"` / `"EMOTE"` / `"WHISPER"` / `"ROLL"` / `"OTHER"` or the integer.

---

## Requests (interactive, routed to a user's screen)

### `request`
Human-in-the-loop requests — these route prompts to a user's screen and are not achievable via `evaluate`. Merges the old `request_roll` / `request_check` / `request_item_use` (+ `request_attack_roll` / `request_damage_roll`).

- **Discriminator**: `action` — `"roll"`, `"check"`, or `"itemUse"`.
- **`action: "roll"`** — pops a Roll dialog on the target user's screen; waits for a human click.
  - Params: `formula` (required), `prompt?`, `label?`, `timeoutSeconds?` (default 60, max 300), `autoAccept?` (skip dialog, roll now — for GM automation/tests).
  - Returns one of: `{ mode: "rolled"|"auto_rolled", formula, total, result, dice }`, `{ mode: "cancelled"|"timed_out"|"dismissed"|"error", formula, ... }`.
- **`action: "check"`** — system-native skill/ability/save check; dialogs always suppressed. Systems: dnd5e, pf2e, shadowdark, vagabond.
  - Params: `actorId` (required), `checkType` — `"skill"`/`"ability"`/`"save"` (required), `identifier` (system slug: `"ath"` for 5e Athletics, `"athletics"` for PF2e, `"str"` for Shadowdark), `dc?`, `adv?` (`"normal"`/`"advantage"`/`"disadvantage"`; dnd5e + shadowdark only).
- **`action: "itemUse"`** — item combat workflow; dialogs suppressed. Param `phase`: `"full"` (default, recommended: Attack → Hit? → Damage → optional Apply, crit threaded), `"attack"` (roll only), `"damage"` (roll only; caller supplies crit).
  - Params: `actorId`, `itemId` (required), `targetIds?` **[full]** (damage applied on hit), `activityId?` (5e multi-attack items), `adv?`, `isCritical?` **[damage]**.
  - **System scope**: structured results for d20-style systems (dnd5e, pf2e) and **Shadowdark NPCs**. Shadowdark **player characters** have no structured programmatic result — use `use_item` (authentic card) or the `interact` click path instead.
- If you target a player without an active browser, the dialog never shows and the call times out — target a connected user (see `list_connected_bridges`), or use `autoAccept` for unattended runs.

---

## Debugging

### `get_console_errors`
Rolling buffer of `console.error`/`console.warn` captured by the bridge. The bridge patches `console.error` and `console.warn` at load; buffer cap is **1000** (oldest entries drop). Invaluable for catching silent failures inside the Foundry client.

- **Params**: `count?`, `sinceMs?` (default 60000), `level?` (`"error"`/`"warn"`).
- **Returns**: `{ bufferSize, bufferCapacity, returned, entries }`.

### `trace`
Runtime diagnostics with three modes; the `action` discriminator picks the mode. Merges the old `trace_hooks` / `trace_socket` / `trace_workflow` tools.

- **`action: "hooks"`** — listen on multiple Foundry hooks at once and return one time-ordered timeline. Params: `hooks` (array, required), `count?` (default 50), `timeoutMs?` (default 5000), `until?` (stop when this hook fires). Returns `{ at, dt, hook, args }` per firing (`dt` = ms since first). Foundry documents are summarized to `{_document, id, name, uuid}`; arrays truncate at 10, depth cap 3. Use for hook-order diagnostics before writing code against them.
- **`action: "socket"`** — tap `game.socket` for a window: out (`socket.emit`) and in (`onAny`). Params: `filter?` (substring on event name, e.g. `"module.vagabond-crawler"`), `count?` (default 100), `timeoutMs?` (default 5000). Returns time-ordered `{ at, dt, dir: "in"|"out", event, args }`. Don't run two socket traces in parallel.
- **`action: "workflow"`** — one-call investigation: expands a named **preset** into an exact hook list (Foundry has no wildcard hook matching — this is how you trace e.g. a full Midi-QOL workflow without hand-typing ~12 hook strings), opens the window, optionally fires `trigger` (any bridge tool) inside it, and with `watch` snapshots actors before/after and returns a structural diff next to the timeline.
  - Params: `preset` (required: `midi-full`, `midi-damage`, `active-effect`, `document-lifecycle`, `dnd5e-roll` — defined in `server/lib/workflow-presets.js`), `watch?`, `trigger?` `{ tool, params }`, `select?`, `extraHooks?`, `count?` (default 200), `timeoutMs?` (default 8000), `until?`, `triggerDelayMs?` (default 150).
  - **Midi gotcha**: the trigger MUST invoke Midi's workflow — use `use_item` (calls `item.use()` through Midi); `request {action:"itemUse"}` bypasses Midi and fires zero `midi-qol.*` hooks.
  - See `docs/debugging-recipes.md` for the scenario→hook lookup table behind every preset.

### `evaluate`
**The power tool.** Runs arbitrary JavaScript in the Foundry client context. The `expression` you pass becomes the body of an async function with `game`, `canvas`, `ui` in scope. Use `return` to send a value back. **Only present when `FOUNDRY_MCP_ALLOW_EVAL=1`.**

- **Params**: `expression` (required), `timeoutMs?` (clamped 5000–180000; default 15000), `background?` (start as a job, return `{ jobId, status }` immediately).
- **Returns**: `{ result, evalMs }`, a background job id, a large-result handle (>256 KiB), or `{ error, stack }` on throw.
- **Return serialization**: Foundry documents are `toObject()`'d; everything else is JSON-roundtripped (functions/circular refs/`undefined` lost).
- **Gotchas**: use `background: true` for work that may outlive the request timeout; running JavaScript cannot be canceled safely.
- **Prefer dedicated tools** — `apply_damage` clamps HP, `token` move routes around walls, `use_item` runs the system attack path; hand-written JS skips that correctness and the audit path.

### `job_result`
Poll a background evaluation or read a large JSON result in bounded chunks.

- **Params**: `jobId` (required), `waitMs?` (0–10000), `offset?`, `length?` (1–65536), `delete?`.
- Small completed jobs return the parsed result inline; large results return `{ chunk, offset, nextOffset, totalChars, totalBytes, done }`.
- **Storage bounds**: 30-minute TTL, 50 entries, 8 MiB per entry, 32 MiB total, 10 concurrently running jobs. Running jobs cannot be canceled/deleted.

---

## Snapshots

### `snapshot`
Actor-state snapshots for before/after verification. Merges the old `snapshot_actors` / `diff_with` tools.

- **Discriminator**: `action` — `"take"` or `"diff"`.
- **`action: "take"`** — capture structured projections of actors at selector paths. Selectors walk the **live** document, so derived/getter-only data surfaces (Active-Effect-modified stats, `prepareDerivedData` patches, computed Sets like `actor.statuses`) that `actor.toObject()` misses.
  - Params: `actors` (id(s)/name(s), required), `select?` — dot paths + array wildcards (`system.health.value`, `effects[*].name`, `items[2].name`, `flags.vagabond`, `statuses`). Omit for full `toObject()` under a `_full` key (persisted source — no derived data). `storeId?` persists server-side (~30 min TTL, LRU 50) for a later diff.
  - Returns: `{ snapshotId, takenAt, actors, errors? }`.
- **`action: "diff"`** — re-snapshot the live game and compute per-path changes against `storeId` (reuses its actors/select/targetUser) **or** an inline `snapshot` payload (requires matching `actors` + `select`).
  - Returns: `{ storeId, takenAt, changes: [{ actorId, path, op, before, after }], summary }`.

---

## Capture

### `screenshot`
Capture a Foundry image. **Returns an image** (MCP image content block). The `target` discriminator selects what to capture and which params apply. Merges the old `screenshot` / `screenshot_dom` / `capture_scene` tools.

- **Discriminator**: `target?` — `"canvas"` (default), `"dom"`, `"scene_grid"`, or `"cdp"`.
- **Params**: `scale?` [canvas/dom/cdp], `quality?` [canvas/dom], `format?` [canvas/dom], `selector?` [dom/cdp].

**`target: "canvas"`** (default) — fast snapshot of the PIXI game canvas (map + tokens, at your current pan/zoom). Uses `renderer.render(stage → RenderTexture)` + `renderer.extract.canvas(...)` — needed because the live WebGL context has `preserveDrawingBuffer: false`, so `view.toDataURL()` would return black.
- **Does NOT capture**: DOM overlays (character sheets, HUD, notifications, targeting reticles) — only the PIXI canvas. Use `target: "dom"` for those.
- **Hidden-tab handling**: advances the PIXI ticker immediately before capture so queued placeable render flags are applied even when the tab is backgrounded.

**`target: "dom"`** — screenshot an arbitrary **DOM element** (character sheets, HUD, chat cards, app windows, sidebar) via `html2canvas`. Fills the gap `target: "canvas"` leaves (PIXI-only). `html2canvas` is lazy-loaded from a CDN on first call and cached for subsequent calls. Useful `selector` values:
- `'.app.sheet'` — a rendered actor/item sheet.
- `'.app[data-appid="123"]'` — a specific app by id.
- `'#chat-log'` — the chat panel.
- `'#sidebar'` — the full right sidebar.
- `'#party-bar'`, `'.crawler-bar'`, etc. — custom module UI.
- **Gotchas**: `html2canvas` re-rasterizes by reading computed CSS — **approximate** (3D transforms, `backdrop-filter`, complex shaders, cross-origin images without CORS may render wrong). First call pays CDN load (~2s, cached after).

**`target: "scene_grid"`** — like `canvas` but at **full resolution**, **WebP**, with a **coordinate grid overlay** — every cell gets a `"gx,gy"` label in white-on-black. Much bigger payload; vastly better for spatial reasoning. No extra capture params.

**`target: "cdp"`** — a DOM element captured via Chrome DevTools Protocol (**pixel-perfect** — the browser's actual composited output; no html2canvas approximations). `selector` (CSS, required), `scale?` (default 2.0), `format?` (default png), `quality?`. Requires the bridge Chromium on port 9222.

### `record_video`
Record a video of the Foundry game viewport using CDP screencast + ffmpeg. Captures whatever is visible in the observer Chrome (port 9223, 60fps GPU); falls back to the bridge Chromium (9222). Requires a Chrome target that produces continuous frames — headless bridge tabs produce none.

- **Params**: `duration` (required, 1–60, default 10), `fps?` (1–30, default 10), `quality?` (1–100, default 85), `maxWidth?` (default 1280), `maxHeight?` (default 720), `output?`.
- **Returns**: `Video recorded: <path> — N frames, X.X MB` or `Recording failed: <reason>`.

---

## Dice & items

### `roll`
Evaluate a dice formula. Can **force** specific dice results via `rig`.

- **Params**: `formula` (required — e.g. `"2d20kh + 5"`, `"(1d8+3)[slashing]"`, `"4d6dl1"`), `rig?` (forced face values, consumed in roll order; clamped to each die's faces; queue exhausts to real RNG).
- **Returns**: `{ formula, total, result, dice: [{ faces, results: [{ result, active, discarded }] }] }`.
- **How rigging works**: the bridge patches `Die.prototype._roll` for the call's duration and watches for Foundry's roll-resolver dialog; both paths consume one shared queue.

### `use_item`
Calls `item.use()` (fallback `item.roll()`) on an actor's item and captures any chat messages it produces. Accepts `rig`.

For systems where the roll path lives on the actor data model rather than the item, `use_item` auto-routes to the system's native method and captures its authentic card. Currently: **Shadowdark weapons** → `actor.system.rollAttack(item.uuid, { skipPrompt: true })` (the same path the sheet's `[data-action="item-attack"]` button calls, dialog suppressed). An explicit `method` param overrides the auto-route.

- **Params**: `actor` (required), `item` (required, on that actor), `rig?`, `method?` (override — disables auto-route), `attackType?` (**Shadowdark weapons**: `"melee"` STR / `"ranged"` DEX for thrown weapons).
- **Returns**: `{ actor, item, method, messagesCreated, messages: [...] }` — each message `{ id, speaker, flavor, content, rolls: [{ formula, total, dice }] }`.
- **Gotchas**:
  - The Shadowdark weapon card carries **both** attack and damage rolls in one message plus an `apply-damage` button. Bonuses come from the system's own calc (ability mod + active-effect talents).
  - For **structured** attack→damage→apply results, use `request {action:"itemUse"}` — `use_item` returns raw card messages.
  - Vagabond's `rollAttack`/`rollDamage` need sheet DOM context — use `interact` click for those.

---

## UI interaction

### `interact`
Simulate user interactions with the live UI. Merges the old `click` / `simulate_dialog_response` tools.

- **Discriminator**: `action` — `"click"` or `"dialog"`.
- **`action: "click"`** — click a DOM element by CSS selector using the native bubbling event (`HTMLElement.click()`), so delegated listeners fire. This is the **real production path** — many systems (Vagabond especially) only dispatch the authentic attack → defender → damage → hit/crit pipeline through their sheet button handlers.
  - Params: `selector` (required — e.g. `'[data-action="rollWeapon"]'`, `'[data-action="vce-bless-mode"][data-mode="allies"]'`), `rig?` (forced dice incl. the roll-resolver dialog), `openActor?` (render this actor's sheet first, wait up to 2s), `waitMs?` (post-click wait for async chat, default 400).
  - Returns: `{ selector, element: { tag, class, id, dataset, text }, messagesCreated, messages: [...] }` or `{ error, stack, element }`.
- **`action: "dialog"`** — click a button on the topmost open DialogV2 (confirmation/options dialogs without stable selectors — cast options, talent config, the dialog-helpers `confirmDialog`/`waitDialog` wrappers).
  - Params: `label?` (button text contains, case-insensitive) **or** `index?` (zero-based button position).
  - Returns: the dialog title and the clicked button's resolved label.

---

## World authoring (opt-in: FOUNDRY_MCP_ALLOW_WRITE=1)

These tools **create and modify persistent world data**. They are gated behind `FOUNDRY_MCP_ALLOW_WRITE=1` on the server; with the gate off none of them are registered. They all route through `targetUser` — document creation runs in that user's browser context with that user's permissions.

### `self_test` (additional opt-in)
Run a guarded schema-drift smoke test after a Foundry core update.

- **Gates**: requires both `FOUNDRY_MCP_ALLOW_WRITE=1` and `FOUNDRY_MCP_ALLOW_SELF_TEST=1`.
- **Params**: `confirm: true` is mandatory.
- **Behavior**: creates uniquely named and flagged Actor, JournalEntry/Page, RollTable/TableResult, and Scene/Level documents; round-trips representative fields; then performs reverse-order cleanup in `finally`.
- **Cleanup guard**: a document is deleted only when its `foundry-mcp-live.selfTestRun` flag still matches the current run id.
- **Returns**: `{ runId, pass, checks, cleanup }`.

### `actor_write`
Create, import, update, or delete a world actor.

- **Discriminator**: `action` — `"create"`, `"fromCompendium"`, `"update"`, or `"delete"`.
- > For `create`, **call `get_data_model({type:"Actor", subtype:"<type>"})` first** if you don't already know the shape for the active system. Without that, you'll likely produce a malformed actor.
- **Params**: `name?` **[create]** (also replaces name on update), `type?` **[create]** (system subtype, e.g. `"character"`/`"npc"` dnd5e, `"Player"` shadowdark), `system?` **[create/update]**, `items?` **[create]** (`{ pack, documentId, nameOverride? }` or inline), `img?`, `prototypeToken?`, `folderId?`/`folderName?` (auto-creates an Actor folder), `pack?`+`documentId?` **[fromCompendium]**, `nameOverride?`, `audit?`.
- **`delete`** — permanent; snapshots (`snapshot` take) first if anything must survive.
- Returns: `{ id, name, type, folder, itemIds }` (create) / `{ id, name, type, folder, sourcePack, sourceDocId }` (import) / `{ actorId, fieldsUpdated }` (update) / `{ id, name, type, deleted: true }` (delete).

### `scene`
Create, update, activate, or delete a scene.

- **Discriminator**: `action` — `"create"`, `"update"`, `"activate"`, or `"delete"`.
- **Params**: `name?` **[create]** (also rename on update), `width?` (default 4000), `height?` (default 3000), `gridType?`, `gridSize?` (default 100), `gridAlpha?`, `folderId?`, `activate?` (default true), `padding?`, `backgroundColor?`, `background?` (v14 maps to `Level.background`/`Level.textures`), `foreground?`, `levelFog?` (v14), `fog?` `{mode:0|1|2, colors}`, `fogExploration?` (compat boolean; false→`fog.mode 0`), plus **[update]** `grid?`, `navigation?`, `sort?`, `navName?`, `initial?`; **[activate/delete]** `sceneId?`/`sceneName?`; **[delete]** `force?` (required to delete the active scene), `audit?`.
- **`delete`** — permanent; `force: true` required when the scene is active.

### `apply_damage`
Applies damage to one or more targets with mixed outcomes (e.g., fireball with some targets saving).

- **Params**: `damages` — array of `{ targetId, amount, type?, multiplier? }`; `multiplier` 0 = immune, 0.5 = save-for-half, 1 = full, 2 = vulnerability. `audit?`.
- Encodes the system's HP clamping — don't re-implement via `evaluate`.

---

## Patterns & workflows

**Discovery flow** — "what's happening?":
1. `get_game_info` → confirms bridge alive, tells you the system.
2. `scene_read` → tokens on the map with positions.
3. `token {action:"details", tokenName:"<name>"}` → deep info on one token.
4. `screenshot { target: "scene_grid" }` → visual confirmation with grid labels.

**Debugging flow** — "something's broken":
1. `get_console_errors` → see what's been throwing in the browser.
2. `trace {action:"hooks", hooks:["relevantHook"]}` → learn what args the hook receives.
3. `evaluate "return <some probe>;"` → prototype against live game state.
4. Add a proper handler to `bridge.js` once you know what works.

**Deterministic test flow** — "prove this attack hits":
1. `token {action:"target", tokens:["Goblin"]}` → set defender.
2. `interact {action:"click", selector:'[data-action="rollWeapon"]', rig:[15,6,6], openActor:"Sassafrass"}` → force attack=15, damage dice=6,6.
3. Inspect the returned chat messages for hit/miss/damage.

**Trigger a weapon attack** — "swing the weapon, get the real card":
- d20 systems (dnd5e/pf2e) or a Shadowdark **NPC**: `request {action:"itemUse", phase:"full", actorId, itemId, targetIds}` → structured attack→damage→apply.
- Shadowdark **player character**: `use_item {actor, item:"<weapon>"}` → fires `actor.system.rollAttack` and returns the system's authentic attack card. `rig` still forces dice.
- DOM alternative (need the live card UI): `interact {action:"click", selector:'[data-action="item-attack"][data-item-id="<weapon-uuid>"]', openActor:"<pc>"}` (shift-click semantics = no prompt).

**Visual verify after mutation**:
1. `token {action:"move", tokenName, x, y, pathed:true}` to a target cell.
2. `screenshot { target: "scene_grid" }` → confirm the grid position visually.

**Rigged dice key rules**:
- `rig` works on `roll`, `use_item`, and `interact` click.
- Values are consumed in roll order across *all* dice in the sequence. Plan the full queue: `[attack, damage_die1, damage_die2, ...]`.
- Values past the queue roll normally from the real RNG.
- Values are clamped to each die's `faces` (so `[99]` on a d20 becomes 20).

**Gotchas not tied to a specific tool**:
- The bridge holds **one** Foundry connection at a time. If the connection drops, in-flight `pendingRequests` on the server reject with "Foundry disconnected".
- Reloading Foundry (F5) is the right way to pick up new bridge code; the module reconnects automatically with 5s backoff.
- Restarting the Node server requires MCP clients to re-initialize (the session ids invalidate).
- `token` update's whitelist is a deliberate guard against accidental destructive writes. Extend it in `bridge.js:handlers.update_token` (`token` update routes there) if you need more.