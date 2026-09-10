#!/usr/bin/env node
/** Quick CDP screenshot test — connects to bridge Chromium on :9222, opens
 *  an actor sheet, and captures a clipped screenshot of just that element. */

const CDP_PORT = 9222;

async function fetchJson(url) {
  const r = await fetch(url);
  return r.json();
}

function wsSend(ws, method, params = {}, id = 1) {
  return new Promise((resolve, reject) => {
    ws.send(JSON.stringify({ id, method, params }));
    const onMsg = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.id === id) {
          ws.removeEventListener('message', onMsg);
          msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
        }
      } catch {}
    };
    ws.addEventListener('message', onMsg);
    setTimeout(() => { ws.removeEventListener('message', onMsg); reject(new Error('timeout')); }, 15000);
  });
}

async function main() {
  // 1. Find the page target
  const targets = await fetchJson(`http://127.0.0.1:${CDP_PORT}/json`);
  const page = targets.find(t => t.type === 'page' && t.url.startsWith('http'));
  if (!page) { console.error('No page target'); process.exit(1); }
  console.log('Page:', page.url);

  // 2. Connect CDP WebSocket
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', reject); });
  console.log('CDP connected');

  // 3. Open Eliara's sheet
  const sheetId = await wsSend(ws, 'Runtime.evaluate', {
    expression: `(async () => {
      const a = game.actors.getName("Eliara");
      if (!a) return { error: 'Eliara not found' };
      await a.sheet.render({ force: true });
      await new Promise(r => setTimeout(r, 800));
      const el = document.getElementById(a.sheet.id);
      if (!el) return { error: 'sheet element not found' };
      const r = el.getBoundingClientRect();
      return { id: a.sheet.id, x: r.x, y: r.y, w: r.width, h: r.height, vw: window.innerWidth, vh: window.innerHeight };
    })()`,
    returnByValue: true,
    awaitPromise: true
  });
  console.log('Sheet:', JSON.stringify(sheetId.result?.value));

  if (sheetId.result?.value?.error) {
    console.error(sheetId.result.value.error);
    process.exit(1);
  }

  const { x, y, w, h } = sheetId.result.value;

  // 4. Take clipped screenshot
  const result = await wsSend(ws, 'Page.captureScreenshot', {
    format: 'png',
    clip: { x, y, width: w, height: h, scale: 2 },
    captureBeyondViewport: true
  });

  // 5. Write to file
  const fs = await import('fs');
  fs.writeFileSync('/tmp/cdp-screenshot-test.png', Buffer.from(result.data, 'base64'));
  console.log(`Wrote /tmp/cdp-screenshot-test.png (${w}x${h})`);

  ws.close();
}

main().catch(e => { console.error(e); process.exit(1); });
