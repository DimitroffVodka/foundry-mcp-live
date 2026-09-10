#!/usr/bin/env node
/**
 * Launch a dedicated observer Chrome for CDP screenshots/recording.
 * Uses hardware GPU, joins Foundry as a player, and exposes CDP on port 9223.
 * Separate from the headless bridge — gives us native resolution, real
 * rendering, and continuous frames for video.
 *
 * Usage: node observer.mjs [--port 9223] [--url http://localhost:30000]
 */

import { spawn } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const CDP_PORT  = parseInt(process.env.OBSERVER_PORT ?? '9223', 10);
const JOIN_URL  = process.env.OBSERVER_URL ?? 'http://localhost:30000/join';
const GAME_URL  = process.env.OBSERVER_URL ?? 'http://localhost:30000';
// Use a temp profile so we don't conflict with the user's normal Chrome
const PROFILE   = process.env.OBSERVER_PROFILE ?? mkdtempSync(join(tmpdir(), 'foundry-observer-'));

async function fetchJson(url) { const r = await fetch(url); return r.json(); }

async function waitForDebugger(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetchJson(`http://127.0.0.1:${CDP_PORT}/json/version`);
      return true;
    } catch { await new Promise(r => setTimeout(r, 300)); }
  }
  throw new Error('Observer Chrome debugger never came up');
}

async function main() {
  console.log(`Observer profile: ${PROFILE}`);
  console.log(`CDP port: ${CDP_PORT}`);
  console.log(`Join URL: ${JOIN_URL}`);

  const args = [
    `--user-data-dir=${PROFILE}`,
    `--remote-debugging-port=${CDP_PORT}`,
    '--remote-debugging-address=127.0.0.1',
    '--no-first-run', '--no-default-browser-check',
    '--no-sandbox',
    '--disable-background-timer-throttling',
    // Keep the window small (offscreen-ish) but not headless — we need GPU
    '--window-size=1280,900',
    '--window-position=9999,9999',  // push it off-screen
    '--disable-features=Translate,MediaRouter',
    '--mute-audio',
    JOIN_URL,
  ];

  console.log('Launching observer Chrome...');
  const child = spawn('google-chrome-stable', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
    env: { ...process.env, DISPLAY: process.env.DISPLAY || ':0' },
  });

  child.stdout?.on('data', d => process.stdout.write(`[chrome] ${d}`));
  child.stderr?.on('data', d => process.stderr.write(`[chrome-err] ${d}`));

  child.on('exit', (code) => {
    console.log(`Observer Chrome exited with code ${code}`);
    try { rmSync(PROFILE, { recursive: true, force: true }); } catch {}
  });

  // Wait for CDP to become available
  await waitForDebugger();
  console.log('Observer Chrome ready — CDP on port', CDP_PORT);

  // Let the user know how to connect
  console.log('');
  console.log('To use in CDP screenshots, set:');
  console.log(`  OBSERVER_WS_URL=http://127.0.0.1:${CDP_PORT}`);
  console.log('');
  console.log('To stop: kill', child.pid);

  // Keep the process alive
  process.on('SIGINT', () => {
    console.log('Shutting down observer...');
    child.kill('SIGTERM');
    setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 2000);
  });

  process.on('SIGTERM', () => {
    child.kill('SIGTERM');
    setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 2000);
  });
}

main().catch(e => { console.error(e); process.exit(1); });
