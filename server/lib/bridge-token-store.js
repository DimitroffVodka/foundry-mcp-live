/**
 * Where the bridge token comes from when nobody typed one.
 *
 * The token guards the bridge port when FOUNDRY_WS_HOST opens it past
 * loopback. Requiring the operator to produce one by hand — `openssl rand`,
 * an env file, a service restart, then a paste into Foundry — is four terminal
 * steps in a tool whose users install things by clicking "Install Module", and
 * it was the single worst part of connecting a phone or a tablet.
 *
 * So the server makes its own. The value is written once to a file next to the
 * rest of this tool's config and reused on every later start; `bridges.js`
 * hands it to trusted local GM clients over the hello-ack, and the module
 * stores it in the world setting, which Foundry then serves to every other
 * client in that world. Nobody has to see it.
 *
 * Deliberately NOT generated when the bridge is loopback-only: a token buys
 * nothing there (see `isTrustedLocalPeer`), and a secret that exists is a
 * secret that can go stale, leak into a log, or be pasted into the wrong
 * world. The plain local setup stays free of one entirely.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Directory this tool keeps its config in — the same one the install script
 * writes `server.env` to, so a user who goes looking finds both together.
 *
 * @param {object}  [deps]
 * @param {object}  [deps.env]      process.env, injectable for tests
 * @param {string}  [deps.platform] process.platform
 * @param {string}  [deps.home]     os.homedir()
 * @returns {string} absolute path
 */
export function defaultConfigDir({ env = process.env, platform = process.platform, home = homedir() } = {}) {
  if (platform === "win32") {
    return join(env.APPDATA || join(home, "AppData", "Roaming"), "foundry-mcp-live");
  }
  return join(env.XDG_CONFIG_HOME || join(home, ".config"), "foundry-mcp-live");
}

/** Path of the persisted token within a config dir. */
export function bridgeTokenPath(dir) {
  return join(dir, "bridge-token");
}

/**
 * Resolve the token to run with, creating and persisting one if that's what
 * the situation calls for.
 *
 * Precedence:
 *   1. an explicitly configured token (FOUNDRY_WS_TOKEN / BRIDGE_TOKEN) always
 *      wins and is never written to disk — the operator owns that value, and
 *      copying it into a second location just creates a way for the two to
 *      disagree
 *   2. loopback-only bridge → no token at all
 *   3. a previously generated token on disk
 *   4. a fresh one, persisted for next time
 *
 * A file that exists but can't be read or written is not fatal: fall back to
 * an in-memory token so the bridge still comes up, and let the caller log it.
 * The cost is that clients have to re-adopt the token after a restart, which
 * beats refusing to start.
 *
 * @param {object}   [opts]
 * @param {string}   [opts.configured] token from the environment
 * @param {boolean}  [opts.exposed]    true when the bridge binds past loopback
 * @param {string}   [opts.dir]        config dir; defaults to defaultConfigDir()
 * @param {Function} [opts.onNotice]   called with human-readable status lines
 * @returns {{token: string, source: "env"|"none"|"file"|"generated"|"memory", path: string}}
 */
export function loadOrCreateWsToken({ configured = "", exposed = false, dir = defaultConfigDir(), onNotice = () => {} } = {}) {
  const path = bridgeTokenPath(dir);

  const fromEnv = String(configured ?? "").trim();
  if (fromEnv) return { token: fromEnv, source: "env", path };

  if (!exposed) return { token: "", source: "none", path };

  try {
    const existing = readFileSync(path, "utf8").trim();
    if (existing) return { token: existing, source: "file", path };
  } catch { /* not created yet, or unreadable — fall through and make one */ }

  const token = randomBytes(24).toString("hex");
  try {
    mkdirSync(dir, { recursive: true });
    // 0600: the token is equivalent to GM access on this world. Windows
    // ignores the mode, which is why this is defense in depth rather than the
    // only thing standing between the file and another local user.
    writeFileSync(path, `${token}\n`, { mode: 0o600 });
    onNotice(`Generated a bridge token for off-loopback clients → ${path}`);
    return { token, source: "generated", path };
  } catch (err) {
    onNotice(`WARNING: could not persist the bridge token to ${path} (${err?.message || err}). `
      + `Using a temporary one — clients will need to re-adopt it after every restart.`);
    return { token, source: "memory", path };
  }
}
