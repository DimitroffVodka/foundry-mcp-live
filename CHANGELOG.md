# Changelog

All notable changes to Foundry MCP Live are documented in this file.

## [Unreleased]

### Added

- **CI that actually runs the tests.** `.github/workflows/ci.yml` runs the
  `server/test/` suite on push and PR across Node 22 and 24, parse-checks every
  file in `module/scripts/` (they ship to Foundry unbuilt, so a syntax error is
  the only thing that can be statically wrong), and fails if `module.json` and
  `server/package.json` disagree on the version. The suite existed; nothing ran
  it but the author's machine.
- **`LICENSE`.** `module.json` and the README both claimed MIT with no licence
  file in the repo to grant it.
- **Error catalogue for setup failures.** `server/lib/errors.js` defines five
  stable codes (`FML-0001`…`FML-0005`) covering no-GM-bridge, no-bridge-for-user,
  the write gate, bearer-token rejection, and relaunch misconfiguration, each
  with a fix documented in [docs/errors.md](docs/errors.md). Deliberately not a
  general taxonomy — the other ~240 throw sites are internal invariants. The
  codes are for the failures an operator (or the LLM on the other end) has to
  act on, and `test/error-codes.test.js` fails the build if a code and its docs
  section drift apart.
- **End-to-end smoke test against a live Foundry.** `server/e2e/foundry-smoke.mjs`
  joins a real world in a real browser, drives `get_game_info` through the full
  MCP → bridge → game-API chain, and gates on `get_console_errors`: any console
  error naming this module fails the run. That gate is the point — a v14 API
  that moved namespace does not throw, it logs, and the mocked unit suite stays
  green while the module is broken in every real world. `.github/workflows/e2e.yml`
  wires it up but is `workflow_dispatch`-only pending a test-world fixture.

### Fixed

- **`relaunch_client` and the relay gateway were broken on Foundry v14.**
  v14.367 replaced the join page's user `<select>` with a free-text
  `input[name="username"]`; `#join-game-form`, the password field and the
  submit button are unchanged. `client-relauncher.js` waited on
  `select[name="userid"]`, which on v14 never appears — so every relaunch hung
  until timeout — and `relay-gateway.js` silently submitted the form with no
  user set, landing back on `/join` and reporting what looked like a timeout.
  Both now probe for the dropdown and fall back to typing the username, so v13
  and v14 both work.

  Found by the new live smoke test on its first honest run. The unit test could
  not have caught it: `client-relauncher.test.js` asserted the v13 selector
  against a mock that returned whatever it was told, so it stayed green for
  months while the feature did not work on the version `module.json` claims
  `verified: 14`. That test now covers both join shapes, and asserts the
  relauncher waits for the *form* rather than for a dropdown v14 never renders.

  The same stale selector was carried by three more join paths, now fixed the
  same way: `auto-join-gm.mjs`, `auto-join-observer.mjs` (both drive the join
  over CDP) and `prototypes/relay-e2e.mjs`. `relay-e2e.mjs` also anchors on
  `form#join-game-form` before falling back to the first form on the page —
  the join screen has two.

### Changed

- **The E2E workflow now has a world to boot, and runs on push.** The fixture
  is `server/e2e/fixtures/worlds/mcp-smoke` — a `world.json` plus a seeded
  settings record, and nothing else. It is deliberately not a copy of a real
  world: a real one carries world-level compendium packs (third-party module
  content), scene thumbnails generated from copyrighted maps, and its owner's
  journals, chat and accounts. The fixture keeps the *shape* a real Shadowdark
  v14 world declares and none of the content; Foundry initialises the empty
  collections and seeds a default Gamemaster on first launch, which is the
  account the smoke test joins as. The seeded settings record exists because a
  virgin world has every module disabled, so without it no bridge would ever
  connect. The workflow installs the `shadowdark` system from its public,
  pinned GitHub release and launches the world with `FOUNDRY_WORLD`.
- **The smoke test routes its calls to its own client, and proves it.** Two
  separate ways it was green for the wrong reason: it matched a bridge by
  username alone, so a developer's own open world (which also has a
  "Gamemaster") satisfied it; and it then made unrouted tool calls, which the
  server resolves by user name — so `get_game_info` was answered by that other
  world entirely, and the console gate was reading that other world's console.
  It now matches on host as well as name, passes the matched bridge's
  `targetUser` on every call, and asserts the world it gets back is the one
  `/api/status` reports for the Foundry it joined. In CI, with a single
  Foundry, all three would have passed regardless — which is precisely what
  made it worth fixing.
