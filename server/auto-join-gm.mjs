#!/usr/bin/env node
/** Auto-join observer as Gamemaster */

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
  const targets = await (await fetch('http://127.0.0.1:9223/json')).json();
  const page = targets.find(t => t.type === 'page' && t.url?.startsWith('http'));
  if (!page) { console.error('No page'); process.exit(1); }
  console.log('Current:', page.url);

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, e) => { ws.addEventListener('open', r); ws.addEventListener('error', e); });

  // Select Gamemaster and join
  const result = await wsSend(ws, 'Runtime.evaluate', {
    expression: `(async () => {
      // v13 renders a user dropdown; v14.367 renders a free-text username input.
      const select = document.querySelector("select[name=userid]");
      if (select) {
        const gm = [...select.options].find(o => o.textContent.trim() === "Gamemaster");
        if (!gm) return { error: "Gamemaster not found", users: [...select.options].map(o => o.textContent.trim()) };
        select.value = gm.value;
        select.dispatchEvent(new Event("change", { bubbles: true }));
      } else {
        const nameInput = document.querySelector("input[name=username], input[name=userid]");
        if (!nameInput) return { error: "no user select and no username input" };
        nameInput.value = "Gamemaster";
        nameInput.dispatchEvent(new Event("input", { bubbles: true }));
        nameInput.dispatchEvent(new Event("change", { bubbles: true }));
      }
      // Fill password if needed
      const pw = document.querySelector("input[name=password]");
      if (pw) pw.value = "";
      document.querySelector("button[name=join]")?.click();
      await new Promise(r => setTimeout(r, 3000));
      return { joined: true, url: location.href, gameReady: typeof game !== "undefined" && game?.ready };
    })()`,
    returnByValue: true, awaitPromise: true
  });

  const info = result.result?.value;
  console.log('Join:', JSON.stringify(info));

  if (info?.url?.includes('/join')) {
    // Still on join — try navigating directly
    console.log('Still on join, navigating to /game...');
    await wsSend(ws, 'Page.navigate', { url: 'http://localhost:30000/game' });
    await new Promise(r => setTimeout(r, 5000));
    const state = await wsSend(ws, 'Runtime.evaluate', {
      expression: '({ url: location.href, ready: typeof game!=="undefined" && game?.ready, user: game?.user?.name })',
      returnByValue: true
    });
    console.log('After navigate:', JSON.stringify(state.result?.value));
  }

  ws.close();
}

main().catch(e => { console.error(e); process.exit(1); });
