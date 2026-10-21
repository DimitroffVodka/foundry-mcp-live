#!/usr/bin/env node
/**
 * Deploy module/ into a Foundry modules directory from a freshly staged copy,
 * so an install is never a hand-copied mix of old and new files.
 *
 *   node scripts/deploy-module.mjs <target-dir> [--dev]
 *
 * 1. refuses if module/scripts/build-info.js is stale (run stamp-module.mjs)
 * 2. wipes the staging dir and copies module.json, the directories holding
 *    every file module.json lists, and lib/ — failing if a listed esmodule,
 *    script, style or language file is missing
 * 3. --dev: strips manifest/download and suffixes the version with
 *    -dev.<UTC timestamp>, so Foundry's updater never replaces this copy and
 *    the module list shows which copy is live
 * 4. rsync -a --delete into <target-dir>, then re-hashes the target and fails
 *    unless it matches the staged copy byte for byte
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { hashModuleTree, moduleFiles } from "../server/lib/module-hash.js";
import { checkStamp, MODULE_DIR, readStamp } from "./stamp-module.mjs";

export const DEFAULT_STAGE_DIR = path.join(os.tmpdir(), "foundry-mcp-live-stage");

/** Every file path module.json says Foundry will load. */
function listedFiles(manifest) {
  return [
    ...(manifest.esmodules ?? []),
    ...(manifest.scripts ?? []),
    ...(manifest.styles ?? []),
    ...(manifest.languages ?? []).map(l => l.path),
  ].filter(Boolean);
}

/**
 * rsync --delete wipes whatever is in the target, so only write into an empty
 * or missing dir, or one that already holds this module.
 */
function assertSafeTarget(target, id) {
  if (!existsSync(target) || readdirSync(target).length === 0) return;
  let existingId = null;
  try { existingId = JSON.parse(readFileSync(path.join(target, "module.json"), "utf8")).id; } catch { /* not a module */ }
  if (existingId !== id) {
    throw new Error(`${target} is not empty and is not a "${id}" install (module.json id: ${existingId ?? "none"}). Refusing to rsync --delete into it.`);
  }
}

export function devVersion(version, now = new Date()) {
  return `${version}-dev.${now.toISOString().replace(/[-:T]/g, "").slice(0, 14)}`;
}

/**
 * @returns {{target: string, version: string, stampHash: string, targetHash: string}}
 */
export function deployModule({ target, dev = false, sourceDir = MODULE_DIR, stageDir = DEFAULT_STAGE_DIR, now = new Date() }) {
  if (!target) throw new Error("usage: deploy-module.mjs <target-dir> [--dev]");
  target = path.resolve(target);

  const stale = checkStamp(sourceDir);
  if (stale) throw new Error(`${stale}. Run: node scripts/stamp-module.mjs`);
  const stampHash = readStamp(sourceDir).hash;

  const manifest = JSON.parse(readFileSync(path.join(sourceDir, "module.json"), "utf8"));
  const listed = listedFiles(manifest);
  const missing = listed.filter(rel => !existsSync(path.join(sourceDir, rel)));
  if (missing.length) throw new Error(`module.json lists files that do not exist: ${missing.join(", ")}`);

  assertSafeTarget(target, manifest.id);

  rmSync(stageDir, { recursive: true, force: true });
  mkdirSync(stageDir, { recursive: true });
  // Listed files pull in their siblings (bridge.js imports the rest of scripts/),
  // so ship each listed file's top-level directory whole.
  const roots = new Set(["module.json", "lib", ...listed.map(rel => rel.split("/")[0])]);
  for (const root of roots) {
    const from = path.join(sourceDir, root);
    if (!existsSync(from)) continue;
    // Same exclusions as the hash (bar build-info.js, which must ship).
    cpSync(from, path.join(stageDir, root), { recursive: true, filter: src => !src.endsWith(".bak") && !path.basename(src).startsWith(".") });
  }

  // Anything under module/ the manifest does not reach would never ship; say so
  // rather than deploy a copy that differs from the tree the stamp describes.
  if (hashModuleTree(stageDir) !== stampHash) {
    const shipped = new Set(moduleFiles(stageDir));
    const left = moduleFiles(sourceDir).filter(rel => !shipped.has(rel));
    throw new Error(`staged copy does not match module/; not shipped: ${left.join(", ") || "(none — files changed while staging?)"}`);
  }

  if (dev) {
    delete manifest.manifest;
    delete manifest.download;
    manifest.version = devVersion(manifest.version, now);
    writeFileSync(path.join(stageDir, "module.json"), JSON.stringify(manifest, null, 2) + "\n");
  }
  const stagedHash = hashModuleTree(stageDir);

  mkdirSync(target, { recursive: true });
  execFileSync("rsync", ["-a", "--delete", `${stageDir}/`, `${target}/`], { stdio: "inherit" });

  const targetHash = hashModuleTree(target);
  if (targetHash !== stagedHash) throw new Error(`target hash ${targetHash} does not match staged ${stagedHash}`);
  if (readStamp(target)?.hash !== stampHash) throw new Error(`target build-info.js does not carry stamp ${stampHash}`);
  return { target, version: manifest.version, stampHash, targetHash };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  try {
    const r = deployModule({ target: args.find(a => !a.startsWith("--")), dev: args.includes("--dev") });
    console.log(`deployed ${r.version} to ${r.target}\n  stamp  ${r.stampHash}\n  target ${r.targetHash} (matches staged copy)`);
  } catch (err) {
    console.error(`deploy failed: ${err.message}`);
    process.exit(1);
  }
}
