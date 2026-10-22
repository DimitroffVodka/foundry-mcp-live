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

**Reads through a player's bridge.** Foundry sends every client the full source of every document, including GM-only HTML; the sheets hide it only when they render. So document reads routed to a non-GM apply the sheet's rules before replying: `document` (actor/item/compendium/actorItems, `derived` too), `search_compendium` with `full`, `get_data_model`'s sample, `token` details, `snapshot` take, `scene_read` placeables, `chat` read/events and `roll` table draws.
- Unrevealed `<section class="secret">` blocks are removed unless the player owns the document (chat: owns the speaker's actor), as `TextEditor.enrichHTML` does with `secrets: false`. Revealed secrets stay. Journals follow the same owner rule (`document` action `"journal"`).
- Flags of namespaces other than `core` and the game system are dropped (modules such as GM Notes keep GM-only text in flags). `document` takes `flags: true` to keep them.
- Every `ownership` map is cut to `{ <playerId>: <their level> }`, so a read does not reveal who else owns or observes what.
- Chat content the player's own chat log hides (blind rolls, whispers to others) comes back empty with `contentHidden: true` and no roll results; the message itself is still listed. `get_debug_snapshot`'s chat preview follows the same rules.

A GM bridge (the default route) returns everything unchanged.

### `audit` (optional, mutating tools only)

Every tool that modifies the Foundry world (creates, updates, or deletes documents) accepts an optional `audit: true` parameter. When set, the tool returns an `audit` block containing a flight recorder of the mutation.

- **`audit.before`** — snapshot of the affected document(s) *before* the change.
- **`audit.after`** — snapshot *after* the change.
- **`audit.diff`** — structured delta of what actually changed. Noisy metadata (timestamps, stats, IDs) is automatically filtered.
- **`audit.undo`** — dry instructions for how to revert the change (e.g. rollback data or a delete command). To actually revert it, use [`changes`](#changes): every write call is logged there whether or not `audit` was set.

**Efficiency Note:** Full snapshots are limited to 10 documents per call to keep context window usage low. If more are affected, the audit will note the truncation. Use this to self-verify your work in an **Act -> Validate** loop.

### Read-only toggle

Every bridge handler declares its access — `read`, `write` or `delete` — in `module/lib/handler-access.js`, and the bridge's single dispatcher checks it before any handler runs, on the direct and the relay path alike. A handler with no declaration is refused as unknown (a test fails when one is missing). `write` and `delete` handlers run only while the world setting **"Allow AI to modify the world"** (`foundry-mcp-live.allowWorldMutations`, default on) is exactly `true`; when it is off, unreadable, or holds anything else, they are refused with a message naming that setting. `write` includes everything that can change the world or other people's screens: chat, rolls posted to chat, dialogs, UI clicks, `evaluate` and `call_module_api`.

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
| Regions and other placeables (`placeable`) | Validated by the core document schema, then created/updated as given | Same, including Region level membership |
| RollTable results | No dedicated authoring tool; legacy `.text` is not written | `self_test` validates `TableResult.description` |
| Compendium configuration | No write tool calls `pack.configure`; label/ownership schema drift is therefore not exposed | Same |
| Snapshots/diffs | Read-only | Read-only |

The guarded `self_test` provides the runtime check for representative Actor,
JournalEntry/Page, RollTable/TableResult, and Scene/Level writes after a
Foundry core update.

Note: several former dedicated write tools (folders, journals, regions, scene
levels, actor items/ownership, measured templates) were removed in the
2026-08 reduction; those operations are now done via `evaluate` against the
same document APIs this table describes. Journal *reads* are back on the merged
tools: `list` type `"journal"` and `document` action `"journal"`. Regions and the
other scene placeables (walls, lights, sounds, tiles, drawings, notes) are back
too, as the one merged `placeable` tool.

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

- **Discriminator**: `type` — `"actor"`, `"scene"`, `"module"`, `"rollTable"`, `"compendium"`, or `"journal"` (required).
- **Params**:
  - `filter?` **[actor]** — actor subtype (e.g. `"character"`, `"npc"`). **[compendium]** — document type (e.g. `"Actor"`, `"Item"`).
  - `folder?` **[actor/journal]** — filter by sidebar folder name (exact match).
  - `activeOnly?` **[module]** — default `true`; `false` includes inactive modules.
  - `query?` **[journal]** — case-insensitive search of entry names, page names and page text (the page Markdown, see `document` action `"journal"`).
  - `secrets?` **[journal]** — also search GM secret blocks. Default `false`.
  - `offset?` / `limit?` **[journal]** — pagination; `limit` default 50, max 500.
- **Returns**:
  - `actor`: `[{ id, name, type, folder, img }]`
  - `scene`: `[{ id, name, active, folder }]`
  - `module`: `[{ id, title, version, active }]`
  - `rollTable`: `[{ id, name, formula, results }]` (`results` is the entry count; draw from one with `roll {table}`.)
  - `compendium`: `[{ id, label, type, system, count }]` — `id` is the collection path (e.g. `"vagabond.monsters"`); use it as `pack` in `search_compendium` / `document`.
  - `journal`: `{ total, offset, count, items, truncated, nextOffset?, note? }`. Without `query`, items are `{ id, name, folder, pages: [{ id, name, type }] }`; with `query`, `{ id, name, folder, matches: [{ pageId, pageName, snippet? }] }` (an entry whose name matches is listed even with no page match). `truncated: true` means more entries exist beyond this call; `note` says which `offset` to use next. Only entries/pages the routed user can see are listed.

### `document`
Read one document. The `action` discriminator picks the kind.

- **Discriminator**: `action` — `"actor"`, `"item"`, `"compendium"`, `"actorItems"`, or `"journal"`.
- **Params**:
  - `id?` / `name?` **[actor/item/journal]** — one of them (exact name match).
  - `pack` **[compendium, required]**, `id?` / `name?` **[compendium]** — fetch one entry from a pack.
  - `actorId` **[actorItems, required]** — actor id or exact name; `filter?` — item type (e.g. `"weapon"`).
  - `derived?` **[actor/item/compendium]** — return the prepared values instead of the stored source (see Returns). Default `false`.
  - `flags?` **[actor/item/compendium]** — through a non-GM bridge, keep other modules' flags (see [Reads through a player's bridge](#targetuser-optional-every-routed-tool)). No effect for a GM. Default `false`.
  - **[journal]** `pack?` — read the entry from a compendium instead of the world; `page?` — one page by id or exact name; `offset?` / `limit?` — page pagination (`limit` default 20, max 100); `maxChars?` — Markdown budget for the reply (default 20000, max 200000); `textOffset?` — with `page`, start at this character (continue a cut page); `enrich?` — run the HTML through `TextEditor.enrichHTML` first; `secrets?` — include GM secret blocks (default `false`, in both modes).
- **Returns**:
  - `actor` — full `actor.toObject()`: `_id, name, type, img, system, items, effects, prototypeToken, folder, sort, ownership, flags`. **Heavy.**
  - `item` — `item.toObject()`.
  - `compendium` — full `toObject()` of the entry (or `{ error: "Document not found in <pack>" }`).
  - with `derived: true` (actor/item/compendium) — `{ id, uuid, name, type, img, system, appliedEffects?, rollData }`: `system` is `toObject(false).system` (schema fields after `prepareData` and Active Effects — e.g. a buffed `hp.max`), `appliedEffects` is `[{ id, name, origin, statuses, changes }]` (actors only), `rollData` is `getRollData()`, which also carries derived values the schema does not hold (dnd5e `abilities.*.mod`, `prof`). This is what the sheet shows; the source read is what is stored. Nested documents become their uuid and cycles become `"[Circular]"`.
  - `actorItems` — `[{ id, name, type, img, system }]` — much smaller than a full actor read.
  - `journal` — `{ id, uuid, name, folder, total, offset, count, items, truncated, nextOffset?, note? }`; items are `{ id, name, type, chars, markdown, textOffset?, cut? }`. Text pages are converted HTML → Markdown in the browser by walking the parsed DOM (headings, lists, tables, links, images; secret blocks dropped unless `secrets`); image/video/pdf pages become a Markdown image or link. Without `enrich`, links stay as written (`@UUID[...]{...}`); with it, enriched links come back as `@UUID[uuid]{label}` and inline rolls/system enrichers as their rendered text. `truncated: true` whenever anything was left out; `note` says how to continue (`offset=…`, or `page` + `textOffset` when a single page was cut at `maxChars`; `chars` is the page's full length).

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
Query spatial state as structured data — the video-game approach to map awareness. Read-only: nothing moves. Cheaper and more deterministic than screenshots for spatial reasoning.

- **Discriminator**: `mode?` — `"cells"` (default), `"path"`, `"collision"`, `"range"`, or `"measure"`.
- `from` / `to` take a token (id, name or linked actor name; its center is used) or a pixel point `{x, y}`.
- **Walls are canvas-bound**: `path`, `collision` and `range` test walls, which Foundry only loads for the scene drawn on the routed client's canvas — view that scene first (they error otherwise). On Foundry v14 walls belong to a Level: they test the walls of `level?` (id or name), default the `from` token's Level (the scene's initial Level if it has none), or for a point the Level on the canvas, and report it as `level` (id; `null` on v13). `measure` works without a drawn canvas, on any scene.
- **`cells`** — `cells?` (array of `{gx, gy}`) or `region?` (`{minGX, minGY, maxGX, maxGY}`, inclusive; max 2500 cells). Returns `sceneId, gridSize, fogExploration, cellCount` and `cells: [{ gx, gy, x, y, explored, visible, occupied, occupiedBy? }]` — `x,y` are pixel centers; `explored` is fog exploration state (always `true` when fog is off); `visible` is current line-of-sight (always `true` for GMs); `occupied` is `true` when a token's center lies in the cell.
- **`path`** — `from`, `to`, `maxNodes?` (1–10000, default 2500). The same wall-aware A* that `token {action:"move", pathed:true}` uses (square-grid 8-way steps, closed doors block). Returns `{ reachable, steps, waypoints: [{x, y, gx, gy}], distance, cost, spaces, diagonals, units }` (waypoints are top-left cell corners, as `token` move takes them), or `{ reachable: false, reason }` — the reason says whether walls cut the route or `maxNodes` ran out.
- **`collision`** — `from`, `to`, `types?` (subset of `move`/`sight`/`light`/`sound`, default all). Calls each `CONFIG.Canvas.polygonBackends[type].testCollision`, so door states, limited, proximity and one-way walls count exactly as core counts them. Returns per type `{ blocked, walls: [wallIds], at?: {x, y} }` (`at` = first contact).
- **`range`** — `from`, `distance` (scene units), `lineOfSight?`. Tokens whose center is within `distance` of `from` (measured with `scene.grid.measurePath`), nearest first, excluding `from` itself; `lineOfSight: true` drops tokens behind a sight-blocking wall. Returns `{ count, units, tokens: [{ id, name, actorId, x, y, distance }] }`.
- **`measure`** — `from` + `to`, or `waypoints` (2–100 pixel points); `sceneId?` (default: the scene on the canvas). `scene.grid.measurePath`, so the core diagonal rule applies. Returns `{ distance, cost, spaces, diagonals, euclidean, units, diagonalRule }`.
- **Usage patterns**: `cells` around a token → find `explored: false` cells → `token {action:"move", onlyUnexplored:true}`. `path` before `token` move to learn whether a destination is reachable and how far it is. `collision` after `placeable` creates walls, to confirm they block what was meant.

---

## Tokens

### `token`
All token operations on the active scene. The `action` discriminator selects the operation.

- **Discriminator**: `action` — `details`, `move`, `create`, `update`, `delete`, `toggleCondition`, `target`, or `setLevel`.
- **`action: "details"`** — the most information-dense token query. `tokenName` (required). Returns geometry/state (`x, y, width, height` in grid units, `rotation`, `elevation`, `hidden`, `disposition`, `lockRotation`, `sort`, `img`), `sight` (vision range/angle/mode/tint), `light` (bright/dim radii, animation, darkness range, shader knobs), plus the linked **`actor`** snapshot (full `system` block, `statuses` array, `effects` list).
- **`action: "move"`** — `tokenName`, `x`, `y` (required). `pathed: false` (default) = straight teleport (no wall check; `animate: false` for instant placement). `pathed: true` = **smart move**: A* against scene walls (`pathCost` returned; on Foundry v14 the walls of the token's own Level — the scene's initial Level if it has none — not the Level the client is viewing, reported as `level`, `null` on v13; `canOpenDoors` only opens doors on that Level), only the final hop animates, `canOpenDoors: true` opens doors en route (returns `doorsOpened`), `elevation`/`rotation` apply to the final waypoint. `onlyUnexplored: true` rejects fog-explored destinations. A* node cap 2500 — very long paths may fail; `query_grid {mode:"path", maxNodes}` checks a route with a higher cap first, or retry with a shorter hop.
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

- **Discriminator**: `action` — `"send"`, `"read"`, `"events"`, or `"wait"`.
- **`action: "read"`** — read history (not gated). Params: `limit?` (default 50, max 500), `since?` (ISO or epoch ms), `speaker?` (by `speaker.alias` or `speaker.actor`), `includeRolls?` (default true), `includeWhispers?` (default false). Returns `{ total, returned, messages: [{ id, timestamp, time, type, speaker, content, isRoll, rolls, whisperTo }] }`.
- **`action: "send"`** — post a message (write-gated at call time: requires `FOUNDRY_MCP_ALLOW_WRITE=1`, otherwise the tool errors without touching Foundry). Speaker defaults to the routed user (GM); `speaker?` display alias; `actorId`/`tokenId` speak as that document; `whisperTo?` userName or array; `type?` `"OOC"` (default) / `"IC"` / `"EMOTE"` / `"WHISPER"` / `"ROLL"` / `"OTHER"` or the integer.
- **`action: "events"`** — the live event cursor (not gated). Every client keeps a ring buffer of its last 300 events, recorded from `createChatMessage` (kind `"chat"`, or `"roll"` when the message carries rolls) plus `request {action:"ask"}` answers shown on that client (kind `"ask"`). Each event has a monotonic `seq`. Params: `sinceSeq?` (only events after it), `limit?` (newest kept, default 50, max 300), filters `kind?`, `user?` (author name/id), `speaker?` (alias/actor id), `contains?` (case-insensitive text/flavor substring). Returns `{ latestSeq, events: [{ seq, at, kind, messageId, user, userId, speaker, actorId, flavor?, content, rolls?, whisper }], dropped?, reset? }`. `dropped` means the cursor fell off the ring; `reset` means the client reloaded (seq restarted) and the read started from the beginning. Whispers the routed client can see are included and flagged. Unlike `trace`, it is always recording, so nothing between two calls is missed.
- **`action: "wait"`** — block until the next event matching the same filters, or return at once if one is already buffered after `sinceSeq` (omit `sinceSeq` to wait for a new one only). `timeoutSeconds?` default 30, **max 40**: MCP clients give up near 60 s, so wait in rounds. Returns `{ status: "matched", latestSeq, event }` or `{ status: "timeout", latestSeq }`. A reply that lands after a timeout is still in the buffer — read it with `events`.
- **Pattern — ask the table and wait for a reply**: `chat {action:"events", limit:1}` → keep `latestSeq` → post the question (`chat send`) → `chat {action:"wait", sinceSeq, user:"Alice"}`; on timeout call `wait` again with the same `sinceSeq`.

---

## Change log

### `changes`
The routed client's log of every document a write call created, updated or deleted, with undo. Always registered; `undo` writes, so it respects the read-only toggle.

- **Discriminator**: `action` — `"list"` or `"undo"`.
- **What is logged**: while a handler declared `write`/`delete` runs (see [Read-only toggle](#read-only-toggle)), each document create/update/delete that browser asks for is one entry `{ id, callId, tool, time, action, documentName, uuid, name, parentUuid, pack, changed, undoable, reason, undoneBy? }` with the document source before and after. Each bridge tab has its own log of its last 200 entries. On a GM client the log is also stored in one hidden JournalEntry ("MCP change log (do not edit)", default ownership None, flagged `flags.foundry-mcp-live.changeStore`; `list` and `document` never show it), so it survives a reload of that tab: the tab's id lives in its `sessionStorage`, and the tab reloads its own log at `ready` with ids continuing where they stopped. The store holds 200 entries and 5,000,000 characters in total across tabs, oldest pruned first, and is written at most once a second (a change in the last second before a reload can be lost). A new tab or a relaunched browser starts an empty log; older tabs' entries stay in the store until pruned. On a player's bridge the log is memory only. **Players can read the store**: Foundry sends every world JournalEntry to every client when it joins, whatever its ownership, so the snapshots (including of documents since deleted) reach players' browsers even though their sidebar never shows it.
- **`action: "list"`** — newest first. Params: `callId?`, `uuid?`, `limit?` (default 50, max 200); `entryId?` returns that one entry with its full `before`/`after`. Returns `{ total, stored, entries, neverLogged }`; `stored` says whether this client keeps the log across reloads.
- **`action: "undo"`** — `entryId` undoes one entry, `callId` every entry of one call, neither the latest call. Before writing anything every step is checked: the entry is undoable; the user may do the reverse action, and changes made by `FOUNDRY_MCP_ALLOW_WRITE` tools need that gate on now; no drift — no later entry on the same document, `_stats.modifiedTime` unchanged, and the document still equal to the recorded `after`. Any problem refuses the whole undo: `{ ok: false, problems, wouldRun }`, nothing written. Otherwise each document goes back to its state before the earliest selected entry: updates are restored field by field (old values set, added keys removed with `-=`; embedded collections are their own entries), created documents are deleted, deleted ones recreated with `keepId`, newest first, and each step is read back: `{ ok: true, undoCallId, applied: [{ op, uuid, entries, fields?, readBack }] }`. The undo is itself a logged call, so undoing it redoes.
- **Interrupted undo**: if a step fails, the steps before it stay applied and are marked undone; the failure result's `retry` (`{ callId }` or `{ entryId }` of the original selection) resumes, skipping them. Do not retry with no ids: the applied steps are logged under the undo's own call, so that would undo the undo. An undo whose entries are all undone already is refused (undo that undo call to put things back).
- **Never undone**: chat messages, settings, users, macros (they are code) — undoing a whole call leaves these alone and lists them in `leftAlone`; one selected by `entryId` is refused — documents over the 200,000-character snapshot cap, and changes made while another write call was running on the same client (which call made them is uncertain). **Never logged**: pause, targeting, canvas view and level, dialogs and clicks on other screens, sounds, uploaded files, dice already rolled, `evaluate` jobs that finish after their call returns, changes from another browser tab, and anything before the tab first loaded the world (on a player's bridge, before its last reload).
- A human editing in the bridge's own browser while a long call runs (for example `request` waiting for a player) is logged under that call; check `list` before undoing a call that waited on people.

---

## Requests (interactive, routed to a user's screen)

### `request`
Human-in-the-loop requests — these route prompts to a user's screen and are not achievable via `evaluate`. Merges the old `request_roll` / `request_check` / `request_item_use` (+ `request_attack_roll` / `request_damage_roll`).

- **Discriminator**: `action` — `"roll"`, `"check"`, `"itemUse"`, or `"ask"`.
- **`action: "roll"`** — pops a Roll dialog (DialogV2) on the target user's screen; waits for a human click.
  - Params: `formula` (required), `prompt?`, `label?`, `timeoutSeconds?` (default 60, max 300), `autoAccept?` (skip dialog, roll now — for GM automation/tests).
  - Returns one of: `{ mode: "rolled"|"auto_rolled", formula, total, result, dice }`, `{ mode: "cancelled"|"timed_out"|"dismissed"|"error", formula, ... }`.
- **`action: "check"`** — system-native skill/ability/save check; dialogs always suppressed. Systems: dnd5e, pf2e, shadowdark, vagabond.
  - Params: `actorId` (required), `checkType` — `"skill"`/`"ability"`/`"save"` (required), `identifier` (system slug: `"ath"` for 5e Athletics, `"athletics"` for PF2e, `"str"` for Shadowdark), `dc?`, `adv?` (`"normal"`/`"advantage"`/`"disadvantage"`; dnd5e + shadowdark only).
- **`action: "itemUse"`** — item combat workflow; dialogs suppressed. Param `phase`: `"full"` (default, recommended: Attack → Hit? → Damage → optional Apply, crit threaded), `"attack"` (roll only), `"damage"` (roll only; caller supplies crit).
  - Params: `actorId`, `itemId` (required), `targetIds?` **[full]** (damage applied on hit), `activityId?` (5e multi-attack items), `adv?`, `isCritical?` **[damage]**.
  - **System scope**: structured results for d20-style systems (dnd5e, pf2e) and **Shadowdark NPCs**. Shadowdark **player characters** have no structured programmatic result — use `use_item` (authentic card) or the `interact` click path instead.
- **`action: "ask"`** — ask the target user a question in a DialogV2. Use it rather than a chat message when you need one structured answer from one player.
  - Params: `question` (required, plain text — escaped), `title?` (default "A question from the GM"), `choices?` (button labels, up to 8, first is default; default `["Yes","No"]`), `freeText?` (adds a text box; default button "Answer"), `timeoutSeconds?` (default 30, max 300 — keep it under ~40, MCP clients give up near 60 s).
  - Returns `{ status: "answered", user, question, choice, index, text? }`, `{ status: "dismissed", ... }` (closed without a button) or `{ status: "timeout", ... }` (the dialog is closed for them).
  - Every outcome is also recorded in that client's event log as kind `"ask"`, so an answer that arrives after the MCP call gave up can be read with `chat {action:"events", kind:"ask", targetUser:<same user>}`.
  - Title and labels are set by Foundry with `innerText`, so they are passed raw (pre-escaping would show `&amp;`); only the question goes into HTML.
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
**The power tool.** Runs arbitrary JavaScript in the Foundry client context. The `expression` you pass becomes the body of an async function with `game`, `canvas`, `ui` in scope. Use `return` to send a value back. **Present by default; absent when `FOUNDRY_MCP_ALLOW_EVAL=0`.**

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

**`target: "cdp"`** — a DOM element captured via Chrome DevTools Protocol (**pixel-perfect** — the browser's actual composited output; no html2canvas approximations). `selector` (CSS, required), `scale?` (default 2.0), `format?` (default png), `quality?`. Requires a debuggable Chromium on port 9223 or 9222 that is logged in as the routed client (`targetUser`, GM by default); errors if none matches.

### `record_video`
Record a video of the Foundry game viewport using CDP screencast + ffmpeg. Captures whatever is visible in the observer Chrome (port 9223, 60fps GPU); falls back to the bridge Chromium (9222). Requires a Chrome target that produces continuous frames — headless bridge tabs produce none.

- **Params**: `duration` (required, 1–60, default 10), `fps?` (1–30, default 10), `quality?` (1–100, default 85), `maxWidth?` (default 1280), `maxHeight?` (default 720), `output?`.
- **Returns**: `Video recorded: <path> — N frames, X.X MB` or `Recording failed: <reason>`.

### `render_fixture` (server-local; present when a design harness is installed)
Render a **design-harness fixture** to a PNG in a Foundry v14 window frame with **no world running** — core CSS, the game system's CSS and a module's stylesheets — and return the harness's layout check alongside the image. This is the offline design-review loop for any module checkout; `screenshot` is its live-world counterpart.

Registers only when a design harness exists on the server host (default `~/git/shadowdark-enhancer/tools/design-harness`; override with `FOUNDRY_DESIGN_HARNESS`). Needs `chromium` (or `google-chrome`) on the host.

- **Params**:
  - `fixture?` — fixture file name (no `.mjs`) under `<module>/tools/design-harness/fixtures/`. **Omit it to discover**: the reply lists the module's fixtures and other sibling checkouts that have a harness.
  - `fixtures?` — **several fixtures in one call** (2–8; use instead of `fixture`), e.g. a window's variants. Each is rendered per theme — and compared, with `against` — then every head render (and diff) comes back cropped to the window, with a one-line summary per variant (`clean | 5 px changed ...`). One **self-contained HTML gallery** is also written on the server host (`~/.cache/foundry-mcp/design-gallery/`, override `FOUNDRY_MCP_GALLERY_DIR`, newest 10 kept) with base / head / diff and the layout check for every variant and theme; the reply gives its path — open it from disk. All variants are validated before any render starts.
  - `module?` — **absolute** path to a module checkout root to render; default: the harness's own module.
  - `state?` — named fixture state (for fixtures with `build(state)`).
  - `against?` — absolute path to a **base** checkout (a PR's base worktree, a release). Renders the fixture from both — `against` is the base, `module` (or the default module) the head — and ends each theme with a verdict: `pixels identical|differ; layout check unchanged|CHANGED` (a CHANGED check shows both). The pixel half decodes both PNGs and counts pixels that moved by more than 8/255 in any channel, so anti-aliasing noise (a checkout compared with itself differs by ±1 on a few corner pixels) reads as identical; real movement reports `N px changed (x%), in a WxH area at x,y`, and a different window size reports `size changed A -> B`. When pixels really moved, a third image per theme (`[theme] diff`) shows the head render dimmed with the changed pixels in red and a yellow box around them, so you can see where the change landed. A fixture the base lacks is reported as new in head; a bad base path errors.
  - `theme?` — `"dark"` (default), `"light"`, or `"both"` (two renders, both images — light is where most design misses happen).
  - `width?` — force the window width in px (e.g. `420`).
- **Returns**: one **image** (PNG) per rendered theme, each preceded by a `[theme]` label (`[theme] base` / `[theme] head` with `against`), plus a text block with the module, theme/width and the per-theme layout check (`visible buttons`, `primary`, overflow/tiny-control problems, and any missing string keys). A failed render says so instead of a junk check (run `shot.mjs` on the host for the stack); a bad fixture or module errors with the available names.

### `write_variant` (server-local; present when a design harness is installed)
Author a **design variant** of an existing harness fixture, then look at it with `render_fixture {fixtures: [base, name]}`. A variant swaps handlebars templates and/or appends CSS; you supply **data, never code** — the fixture's JavaScript is generated by the tool from a fixed template (every value goes through `JSON.stringify`), so no caller-written code reaches the node process that renders it.

Writes are real files in the module checkout, **under `<module>/tools/design-harness/` only**: `fixtures/<name>.mjs` (carries a `// generated by foundry-mcp-live write_variant` first line) and `variants/<name>/*.hbs`. It never overwrites a fixture that lacks that line (a hand-written one), refuses symlinks, and `discard` only deletes what it generated. The files show up in `git status` — discard the variants you do not keep.

- **Params**:
  - `action?` — `"write"` (default) or `"discard"`.
  - `name` — the variant's fixture name (letters, digits, `-`, `_`); new, or a variant this tool generated.
  - `base` — existing fixture to derive from (required for write).
  - `module?` — absolute path to the module checkout; default: the harness's own module.
  - `templates?` — `{ "<template path the base uses>": "<handlebars source>" }`, up to 20, 200 KB each. Keys are the paths the base fixture names (e.g. `templates/crawl-tracker-list.hbs`); use the real template's context shape and `data-action` names.
  - `css?` — CSS appended after the base fixture's styles (200 KB max).
  - `title?`, `width?`, `classes?` — scalar overrides of the window.
- **Returns**: the files written (relative to the module), a warning naming any template key the base fixture does not mention together with the templates it does (a JS-built window mentions none and can only change `css`), and the next call to make.
- **Typical loop**: `write_variant` ×N → `render_fixture {fixtures: ["base", "v1", "v2"], theme: "both", against?: …}` → keep one, `write_variant {action: "discard"}` the rest.

### `preview_fixture` (server-local; present when a design harness is installed)
Open a design-harness fixture as a **real window inside a live Foundry client** — the offline harness replica can disagree with the live cascade (it cannot model the client's unlayered stylesheet re-injection), so this is the look at the truth before a window ships. Renders the fixture's parts plus its own css (proposal fixtures bring the kit), opens (or replaces) one preview window (id `mcp-fixture-preview`), screenshots it back (**CDP real pixels** when a Chrome debugger port answers; an html2canvas fallback — flagged in the reply, and its text baselines are approximate — otherwise), and **leaves it open for inspection**.

- **Params**:
  - `fixture` (required unless `close:true`; omit to list the available ones) — fixture file name (no `.mjs`).
  - `module?` — absolute path to a module checkout root; default: the harness's own module.
  - `state?` — named fixture state.
  - `width?` — override the window width in px; default: the fixture's own width (else 600).
  - `close?` — close the preview window and return instead of opening.
  - `targetUser?` — which connected client shows the preview (GM by default).
- **Returns**: a PNG screenshot of the open window plus a text line (target client, capture method, missing string keys if any). CDP only captures a debugger page logged in as the routed client's user; otherwise the reply says `html2canvas fallback` and why CDP was skipped. A screenshot failure still leaves the window open and says so. Nothing is persisted; no world documents change.
- **How it reaches the client**: the compiled markup and CSS go to the module's `design_preview` handler as **data** — no `evaluate`, so it works with `FOUNDRY_MCP_ALLOW_EVAL=0` and over a relayed client. The markup reaches `DialogV2` as a string, which Foundry runs through `cleanHTML` (no script, no event-handler attributes). It is a transient UI window: no world document is touched, so it is not behind the read-only toggle. **Needs the current `module/` deployed to Foundry** (the install is a copy: copy `module/` to `Data/modules/foundry-mcp-live` and reload the client); a module that predates the handler answers `Unknown tool`, and the server then falls back to driving the same steps through `evaluate` when the eval gate allows it, or says what to deploy.

### `ui_test` (server-local; present when the ui-test harness is installed)
Browser-level **Playwright tests for any Foundry module**, run in a **throwaway Foundry sandbox**, never the live world. The live instance is only read from: its `Config/license.json` is copied and its installed system (and the modules the module under test hard-requires) are staged in.

A sandbox is a second Foundry process from the installed app (`FOUNDRY_APP`, default `~/FoundryV14/app`; node from `FOUNDRY_NODE`, default the server's) with its own dataPath under `tools/ui-test/.cache/sandboxes/sbx-<port>` (gitignored; `FOUNDRY_UI_TEST_CACHE` overrides), its own port in **30700–30799**, **bound to 127.0.0.1**, and one world `ui-test` built offline: `world.json` for the system plus a seeded `core.moduleConfiguration` enabling the module and its required modules. Foundry seeds a passwordless **Gamemaster** on first launch. Packages are staged as symlinks to their top-level entries, except `packs/`, which is copied (Foundry writes into compendium LevelDBs). There is no admin password, so foundry-playwright's setup-screen flows (`useFoundry`, `useBaseWorld`) are not used: isolation is a fresh sandbox per run.

Specs live in the **module repo** at `e2e/*.spec.{mjs,js,ts}` and import the harness:

```js
import { test, expect } from "@foundry-mcp-live/ui-test";
test("sheet renders", async ({ page, foundry }) => {
  await foundry.state.createTestActor("Hero");          // system adapter: shadowdark, dnd5e, pf2e
  await page.evaluate(() => game.actors.getName("Hero").sheet.render(true));
  await expect(page.locator('.window-app .navigation-tab[data-tab="tab-inventory"]')).toBeVisible(); // Shadowdark sheet
});
```

`test` is [foundry-playwright](https://github.com/TheFehr/foundry-playwright)'s (console monitoring, tour suppression, `foundry.state/ui/canvas`) plus an auto fixture that joins as `user` (default `"Gamemaster"`; `test.use({ user: null })` to start on a blank page). Everything foundry-playwright exports is re-exported. A run copies the specs into the harness so they resolve its Playwright; result paths point back at the module checkout. Tests run one at a time (one world, one GM). System state adapters: `shadowdark` (here, `tools/ui-test/adapters/`), `dnd5e` and `pf2e` (from the library); register others in `tools/ui-test/index.mjs`.

Same thing from a shell: `node tools/ui-test/run.mjs --module <dir> [--system <id>] [--grep <re>] [--keep]`.

- **Params**:
  - `action` — `"run"`, `"status"`, `"start"` or `"stop"`.
  - `module?` — [run, start] absolute path to the module checkout.
  - `system?` — [run, start] game system id installed in the live Foundry; default: the module's first `relationships.systems` entry.
  - `grep?` — [run] only tests whose title matches.
  - `sandbox?` — [run] reuse a running sandbox (left running); [stop] the sandbox to stop.
  - `keep?` — [run] leave the sandbox the run started running.
  - `runId?`, `waitMs?` — [status] the run to report, and how long to wait for it (≤ 40000).
- **Returns**: `run` returns `{runId, status: "running"}` at once (the run takes a minute or more; it continues in the background, outliving the MCP call). `status {runId}` returns `{status: "done", ok, passed, failed, skipped, tests: [{title, file, status, durationMs, error?, attachments: [screenshot/trace/error-context paths]}], errors, sandbox}` once finished, else `{status: "running"|"died", logTail}`. `status` with no runId lists sandboxes and the 10 latest runs. `start` returns the sandbox record (`url`, `id`, `dataPath`); `stop` kills it (SIGINT, then SIGKILL) and deletes its dataPath.
- **Install**: `cd tools/ui-test && npm ci`. Browser: `/usr/bin/chromium` when present (`FOUNDRY_CHROME_PATH` overrides), else Playwright's own (`npx playwright install chromium`).

---

## Dice & items

### `roll`
Evaluate a dice formula, or draw from a RollTable. Can **force** specific dice results via `rig`.

- **Params**: `formula` (e.g. `"2d20kh + 5"`, `"(1d8+3)[slashing]"`, `"4d6dl1"`) **or** `table` (RollTable id, exact name, or UUID — compendium tables work), `rig?` (forced face values, consumed in roll order; clamped to each die's faces; queue exhausts to real RNG). **[table]** `displayChat?` (default true; false draws silently), `reset?` (put drawn results back first).
- **Returns** (formula): `{ formula, total, result, dice: [{ faces, results: [{ result, active, discarded }] }], chatMessageId }`.
- **Returns** (table): `{ table: { id, name, uuid }, roll: { formula, total }, results: [{ id, name, description?, type, documentUuid?, img, fromTable? }], remaining, note? }`. Uses the native `RollTable#draw`, so nested (linked) tables are drawn recursively (`fromTable` names the inner table), results are marked drawn when the table has no replacement (`remaining` counts what is left; `null` with replacement), and the chat card is Foundry's own. An empty `results` comes with a `note`: either no range covers the roll or everything is drawn — pass `reset: true`. Respects the per-world read-only toggle (a draw can mark results drawn).
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

### `placeable`
Author scene placeables — walls, lights, sounds, tiles, drawings, regions, map notes — without `evaluate`. Works without a drawn canvas (plain document APIs). Respects the per-world read-only toggle and accepts `audit`.

- **Discriminator**: `action` — `"create"`, `"update"`, `"delete"`, or `"door"`.
- **`type`** — one per call: `"Wall"`, `"AmbientLight"`, `"AmbientSound"`, `"Tile"`, `"Drawing"`, `"Region"`, or `"Note"` (`door` is always Wall). `sceneId?` defaults to the active scene.
- **`create`** — `entries` (1–200), each that document's own data, e.g. Wall `{c:[x1,y1,x2,y2]}` in pixels, Region `{name, shapes:[{type:"rectangle",x,y,width,height}], behaviors:[…]}`, AmbientLight `{x, y, config:{bright, dim}}`. Each created document gets `flags.foundry-mcp-live.createdBy = "placeable"` and `flags.foundry-mcp-live.callId`; the result returns that `callId`.
- **Levels (v14)**: `level?` **[create]** (Level id or name) is applied to entries that have no `levels` of their own. On a scene with more than one Level, an entry with neither is refused: an empty `levels` set puts a placeable on *every* Level, which for a wall means it blocks on every floor. Pass `levels: []` on the entry when that is meant. Single-level scenes are unaffected.
- **`update`** — `entries` (1–200), each `{_id, …fields to change}`; dotted keys (`"config.dim": 30`) work.
- **All-or-nothing**: every entry is validated by Foundry's own data model (a throwaway construction for create, `updateSource` on a clone for update) before anything is written. One bad entry → nothing written, and the error names each bad entry by index.
- **Read-back**: the result's `storedDifferently` lists `{index, id, field, sent, stored}` for every sent field Foundry stored differently — rounded wall coordinates, clamped volumes, and so on. Absent when everything stored as sent. If another module's `preCreate` hook vetoes some documents, the rest are still created and `notCreated` lists the vetoed entries' indexes (`created` counts only what exists) — do not retry the whole call.
- **Plain words on walls** (case-insensitive; CONST numbers also accepted): `door` none/door/secret, `ds` closed/open/locked, `move` none/normal, `sight`/`light`/`sound` none/limited/normal/proximity/distance, `dir` both/left/right.
- **`delete`** — `ids` (1–200), or `createdByMcp: true` for every document of that `type` this tool created, or `callId` for exactly what one create call made — `ids` together with `createdByMcp`/`callId` is refused. `dryRun: true` lists what would go (`{id, label}`) and deletes nothing — use it first. Any unknown id → nothing deleted. Undo with [`changes`](#changes) while it is in the change log.
- **`door`** — `ids` (door walls) + `state` `"open"`/`"closed"`/`"locked"`. A non-door wall in the list → nothing written.
- **Relay**: over the relay, Region `executeScript`/`executeMacro` behaviors (and behavior `system.source` updates) are refused unless the world allows evaluate over the relay — the same stored-code check every relayed write gets.
- **Free text** (Note `text`, Drawing `text`, names) is stored as given; Foundry draws these as plain canvas labels and does not enrich them, so `@UUID`/`[[roll]]` syntax in them is inert.
- **Returns**: `{ sceneId, type, callId, created, ids, notCreated?, storedDifferently? }` / `{ sceneId, type, updated, ids, storedDifferently? }`; delete `{ sceneId, type, deleted, documents }` (dry run `{ dryRun: true, wouldDelete, documents }`); door `{ sceneId, updated, ids, ds }`.
- Check new walls with `query_grid {mode:"collision"}`.

### `stage`
Put things in front of the players during play — the GM staging actions that used to need `evaluate`. Respects the per-world read-only toggle.

- **Discriminator**: `action` — `"showJournal"`, `"shareImage"`, `"pause"`, `"pullToScene"`, or `"playlist"`.
- `users?` (names or ids) limits **showJournal / shareImage / pullToScene** to some players; omit for everyone.
- **`showJournal`** — `journal` (id or name, required), `page?` (id or name), `force?` (default true: shown even to players without permission). Native `Journal.show`. Returns `{ shown: <uuid>, name, users }`.
- **`shareImage`** — `image` (path or URL, required), `title?`, `caption?`. Native `ImagePopout#shareImage` (the GM's own screen does not pop up). Returns `{ shared, users }`.
- **`pause`** — `paused?` (true/false; omit to toggle). `game.togglePause(…, {broadcast: true})`; GM only. Returns `{ paused }`.
- **`pullToScene`** — `scene` (id or name, required). Moves the view of connected players (not the caller) to that scene **without** making it active — the `pullToScene` socket event `Scene#pullUsers` sends. Use `scene {action:"activate"}` instead when everyone should move and the scene should become active. GM only. Returns `{ scene, sceneId, pulled: [names] }`.
- **`playlist`** — `playlist` (id or name, required), `sound?` (one track id or name), `play?` (default true; false stops). `playAll`/`playSound`/`stopAll`/`stopSound`. Returns `{ playlist, sound?, playing: [names] }`.

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