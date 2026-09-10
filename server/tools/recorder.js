/**
 * Video recording tool — wraps CDP screencast + ffmpeg encoding.
 * Records the observer Chrome (port 9223) or falls back to bridge (9222).
 */

import { spawn } from "child_process";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const PORTS = [9223, 9222];
const FRAMES_DIR = join(tmpdir(), "mcp-screencast-frames");

async function fetchJson(url) { const r = await fetch(url); return r.json(); }

function wsSend(ws, method, params = {}, id = 1, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    ws.send(JSON.stringify({ id, method, params }));
    const onMsg = (ev) => {
      try { const m = JSON.parse(ev.data); if (m.id === id) { ws.removeEventListener("message", onMsg); m.error ? reject(new Error(m.error.message)) : resolve(m.result); } } catch {}
    };
    ws.addEventListener("message", onMsg);
    setTimeout(() => { ws.removeEventListener("message", onMsg); reject(new Error("timeout")); }, timeoutMs);
  });
}

async function getPageWs() {
  for (const port of PORTS) {
    try {
      const targets = await fetchJson(`http://127.0.0.1:${port}/json`);
      const page = targets.find(t => t.type === "page" && t.url?.startsWith("http://"));
      if (!page) continue;
      const ws = new WebSocket(page.webSocketDebuggerUrl);
      await new Promise((r, e) => { ws.addEventListener("open", r); ws.addEventListener("error", e); });
      return { ws, port };
    } catch { /* try next port */ }
  }
  throw new Error("No CDP target found on ports " + PORTS.join(" or "));
}

/**
 * @param {object} params
 * @param {number} params.duration - Recording duration in seconds (1-60)
 * @param {number} [params.fps=10] - Target frames per second
 * @param {number} [params.quality=85] - JPEG quality (1-100)
 * @param {number} [params.maxWidth=1280]
 * @param {number} [params.maxHeight=720]
 * @returns {{ videoPath: string, frames: number, duration: number, size: number }}
 */
export async function recordVideo(params = {}) {
  const duration = Math.min(Math.max(params.duration ?? 10, 1), 60);
  const fps      = Math.min(Math.max(params.fps ?? 10, 1), 30);
  const quality  = Math.min(Math.max(params.quality ?? 85, 1), 100);
  const maxW     = params.maxWidth ?? 1280;
  const maxH     = params.maxHeight ?? 720;
  const outPath  = params.output || join(tmpdir(), `foundry-recording-${Date.now()}.mp4`);

  const { ws, port } = await getPageWs();

  rmSync(FRAMES_DIR, { recursive: true, force: true });
  mkdirSync(FRAMES_DIR, { recursive: true });

  let frames = 0;
  let done = false;

  ws.addEventListener("message", (ev) => {
    if (done) return;
    try {
      const m = JSON.parse(ev.data);
      if (m.method === "Page.screencastFrame") {
        const seq = String(frames).padStart(5, "0");
        writeFileSync(join(FRAMES_DIR, `frame_${seq}.jpg`), Buffer.from(m.params.data, "base64"));
        frames++;
        ws.send(JSON.stringify({ id: 0, method: "Page.screencastFrameAck", params: { sessionId: m.params.sessionId } }));
      }
    } catch {}
  });

  // everyNthFrame: target ~fps from assumed 60fps source
  const everyNth = Math.max(1, Math.round(60 / fps));
  await wsSend(ws, "Page.startScreencast", {
    format: "jpeg", quality, maxWidth: maxW, maxHeight: maxH, everyNthFrame: everyNth,
  });

  await new Promise(r => setTimeout(r, duration * 1000));
  done = true;

  await wsSend(ws, "Page.stopScreencast");
  ws.close();

  if (frames < 3) {
    rmSync(FRAMES_DIR, { recursive: true, force: true });
    return { error: `Only ${frames} frames captured — CDP target may be idle. Ensure an observer Chrome is running on port 9223 or 9222.` };
  }

  const actualFps = Math.round(frames / duration) || fps;

  // Encode with ffmpeg
  await new Promise((resolve, reject) => {
    const ffmpeg = spawn("ffmpeg", [
      "-y", "-framerate", String(actualFps),
      "-i", join(FRAMES_DIR, "frame_%05d.jpg"),
      "-c:v", "libx264", "-pix_fmt", "yuv420p",
      "-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2",  // ensure even dimensions for x264
      "-preset", "fast", "-crf", "28",
      outPath,
    ], { stdio: "pipe" });

    let stderr = "";
    ffmpeg.stderr.on("data", d => stderr += String(d));

    ffmpeg.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(-500)}`));
    });
    ffmpeg.on("error", reject);
  });

  rmSync(FRAMES_DIR, { recursive: true, force: true });

  const { size } = await import("fs/promises").then(fs => fs.stat(outPath));

  return {
    videoPath: outPath,
    frames,
    duration,
    fps: actualFps,
    size,
    port,
  };
}

// --- MCP tool registration ---
import { z } from "zod";
import { registerRawTool } from "./_helpers.js";

export function registerRecorderTools(mcp) {
  registerRawTool(mcp, "record_video",
    "Record a video of the Foundry game viewport using CDP screencast. "
    + "The recording captures whatever is visible in the observer Chrome "
    + "(port 9223, 60fps GPU) or falls back to the bridge Chromium (9222). "
    + "Returns the video file path, frame count, and file size. "
    + "Maximum duration: 60 seconds.",
    {
      duration:  z.number().describe("Recording duration in seconds (1–60). Default 10."),
      fps:       z.number().optional().describe("Target frames per second (1–30). Default 10."),
      quality:   z.number().optional().describe("JPEG quality 1–100. Default 85."),
      maxWidth:  z.number().optional().describe("Max frame width. Default 1280."),
      maxHeight: z.number().optional().describe("Max frame height. Default 720."),
      output:    z.string().optional().describe("Output file path. Default: temp dir with timestamp."),
    },
    async (p) => {
      const result = await recordVideo(p);
      if (result.error) return { content: [{ type: "text", text: `Recording failed: ${result.error}` }] };
      const sizeMB = (result.size / (1024 * 1024)).toFixed(1);
      return {
        content: [{ type: "text", text:
          `Video recorded: ${result.videoPath}\n`
          + `${result.frames} frames @ ${result.fps}fps, ${result.duration}s, ${sizeMB} MB\n`
          + `Source: CDP port ${result.port}`
        }],
      };
    });
}
