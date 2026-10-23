# Design harness

The engine ships with foundry-mcp-live. A module keeps only its own `tools/design-harness/fixtures/`.
The MCP tools `render_fixture`, `preview_fixture` and `write_variant` run this engine (they appear when chromium and a Foundry install are found; `FOUNDRY_DESIGN_HARNESS` points them at another copy, and `render_fixture` needs a `module`).

Renders a module template in a Foundry v14 window frame (core CSS, the active game system's CSS, the
module's stylesheets), with no world running. For checking how a window looks before it ships.

Runs for any module checkout. Launch it from the module's root (or set `MODULE_DIR`): it reads that
module's `module.json` (id, styles, templates, strings) and its `tools/design-harness/fixtures/`.
The game system comes from the module's first declared system, else shadowdark (`SYSTEM_DIR` overrides):

    cd ~/git/<module> && node <foundry-mcp-live>/tools/design-harness/serve.mjs      # http://127.0.0.1:4177/

- Each file in `fixtures/` is one window: its template, a sample context, its title, classes and width.
  Use the busiest state a GM can reach, not the empty one.
- A fixture can be several screens: `initial`, `build(state)` and `actions` (a `data-action` click goes to
  a state, or toggles between two). Tabs, panels and wizard steps are clickable. Native controls
  (select, checkbox, details) work as they are. A state with several parts (`gm.items.-.lantern`) can be
  edited one part at a time: in an action's `state`, `{tab}` is the clicked element's `data-tab`, `{1}` is
  the current state's second part, and `{icon|3}` is `data-icon` or, without one, the current fourth part.
  A window with several ApplicationV2 parts lists them as `parts` (id + template + context); each part's
  root is stamped `data-application-part`, as the real window does.
  - `/w/<fixture>` dark, `?theme=light`, `?w=420` to force a width. Edit a template or stylesheet and reload.
- The box bottom right counts visible buttons and primary buttons (`button.primary, button.sde-import-primary`,
  or the fixture's own `primary` selector) and lists layout problems
  (content sticking out sideways, text overflowing, tiny controls, sideways scroll), and names any missing
  string keys.
- Paths: `MODULE_DIR` (the module to render; default: the module you run it from, else this checkout),
  `SYSTEM_DIR` (default: the module's declared system, else shadowdark), `FOUNDRY_APP` (default
  `~/FoundryV14/app`), `PORT`.
- A fixture can export `helpers: { name: fn }` for Handlebars helpers its module registers at init (the harness cannot know them); they are registered for that fixture's renders only.
- Not a Foundry: no module JS runs, helpers are stubs, and only the actions a fixture lists respond. A window built only from a template and CSS renders faithfully.

## From any agent (Claude, Hermes, anything with a shell)

Nothing here is tied to one tool. It is a plain node script (no install: it borrows Foundry's own Handlebars)
serving plain HTTP, and fixtures are plain `.mjs` data.

    node <foundry-mcp-live>/tools/design-harness/shot.mjs <fixture> [out.png] [--w=420] [--state=items] [--theme=light]

writes a PNG and prints the layout check, with no browser pane or MCP. It starts the server itself and needs
chromium or google-chrome on PATH (or `CHROME=/path`). An agent that can read images looks at the PNG; one that
cannot still gets the check lines. Or run `node <foundry-mcp-live>/tools/design-harness/serve.mjs` and open the gallery at
http://127.0.0.1:4177/ in any browser.

Windows built in JS (the crawl bar and strip) have no template. Capture their markup from a live world
(`document.querySelector(".shadowdark-enhancer-strip").outerHTML`) into a fixture with an `html` key; see
a module's own `fixtures/` for an example.

The harness caches the helper modules it imports; restart it after editing a fixture helper.

Review galleries and proposal workflows (`<name>-proposed` fixtures, a kit stylesheet) are a module's own business: Shadowdark Enhancer keeps its gallery in its `tools/design-harness/`.
