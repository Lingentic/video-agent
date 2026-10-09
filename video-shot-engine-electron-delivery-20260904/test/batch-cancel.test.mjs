import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test("cancel recovers an interrupted batch, preserves finished videos, and blocks resume", async () => {
  const runsDir = await fsp.mkdtemp(path.join(os.tmpdir(), "shot-cancel-api-"));
  const batchId = "batch_cancel_test";
  const batchDir = path.join(runsDir, batchId);
  const itemsDir = path.join(batchDir, "items");
  const refs = [
    { videoId: "video_001", sourceFilename: "finished.mp4", status: "completed" },
    { videoId: "video_002", sourceFilename: "unfinished.mp4", status: "processing" },
  ];
  const port = await freePort();
  let child;
  try {
    for (const [index, ref] of refs.entries()) {
      const itemDir = path.join(itemsDir, ref.videoId);
      await fsp.mkdir(itemDir, { recursive: true });
      await fsp.writeFile(path.join(itemDir, "item.json"), JSON.stringify({ ...ref, stage: ref.status, sourceFolderName: "商品A", sourceFolderId: "folder_a" }));
      if (index === 0) {
        await fsp.mkdir(path.join(itemDir, "named_segments"));
        await fsp.writeFile(path.join(itemDir, "named_segments", "finished.mp4"), "finished video");
      }
    }
    const orphanDir = path.join(itemsDir, "video_003");
    await fsp.mkdir(orphanDir);
    await fsp.writeFile(path.join(orphanDir, "item.json"), JSON.stringify({ videoId: "video_003", sourceFilename: "queued.mp4", status: "queued", stage: "queued" }));
    await fsp.writeFile(path.join(batchDir, "batch.json"), JSON.stringify({ batchId, status: "processing", workflow: "ffmpeg_only", items: refs, createdAt: new Date().toISOString() }));

    child = spawn(process.execPath, ["src/server.mjs"], {
      cwd: path.resolve(import.meta.dirname, ".."),
      env: { ...process.env, RUNS_DIR: runsDir, PORT: String(port), HOST: "127.0.0.1", XINHANKR_API_KEY: "" },
      stdio: "ignore",
      windowsHide: true,
    });
    const base = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      try { ready = (await fetch(`${base}/api/health`)).ok; if (ready) break; } catch {}
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(ready, "shot service did not start");

    const response = await fetch(`${base}/api/batches/${batchId}/cancel`, { method: "POST" });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).status, "cancelled");
    const result = await (await fetch(`${base}/api/batches/${batchId}`)).json();
    assert.equal(result.batch.status, "cancelled");
    assert.deepEqual(result.items.map((item) => item.status), ["completed", "cancelled", "cancelled"]);
    assert.equal(await fsp.readFile(path.join(itemsDir, "video_001", "named_segments", "finished.mp4"), "utf8"), "finished video");
    assert.equal((await fetch(`${base}/api/batches/${batchId}/resume`, { method: "POST" })).status, 400);
  } finally {
    if (child && child.exitCode === null) {
      child.kill();
      await new Promise((resolve) => child.once("exit", resolve));
    }
    await fsp.rm(runsDir, { recursive: true, force: true });
  }
});
