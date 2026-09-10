#!/usr/bin/env node
const CDP_PORT = 9222;
const OUT = '/tmp/cdp-sheet-clean.png';

async function fetchJson(url) { const r = await fetch(url); return r.json(); }
function wsSend(ws, method, params = {}, id = 1) {
  return new Promise((resolve, reject) => {
    ws.send(JSON.stringify({ id, method, params }));
    const onMsg = (ev) => {
      try { const msg = JSON.parse(ev.data); if (msg.id === id) { ws.removeEventListener('message', onMsg); msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result); } } catch {}
    };
    ws.addEventListener('message', onMsg);
    setTimeout(() => { ws.removeEventListener('message', onMsg); reject(new Error('timeout')); }, 15000);
  });
}

async function main() {
  const targets = await fetchJson(`http://127.0.0.1:${CDP_PORT}/json`);
  const page = targets.find(t => t.type === 'page' && t.url.startsWith('http'));
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, e) => { ws.addEventListener('open', r); ws.addEventListener('error', e); });

  // Dismiss error overlays, open sheet, get rect
  const r = await wsSend(ws, 'Runtime.evaluate', {
    expression: `(async () => {
      for (const el of document.querySelectorAll(".notification.error,.notification.warning,#error-display"))
        el.style.display = "none";
      const a = game.actors.getName("Eliara");
      await a.sheet.render({ force: true });
      await new Promise(r => setTimeout(r, 800));
      const sheetEl = document.getElementById(a.sheet.id);
      const rect = sheetEl.getBoundingClientRect();
      return { id: a.sheet.id, x: rect.x, y: rect.y, w: rect.width, h: rect.height };
    })()`,
    returnByValue: true, awaitPromise: true
  });

  const { x, y, w, h } = r.result.value;
  const shot = await wsSend(ws, 'Page.captureScreenshot', {
    format: 'png', clip: { x, y, width: w, height: h, scale: 2 }, captureBeyondViewport: true
  });

  const fs = await import('fs');
  fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
  console.log(`${w}x${h} -> ${OUT}`);
  ws.close();
}

main().catch(e => { console.error(e); process.exit(1); });