- **`SECURITY.md` now states what leaves the machine.** New "What leaves your
  machine" section: the module makes no outbound requests at all, the server
  makes three (Foundry `/api/status`, local CDP, npm at install time), and the
  usage-telemetry JSONL can contain argument previews of world data — which is
  why it is local and gitignored, and the first file to check before attaching
  a debug bundle to an issue.

- **Merged 54 tools down to ~32 with action-discriminator tools (2026-08-19
  merge pass).** `list` (actors/scenes/modules/tables/compendiums),
  `document` (actor/item/compendium/actorItems), `chat` (send/read),
  `scene_read` (summary/placeables), `token` (details/move/create/update/
  delete/toggleCondition/target/setLevel), `request` (roll/check/itemUse),
  `trace` (hooks/socket/workflow), `snapshot` (take/diff), `interact`
  (click/dialog). `place_measured_template` cut (v14 templates are Regions;
  reachable via `evaluate`). Bridge handlers unchanged — all merges are
  server-side routing. Also fixed a latent gating bug: `list_scenes` was
  registered in both `canvas.js` and the write-gated `world-authoring.js`
  (the gated one won), so scene listing required `FOUNDRY_MCP_ALLOW_WRITE=1`.
  Behavior notes: `token` create is now ungated like its sibling token
  mutations (the per-world read-only toggle still guards it);
  `chat` send is write-gated at call time; the per-routed-tool `targetUser`
  description was shortened (~40 tools × ~250 bytes saved).

### Removed

- **Deleted 14 low-use tools (68 → 54 registered) to cut per-request schema
  context.** Telemetry (13.7k calls, Jun 24–Aug 18) showed these accounted for
  ~25 calls combined: `folder`, `scene_level`, `get_macro`, `list_macros` (zero
  uses) and `get_active_effects`, `get_selected_token`,
  `list_region_behavior_types`, `actor_ownership`, `get_scene_levels`,
  `actor_items`, `list_items`, `list_journals`, `journal`, `region` (1–8 uses).
  Their operations remain reachable via `evaluate`
  (`FOUNDRY_MCP_ALLOW_EVAL=1` is on in this deployment); the module-side
  bridge handlers are unchanged. TOOLS.md, AGENTS.md, and the docs test
  fixture updated to match.

### Fixed

