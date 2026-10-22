// Driven by run.mjs, which sets these env vars; not meant to be run by hand.
import { defineConfig } from "@playwright/test";
import path from "node:path";

const out = process.env.UI_TEST_OUT;

export default defineConfig({
  testDir: process.env.UI_TEST_SPECS,
  testMatch: /.*\.(spec|test)\.(m?js|ts)$/,
  outputDir: path.join(out, "artifacts"),
  // One world, one GM: tests share state, so they run one at a time.
  workers: 1,
  fullyParallel: false,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [["json", { outputFile: path.join(out, "report.json") }], ["list"]],
  use: {
    baseURL: process.env.FOUNDRY_URL,
    viewport: { width: 1600, height: 1000 },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    launchOptions: process.env.UI_TEST_CHROME ? { executablePath: process.env.UI_TEST_CHROME } : {},
  },
});
