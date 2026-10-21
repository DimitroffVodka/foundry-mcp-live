# Compendium Content Fixtures via the Foundry CLI — Reference

The official Foundry CLI (`@foundryvtt/foundryvtt-cli`, the `fvtt` binary) **`unpack`s** a module's
binary LevelDB compendium packs into per-entry JSON/YAML source. That one step extends **Layer 1**
(`node:test`) from *code* to *content*: once a pack is plain files, the skill's existing **fixture**
and **contract** patterns apply directly to shipped spells, monsters, roll tables, items, etc.

> This is a **Layer-1 input technique, not a fifth layer.** Unpacking happens once, offline; everything
> after it is ordinary `node:test` running in milliseconds with no client. Frame it that way — the CLI
> *feeds* Layer 1, it does not sit beside Playwright.

## Install / invoke

```sh
npm install -g @foundryvtt/foundryvtt-cli   # gives you the `fvtt` command
# or, no install:
npx @foundryvtt/foundryvtt-cli package unpack ...
```

## Unpacking a pack — the portable gotchas

```sh
# 1. A RUNNING world holds a LevelDB lock on its packs. Never unpack in place —
#    copy the pack directory out first, then unpack the copy.
cp -r /path/to/<world-or-module>/packs/spells /tmp/fvtt-unpack/spells

# 2. --in is the PARENT dir; -n names the pack SUBDIR inside it. --out is the destination.
#    Default output is JSON; add --yaml for YAML.
npx @foundryvtt/foundryvtt-cli package unpack -n spells --in /tmp/fvtt-unpack --out test/fixtures/spells
```

- **Locked LevelDB.** Unpacking a pack that a live world (or another `fvtt` process) has open fails or
  reads a torn state. Copy the pack dir and unpack the copy — that is the single most common trap.
- **`--in` is the parent, `-n` is the pack name.** `--in` points at the directory *containing* the
  pack subdir, not at the pack itself; `-n` selects which subdir. Getting these backwards is the second
  most common trap.
- **JSON by default**, `--yaml` for YAML. Pick one and keep fixtures consistent so diffs stay readable.
- `pack` is the inverse (source → LevelDB) if you ever need to rebuild, but for testing you almost
  always only `unpack`.

## Keep fixtures small: assert metadata, not prose

Tests rarely need a full compendium entry. Project to the fields your logic actually depends on —
names, structure, tiers, formulas, numeric ranges, counts — and strip `system.description`, flavor,
and GM text. Smaller fixtures keep diffs readable and assertions focused, and they stay robust when an
upstream edit rewrites flavor text without changing mechanics.

**Committed vs. local-only.** Commit the metadata projection when you want regression coverage in the
repo. If the unpacked pack is large or you'd rather not vendor a third-party pack, gitignore the raw
fixtures and commit just the **contract test plus a regenerate script** so each developer unpacks their
own copy locally. Note which choice you made at the top of the test.

## Fixture and contract patterns on unpacked content

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

// Metadata-only fixtures: CLI-unpacked entries with description/flavor stripped to keep them small.
const dir = new URL("./fixtures/spells/", import.meta.url);
const spells = readdirSync(dir)
  .filter(f => f.endsWith(".json"))
  .map(f => JSON.parse(readFileSync(new URL(f, dir), "utf8")));

// contract: every entry still carries the fields the module's logic depends on
test("every spell has an integer tier and a known range", () => {
  for (const s of spells) {
    assert.ok(Number.isInteger(s.system?.tier), `${s.name}: missing/!int tier`);
    assert.ok(["Self", "Close", "Near", "Far"].includes(s.system?.range), `${s.name}: bad range`);
  }
});

// fixture: a known-good count freezes "did a content edit or migration drop entries?"
test("spells pack entry count is frozen", () => {
  assert.equal(spells.length, 42);
});
```

A content **contract test** is the early-warning for *content* drift the same way a vendored-bundle
contract test is for *code* drift: a system upgrade that renames `system.range`, or a build that drops
half a pack, fails here loudly instead of degrading silently in play.

## Server/world-level recovery (what a client watchdog can't cover)

The client-crash watchdog in `mcp-live-verification.md` keeps a *browser client* alive — but if the
Foundry **server** is down, or no world is active, there is no client to revive and the bridge can
never connect. Bringing the server itself up with a world active is a separate, server-level lever:

```sh
fvtt launch --world <world-id>      # (or the dedicated server's own --world launch flag)
```

Use this as the outer recovery ring: server/world up (`--world`) → supervised client re-joins → bridge
routes calls. The watchdog handles the inner ring (client crash); this handles the outer ring (server
or world not running).
