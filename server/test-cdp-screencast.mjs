#!/usr/bin/env node
/** Record N seconds of bridge Chromium screencast → MP4 via ffmpeg */

import { spawn } from 'child_process';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';

const CDP_PORT = 9222;
const DURATION_S = 6;
const OUT = '/tmp/cdp-screencast-test.mp4';
const FRAME_DIR = '/tmp/cdp-screencast-frames';

async function fetchJson(url) { const r = await fetch(url); return r.json(); }

async function main() {
  const targets = await fetchJson(`http://127.0.0.1:${CDP_PORT}/json`);
  const page = targets.find(t => t.type === 'page' && t.url.startsWith('http'));
  if (!page) { console.error('No page target'); process.exit(1); }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, e) => { ws.addEventListener('open', r); ws.addEventListener('error', e); });
  console.log(`Recording ${DURATION_S}s from ${page.url}`);

  rmSync(FRAME_DIR, { recursive: true, force: true });
  mkdirSync(FRAME_DIR, { recursive: true });

  let frames = 0;
  let done = false;

  ws.addEventListener('message', (ev) => {
    if (done) return;
    try {
      const msg = JSON.parse(ev.data);
      if (msg.method === 'Page.screencastFrame') {
        const { data, sessionId } = msg.params;
        const seq = String(frames).padStart(5, '0');
        writeFileSync(join(FRAME_DIR, `frame_${seq}.jpg`), Buffer.from(data, 'base64'));
        frames++;
        ws.send(JSON.stringify({ id: 0, method: 'Page.screencastFrameAck', params: { sessionId } }));
      }
    } catch {}
  });

  // Start screencast — 5fps should work even on throttled headless
  await new Promise((resolve, reject) => {
    const onMsg = (ev) => {
      try { const m = JSON.parse(ev.data); if (m.id === 1) { ws.removeEventListener('message', onMsg); resolve(m); } } catch {}
    };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id: 1, method: 'Page.startScreencast', params: {
      format: 'jpeg', quality: 85, maxWidth: 1280, maxHeight: 720,
    }}));
    setTimeout(() => reject(new Error('startScreencast timeout')), 5000);
  });

  // Wait
  await new Promise(r => setTimeout(r, DURATION_S * 1000));

  // Stop
  done = true;
  await new Promise((resolve) => {
    const onMsg = (ev) => {
      try { const m = JSON.parse(ev.data); if (m.id === 2) { ws.removeEventListener('message', onMsg); resolve(); } } catch {}
    };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id: 2, method: 'Page.stopScreencast' }));
    setTimeout(resolve, 2000);
  });

  ws.close();
  console.log(`Captured ${frames} frames`);

  if (frames < 2) { console.error('Not enough frames'); process.exit(1); }

  // ffmpeg
  const fps = Math.round(frames / DURATION_S) || 5;
  console.log(`Encoding at ${fps}fps...`);
  const ffmpeg = spawn('ffmpeg', [
    '-y', '-framerate', String(fps),
    '-i', join(FRAME_DIR, 'frame_%05d.jpg'),
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-preset', 'fast', '-crf', '28',
    OUT
  ], { stdio: 'inherit' });

  await new Promise((resolve, reject) => {
    ffmpeg.on('close', (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}`)));
  });

  rmSync(FRAME_DIR, { recursive: true, force: true });
  const { size } = await import('fs/promises').then(fs => fs.stat(OUT));
  console.log(`Done: ${OUT} (${(size/1024).toFixed(0)}KB, ${frames}frames, ${fps}fps)`);
}

main().catch(e => { console.error(e); process.exit(1); });
