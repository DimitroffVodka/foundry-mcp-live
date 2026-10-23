// Screenshot one fixture from the command line, and print its layout check. No browser pane or MCP needed:
//   node tools/design-harness/shot.mjs <fixture> [out.png] [--w=420] [--h=900] [--state=items] [--theme=light] [--clean=1] [--compare]
// --compare shows <fixture> and <fixture>-proposed together, labelled BEFORE and AFTER.
// Any module: run it from that module's root (or set MODULE_DIR); the fixture is read from its tools/design-harness/fixtures/.
// Starts the server itself if it is not already running. Needs chromium or google-chrome on PATH (or CHROME=...).
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2), flag = (k, d) => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const [name, out = path.join(os.tmpdir(), `${args[0]}.png`)] = args.filter((a) => !a.startsWith("--"));
if (!name) { console.error("usage: shot.mjs <fixture> [out.png] [--w=] [--h=] [--state=] [--theme=]"); process.exit(2); }
const PORT = Number(process.env.PORT ?? 4177), base = `http://127.0.0.1:${PORT}`;
const chrome = process.env.CHROME ?? ["/usr/bin/chromium", "/usr/bin/google-chrome-stable", "/usr/bin/google-chrome"].find(existsSync);
if (!chrome) { console.error("no chromium/google-chrome found; set CHROME=/path/to/browser"); process.exit(2); }

const TOOL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MODULE = path.resolve(process.env.MODULE_DIR ?? process.cwd());
const served = await fetch(base + "/.harness").then((r) => (r.ok ? r.text() : "?")).catch(() => null);
if (served === null) { await import("./serve.mjs"); await new Promise((r) => setTimeout(r, 300)); }
else if (served !== `${TOOL}\n${MODULE}`) { console.error(`port ${PORT} is already served by a different harness or module (${served.replace("\n", ", ")}); stop it or set PORT=`); process.exit(2); }
const q = new URLSearchParams(); for (const k of ["w", "state", "theme", "clean"]) if (flag(k)) q.set(k, flag(k));
const url = args.includes("--compare") ? `${base}/compare/${name}` : `${base}/w/${name}?${q}`, size = `${Number(flag("w", 1000)) + 80},${flag("h", 900)}`;
const run = async (extra) => (await promisify(execFile)(chrome, ["--headless=new", "--no-sandbox", "--disable-gpu", "--hide-scrollbars", `--window-size=${size}`, "--virtual-time-budget=4000", ...extra, url], { encoding: "utf8", maxBuffer: 1 << 26, timeout: 30000 })).stdout;
await run([`--screenshot=${out}`]);
const check = (await run(["--dump-dom"])).match(/<pre id="design-check">([\s\S]*?)<\/pre>/)?.[1] ?? "(no check ran)";
console.log(`${out}\n${check.replace(/&amp;/g, "&").replace(/&lt;/g, "<")}`);
process.exit(0);
