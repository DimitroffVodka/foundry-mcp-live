import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";

const serverPath = new URL("../server.js", import.meta.url).pathname;

// Puppeteer's launcher adds SIGTERM and SIGHUP listeners that close its browser
// and never exit. The preload stands in for them: with such a listener present,
// the server must still exit on the signal instead of waiting for SIGKILL.
for (const signal of ["SIGTERM", "SIGHUP"]) {
test(`server exits on ${signal} even when another ${signal} listener exists`, { timeout: 20_000 }, async () => {
  const child = spawn(process.execPath, [
    "--import", `data:text/javascript,process.on('${signal}', () => {})`,
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
  child.kill(signal);
  const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
  const [code, exitSignal] = await exited;
  clearTimeout(timer);

  assert.equal(exitSignal, null, `server ignored ${signal} and had to be killed:\n${stderr}`);
  assert.equal(code, 0);
});
}
