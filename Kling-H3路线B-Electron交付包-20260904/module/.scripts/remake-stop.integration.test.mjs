import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function freePort() {
  const probe = http.createServer();
  await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  return port;
}

async function startService(dir, env = {}) {
  const serverPath = path.join(dir, "server.mjs");
  await copyFile(path.join(root, "server.mjs"), serverPath);
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const client = spawn(process.execPath, [serverPath], {
    cwd: root,
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", RUNS_DIR: path.join(dir, "runs"), MOCK_PIPELINE: "false", ...env },
    stdio: "ignore",
    windowsHide: true
  });
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(`${base}/api/health`)).ok) return { client, base, serverPath, port }; } catch {}
    await pause(50);
  }
  client.kill();
  throw new Error("service did not start");
}

function stopService(client) {
  return new Promise(resolve => {
    if (!client || client.exitCode !== null) return resolve();
    client.once("exit", resolve);
    client.kill();
  });
}

function beginPartialPost(base, pathname, body) {
  const serialized = JSON.stringify(body);
  const split = Math.min(12, Math.max(1, serialized.length - 1));
  const request = http.request(new URL(pathname, base), {
    method: "POST",
    headers: { "content-type": "application/json", "content-length": Buffer.byteLength(serialized) }
  });
  const response = new Promise((resolve, reject) => {
    request.on("error", reject);
    request.on("response", res => {
      const chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
    });
  });
  request.write(serialized.slice(0, split));
  request.flushHeaders();
  return { finish: () => { request.end(serialized.slice(split)); return response; } };
}

function media(id, name, filePath) {
  return { id, name, mime: "image/png", size: 8, path: filePath, category: "kling-output" };
}

async function writeRun(runsDir, run) {
  const dir = path.join(runsDir, run.id);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "run.json"), JSON.stringify(run));
}

function imageRun(id, framePath, productImages) {
  const editedKeyframes = [1, 2, 3].map(index => media(`${id}-edited-${index}`, `edited-${index}.png`, framePath));
  return {
    id, stage: "image", status: "SUCCEEDED", imageStatus: "SUCCEEDED", videoMode: "multi_keyframes",
    videoTaskId: null, videoSubmission: null,
    keyframes: [1, 2, 3].map(index => media(`${id}-source-${index}`, `source-${index}.png`, framePath)),
    editedKeyframes, imageTasks: editedKeyframes.map((editedImage, index) => ({ index, taskId: `image-task-${index}`, status: "SUCCEEDED", editedImage })),
    productImage: productImages[0], productImages, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  };
}

