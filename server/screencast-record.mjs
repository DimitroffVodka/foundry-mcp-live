#!/usr/bin/env node
/** Record observer screencast → MP4 */

import { spawn } from 'child_process';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';

const CDP_PORT = parseInt(process.argv[2] || '9223', 10);
const DURATION = parseInt(process.argv[3] || '10', 10);
const OUT = process.argv[4] || `/tmp/observer-recording-${Date.now()}.mp4`;
const FRAMES = '/tmp/cdp-screencast-frames';

async function fetchJson(url) { const r = await fetch(url); return r.json(); }

function wsSend(ws, method, params = {}, id = 1) {
  return new Promise((resolve, reject) => {
    ws.send(JSON.stringify({ id, method, params }));
    const onMsg = (ev) => {
      try { const m = JSON.parse(ev.data); if (m.id === id) { ws.removeEventListener('message', onMsg); m.error ? reject(new Error(m.error.message)) : resolve(m.result); } } catch {}
    };
    ws.addEventListener('message', onMsg);
    setTimeout(() => { ws.removeEventListener('message', onMsg); reject(new Error('timeout')); }, 30000);
  });
}

async function main() {
  const targets = await fetchJson(`http://127.0.0.1:${CDP_PORT}/json`);
  const page = targets.find(t => t.type === 'page' && t.url.startsWith('http'));
  if (!page) { console.error('No page target'); process.exit(1); }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, e) => { ws.addEventListener('open', r); ws.addEventListener('error', e); });

  console.log(`Recording ${DURATION}s from ${page.url}...`);
  rmSync(FRAMES, { recursive: true, force: true });
  mkdirSync(FRAMES, { recursive: true });

  let frames = 0, done = false;

  ws.addEventListener('message', (ev) => {
    if (done) return;
    try {
      const m = JSON.parse(ev.data);
      if (m.method === 'Page.screencastFrame') {
        const seq = String(frames).padStart(5, '0');
        writeFileSync(join(FRAMES, `frame_${seq}.jpg`), Buffer.from(m.params.data, 'base64'));
        frames++;
        ws.send(JSON.stringify({ id: 0, method: 'Page.screencastFrameAck', params: { sessionId: m.params.sessionId } }));
      }
    } catch {}
  });

  // Screencast at 10fps, 720p
  await wsSend(ws, 'Page.startScreencast', {
    format: 'jpeg', quality: 85, maxWidth: 1280, maxHeight: 720, everyNthFrame: 6
  });

  await new Promise(r => setTimeout(r, DURATION * 1000));
  done = true;

  await wsSend(ws, 'Page.stopScreencast');
  ws.close();

  console.log(`Got ${frames} frames`);

  if (frames < 5) { console.error('Too few frames'); process.exit(1); }

  const fps = Math.round(frames / DURATION) || 10;
  console.log(`Encoding ${fps}fps...`);

  const ffmpeg = spawn('ffmpeg', [
    '-y', '-framerate', String(fps),
    '-i', join(FRAMES, 'frame_%05d.jpg'),
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-preset', 'fast', '-crf', '28',
    OUT
  ], { stdio: 'inherit' });

  await new Promise((resolve, reject) => {
    ffmpeg.on('close', (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}`)));
  });

  rmSync(FRAMES, { recursive: true, force: true });
  const { size } = await import('fs/promises').then(fs => fs.stat(OUT));
  console.log(`Done: ${OUT} (${Math.round(size/1024)}KB, ${frames}frames @ ${fps}fps)`);
}

main().catch(e => { console.error(e); process.exit(1); });
