import test from "node:test";
import assert from "node:assert/strict";

import {
  createRelaunchHandler,
  validateRelaunchConfig,
} from "../lib/client-relauncher.js";

const baseConfig = {
  enabled: true,
  foundryUrl: "http://localhost:30000",
  gmUser: "Gamemaster",
  gmPassword: "secret-value",
  chromePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  userDataDir: "",
  allowRemote: false,
};

test("relaunch config requires explicit safe browser and Foundry settings", () => {
  assert.deepEqual(validateRelaunchConfig({
    ...baseConfig,
    foundryUrl: "http://user:pass@localhost:30000/join",
  }).errors, ["FOUNDRY_RELAUNCH_URL must not contain credentials"]);

  assert.deepEqual(validateRelaunchConfig({
    ...baseConfig,
    foundryUrl: "https://foundry.example.com",
  }).errors, [
    "FOUNDRY_RELAUNCH_URL must use a loopback host unless FOUNDRY_RELAUNCH_ALLOW_REMOTE=1",
  ]);

  const remote = validateRelaunchConfig({
    ...baseConfig,
    foundryUrl: "https://foundry.example.com/game",
    allowRemote: true,
  });
  assert.equal(remote.valid, true);
  assert.equal(remote.origin, "https://foundry.example.com");
  assert.equal(remote.joinUrl, "https://foundry.example.com/join");
});

test("relaunch returns immediately when the configured GM bridge is connected", async () => {
  const bridges = new Map([["gm-id", {
    userId: "gm-id",
    userName: "Gamemaster",
    origin: "http://localhost:30000",
    isGM: true,
  }]]);
  let launches = 0;
  const handler = createRelaunchHandler({
    config: baseConfig,
    bridges,
    launchBrowser: async () => {
      launches += 1;
      throw new Error("must not launch");
    },
  });

  const result = await handler();

  assert.equal(result.ready, true);
  assert.equal(result.alreadyConnected, true);
  assert.equal(result.targetUser, "Gamemaster@localhost:30000");
  assert.equal(launches, 0);
});

// The join page comes in two shapes. v13 renders a <select> of users; v14.367
// renders a free-text username input. This mock's `$` decides which the
// relauncher finds — the previous version of this test hard-coded the v13
// selector and stayed green for months while relaunch was broken on v14, which
// is exactly the failure a mock can produce and a real Foundry cannot.
function makeJoinEnv({ hasUserSelect }) {
  const calls = [];
  const bridges = new Map();
  const page = {
    goto: async (...args) => calls.push(["goto", ...args]),
    waitForSelector: async (...args) => calls.push(["waitForSelector", ...args]),
    $: async (selector) => {
      calls.push(["$", selector]);
      return hasUserSelect ? { handle: selector } : null;
    },
    $eval: async (selector, callback) => callback({
      options: [
        { textContent: "Player1", value: "player-id", disabled: false },
        { textContent: "Gamemaster", value: "gm-id", disabled: false },
      ],
    }),
    select: async (...args) => calls.push(["select", ...args]),
    type: async (...args) => calls.push(["type", ...args]),
    click: async (...args) => calls.push(["click", ...args]),
    waitForNavigation: async (...args) => calls.push(["waitForNavigation", ...args]),
    url: () => "http://localhost:30000/game",
  };
  const browser = {
    newPage: async () => page,
    close: async () => calls.push(["close"]),
    on: () => {},
  };
  let sleeps = 0;
  const handler = createRelaunchHandler({
    config: baseConfig,
    bridges,
    launchBrowser: async options => {
      calls.push(["launch", options]);
      return browser;
    },
    sleep: async () => {
      sleeps += 1;
      if (sleeps === 1) {
        bridges.set("gm-id", {
          userId: "gm-id",
          userName: "Gamemaster",
          origin: "http://localhost:30000",
          isGM: true,
        });
      }
    },
  });
  return { calls, handler };
}

test("relaunch waits for the join form, not for a user dropdown that v14 does not render", async () => {
  const { calls, handler } = makeJoinEnv({ hasUserSelect: false });
  await handler({ timeoutMs: 5_000 });

  assert.deepEqual(
    calls.find(call => call[0] === "waitForSelector")?.[1],
    "#join-game-form",
    "must wait for the form itself — waiting on the v13 <select> hangs on v14"
  );
});

