const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const JOIN_FORM = "#join-game-form";
const USER_SELECT = `${JOIN_FORM} select[name="userid"]`;
// v14.367 replaced the user <select> with a free-text username input. The form
// id, the password field and the submit button are all unchanged, so only the
// user step forks. Probed at join time rather than switched on game version:
// the version is not known until after the page loads, and probing is cheaper
// than being wrong.
const USERNAME_INPUT = `${JOIN_FORM} input[name="username"]`;
const PASSWORD_INPUT = `${JOIN_FORM} input[name="password"]`;
const JOIN_BUTTON = `${JOIN_FORM} button[name="join"]`;

// Headless clients have no GPU → Chromium rasterizes Foundry's WebGL canvas and
// CSS animations on the CPU via SwiftShader (10+ cores). We never need the canvas
// for a bridge client, so a headless relaunch disables it (`core.noCanvas`,
// pre-seeded in localStorage before /game loads) and strips animations.
const NO_ANIM_CSS = "*,*::before,*::after{animation:none!important;transition:none!important}";

function parseFoundryUrl(value) {
  const input = String(value ?? "").trim();
  if (!input) return null;
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `http://${input}`);
  } catch {
    return null;
  }
}

function bridgeMatches(bridge, validation, gmUser) {
  if (!bridge?.isGM || bridge.userName !== gmUser) return false;
  const bridgeUrl = parseFoundryUrl(bridge.origin);
  if (bridgeUrl?.origin === validation.origin) return true;
  return bridge.host === validation.host;
}

function findMatchingBridge(bridges, validation, gmUser) {
  for (const bridge of bridges.values()) {
    if (bridgeMatches(bridge, validation, gmUser)) return bridge;
  }
  return null;
}

function safeError(error, secrets = []) {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of secrets) {
    if (secret) message = message.replaceAll(secret, "[redacted]");
  }
  return message;
}

function clampTimeout(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 30_000;
  return Math.max(5_000, Math.min(120_000, Math.trunc(parsed)));
}

async function defaultLaunchBrowser(options) {
  const puppeteer = await import("puppeteer-core");
  return puppeteer.launch(options);
}

