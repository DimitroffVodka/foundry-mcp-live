#!/usr/bin/env node
/**
 * Regenerate the fixture world's `data/settings` LevelDB.
 *
 * A world created from a bare `world.json` has every module disabled, so
 * without this the bridge never connects and the smoke test fails for a reason
 * that has nothing to do with the code under test. Module activation is a
 * single settings record, so this writes exactly that record and nothing else.
 *
 * The generated database is committed alongside `world.json` — it is a few KB
 * and contains one key — but this script is what lets you change or inspect it
 * instead of treating those bytes as magic.
 *
 * Uses the `classic-level` bundled with Foundry itself, so it needs no new
 * dependency in server/package.json. Point FOUNDRY_APP at your install if it
 * is not in the usual place.
 *
 *   node seed-settings.mjs worlds/mcp-smoke
 *   FOUNDRY_APP=/opt/foundry/resources/app node seed-settings.mjs worlds/mcp-smoke
 *
 * Afterwards, delete the runtime artefacts LevelDB leaves behind — `LOCK`,
 * `LOG`, `LOG.old` are recreated on every open and should not be committed.
 */
import { createRequire } from "node:module";
import { rm, mkdir, access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

const CANDIDATES = [
  process.env.FOUNDRY_APP,
  join(homedir(), "FoundryV14", "app"),
  join(homedir(), "foundryvtt", "resources", "app"),
  "/opt/foundryvtt/resources/app",
].filter(Boolean);

async function findClassicLevel() {
  for (const app of CANDIDATES) {
    try {
      await access(join(app, "node_modules", "classic-level"));
      return createRequire(join(app, "/"))("classic-level");
    } catch { /* try the next one */ }
  }
  // Last resort: a locally installed copy.
  try { return createRequire(import.meta.url)("classic-level"); } catch { /* fall through */ }
  throw new Error(
    "Could not find classic-level. It ships with Foundry — set FOUNDRY_APP to your "
    + `install's app directory. Tried: ${CANDIDATES.join(", ")}`
  );
}

const worldDir = process.argv[2];
if (!worldDir) {
  console.error("usage: node seed-settings.mjs <path-to-world-dir>");
  process.exit(1);
}

// Fixed rather than random: a fixture that regenerates to identical bytes is
// one you can diff, and a churning id would make every refresh a noisy commit.
const SETTING_ID = "mcpsmokecfg00001";
const MODULE_ID = "foundry-mcp-live";

const { ClassicLevel } = await findClassicLevel();
const settingsDir = resolve(worldDir, "data", "settings");
await rm(settingsDir, { recursive: true, force: true });
await mkdir(settingsDir, { recursive: true });

const db = new ClassicLevel(settingsDir, { keyEncoding: "utf8", valueEncoding: "utf8" });
await db.open();

// Foundry stores the module map as a JSON *string* inside the record's value.
const record = {
  _id: SETTING_ID,
  key: "core.moduleConfiguration",
  value: JSON.stringify({ [MODULE_ID]: true }),
};
await db.put(`!settings!${SETTING_ID}`, JSON.stringify(record));
await db.close();

console.log(`seeded ${settingsDir}`);
console.log(`  !settings!${SETTING_ID} -> ${JSON.stringify(record)}`);
console.log("now remove LOCK, LOG and LOG.old before committing");
