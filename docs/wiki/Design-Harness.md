# Design Harness

[← Wiki home](Home)

You can look at a window from your module without opening Foundry. The design
harness renders one of your templates inside a real v14 window frame, using
Foundry's core CSS, your game system's CSS and your module's stylesheets, then
tells you what looks wrong: a button too small to hit, a label running past the
edge, a string that never got a translation. You do not need a world open, or even
a login.

The engine is part of this repo, in `tools/design-harness/`. Your module only
supplies the windows to render, as files in `tools/design-harness/fixtures/`.
There is nothing to install. The harness borrows Handlebars and the stylesheets
from a Foundry install you already have, which is the whole reason it works
without a world.

## What it needs

Three things, all on the machine that runs the MCP server:

- the engine, already here in this repo
- a Chromium
- a Foundry install for the CSS, at `FOUNDRY_APP`, default `~/FoundryV14/app`

Miss any one of them and the three design tools never appear in your client's
tool list. That is why a plain install shows 27 tools and this one shows 30.

The window also needs your game system's stylesheets and templates. The harness
reads them from `SYSTEM_DIR` if you set it, otherwise from
`<FOUNDRY_APP>/../Data/systems/<the system your module declares>`. Images from
other modules come out of `<FOUNDRY_APP>/../Data/modules`.

## Where to find it

| Where | What you get |
|---|---|
| `render_fixture` | One window as a PNG, plus the check. `theme: "both"` renders dark and light; `against` renders a second checkout and compares. |
| `render_fixture { fixtures: [...] }` | Up to eight windows in one call, cropped, plus one HTML gallery you can open from disk and click through. |
| `preview_fixture` | The same window inside your running Foundry client, screenshotted. |
| `write_variant` | A throwaway variant of an existing fixture, to compare before you touch CSS. It can delete it again. |
| `node tools/design-harness/shot.mjs` | One PNG and its check, from a shell, no MCP. |
| `node tools/design-harness/serve.mjs` | A browsable gallery of every fixture at `http://127.0.0.1:4177/`, before/after pairs included. |

## Using it

1. **Point it at your module.** All three tools want `module`, an absolute path
   to a checkout. Leave it out and the reply lists the checkouts that already
   have fixtures, which is usually faster than typing paths. If there is only one
   module you render, set `FOUNDRY_DESIGN_MODULE` and stop passing it.

2. **Pick a window.** Every `.mjs` file in
   `<module>/tools/design-harness/fixtures/` is one window, and the file name is
   what you pass:

   ```js
   render_fixture({ module: "/home/you/git/your-module", fixture: "bastion-panel", theme: "both" })
   ```

   You get an image per theme and a short block of text naming the module, the
   theme and the check. `width: 420` forces the narrow case when the fixture's own
   width is the roomy one.

3. **Read the check.** It is the part people skip and then regret skipping. On a
   good day it says:

   ```
   visible buttons: 13   primary: 1
   no layout problems found
   ```

   On a bad day it names the element and the problem: `sticks out sideways`,
   `text cut off with ...`, `text overflows`, `tiny control` (under 22 by 22
   pixels), `window scrolls sideways`. A `localize` key the dictionaries do not
   define shows up as `missing strings: ...`.

4. **Compare against a base.** `against` takes an absolute path to a second
   checkout, usually a PR's base worktree or the last release:

   ```js
   render_fixture({ module: "/home/you/git/mod-pr", against: "/home/you/git/mod-main", fixture: "party-sheet", theme: "both" })
   ```

   Each theme ends with a verdict, `pixels identical; layout check unchanged` or
   `pixels differ; layout check CHANGED`. When pixels really moved you also get a
   third image with the changes marked. Pointing `against` at the same checkout
   reads `pixels identical`, which is a quick way to prove the wiring works.

5. **Render several at once.** `fixtures: ["base", "v1", "v2"]` checks every name
   before rendering anything, returns each window cropped, and writes one
   self-contained HTML gallery: base, head, diff and check for every variant. The
   path is in the reply; the default folder is
   `~/.cache/foundry-mcp/design-gallery/` and it keeps the newest ten.

