#!/usr/bin/env node
import { writeFileSync } from 'fs';

const CDP_PORT = 9223;
const JOIN_URL = 'http://localhost:30000/join';

async function fetchJson(url) { const r = await fetch(url); return r.json(); }

function wsSend(ws, method, params = {}, id = 1) {
  return new Promise((resolve, reject) => {
    ws.send(JSON.stringify({ id, method, params }));
    const onMsg = (ev) => {
      try { const m = JSON.parse(ev.data); if (m.id === id) { ws.removeEventListener('message', onMsg); m.error ? reject(new Error(m.error.message)) : resolve(m.result); } } catch {}
    };
    ws.addEventListener('message', onMsg);
    setTimeout(() => { ws.removeEventListener('message', onMsg); reject(new Error('timeout')); }, 15000);
  });
}

async function main() {
  const targets = await fetchJson(`http://127.0.0.1:${CDP_PORT}/json`);
  const page = targets.find(t => t.type === 'page' && t.url?.startsWith('http'));
  if (!page) { console.error('No page target'); process.exit(1); }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, e) => { ws.addEventListener('open', r); ws.addEventListener('error', e); });
  console.log('Connected to observer page:', page.url);

  // Join as Bridge user
  const result = await wsSend(ws, 'Runtime.evaluate', {
    expression: `(async () => {
      // v13 renders a user dropdown; v14.367 renders a free-text username input.
      const select = document.querySelector("select[name=userid]");
      if (select) {
        const bridgeOpt = [...select.options].find(o => o.textContent.trim() === "Bridge");
        if (!bridgeOpt) return { error: "Bridge not found", users: [...select.options].map(o => o.textContent.trim()) };
        select.value = bridgeOpt.value;
        select.dispatchEvent(new Event("change", { bubbles: true }));
      } else {
        const nameInput = document.querySelector("input[name=username], input[name=userid]");
        if (!nameInput) return { error: "no user select and no username input" };
        nameInput.value = "Bridge";
        nameInput.dispatchEvent(new Event("input", { bubbles: true }));
        nameInput.dispatchEvent(new Event("change", { bubbles: true }));
      }
      document.querySelector("button[name=join]")?.click();
      await new Promise(r => setTimeout(r, 3000));
      return { joined: true, url: location.href };
    })()`,
    returnByValue: true, awaitPromise: true
  });

  console.log('Result:', JSON.stringify(result.result?.value, null, 2));
  ws.close();

  // Navigate to game if still on join
  if (result.result?.value?.url?.includes('/join')) {
    console.log('Still on join page, navigating to /game...');
    const ws2 = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((r, e) => { ws2.addEventListener('open', r); ws2.addEventListener('error', e); });
    await wsSend(ws2, 'Page.navigate', { url: 'http://localhost:30000/game' });
    await new Promise(r => setTimeout(r, 3000));
    ws2.close();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
