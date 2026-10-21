import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";

const serverPath = new URL("../server.js", import.meta.url).pathname;

// Puppeteer's launcher adds a SIGTERM listener that closes its browser and
// never exits. The preload stands in for it: with any such listener present,
// the server must still exit on SIGTERM instead of waiting for SIGKILL.
test("server exits on SIGTERM even when another SIGTERM listener exists", { timeout: 20_000 }, async () => {
  const child = spawn(process.execPath, [
    "--import", "data:text/javascript,process.on('SIGTERM', () => {})",
    serverPath,
  ], {
    env: {
      ...process.env,
      FOUNDRY_MCP_PORT: "0",
      FOUNDRY_WS_PORT: "0",
      FOUNDRY_MCP_USAGE: "0",
      FOUNDRY_RELAY_ENABLED: "",
      FOUNDRY_RELAUNCH_AUTO: "",
      BRIDGE_TOKEN: "",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });

  let stderr = "";
  await new Promise((resolve, reject) => {
    child.stderr.on("data", (d) => {
      stderr += d;
      if (stderr.includes("Ready")) resolve();
    });
    child.once("exit", () => reject(new Error(`server exited before ready:\n${stderr}`)));
  });

  const exited = once(child, "exit");
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
  const [code, signal] = await exited;
  clearTimeout(timer);

  assert.equal(signal, null, `server ignored SIGTERM and had to be killed:\n${stderr}`);
  assert.equal(code, 0);
});