6. **Check it in a real client.** The offline frame models Foundry's static page,
   where stylesheets arrive in layers. A running client re-injects the module's
   stylesheet unlayered, so an equal-specificity conflict can resolve the other
   way once the game is open. `preview_fixture` compiles the same markup and opens
   it as a real window (id `mcp-fixture-preview`) through the module's
   `design_preview` handler, then screenshots it: real pixels over CDP when a
   debugger port answers, an `html2canvas` fallback otherwise, flagged as such
   because its text baselines sit low. `targetUser` picks the client. The window
   stays open, so close it with `preview_fixture { close: true }` or its ✕.

7. **Sketch a variant.** `write_variant` derives a fixture from an existing one
   with `templates` (template path to new Handlebars source), `css`, `title`,
   `width` or `classes`. You give it data, not code. The file it writes starts
   with `// generated by foundry-mcp-live write_variant`, stays under
   `<module>/tools/design-harness/`, and never overwrites a fixture you wrote by
   hand. Those are real files in your checkout, so throw away the ones you do not
   keep: `write_variant { action: "discard", name: ... }`.

## A fixture is a window

A fixture says which template to render, what data to feed it, how wide the window
is, and which states it can be clicked through. If a template and a context are
enough, that is all you write. If the window is built in JavaScript, capture its
markup into `html` instead.

| Key | What it does |
|---|---|
| `template`, `context` | The Handlebars template (path inside the module) and the sample data |
| `parts` | Multi-part ApplicationV2 window: `[{ id, template, context }]`. Each part's root gets `data-application-part` |
| `title`, `width`, `height`, `classes`, `icon`, `resizable` | Window chrome |
| `css` | Extra styles for this fixture, added after the module's |
| `html` | Markup instead of a template, for a window built in JS |
| `helpers` | Handlebars helpers your module registers at init and the harness cannot know about |
| `build(state)`, `initial`, `actions` | Several screens in one fixture. `actions` maps a `data-action` click to a state, `{tab}` and `{1}` fill from the element and the current state, `{ toggle: [...] }` flips between two |
| `primary` | Which selector counts as a primary button (default `button.primary, button.sde-import-primary`) |
| `previewHeight`, `compareState` | Gallery iframe height, and the state a `<name>-proposed` fixture opens at |

Pick the busiest state a GM can reach. An empty window always looks fine. State is
addressable from the browser too: `/w/<fixture>?state=items&theme=light&w=420`.

## Running it from a shell

The same engine runs without MCP, which helps when you live in a terminal or the
agent cannot see images. Start from the module's folder:

```bash
cd ~/git/your-module
node ~/git/foundry-mcp-live/tools/design-harness/serve.mjs     # gallery at http://127.0.0.1:4177/
node ~/git/foundry-mcp-live/tools/design-harness/shot.mjs bastion-panel out.png --theme=light --w=420
```

`serve.mjs` renders the module you run it in, or `MODULE_DIR`. Run it anywhere
else and it stops with `no module.json with an id in <dir>`, because the engine is
not itself a module. `shot.mjs` starts its own server, writes the PNG and prints
the check. If another harness already holds the port it refuses to reuse it unless
that server reports the same engine and module, so two checkouts cannot quietly
render each other's windows; set `PORT=` to run both. `--compare` puts `<fixture>`
and `<fixture>-proposed` side by side as BEFORE and AFTER.

## Hosted Foundry, or a remote server

None of this talks to Foundry over the network. The render reads files: a Foundry
application install, the game system's folder, and your module checkout. That is
the trick, and it is also the gotcha. A hosted Forge world changes nothing about
rendering, because the world is never contacted. An account that only ever used
Forge, though, has no application files on disk, and then the tools do not appear
at all.

What has to be on the machine running the MCP server:

- the engine, already there
- a Chromium, or `CHROME` pointing at one
- Foundry application files at `FOUNDRY_APP`, default `~/FoundryV14/app`. The
  check is crude: no `public/` folder, no tools.
- the game system's CSS and templates, from `SYSTEM_DIR` or
  `<FOUNDRY_APP>/../Data/systems/<system>`
- optionally, other modules' images from `<FOUNDRY_APP>/../Data/modules`

A wrong `SYSTEM_DIR` is the quiet failure. Nothing errors. You get core CSS only,
a body class named after the folder you pointed at, and a window that looks
nothing like the real one, so a layout you then "fixed" was never broken. The
banner line names what it used: `design harness: http://127.0.0.1:4177/  (module:
..., system: <id>)`. A wrong `FOUNDRY_APP` is the loud one; run the engine by hand
and it dies while loading Handlebars.