export function validateRelaunchConfig(config) {
  const errors = [];
  const url = parseFoundryUrl(config?.foundryUrl);

  if (!config?.enabled) errors.push("FOUNDRY_RELAUNCH_ENABLED must be set to 1");
  if (!String(config?.chromePath ?? "").trim()) {
    errors.push("FOUNDRY_CHROME_PATH is required");
  }
  if (!String(config?.gmUser ?? "").trim()) {
    errors.push("FOUNDRY_RELAUNCH_GM_USER is required");
  }
  if (!url) {
    errors.push("FOUNDRY_RELAUNCH_URL must be a valid HTTP(S) URL");
  } else {
    if (!["http:", "https:"].includes(url.protocol)) {
      errors.push("FOUNDRY_RELAUNCH_URL must use HTTP or HTTPS");
    }
    if (url.username || url.password) {
      errors.push("FOUNDRY_RELAUNCH_URL must not contain credentials");
    }
    if (!config?.allowRemote && !LOOPBACK_HOSTS.has(url.hostname)) {
      errors.push(
        "FOUNDRY_RELAUNCH_URL must use a loopback host unless "
        + "FOUNDRY_RELAUNCH_ALLOW_REMOTE=1"
      );
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    origin: url?.origin ?? "",
    host: url?.host ?? "",
    joinUrl: url ? new URL("/join", url.origin).toString() : "",
  };
}

export function createRelaunchHandler({
  config,
  bridges,
  launchBrowser = defaultLaunchBrowser,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  diagnose,
}) {
  let managedBrowser = null;
  let inFlight = null;

  async function run({ timeoutMs } = {}) {
    const validation = validateRelaunchConfig(config);
    if (!validation.valid) {
      return {
        ready: false,
        configurationError: true,
        code: "FML-0005",
        errors: validation.errors,
      };
    }

    const existing = findMatchingBridge(bridges, validation, config.gmUser);
    const targetUser = `${config.gmUser}@${validation.host}`;
    if (existing) {
      return {
        ready: true,
        alreadyConnected: true,
        targetUser,
        origin: validation.origin,
      };
    }

    const boundedTimeout = clampTimeout(timeoutMs);
    const startedAt = Date.now();
    let browser = null;
    let page = null;
    let submitted = false;

    try {
      if (managedBrowser) {
        try { await managedBrowser.close(); } catch { /* stale browser */ }
        managedBrowser = null;
      }

      const launchOptions = {
        executablePath: config.chromePath,
        headless: !!config.headless,
        defaultViewport: null,
        args: [
          "--disable-background-timer-throttling",
          "--disable-backgrounding-occluded-windows",
          "--disable-renderer-backgrounding",
        ],
      };
      if (config.userDataDir) launchOptions.userDataDir = config.userDataDir;

      browser = await launchBrowser(launchOptions);
      managedBrowser = browser;
      browser.on?.("disconnected", () => {
        if (managedBrowser === browser) managedBrowser = null;
      });

      page = await browser.newPage();
      const pageTimeout = Math.min(boundedTimeout, 30_000);
      await page.goto(validation.joinUrl, {
        waitUntil: "domcontentloaded",
        timeout: pageTimeout,
      });
      await page.waitForSelector(JOIN_FORM, { timeout: pageTimeout });

      if (config.headless) {
        // On the /join page (same origin) — seed the client-scoped "disable
        // canvas" setting so the upcoming /game load skips the canvas entirely.
        // Best-effort: a tuning optimization, never a correctness requirement.
        try {
          await page.evaluate(() => {
            try { localStorage.setItem("core.noCanvas", "true"); } catch { /* ignore */ }
          });
        } catch { /* page may lack evaluate in tests / hardened pages */ }
      }

      // v13 offers a dropdown of users, which lets us validate the configured
      // name up front. v14 offers a free-text field, where a wrong name can
      // only fail at submit — the bridge simply never appears and the wait
      // below times out.
      const legacySelect = typeof page.$ === "function" ? await page.$(USER_SELECT) : null;
      if (legacySelect) {
        const users = await page.$eval(USER_SELECT, select =>
          Array.from(select.options).map(option => ({
            text: option.textContent.trim(),
            value: option.value,
            disabled: option.disabled,
          }))
        );
        const gm = users.find(user => user.text === config.gmUser);
        if (!gm) {
          throw new Error(`Configured GM user "${config.gmUser}" is not present on the join page`);
        }
        if (gm.disabled) {
          throw new Error(
            `Configured GM user "${config.gmUser}" is disabled on the join page`
          );
        }

        await page.select(USER_SELECT, gm.value);
      } else {
        await page.type(USERNAME_INPUT, config.gmUser);
      }
      if (config.gmPassword) {
        await page.type(PASSWORD_INPUT, config.gmPassword);
      }

      const [navigation, click] = await Promise.allSettled([
        page.waitForNavigation({
          waitUntil: "domcontentloaded",
          timeout: Math.min(boundedTimeout, 15_000),
        }),
        page.click(JOIN_BUTTON),
      ]);
      if (click.status === "rejected") throw click.reason;
      submitted = true;

      const deadline = startedAt + boundedTimeout;
      while (Date.now() < deadline) {
        const connected = findMatchingBridge(bridges, validation, config.gmUser);
        if (connected) {
          if (config.headless) {
            // Bridge is up on /game — strip CSS animations so software-WebGL
            // compositing doesn't spin. Best-effort.
            try { await page.addStyleTag({ content: NO_ANIM_CSS }); }
            catch { /* page may lack addStyleTag in tests */ }
          }
          return {
            ready: true,
            alreadyConnected: false,
            launched: true,
            targetUser,
            origin: validation.origin,
            durationMs: Date.now() - startedAt,
          };
        }
        await sleep(250);
      }

      const result = {
        ready: false,
        launched: true,
        targetUser,
        origin: validation.origin,
        currentUrl: page.url(),
        error: `Timed out after ${boundedTimeout}ms waiting for the configured GM bridge`,
      };
      if (diagnose) result.diagnosis = await diagnose();
      return result;
    } catch (error) {
      if (!submitted && browser) {
        try { await browser.close(); } catch { /* best-effort cleanup */ }
        if (managedBrowser === browser) managedBrowser = null;
      }
      const result = {
        ready: false,
        launched: !!browser,
        targetUser,
        origin: validation.origin,
        error: safeError(error, [config.gmPassword]),
      };
      if (diagnose) result.diagnosis = await diagnose();
      return result;
    }
  }

  return async params => {
    if (inFlight) return inFlight;
    inFlight = run(params);
    try {
      return await inFlight;
    } finally {
      inFlight = null;
    }
  };
}