test("image stop requires the complete confirmation stage, keeps outputs and blocks every paid resubmission", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remake-stop-image-"));
  const runsDir = path.join(dir, "runs");
  const framePath = path.join(dir, "frame.png");
  await writeFile(framePath, Buffer.from("frame"));
  const products = [1, 2, 3].map(index => ({ id: `product-${index}`, name: `product-${index}.png`, mime: "image/png", size: 8, path: framePath }));
  const ready = imageRun("image-ready", framePath, products);
  const streamVideo = imageRun("stream-video", framePath, products);
  const streamRetry = imageRun("stream-retry", framePath, products);
  const incomplete = imageRun("image-incomplete", framePath, products);
  incomplete.editedKeyframes[2] = null;
  const uncertain = imageRun("image-uncertain", framePath, products);
  uncertain.videoSubmission = { status: "uncertain" };
  await writeRun(runsDir, ready);
  await writeRun(runsDir, streamVideo);
  await writeRun(runsDir, streamRetry);
  await writeRun(runsDir, incomplete);
  await writeRun(runsDir, uncertain);
  let providerCalls = 0;
  const provider = http.createServer((req, res) => { providerCalls++; res.writeHead(404).end(); });
  await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
  const providerBase = `http://127.0.0.1:${provider.address().port}`;
  let service;
  try {
    service = await startService(dir, { WAW_API_KEY: "test-key", WAW_API_BASE: `${providerBase}/v1`, AIMANPLAY_TOKEN: "test-token", AIMANPLAY_API_BASE: providerBase });
    const post = (url, body) => fetch(service.base + url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

    const delayedVideo = beginPartialPost(service.base, "/api/runs/stream-video/video", { videoMode: "multi_keyframes", videoPrompt: "motion", duration: 5, resolution: "768P", audioMode: "silent" });
    await pause(30);
    const stoppedBeforeVideoBody = await post("/api/runs/stream-video/stop", { stage: "image" });
    assert.equal(stoppedBeforeVideoBody.status, 200);
    const delayedVideoResult = await delayedVideo.finish();
    assert.equal(delayedVideoResult.status, 409);
    assert.deepEqual(delayedVideoResult.body.error, "任务已在本地结束，不能再次提交付费生成");
    assert.deepEqual((await (await fetch(`${service.base}/api/runs/stream-video`)).json()).editedKeyframes.map(item => item.id), streamVideo.editedKeyframes.map(item => item.id));

    const delayedRetry = beginPartialPost(service.base, "/api/runs/stream-retry/image/retry", { indexes: [0] });
    await pause(30);
    assert.equal((await post("/api/runs/stream-retry/stop", { stage: "image" })).status, 200);
    assert.equal((await delayedRetry.finish()).status, 409);
    assert.deepEqual((await (await fetch(`${service.base}/api/runs/stream-retry`)).json()).editedKeyframes.map(item => item.id), streamRetry.editedKeyframes.map(item => item.id));
    assert.equal(providerCalls, 0, "a stop that wins while a paid request body is being read prevents provider submission");

    assert.equal((await post("/api/runs/image-incomplete/stop", { stage: "image" })).status, 409);
    assert.equal((await post("/api/runs/image-uncertain/stop", { stage: "image" })).status, 409);
    assert.equal((await post("/api/runs/image-ready/stop", { stage: "invalid" })).status, 400);

    const stoppedResponse = await post("/api/runs/image-ready/stop", { stage: "image" });
    assert.equal(stoppedResponse.status, 200);
    const stopped = await stoppedResponse.json();
    assert.equal(stopped.status, "SUCCEEDED");
    assert.equal(stopped.imageStatus, "SUCCEEDED");
    assert.deepEqual(stopped.editedKeyframes.map(item => item.id), ready.editedKeyframes.map(item => item.id));
    assert.deepEqual(stopped.productImages.map(item => item.id), products.map(item => item.id));
    assert.equal(stopped.userStopped.stage, "image");
    const stoppedAt = stopped.userStopped.stoppedAt;
    const repeated = await (await post("/api/runs/image-ready/stop", { stage: "image" })).json();
    assert.equal(repeated.userStopped.stoppedAt, stoppedAt);
    assert.equal((await post("/api/runs/image-ready/stop", { stage: "video" })).status, 409);
    const stopEvents = (await readFile(path.join(runsDir, "image-ready", "events.jsonl"), "utf8")).trim().split(/\r?\n/).map(JSON.parse);
    assert.equal(stopEvents.filter(event => event.event === "run_user_stopped").length, 1);

    assert.equal((await post("/api/runs/image-ready/image/retry", { indexes: [0] })).status, 409);
    assert.equal((await post("/api/runs/image-ready/video", { videoMode: "multi_keyframes", videoPrompt: "motion", duration: 5, resolution: "768P", audioMode: "silent" })).status, 409);
    assert.equal((await post("/api/runs", { runId: "image-ready", videoMode: "multi_keyframes" })).status, 409);
    assert.equal(providerCalls, 0, "stopped paid endpoints must reject before a provider call");
    await stopService(service.client);
    service = null;

    service = await startService(dir, { WAW_API_KEY: "test-key", WAW_API_BASE: `${providerBase}/v1`, AIMANPLAY_TOKEN: "test-token", AIMANPLAY_API_BASE: providerBase });
    const restored = await (await fetch(`${service.base}/api/runs/image-ready`)).json();
    assert.equal(restored.userStopped.stoppedAt, stoppedAt);
    assert.deepEqual(restored.editedKeyframes.map(item => item.id), ready.editedKeyframes.map(item => item.id));
  } finally {
    await stopService(service?.client);
    provider.closeAllConnections();
    await new Promise(resolve => provider.close(resolve));
  }
});

