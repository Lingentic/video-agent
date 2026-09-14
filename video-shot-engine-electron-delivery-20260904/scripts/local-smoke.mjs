import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const tempRuns = await fsp.mkdtemp(path.join(os.tmpdir(), "video-shot-engine-smoke-"));
const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";
const ffprobe = process.env.FFPROBE_PATH || "ffprobe";

const port = await new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const value = server.address().port;
    server.close((error) => error ? reject(error) : resolve(value));
  });
});

await execFileAsync(ffmpeg, ["-version"]);
await execFileAsync(ffprobe, ["-version"]);

const child = spawn(process.execPath, ["src/server.mjs"], {
  cwd: root,
  env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), RUNS_DIR: tempRuns, PUBLIC_DIR: path.join(root, "public"), XINHANKR_API_KEY: "" },
  stdio: ["ignore", "pipe", "pipe"],
});

try {
  const health = await new Promise((resolve, reject) => {
    const deadline = Date.now() + 10000;
    const poll = async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/health`);
        if (response.ok) return resolve(await response.json());
      } catch {}
      if (Date.now() >= deadline) return reject(new Error("服务未在10秒内就绪"));
      setTimeout(poll, 100);
    };
    poll();
  });
  const config = await (await fetch(`http://127.0.0.1:${port}/api/config`)).json();
  if (!health.ok || config.apiKeyConfigured) throw new Error("无费用冒烟检查结果异常");
  console.log(JSON.stringify({ ok: true, port, ffmpeg: true, ffprobe: true, apiKeyConfigured: false }));
} finally {
  child.kill();
  await fsp.rm(tempRuns, { recursive: true, force: true });
}

