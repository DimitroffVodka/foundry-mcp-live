/**
 * CDP-based DOM screenshots — pixel-perfect captures using Chrome DevTools
 * Protocol.  Unlike html2canvas, CDP captures the browser's actual composited
 * output, so form inputs, fonts, and CSS render exactly as the user sees them.
 *
 * Tries the observer Chrome first (port 9223, hardware GPU, full viewport).
 * Falls back to the bridge Chromium (port 9222, headless, smaller viewport).
 * If neither is available the call errors.
 */

const PORTS = [9223, 9222]; // observer first, bridge as fallback

async function fetchJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`CDP fetch ${url}: ${r.status}`);
  return r.json();
}

function cdpSend(ws, method, params = {}, id = 1, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    ws.send(JSON.stringify({ id, method, params }));
    const onMsg = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.id === id) {
          ws.removeEventListener("message", onMsg);
          msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
        }
      } catch { /* ignore non-JSON */ }
    };
    ws.addEventListener("message", onMsg);
    setTimeout(() => {
      ws.removeEventListener("message", onMsg);
      reject(new Error(`CDP timeout: ${method}`));
    }, timeoutMs);
  });
}

async function getPageWs() {
  for (const port of PORTS) {
    try {
      const targets = await fetchJson(`http://127.0.0.1:${port}/json`);
      const page = targets.find(t => t.type === "page" && t.url?.startsWith("http"));
      if (!page) continue;
      const ws = new WebSocket(page.webSocketDebuggerUrl);
      await new Promise((resolve, reject) => {
        ws.addEventListener("open", resolve);
        ws.addEventListener("error", reject);
      });
      return ws;
    } catch {
      // port not available, try next
    }
  }
  throw new Error("No CDP target found on ports " + PORTS.join(" or "));
}

/**
 * Capture a DOM element using CDP Page.captureScreenshot with a clip.
 *
 * @param {string} selector - CSS selector for the target element
 * @param {object} [opts]
 * @param {number} [opts.scale=2] - device pixel ratio for the capture
 * @param {string} [opts.format='png'] - 'png' or 'jpeg'
 * @param {number} [opts.quality] - JPEG quality 0-1
 * @returns {{ image: string, mimeType: string, width: number, height: number,
 *             selector: string, element: { tag, class, id } }}
 */
export async function cdpScreenshot(selector, opts = {}) {
  const scale   = opts.scale   ?? 2;
  const format  = opts.format  ?? "png";
  const quality = opts.quality;
  const mime    = `image/${format}`;

  const ws = await getPageWs();

  try {
    // Dismiss error overlays, open sheet if needed, scroll element into view,
    // and get its bounding rect.  We run this as a single evaluate to avoid
    // extra round-trips.
    const rectResult = await cdpSend(ws, "Runtime.evaluate", {
      expression: `(async () => {
        // Dismiss anything that might cover our target
        for (const el of document.querySelectorAll(".notification.error,.notification.warning,#error-display"))
          el.style.display = "none";

        let el = document.querySelector(${JSON.stringify(selector)});

        // If not found, try opening the sheet for a matching actor
        if (!el) {
          const sel = ${JSON.stringify(selector)};
          const actor = game.actors?.find(a =>
            a.sheet?.id === sel ||
            a.name === sel ||
            (sel.startsWith("#") && a.sheet?.id === sel.slice(1)) ||
            (sel.startsWith("#") && a.name === sel.slice(1))
          );
          if (actor) {
            await actor.sheet.render({ force: true });
            await new Promise(r => setTimeout(r, 800));
            el = document.getElementById(actor.sheet.id);
          }
        }

        if (!el) return { error: "Element not found: ${selector}" };
        el.scrollIntoView({ block: "nearest", inline: "nearest" });
        await new Promise(r => setTimeout(r, 300));
        const r = el.getBoundingClientRect();
        return { tag: el.tagName.toLowerCase(), id: el.id || null,
                 cls: (el.className && typeof el.className === "string")
                      ? el.className.slice(0, 100) : null,
                 x: r.x, y: r.y, w: r.width, h: r.height };
      })()`,
      returnByValue: true,
      awaitPromise: true,
    }, 20000);

    const info = rectResult.result?.value;
    if (!info || info.error) {
      return { error: info?.error ?? "CDP evaluate returned no result" };
    }

    if (info.w <= 0 || info.h <= 0) {
      return { error: `Element has zero dimensions (${info.w}x${info.h})` };
    }

    const clip = { x: info.x, y: info.y, width: info.w, height: info.h, scale };

    const shot = await cdpSend(ws, "Page.captureScreenshot", {
      format,
      ...(quality !== undefined ? { quality } : {}),
      clip,
      captureBeyondViewport: true,
    });

    return {
      image:    shot.data,
      mimeType: mime,
      width:    Math.round(info.w * scale),
      height:   Math.round(info.h * scale),
      selector,
      element:  { tag: info.tag, class: info.cls, id: info.id },
    };
  } finally {
    ws.close();
  }
}