test("video stop is local and idempotent; the retained provider task can finish and archive on GET", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remake-stop-video-"));
  const runsDir = path.join(dir, "runs");
  let queries = 0, cancels = 0, downloads = 0;
  const provider = http.createServer(async (req, res) => {
    if (req.method === "POST" || req.url.includes("cancel")) cancels++;
    if (req.url === "/v1/videos/provider-task-keep") {
      queries++;
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ id: "provider-task-keep", status: "completed" }));
    }
    if (req.url === "/v1/videos/provider-task-keep/content") {
      downloads++;
      const mp4 = Buffer.alloc(16);
      mp4.write("ftyp", 4, "ascii");
      res.setHeader("content-type", "video/mp4");
      return res.end(mp4);
    }
    res.writeHead(404).end();
  });
  let service;
  try {
    await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
    const providerBase = `http://127.0.0.1:${provider.address().port}`;
    await writeRun(runsDir, {
      id: "video-running", stage: "video", status: "PROCESSING", videoStatus: "processing", videoProvider: "aimanplay",
      videoModel: "minimax_h3_image_audio_to_video_v2_15s", videoTaskId: "provider-task-keep", audioMode: "voice",
      videoSubmission: { status: "accepted", acceptedAt: "2026-10-08T01:00:00.000Z" },
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    });
    service = await startService(dir, { AIMANPLAY_TOKEN: "test-token", AIMANPLAY_API_BASE: providerBase });
    const post = (url, body) => fetch(service.base + url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal((await post("/api/runs/video-running/stop", { stage: "image" })).status, 409);
    const first = await post("/api/runs/video-running/stop", { stage: "video" });
    assert.equal(first.status, 200);
    const stopped = await first.json();
    assert.equal(stopped.videoTaskId, "provider-task-keep");
    assert.deepEqual(stopped.videoSubmission, { status: "accepted", acceptedAt: "2026-10-08T01:00:00.000Z" });
    assert.equal((await post("/api/runs/video-running/stop", { stage: "video" })).status, 200);
    assert.equal(queries, 0, "stop itself must not poll the provider");
    assert.equal(cancels, 0, "stop must not call provider cancel");

    const completed = await (await fetch(`${service.base}/api/runs/video-running`)).json();
    assert.equal(completed.status, "SUCCEEDED");
    assert.equal(completed.videoTaskId, "provider-task-keep");
    assert.equal(completed.userStopped.stage, "video");
    assert.ok(completed.output?.id);
    assert.equal(queries, 1);
    assert.equal(downloads, 1);
    assert.equal(cancels, 0);
    assert.equal((await fetch(`${service.base}${completed.output.url}`)).status, 200);
    await stopService(service.client);
    service = null;
    service = await startService(dir, { AIMANPLAY_TOKEN: "test-token", AIMANPLAY_API_BASE: providerBase });
    const restored = await (await fetch(`${service.base}/api/runs/video-running`)).json();
    assert.equal(restored.videoTaskId, "provider-task-keep");
    assert.equal(restored.userStopped.stage, "video");
    assert.ok(restored.output?.id);
    const archived = JSON.parse(await readFile(path.join(runsDir, "video-running", "run.json"), "utf8"));
    assert.equal(archived.videoTaskId, "provider-task-keep");
    assert.equal(archived.videoSubmission.status, "accepted");
    assert.equal(archived.userStopped.stage, "video");
  } finally {
    await stopService(service?.client);
    provider.closeAllConnections();
    await new Promise(resolve => provider.close(resolve));
  }
});

