/**
 * Content fingerprint of the Foundry module tree.
 *
 * module.json's version says what a copy claims to be; this says what it is.
 * A bumped manifest over stale scripts passes every version check — a remote
 * install ran two-month-old scripts unnoticed that way — so the module also
 * reports a SHA-256 over its files, baked into scripts/build-info.js by
 * scripts/stamp-module.mjs, and the server compares it with a hash of its own
 * ../module tree.
 *
 * Node-only (fs, crypto). The browser side never hashes; it sends the baked
 * value.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

// Holds the hash, so it cannot be part of it.
export const BUILD_INFO_PATH = "scripts/build-info.js";

// Hidden paths (.DS_Store, .git/, editor state) are local noise, never shipped.
const excluded =(rel) => rel === BUILD_INFO_PATH || rel.endsWith(".bak")
  || rel.split("/").some(seg => seg.startsWith("."));

// Hashed with CRLF → LF so a core.autocrlf=true checkout matches the LF stamp.
// Keep in step with the eol=lf list in .gitattributes.
const TEXT_FILE = /\.(js|mjs|cjs|json|css|html|hbs|md|txt|svg|yml|yaml)$/i;

/** Every hashed file under `dir`, as sorted POSIX relative paths. */
export function moduleFiles(dir) {
  return readdirSync(dir, { recursive: true })
    .map(rel => String(rel).split(path.sep).join("/"))
    .filter(rel => !excluded(rel) && statSync(path.join(dir, rel)).isFile())
    .sort();
}

/**
 * SHA-256 hex over every file under `dir` except build-info.js, *.bak and
 * hidden paths: for each sorted relative path, the path, a NUL, the byte
 * length, a NUL, then the bytes (text files with CRLF → LF). The length keeps
 * file boundaries unambiguous.
 */
export function hashModuleTree(dir) {
  const h = createHash("sha256");
  for (const rel of moduleFiles(dir)) {
    let bytes = readFileSync(path.join(dir, rel));
    // latin1 round-trips every byte, so only the CRs change.
    if (TEXT_FILE.test(rel)) bytes = Buffer.from(bytes.toString("latin1").replaceAll("\r\n", "\n"), "latin1");
    h.update(`${rel}\0${bytes.length}\0`);
    h.update(bytes);
  }
  return h.digest("hex");
}

/**
 * What bridge_status / list_connected_bridges report for one bridge.
 * Unknown server hash (no module/ next to this server) → nothing to say.
 * A module that sends no hash predates the fingerprint, so it is stale too.
 */
export function moduleFingerprint(clientHash, serverHash) {
  if (!serverHash) return {};
  if (clientHash === serverHash) return { moduleStale: false };
  return { moduleStale: true, moduleHash: clientHash || null, serverModuleHash: serverHash };
}