- **v14 deprecation errors when placing/reading measured templates.** Foundry
  v14 merged `MeasuredTemplateDocument` into the Region document, and every
  legacy `MeasuredTemplate` embedded-document operation logged three
  deprecation errors in the console (MeasuredTemplateDocument,
  `CONST.MEASURED_TEMPLATE_TYPES`, `Scene#templates`). `place_measured_template`
  now creates templates the v14-native way (a Region flagged
  `flags.core.MeasuredTemplate`, built through core's own
  `BaseRegion._migrateMeasuredTemplateData`), and `get_scene_placeables`
  reads them back from the Region collection. v13 and below keep the legacy
  collection path. Tool parameters and return shapes are unchanged. (The
  migration's `gridTemplates`/`coneTemplateType` inputs are themselves
  deprecated settings in v14, so the tool uses the migration defaults, which
  match core's.)

## [0.19.0-beta.3] - 2026-08-13

### Fixed

- **Gateway key rotation orphaned every open client.** The gateway mints a new
  keypair on each server restart; clients only loaded the public key when they
  had none, so any client open across a restart kept verifying against the old
  one and silently rejected everything. It carried on heartbeating, so the
  directory reported it healthy while every call to it timed out — which is
  what a whole afternoon of "the device is connected but does not answer"
  actually was. Clients now re-read the published key on a verification failure
  before concluding forgery.
- **The gateway reported itself running after losing its Foundry session.**
  Foundry evicts a user's older session when that user signs in elsewhere,
  sending the gateway page back to the join screen while its Chromium process
  lives on. It now checks for its relay before each use and rejoins itself
  instead of requiring a server restart.
- **The relay directory served stale data on a failed read**, so devices that
  had joined stayed invisible and departed ones looked present. A read failure
  is now reported rather than hidden behind the last good snapshot.
- **Direct bridge is preferred over the relay** when both can reach a target.
  The relay applies its own gates, so silently routing through it changed which
  rules applied to a call.
- **Devices are identified by physical pixels**, not CSS pixels. A Steam Deck at
  devicePixelRatio 0.8 reports 1600x1000 for its 1280x800 panel, so a real Deck
  was labelled a desktop.

### Added

- **Relayed clients announce themselves.** The direct bridge pops a toast on
  connect; the relay showed nothing, so a device that can only ever be relayed
  gave no sign it was working. It now says so on load, and warns distinctly
  when no gateway is running for the world.

## [0.19.0-beta.2] - 2026-08-13

### Fixed

- **Released manifests pointed installers at the wrong version.** `download`
  (and, for a pre-release, `manifest`) were left pointing at
  `releases/latest`. Installing 0.19.0-beta.1 therefore made Foundry fetch the
  *stable* zip and install 0.18.0 — no error, because the manifest genuinely
  told it to. The release workflow now pins `download` to the tag's own asset,
  and pins `manifest` too for pre-releases so a beta cannot resolve itself back
  to an older stable.

## [0.19.0-beta.1] - 2026-08-13

Pre-release. Published as a GitHub pre-release so it stays out of
`releases/latest` and cannot offer itself as an update to anyone on stable.
Install deliberately from its own manifest URL.

### Added

- **Foundry-mediated relay: reach clients the MCP server cannot dial.** The
  direct bridge requires every execution target to be a network peer of the
  server, which a remote device can never be — an https page cannot open
  `ws://` to a private IP, and `localhost` on that device means that device.
  A managed gateway browser on the MCP machine now joins the world as an
  ordinary client and forwards signed requests over Foundry's own
  authenticated socket to a target browser, where the existing handlers run
  unchanged. Nothing is installed on the remote device; no tunnel, no token,
  no firewall rule. Opt in with `FOUNDRY_RELAY_ENABLED=1`.
- **Per-tab client identity.** A desktop and a Steam Deck signed in as the
  same GM share a `userId`, and the direct registry had them silently evict
  each other. Targets are now addressed by `clientId`, with device labels and
  capabilities (including `gamepad`) advertised for routing. A bare shared
  `userName` is refused as ambiguous rather than resolved by guess.
- **`list_connected_bridges` reports relayed clients** alongside direct ones.
- **Relayed `evaluate` is refused** unless a world setting permits it. In a
  relay the receiving browser is the security boundary, not the server, so the
  server's env gate no longer covers that path.

### Security

- Requests are ECDSA-signed and verified against a public key published in a
  world setting — a trustworthy channel precisely because Foundry only lets
  GMs write those. Results are sealed with ECDH+AES-GCM, so a broadcast
  namespace where every client sees every packet cannot leak one client's
  screenshots to another. Keys live in the Node process, never in the gateway
  browser, which runs unattended.
- **Known gap:** per-client keys (GM device pairing) are not implemented, so a
  malicious authenticated client can still forge a *reply*. Not fit for
  worlds with untrusted players until that lands.

### Fixed

- **`wss://` bridge URLs no longer get port 3001 appended.** A page served over
  https cannot open `ws://` to a private IP — mixed content blocks it before a
  packet leaves the browser — so the only route for a remote device (a Steam
  Deck, a tablet) is a TLS proxy: Tailscale Serve, a tunnel, nginx. Those listen
  on 443. Port defaulting is now scheme-aware: `wss://host` stays `wss://host`,
  while bare `host` and `ws://host` still get the bridge's 3001.

- **Document `::` rather than `0.0.0.0` for `FOUNDRY_WS_HOST`.** `0.0.0.0` is
  IPv4-only, so a browser that resolves `localhost` to `::1` finds nothing
  listening and fails with a bare "can't establish a connection". Every
  shell-based check passes, because command-line clients fall back to IPv4 and
  browsers may not — so the bridge looks reachable from the server while a real
  client can't reach it. `::` binds IPv6 and accepts IPv4 via v4-mapped
  addresses, so every address form works regardless of resolver preference.

## [0.18.0] - 2026-08-13

### Added

- **LAN clients: "MCP server address" module setting.** The bridge URL was
  hardcoded to `ws://localhost:3001`, so a second device on the network could
  never connect — its "localhost" is itself, not the machine running the MCP
  server. The URL is now resolved per-connect: blank (the default) derives it
  from the page host when that host is loopback or RFC1918, and falls back to
  `localhost` for public origins, since a hosted Foundry doesn't run your MCP
  server. Client-scoped, so each device sets its own. Accepts `192.168.0.106`,
  `192.168.0.106:3001`, or a full `ws://host:port`.
- **"MCP bridge token" world setting.** The token was previously per-browser
  localStorage, set through devtools — not something you can ask a normal user
  or a player to do, and it had to be repeated on every device. It's now a
  world-scoped setting the GM fills in once; Foundry hands world settings to
  every client that loads the world, so each device authenticates with no setup
  of its own. localStorage is still read as a per-client override, with the
  world setting winning when both are present so a stale hand-set value can't
  lock a client out of a world whose token has since been corrected.
- **`FOUNDRY_WS_TOKEN`** — a bridge-only secret, defaulting to `BRIDGE_TOKEN`.
  Exposing the bridge with `FOUNDRY_WS_HOST` needs auth, but `BRIDGE_TOKEN`
  also puts Bearer auth on `/mcp`, which breaks MCP clients that can't send a
  header (Codex has no per-server header config). Since `/mcp` is bound to
  `127.0.0.1` in code and unreachable off-box anyway, the two are now separable.
- **Startup warning when the bridge is exposed without a token.** Binding
  off-loopback with no `FOUNDRY_WS_TOKEN`/`BRIDGE_TOKEN` lets anything that can
  route to the port register as a GM bridge; the server now says so on boot.
- **Token rejection is visible.** A close with code 1008 (the server's only use
  of it is a token mismatch) now raises a permanent Foundry notification naming
  the `localStorage.mcpBridgeToken` fix, instead of reconnect-looping silently.

- **Tool-usage telemetry.** Every MCP tool call is recorded — to an in-memory
  aggregate served at `GET /api/usage` and to a per-call JSONL log
  (`server/usage-telemetry.jsonl`). A single wrapper at the tool-registration
  chokepoint covers every tool; it captures tool name, ok/error, duration,
  `targetUser`, arg keys, and (for `evaluate`) the truncated body. On by
  default — `FOUNDRY_MCP_USAGE=0` disables it, `FOUNDRY_MCP_USAGE_LOG`
  redirects the log. Local-only: the `/api/usage` aggregate carries no args or
  eval bodies and honors `BRIDGE_TOKEN`.
- **`npm run report` usage report** (`server/scripts/usage-report.mjs`) — reads
  the JSONL and buckets tools into used / never-used / evaluate-share, flags
  never-used tools as merge/cut candidates vs. irreplaceable (Tier-4) vs.
  opt-in infra, and dumps the `evaluate` bodies so calls a dedicated tool
  should have handled are easy to spot. Has a low-sample guard.
- **MCP server `instructions`.** The server now returns orientation guidance in
  the `initialize` handshake, which clients inject into the model's context:
  what the server is, prefer dedicated tools over `evaluate`, the
  action-discriminator tool model, and routing/gates. This is the only guidance
  channel a pure MCP client sees — it never reads AGENTS.md/TOOLS.md.
- **"Auto-connect to MCP server" client setting** (default on). Gates whether an
  interactive client opens the bridge socket on world load; the dedicated
  headless (no-canvas) client always connects regardless. The decision is a
  pure `shouldAutoConnect()` helper.

### Changed

- `evaluate`'s tool description now leads with a "last-resort — prefer a
  dedicated tool" redirect, so the steering reaches clients that don't surface
  server instructions.
- **AGENTS.md** rewritten for the consolidated 67-tool set: pre-consolidation
  tool names replaced with the action-discriminator model and a tool-selection
  policy, the read-only and auto-connect behaviors documented, and a stale
  auto-injected memory block removed.
- **server/TOOLS.md** now documents 11 previously-missing tools
  (`get_actor_items`, `get_scene_placeables`, `get_scene_levels`,
  `set_canvas_level`, `get_settings`, `list_region_behavior_types`,
  `get_debug_snapshot`, `snapshot_actors`, `diff_with`, `call_module_api`,
  `simulate_dialog_response`).

### Fixed

- Token moves over the bridge on Foundry v13+ no longer revert: the move tools
  pass `{ animate: false }` instead of the v12-era `{ animation: { duration: 0 } }`,
  which v13 ignored — animated bridge-driven moves snapped back to origin.

### Internal

- Doc-currency test guards: `docs-tool-names` (AGENTS.md names only registered
  tools) and `docs-tool-coverage` (TOOLS.md documents every tool, no orphans),
  plus unit tests for the telemetry tracker, server instructions, and the
  auto-connect decision.

## [0.17.1] - 2026-06-19

### Fixed

- **Module now loads on Foundry V13 again.** `compatibility.minimum` had been
  raised to `"14"` in v0.11.3, which made Foundry V13 silently drop the package
  at world load — it never registered, so `game.modules.get("foundry-mcp-live")`
  returned `undefined` and the module was invisible despite installing fine in
  The Forge. Lowered `minimum` back to `"13"` (`verified` stays `"14"`).

### Changed

- The five V14-only multi-level-scene tools (`get_scene_levels`,
  `set_canvas_level`, `add_scene_level`, `update_scene_level`,
  `remove_scene_level`) now degrade cleanly on V13 instead of throwing cryptic
  errors: `get_scene_levels` returns a clear "requires v14, single-level world"
  note, and the four mutating tools fail with an explicit
  "requires Foundry v14" message. Everything else is fully supported on V13.
- Server bumped to 0.17.1 in lockstep with the module (no functional server
  change) so the server-version handshake stays quiet after updating.

## [0.17.0] - 2026-06-18

> **Updating the module does NOT update the server.** This release requires
> updating the server too — see [docs/updating-the-server.md](docs/updating-the-server.md).

### Added

- `trace_workflow` tool — preset-driven workflow tracing (snapshot → trace
  hooks → optional trigger → diff) in one call. Presets verified live against
  Midi-QOL v14.0.8 / dnd5e 5.3.3. See [docs/debugging-recipes.md](docs/debugging-recipes.md).
- Server-version handshake: the server reports its version in a `hello-ack`;
  the module warns the GM (toast + dialog with copy-paste update commands and a
  link to the update guide) when the server is older than the module.
- GM-only **"Allow AI to modify the world"** setting — toggles the bridge to
  read-only at runtime with no server restart, within the server's write
  ceiling. `evaluate` remains env-gated.

### Fixed

- Pin `zod` to v3 (`^3.25.76`). zod 4 broke `tools/list` with
  "Cannot read properties of undefined (reading '_zod')", so clients saw zero
  tools.
- Hook-arg serializer now collapses Foundry placeables / PIXI objects to a short
  summary (Midi hook args were dumping the entire token scene-graph).
- `trace_workflow` propagates its window length to the RPC deadline, and its
  Midi damage hooks use the correct v14 names (`isDamaged`/`isHealed`).
- `trace_workflow` Midi presets must be triggered via `use_item` (not
  `request_item_use`, which bypasses Midi) — documented.

### Changed

- **Tool consolidation — BREAKING tool renames, ~96 → ~67 tools.** Same
  capabilities, far fewer entries, to cut LLM context cost and stay under client
  tool-count caps (Cursor ~80). Merged families take an `action`/`target`/
  `phase`/`pathed` discriminator and route to the unchanged Foundry bridge
  handlers (server-side only):
  - `folder`, `actor_write`, `actor_items`, `actor_ownership`, `journal`,
    `scene`, `scene_level`, `region`, `combat` replace their separate
    create/update/delete/activate/etc. tools.
  - `screenshot` (`target`: canvas|dom|scene_grid) replaces screenshot /
    screenshot_dom / capture_scene.
  - `move_token` (`pathed` flag) replaces move_token / move_token_pathed.
  - `request_item_use` (`phase`: full|attack|damage) replaces request_item_use /
    request_attack_roll / request_damage_roll; the `full` phase keeps its
    per-target timeout scaling.
  - Removed redundant `trace_hook` (use `trace_hooks`), `snapshot_actor` /
    `diff_actor` (use `snapshot_actors` / `diff_with`), and the deprecated
    `request_roll_typed` (use `request_check`).

## [0.16.0] - 2026-06-11

### Added

- Background `evaluate` jobs with `job_result` polling and bounded result
  storage.
- `bridge_status` for connection diagnosis without a live Foundry bridge.
- Opt-in `relaunch_client` recovery using a configured local Chrome.
- Guarded `self_test` coverage for Actor, Journal, RollTable, and Scene
  document schema drift.
- Foundry v13/v14 Scene compatibility helpers and automated Node tests.

### Changed

- `evaluate` accepts a 5-180 second server timeout override and returns large
  results through chunkable handles.
- `reload_foundry` includes structured bridge diagnostics when routing or
  reconnecting fails.
- `create_scene` and `update_scene` translate v14 background, texture,
  foreground, level-fog, and fog-exploration fields to Scene Level documents.
- `screenshot` and `capture_scene` flush queued PIXI rendering before capture.
- Bridge hello metadata includes Foundry origin, world, system, and version.
- Server dependencies were refreshed and `puppeteer-core` was added without
  bundling a browser.

### Security

- Client relaunch is disabled by default, restricted to loopback Foundry URLs
  unless explicitly overridden, and accepts passwords only through server
  environment configuration.
- `self_test` requires both write and self-test gates plus `confirm: true`;
  cleanup is restricted to documents carrying the current run flag.
- Background result storage is bounded by TTL, entry count, per-entry size,
  total size, and concurrent job count.

### Verification

- 29 automated tests passed.
- `npm audit` reported zero vulnerabilities.
- Live Foundry 14.363 checks covered a 60-second background evaluation,
  300,059-byte chunked result, v14 Scene field round-trips, guarded self-test
  cleanup, and automated GM client recovery.