A hosted world with the MCP server on your desk needs this: install Foundry at the
version your world runs, point `FOUNDRY_APP` at its app folder, and point
`SYSTEM_DIR` at a local copy of the system your module declares. No token, port or
relay is involved, because nothing is being connected to.

A remote MCP server, on a VPS or a NAS: everything above has to be on that box,
Chromium included, and headless servers rarely have one. The harness binds
`127.0.0.1` only, so there is no port to open. Your browser can be anywhere that
reaches the server and its bridge.

`preview_fixture` is the exception. It opens the window in a connected client, so
it needs the bridge and the current `module/` deployed to that world. On a world
that installs modules from a manifest, the deployed copy is a release, not your
working tree, so the `design_preview` handler has to have shipped. Without it the
tool answers `Unknown tool`. This is the one part of the page I could not test
against a hosted world.

## Settings

Every default here comes from the code.

| Variable | Default | What it changes |
|---|---|---|
| `FOUNDRY_DESIGN_MODULE` | unset | The default `module` for the three tools. Without it, each call has to pass one |
| `FOUNDRY_DESIGN_HARNESS` | this repo's `tools/design-harness` | Run a different copy of the engine |
| `FOUNDRY_APP` | `~/FoundryV14/app` | Foundry install the render reads Handlebars, CSS, fonts and icons from. The tools stay unregistered unless its `public/` exists |
| `CHROME` | first of `/usr/bin/chromium`, `/usr/bin/google-chrome-stable`, `/usr/bin/google-chrome` | Browser the render drives. A path you set but never installed counts as present and fails at render time |
| `FOUNDRY_MCP_GALLERY_DIR` | `~/.cache/foundry-mcp/design-gallery` | Where the multi-variant gallery goes, newest ten kept |
| `MODULE_DIR`, `SYSTEM_DIR`, `PORT` | cwd, the module's declared system (else `shadowdark`), `4177` | Command line only. `PORT` also keeps two renders or a running gallery from colliding |

`CHROME` is not the relaunch tools' `FOUNDRY_CHROME_PATH`. That one drives
`puppeteer-core` for `relaunch_client` and the relay, so it is a different browser
with a different job.

## What it cannot do

No module code runs. Helpers are the harness's own stubs plus whatever a fixture
passes in `helpers`, and only the `data-action` clicks a fixture lists respond.
There is no AppV2 lifecycle and there are no hooks.

The frame is Foundry's static page, with stylesheets in layers. A live client
re-injects the module's stylesheet unlayered, and that is not modelled here, which
is what `preview_fixture` is for.

A fixture for a JS-built window is captured markup, and captured markup goes stale
the moment the window changes.

`preview_fixture` itself was not exercised for this page. It needs a running world
with the current `module/` deployed and a connected client. Everything else here
was run against this repo's engine on a real module.

## When something goes wrong

| What you see | Why | What to do |
|---|---|---|
| The three tools are missing from the client's list | No Chromium, no `FOUNDRY_APP/public`, or `FOUNDRY_DESIGN_HARNESS` points at a folder without `shot.mjs` | Fix whichever is missing. Registration is all or nothing |
| The reply asks for `module` | Neither `module` nor `FOUNDRY_DESIGN_MODULE` is set | Pass the checkout path; the same message lists checkouts that have fixtures |
| `no module.json under <dir>` | That path is not a checkout root | Point at the folder holding `module.json` |
| `no design harness in <dir>` | The checkout has no `tools/design-harness/fixtures` | Make the folder and add a fixture |
| `design harness: no module.json with an id in <dir>` and exit 2 | `serve.mjs` was run from a folder that is not a module | `cd` into the module or set `MODULE_DIR` |
| `no chromium/google-chrome found; set CHROME=/path/to/browser` | No browser on `PATH` | Install one or set `CHROME` |
| `port 4177 is already served by a different harness or module` | Another checkout's harness holds the port | Stop it, or run yours with a different `PORT` |
| `preview_fixture` answers `Unknown tool` | The world runs an older `module/` without the `design_preview` handler | Copy `module/` to Foundry's modules folder and reload the client, or ship a release |

The engine's own notes are in
[tools/design-harness/README.md](https://github.com/DimitroffVodka/foundry-mcp-live/blob/main/tools/design-harness/README.md),
and every argument for every tool is in
[server/TOOLS.md](https://github.com/DimitroffVodka/foundry-mcp-live/blob/main/server/TOOLS.md).