test("stopping the source during a video variant clone prevents submission of the derived run", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remake-stop-variant-"));
  const runsDir = path.join(dir, "runs");
  const framePath = path.join(dir, "frame.png");
  const videoPath = path.join(dir, "source.mp4");
  await writeFile(framePath, Buffer.alloc(8 * 1024 * 1024));
  const mp4 = Buffer.alloc(8 * 1024 * 1024);
  mp4.write("ftyp", 4, "ascii");
  await writeFile(videoPath, mp4);
  const products = [1, 2, 3].map(index => ({ id: `variant-product-${index}`, name: `product-${index}.png`, mime: "image/png", size: 8, path: framePath }));
  const source = imageRun("variant-source", framePath, products);
  source.stage = "video";
  source.status = "SUCCEEDED";
  source.videoTaskId = "previous-video-task";
  source.videoStatus = "completed";
  source.videoMode = "multi_keyframes";
  source.sourceVideo = { id: "variant-source-video", name: "source.mp4", mime: "video/mp4", size: 16, path: videoPath };
  source.firstFrame = media("variant-first-frame", "first.png", framePath);
  source.editedImage = source.editedKeyframes[0];
  let providerCalls = 0;
  const provider = http.createServer((req, res) => { providerCalls++; res.writeHead(502).end(); });
  await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
  const providerBase = `http://127.0.0.1:${provider.address().port}`;
  let service, submission;
  try {
    await writeRun(runsDir, source);
    service = await startService(dir, { AIMANPLAY_TOKEN: "test-token", AIMANPLAY_API_BASE: providerBase });
    const serialized = JSON.stringify({ confirmResubmit: true, videoMode: "multi_keyframes", videoPrompt: "motion", duration: 5, resolution: "768P", audioMode: "silent" });
    submission = fetch(`${service.base}/api/runs/variant-source/video`, { method: "POST", headers: { "content-type": "application/json" }, body: serialized });
    let variantDirectory = null;
    for (let i = 0; i < 300; i++) {
      const dirs = await readdir(runsDir);
      variantDirectory = dirs.find(name => name !== "variant-source") || null;
      if (variantDirectory) break;
      await pause(1);
    }
    assert.ok(variantDirectory, "variant layout should be created before its media clone completes");
    let stopped;
    try { stopped = await fetch(`${service.base}/api/runs/variant-source/stop`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ stage: "video" })
    }); } catch (error) { throw new Error("stop request failed after observing the clone", { cause: error }); }
    assert.equal(stopped.status, 200);
    const sourceStopped = await stopped.json();
    let submitted;
    try { submitted = await submission; } catch (error) { throw new Error("submission response failed after source stop", { cause: error }); }
    assert.equal(submitted.status, 409);
    assert.equal(providerCalls, 0);
    const runsAfter = (await (await fetch(`${service.base}/api/runs`)).json()).runs;
    const unsubmitted = runsAfter.find(run => run.derivedFromRunId === "variant-source");
    assert.ok(unsubmitted);
    assert.equal(unsubmitted.videoTaskId, null);
    assert.equal(unsubmitted.status, "FAILED");
    assert.equal(unsubmitted.videoStatus, null);
    assert.match(unsubmitted.message, /派生视频未提交/);
    assert.deepEqual(unsubmitted.userStopped, {
      ...sourceStopped.userStopped,
      inheritedFromRunId: "variant-source"
    });

    await stopService(service.client);
    service = null;
    service = await startService(dir, { AIMANPLAY_TOKEN: "test-token", AIMANPLAY_API_BASE: providerBase });
    const restoredRuns = (await (await fetch(`${service.base}/api/runs`)).json()).runs;
    const restoredVariant = restoredRuns.find(run => run.derivedFromRunId === "variant-source");
    assert.deepEqual(restoredVariant.userStopped, unsubmitted.userStopped);
    assert.equal(restoredVariant.videoTaskId, null);
    assert.equal(providerCalls, 0);
  } finally {
    await stopService(service?.client);
    provider.closeAllConnections();
    await new Promise(resolve => provider.close(resolve));
  }
});

test("a stop cannot pass while the final video submission claim is held", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remake-stop-claim-"));
  const runsDir = path.join(dir, "runs");
  const framePath = path.join(dir, "frame.png");
  await writeFile(framePath, Buffer.from("frame"));
  const source = imageRun("claimed-source", framePath, [{ id: "claimed-product", name: "product.png", mime: "image/png", size: 8, path: framePath }]);
  source.videoMode = "first_frame";
  source.firstFrame = media("claimed-first-frame", "first.png", framePath);
  source.editedImage = { ...media("claimed-edited-image", "edited.png", framePath), remoteUrl: "https://provider.invalid/edited.png" };
  let paidCalls = 0, releaseProvider;
  let signalPaidCall;
  const paidCall = new Promise(resolve => { signalPaidCall = resolve; });
  const provider = http.createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/v1/video/generations") {
      paidCalls++;
      signalPaidCall();
      await new Promise(resolve => { releaseProvider = resolve; });
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ task: { id: "claimed-provider-task", status: "queued" } }));
    }
    res.writeHead(404).end();
  });
  let service;
  try {
    await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
    const providerBase = `http://127.0.0.1:${provider.address().port}`;
    await writeRun(runsDir, source);
    service = await startService(dir, { XINHANKR_API_KEY: "test-key", XINHANKR_API_BASE: providerBase });
    const submission = fetch(`${service.base}/api/runs/claimed-source/video`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ videoMode: "first_frame", videoPrompt: "motion", duration: 5, resolution: "768P", audioMode: "silent" })
    });
    await paidCall;
    const stopped = await fetch(`${service.base}/api/runs/claimed-source/stop`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ stage: "image" })
    });
    assert.equal(stopped.status, 409);
    assert.equal(paidCalls, 1);
    releaseProvider();
    const response = await submission;
    assert.equal(response.status, 201);
    assert.equal((await response.json()).videoTaskId, "claimed-provider-task");
  } finally {
    releaseProvider?.();
    await stopService(service?.client);
    provider.closeAllConnections();
    await new Promise(resolve => provider.close(resolve));
  }
});