test("v13 join: selects the configured user from the dropdown", async () => {
  const { calls, handler } = makeJoinEnv({ hasUserSelect: true });
  const result = await handler({ timeoutMs: 5_000 });

  assert.equal(result.ready, true);
  assert.equal(result.alreadyConnected, false);
  assert.equal(result.targetUser, "Gamemaster@localhost:30000");
  assert.deepEqual(calls.find(call => call[0] === "select"), [
    "select",
    '#join-game-form select[name="userid"]',
    "gm-id",
  ]);
  assert.deepEqual(calls.filter(call => call[0] === "type"), [
    ["type", '#join-game-form input[name="password"]', "secret-value"],
  ]);
  assert.deepEqual(calls.find(call => call[0] === "click"), [
    "click",
    '#join-game-form button[name="join"]',
  ]);
  assert.equal(JSON.stringify(result).includes("secret-value"), false);
  assert.equal(JSON.stringify(calls[0]).includes("secret-value"), false);
});

test("v14 join: types the configured user into the username field", async () => {
  const { calls, handler } = makeJoinEnv({ hasUserSelect: false });
  const result = await handler({ timeoutMs: 5_000 });

  assert.equal(result.ready, true);
  assert.equal(result.targetUser, "Gamemaster@localhost:30000");
  assert.equal(
    calls.some(call => call[0] === "select"),
    false,
    "must not call page.select on v14 — there is no <select> to select from"
  );
  assert.deepEqual(calls.filter(call => call[0] === "type"), [
    ["type", '#join-game-form input[name="username"]', "Gamemaster"],
    ["type", '#join-game-form input[name="password"]', "secret-value"],
  ]);
  assert.deepEqual(calls.find(call => call[0] === "click"), [
    "click",
    '#join-game-form button[name="join"]',
  ]);
  assert.equal(JSON.stringify(result).includes("secret-value"), false);
});

test("relaunch reports invalid configuration without launching Chrome or exposing passwords", async () => {
  let launches = 0;
  const config = { ...baseConfig, foundryUrl: "https://foundry.example.com" };
  const handler = createRelaunchHandler({
    config,
    bridges: new Map(),
    launchBrowser: async () => {
      launches += 1;
    },
  });

  const result = await handler();

  assert.equal(result.ready, false);
  assert.equal(result.configurationError, true);
  assert.equal(launches, 0);
  assert.equal(JSON.stringify(result).includes("secret-value"), false);
});

test("headless relaunch passes headless:true, pre-seeds noCanvas, and strips animations", async () => {
  const calls = [];
  const bridges = new Map();
  const page = {
    goto: async () => {},
    waitForSelector: async () => {},
    evaluate: async () => { calls.push(["evaluate"]); },          // localStorage noCanvas pre-seed
    $eval: async (selector, callback) => callback({
      options: [{ textContent: "Bridge", value: "bridge-id", disabled: false }],
    }),
    select: async () => {},
    type: async () => {},
    click: async () => {},
    waitForNavigation: async () => {},
    addStyleTag: async arg => { calls.push(["addStyleTag", arg?.content]); },
    url: () => "http://localhost:30000/game",
  };
  const browser = { newPage: async () => page, close: async () => {}, on: () => {} };
  const config = { ...baseConfig, gmUser: "Bridge", gmPassword: "", headless: true };
  const handler = createRelaunchHandler({
    config,
    bridges,
    launchBrowser: async options => { calls.push(["launch", options.headless]); return browser; },
    sleep: async () => {
      bridges.set("bridge-id", {
        userId: "bridge-id",
        userName: "Bridge",
        origin: "http://localhost:30000",
        isGM: true,
      });
    },
  });

  const result = await handler({ timeoutMs: 5_000 });

  assert.equal(result.ready, true);
  assert.equal(calls.find(call => call[0] === "launch")[1], true);   // headless:true
  assert.ok(calls.some(call => call[0] === "evaluate"));             // noCanvas pre-seed ran
  const styleCall = calls.find(call => call[0] === "addStyleTag");
  assert.ok(styleCall && /animation:none/.test(styleCall[1]));       // animations stripped
});
