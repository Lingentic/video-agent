import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createShotServer } from "../src/server.mjs";
import { SHOT_DETECTION_VERSION } from "../src/shot-service.mjs";
import { processBatchItem, subtitleSummary } from "../src/batch-service.mjs";

const cropA = { x1: 0.1, y1: 0.7, x2: 0.9, y2: 0.8 };
const cropB = { x1: 0.2, y1: 0.6, x2: 0.8, y2: 0.75 };
const defaultCrop = { x1: 0.05, y1: 0.60, x2: 0.95, y2: 0.85 };
const options = { model: "video_removal_std", method: "sel_area", rectNormalized: cropA };
const shotResult = { shots: [{ shotId: "shot_001", startSec: 0, endSec: 1 }], durationSec: 1, shotDetectionVersion: SHOT_DETECTION_VERSION };

async function waitFor(read, predicate) {
  let last;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = await read();
    last = value;
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`mock pipeline did not reach expected state: ${JSON.stringify(last)}`);
}

async function fixture(overrides = {}) {
  const runsDir = await fsp.mkdtemp(path.join(os.tmpdir(), "wuhen-pipeline-"));
  const transport = { port: 12345, setPublicBaseUrl(value) { this.lastBase = value; }, close: async () => {} };
  const runtime = await createShotServer({ port: 0, runsDir, subtitleApiKey: "test-only-key", transportManager: transport, ...overrides });
  const server = await runtime.listen();
  const base = `http://127.0.0.1:${server.address().port}`;
  return { runsDir, transport, base, json: async (route) => (await fetch(base + route)).json(),
    post: (route, body) => fetch(base + route, { method: "POST", ...(body instanceof FormData ? { body } : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) }) }),
    close: async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); await fsp.rm(runsDir, { recursive: true, force: true }); } };
}

function form({ batch = false, enabled = true, subtitleOptions = options, folderRegions = true } = {}) {
  const data = new FormData();
  data.append(batch ? "videos" : "video", new Blob(["fake local media"]), "one.mp4");
  if (batch) data.append("videos", new Blob(["second local media"]), "two.mp4");
  data.set("workflow", "ffmpeg_only");
  data.set("removeSubtitles", String(enabled));
  if (subtitleOptions !== null) data.set("subtitleOptions", typeof subtitleOptions === "string" ? subtitleOptions : JSON.stringify(subtitleOptions));
  if (batch) data.set("folderManifest", JSON.stringify([
    { sourceFolderId: "folder_a", sourceFolderName: "A", sourceRelativePath: "nested/one.mp4", ...(folderRegions ? { subtitleRectNormalized: cropA } : {}) },
    { sourceFolderId: "folder_b", sourceFolderName: "B", sourceRelativePath: "two.mp4", ...(folderRegions ? { subtitleRectNormalized: cropB } : {}) },
  ]));
  return data;
}

test("subtitle summaries never expose transport URLs, signatures, paths or raw errors", () => {
  assert.deepEqual(subtitleSummary({ provider: "wuhen", taskId: "remote-1", model: "video_removal_std", inputUrl: "secret", uploadUrl: "secret", outputPath: "private", error: "Bearer secret" }), { provider: "wuhen", taskId: "remote-1", model: "video_removal_std" });
});

test("config uses wuhen runtime credentials and transport accepts only official HTTPS Quick Tunnel", async () => {
  const fx = await fixture();
  try {
    const config = await fx.json("/api/config");
    assert.equal(config.subtitleProvider, "wuhen");
    assert.equal(config.subtitleTransportPort, 12345);
    assert.equal(config.subtitleConfigured, true);
    for (const url of ["http://127.0.0.1:12345", "https://evil.example", "https://ok.trycloudflare.com/private", "https://ok.trycloudflare.com?signature=secret"]) assert.equal((await fx.post("/api/subtitle-transport", { publicBaseUrl: url })).status, 400);
    assert.equal((await fx.post("/api/subtitle-transport", { publicBaseUrl: "https://ok.trycloudflare.com" })).status, 200);
    assert.equal(fx.transport.lastBase, "https://ok.trycloudflare.com");
    const publicConfig = JSON.stringify(await fx.json("/api/config"));
    assert.ok(!publicConfig.includes("test-only-key"));
    assert.ok(!publicConfig.includes("ok.trycloudflare.com"));
    assert.equal((await fx.post("/api/subtitle-config", { apiKey: "" })).status, 200);
    assert.equal((await fx.json("/api/config")).subtitleConfigured, false);
  } finally { await fx.close(); }
});

test("folder batch pauses locally and resumes the original cloud task and each saved region", { timeout: 15000 }, async () => {
  const calls = [];
  let pausedOnce = false;
  const fx = await fixture({
    subtitleService: async ({ runDir, inputPath, apiKey, options: saved, signal, onStage }) => {
      assert.equal(apiKey, "test-only-key");
      calls.push({ phase: "subtitle", videoId: path.basename(runDir), options: structuredClone(saved) });
      const jobFile = path.join(runDir, "mock-cloud-job.json");
      let job;
      try { job = JSON.parse(await fsp.readFile(jobFile, "utf8")); }
      catch { job = { provider: "wuhen", taskId: `task-${path.basename(runDir)}` }; await fsp.writeFile(jobFile, JSON.stringify(job)); calls.push({ phase: "submit", taskId: job.taskId }); }
      await onStage("subtitle_cloud_processing", job);
      if (path.basename(runDir) === "video_002" && !pausedOnce) {
        pausedOnce = true;
        signal.throwIfAborted();
        await new Promise((_resolve, reject) => { signal.addEventListener("abort", () => reject(signal.reason), { once: true }); });
      }
      const outputPath = path.join(runDir, "clean.mp4");
      await fsp.copyFile(inputPath, outputPath);
      return { outputPath, job, inputMedia: { durationSec: 1 }, outputMedia: { durationSec: 1 } };
    },
    videoProcessor: async ({ inputPath }) => { calls.push({ phase: "split", inputPath }); assert.equal(path.basename(inputPath), "clean.mp4"); return shotResult; },
  });
  try {
    const response = await fx.post("/api/batches", form({ batch: true, subtitleOptions: { model: "video_removal_std", method: "sel_area" } }));
    assert.equal(response.status, 202);
    const { batchId } = await response.json();
    await waitFor(() => fx.json(`/api/batches/${batchId}`), (value) => value.items[1].subtitle?.taskId);
    assert.equal((await (await fx.post(`/api/batches/${batchId}/cancel`)).json()).status, "paused");
    const paused = await fx.json(`/api/batches/${batchId}`);
    assert.deepEqual(paused.items.map((item) => item.status), ["completed", "paused"]);
    assert.deepEqual(paused.items.map((item) => item.subtitleOptions.rectNormalized), [cropA, cropB]);
    assert.equal((await fx.post(`/api/batches/${batchId}/resume`, { subtitleOptions: { model: "video_removal_pro", method: "all_area" } })).status, 202);
    const completed = await waitFor(() => fx.json(`/api/batches/${batchId}`), (value) => value.batch.status === "completed" && !value.batch.active);
    assert.deepEqual(completed.batch.items.map((item) => item.subtitleOptions.rectNormalized), [cropA, cropB]);
    assert.equal(calls.filter((call) => call.phase === "submit").length, 2);
    assert.equal(calls.filter((call) => call.phase === "split").length, 2);
    assert.deepEqual(calls.filter((call) => call.phase === "subtitle").map((call) => call.options), [{ ...options, rectNormalized: cropA }, { ...options, rectNormalized: cropB }, { ...options, rectNormalized: cropB }]);
    assert.equal(completed.items[0].sourceRelativePath, "nested/one.mp4");
  } finally { await fx.close(); }
});

test("single-video pipeline defaults missing options before cleaning and splitting", async () => {
  let subtitleCalls = 0;
  const fx = await fixture({ subtitleService: async ({ runDir, inputPath, options: saved }) => {
    subtitleCalls += 1;
    assert.deepEqual(saved, { model: "video_removal_std", method: "sel_area", rectNormalized: defaultCrop });
    const outputPath = path.join(runDir, "clean.mp4");
    await fsp.copyFile(inputPath, outputPath);
    return { outputPath, job: { provider: "wuhen", taskId: "single" } };
  }, videoProcessor: async ({ inputPath }) => { assert.equal(path.basename(inputPath), "clean.mp4"); return shotResult; } });
  try {
    for (const invalidOptions of ["{", "[]", "null", "17"]) {
      const invalid = await fx.post("/api/runs", form({ subtitleOptions: invalidOptions }));
      assert.ok(invalid.status >= 400);
    }
    assert.equal(subtitleCalls, 0);
    const response = await fx.post("/api/runs", form({ subtitleOptions: null }));
    assert.equal(response.status, 202);
    const { runId } = await response.json();
    const result = await waitFor(() => fx.json(`/api/runs/${runId}`), (value) => value.run.status === "completed" && !value.run.active);
    assert.deepEqual(result.run.subtitleOptions, { model: "video_removal_std", method: "sel_area", rectNormalized: defaultCrop });
    assert.equal(subtitleCalls, 1);
    const secretDir = path.join(fx.runsDir, runId, "artifacts", "subtitle-removal");
    await fsp.mkdir(secretDir, { recursive: true });
    await fsp.writeFile(path.join(secretDir, "job.json"), "private signatures");
    await fsp.writeFile(path.join(secretDir, "output.mp4"), "local cleaned output");
    assert.equal((await fetch(`${fx.base}/runs/${runId}/artifacts/subtitle-removal/job.json`)).status, 404);
    assert.equal((await fetch(`${fx.base}/runs/${runId}/artifacts/subtitle-removal/output.mp4`)).status, 200);
  } finally { await fx.close(); }
});

test("folder batch persists the fixed default region independently for every video", { timeout: 15000 }, async () => {
  const received = [];
  const fx = await fixture({ subtitleService: async ({ runDir, inputPath, options: saved }) => {
    received.push({ videoId: path.basename(runDir), options: structuredClone(saved) });
    const outputPath = path.join(runDir, "clean.mp4");
    await fsp.copyFile(inputPath, outputPath);
    return { outputPath, job: { provider: "wuhen", taskId: `default-${path.basename(runDir)}` } };
  }, videoProcessor: async () => shotResult });
  try {
    const response = await fx.post("/api/batches", form({ batch: true, subtitleOptions: "", folderRegions: false }));
    assert.equal(response.status, 202);
    const { batchId } = await response.json();
    const result = await waitFor(() => fx.json(`/api/batches/${batchId}`), (value) => value.batch.status === "completed" && !value.batch.active);
    const expected = { model: "video_removal_std", method: "sel_area", rectNormalized: defaultCrop };
    assert.deepEqual(received.map((entry) => entry.options), [expected, expected]);
    assert.deepEqual(result.items.map((item) => item.subtitleOptions), [expected, expected]);
    assert.deepEqual(result.batch.items.map((item) => item.subtitleOptions), [expected, expected]);
  } finally { await fx.close(); }
});

test("disabled subtitle batch keeps the original split workflow without any subtitle or tunnel call", async () => {
  let splits = 0;
  const fx = await fixture({ subtitleApiKey: "", subtitleService: async () => assert.fail("disabled subtitles must not call provider"), videoProcessor: async ({ inputPath }) => {
    splits += 1;
    assert.equal(path.basename(inputPath), "input.mp4");
    return shotResult;
  } });
  try {
    const response = await fx.post("/api/batches", form({ batch: true, enabled: false, subtitleOptions: null }));
    assert.equal(response.status, 202);
    const { batchId } = await response.json();
    const result = await waitFor(() => fx.json(`/api/batches/${batchId}`), (value) => value.batch.status === "completed" && !value.batch.active);
    assert.equal(result.batch.removeSubtitles, false);
    assert.equal(splits, 2);
    assert.equal(fx.transport.lastBase, undefined);
    assert.ok(result.items.every((item) => !item.subtitleOptions));
  } finally { await fx.close(); }
});

test("retrying one paused video leaves a batch paused while another video is still queued", async () => {
  const fx = await fixture({ subtitleService: async ({ runDir, inputPath }) => {
    const outputPath = path.join(runDir, "clean.mp4");
    await fsp.copyFile(inputPath, outputPath);
    return { outputPath, job: { provider: "wuhen", taskId: "saved-task" } };
  }, videoProcessor: async () => shotResult });
  try {
    const batchId = "batch_partial_retry";
    const batchDir = path.join(fx.runsDir, batchId);
    const refs = [{ videoId: "video_001", status: "paused" }, { videoId: "video_002", status: "queued" }];
    for (const ref of refs) {
      const dir = path.join(batchDir, "items", ref.videoId);
      await fsp.mkdir(dir, { recursive: true });
      const input = path.join(dir, "input.mp4");
      await fsp.writeFile(input, "media");
      await fsp.writeFile(path.join(dir, "item.json"), JSON.stringify({ ...ref, shotDetectionVersion: SHOT_DETECTION_VERSION, input, stage: ref.status, removeSubtitles: true, subtitleProvider: "wuhen", subtitleOptions: options, autoName: false }));
    }
    await fsp.writeFile(path.join(batchDir, "batch.json"), JSON.stringify({ batchId, shotDetectionVersion: SHOT_DETECTION_VERSION, status: "paused", removeSubtitles: true, items: refs }));
    assert.equal((await fx.post(`/api/batches/${batchId}/items/video_001/retry`)).status, 202);
    const result = await waitFor(() => fx.json(`/api/batches/${batchId}`), (value) => value.items[0].status === "completed" && !value.batch.active);
    assert.equal(result.batch.status, "paused");
    assert.equal(result.items[1].status, "queued");
  } finally { await fx.close(); }
});

test("downstream naming uses prepared clean file and legacy provider records cannot submit", async () => {
  const runDir = await fsp.mkdtemp(path.join(os.tmpdir(), "wuhen-naming-"));
  const input = path.join(runDir, "input.mp4");
  const clean = path.join(runDir, "clean.mp4");
  await fsp.writeFile(input, "input");
  await fsp.writeFile(clean, "clean");
  try {
    let splitCalls = 0;
    const result = await processBatchItem({ runDir, item: { input, videoId: "video_001", removeSubtitles: true, subtitleProvider: "wuhen", subtitleOptions: options, autoName: true, ...shotResult }, thresholds: {}, onUpdate: async () => {}, gemini: {},
      subtitleService: async () => ({ outputPath: clean, job: { provider: "wuhen", taskId: "existing" } }),
      videoProcessor: async () => { splitCalls += 1; return shotResult; },
      namingService: async ({ initialRun }) => { assert.equal(initialRun.processingInput, clean); return { manifest: [{ shotId: "shot_001" }], usage: {} }; },
    });
    assert.equal(result.status, "completed");
    assert.equal(splitCalls, 0);
    const old = await processBatchItem({ runDir, item: { shotDetectionVersion: SHOT_DETECTION_VERSION, input, videoId: "video_002", removeSubtitles: true, subtitleOptions: options, subtitle: { provider: "zhiling", taskId: "old-paid-task" } }, thresholds: {}, onUpdate: async () => {}, subtitleService: async () => assert.fail("legacy paid task must not be resubmitted") });
    assert.equal(old.status, "failed");
    assert.match(old.error, /旧去字幕供应商/);
    assert.equal(await fsp.readFile(input, "utf8"), "input");
  } finally { await fsp.rm(runDir, { recursive: true, force: true }); }
});

test("pause aborts an active executor even while the persisted batch still says paused", async () => {
  let observedSignal, release, started = 0;
  const fx = await fixture({ subtitleService: async ({ signal }) => {
    started += 1; observedSignal = signal;
    await new Promise((resolve, reject) => { release = resolve; signal.addEventListener("abort", () => reject(new Error("paused")), {once:true}); });
    return {outputPath:"unused",job:{provider:"wuhen",taskId:"old-id"}};
  }, videoProcessor: async () => shotResult });
  try {
    const {batchId} = await (await fx.post("/api/batches", form({batch:true}))).json();
    await waitFor(async()=>observedSignal, Boolean);
    const stateFile = path.join(fx.runsDir,batchId,"batch.json");
    const saved = JSON.parse(await fsp.readFile(stateFile,"utf8"));saved.status="paused";
    await fsp.writeFile(stateFile,JSON.stringify(saved)); // Emulate the paused disk snapshot during resume's async load.
    const response = await fx.post(`/api/batches/${batchId}/cancel`);assert.equal(response.status,200);
    assert.equal(observedSignal.aborted,true);assert.equal(started,1);
    const result=await fx.json(`/api/batches/${batchId}`);assert.equal(result.batch.status,"paused");assert.equal(result.items[1].status,"queued");
  } finally {release?.();await fx.close();}
});

test("known cloud identity survives a private state save failure and is passed back on recovery", async () => {
  const root=await fsp.mkdtemp(path.join(os.tmpdir(),"wuhen-id-backup-"));
  try {
    const input=path.join(root,"input.mp4");await fsp.writeFile(input,"original");
    const safe={id:"job-1",provider:"wuhen",taskId:"paid-task-1",submittedAt:new Date().toISOString(),inputUrl:"secret-cap-url"};
    const failed=await processBatchItem({runDir:root,item:{shotDetectionVersion:SHOT_DETECTION_VERSION,videoId:"video_001",input,removeSubtitles:true,subtitleProvider:"wuhen",subtitleOptions:options},thresholds:{},onUpdate:async()=>{},subtitleService:async()=>{throw Object.assign(new Error("persist failed"),{job:safe});}});
    assert.equal(failed.subtitle.taskId,"paid-task-1");assert.equal(failed.subtitle.id,"job-1");assert.equal(failed.subtitle.inputUrl,undefined);
    await processBatchItem({runDir:root,item:failed,thresholds:{},onUpdate:async()=>{},subtitleService:async({recoveryJob})=>{assert.equal(recoveryJob.taskId,"paid-task-1");assert.equal(recoveryJob.id,"job-1");throw Error("keep paused without submitting");}});
    const record=JSON.parse(await fsp.readFile(path.join(root,"artifacts","error.json"),"utf8"));assert.equal(record.subtitle.taskId,"paid-task-1");assert.ok(!JSON.stringify(record).includes("secret-cap-url"));
  } finally {await fsp.rm(root,{recursive:true,force:true});}
});

test("HTTP recovery and naming reject historical versions without paid calls or changing history", async () => {
  let calls = 0;
  const forbidden = async () => { calls += 1; throw new Error("history must not execute"); };
  const fx = await fixture({ gemini: {}, subtitleService: forbidden, videoProcessor: forbidden, namingService: forbidden });
  const files = [];
  const save = async (file, value) => { await fsp.mkdir(path.dirname(file), { recursive: true }); await fsp.writeFile(file, value); files.push([file, value]); };
  const assertRejected = async (route) => {
    const response = await fx.post(route);
    assert.equal(response.status, 400, route);
    assert.match((await response.json()).error, /版本不一致.*创建新任务/);
  };
  try {
    for (const version of ["2-primary-threshold", undefined]) {
      const suffix = version ? "old" : "missing";
      for (const removeSubtitles of [true, false]) {
        const runId = `run_${suffix}_${removeSubtitles ? "subtitle" : "naming"}`;
        const artifacts = path.join(fx.runsDir, runId, "artifacts");
        await save(path.join(artifacts, "run.json"), JSON.stringify({ runId, status: "failed", shotDetectionVersion: version, removeSubtitles, shots: [{ shotId: "shot_001" }] }));
        await save(path.join(artifacts, "shot_labels_normalized.json"), "cached names");
        await save(path.join(artifacts, "analysis_input_numbered.mp4"), "analysis");
        await save(path.join(artifacts, "shot_segments", "shot_001.mp4"), "old clip");
        if (removeSubtitles) await assertRejected(`/api/runs/${runId}/resume`);
        await assertRejected(`/api/runs/${runId}/name`);
        await assertRejected(`/api/runs/${runId}/resume-naming`);
        assert.equal((await fx.json(`/api/runs/${runId}`)).run.status, "failed");
      }
      for (const batchVersion of [version, SHOT_DETECTION_VERSION]) {
        const batchId = `batch_${suffix}_${batchVersion === SHOT_DETECTION_VERSION ? "item" : "batch"}`;
        const batchDir = path.join(fx.runsDir, batchId);
        await save(path.join(batchDir, "batch.json"), JSON.stringify({ batchId, status: "paused", removeSubtitles: true, shotDetectionVersion: batchVersion, items: [{ videoId: "video_001", status: "paused" }] }));
        await save(path.join(batchDir, "items", "video_001", "item.json"), JSON.stringify({ videoId: "video_001", status: "paused", removeSubtitles: true, shotDetectionVersion: version }));
        await save(path.join(batchDir, "items", "video_001", "artifacts", "shot_labels_normalized.json"), "batch cached names");
        await assertRejected(`/api/batches/${batchId}/resume`);
        await assertRejected(`/api/batches/${batchId}/items/video_001/retry`);
        assert.equal((await fx.json(`/api/batches/${batchId}`)).batch.status, "paused");
      }
      const runId = `run_completed_${suffix}`;
      await save(path.join(fx.runsDir, runId, "artifacts", "run.json"), JSON.stringify({ runId, status: "completed", removeSubtitles: true, shotDetectionVersion: version }));
      assert.equal((await fx.json(`/api/runs/${runId}`)).run.status, "completed");
      assert.equal((await fx.post(`/api/runs/${runId}/resume`)).status, 200);
      const batchId = `batch_completed_${suffix}`;
      await save(path.join(fx.runsDir, batchId, "batch.json"), JSON.stringify({ batchId, status: "completed", shotDetectionVersion: version, items: [] }));
      assert.equal((await fx.json(`/api/batches/${batchId}`)).batch.status, "completed");
    }
    assert.equal(calls, 0);
    for (const [file, value] of files) assert.equal(await fsp.readFile(file, "utf8"), value);
  } finally { await fx.close(); }
});

test("completed current subtitle split tasks can explicitly add naming without redetecting", async () => {
  let splitCalls = 0;
  let namingCalls = 0;
  const fx = await fixture({ gemini: {},
    subtitleService: async ({ runDir }) => ({ outputPath: path.join(runDir, "clean.mp4"), job: { provider: "wuhen", taskId: "existing-completed-task" } }),
    videoProcessor: async () => { splitCalls += 1; assert.fail("completed cut plan must not be redetected"); },
    namingService: async ({ initialRun }) => {
      namingCalls += 1;
      assert.equal(initialRun.shotDetectionVersion, SHOT_DETECTION_VERSION);
      assert.equal(path.basename(initialRun.processingInput), "clean.mp4");
      return { manifest: [{ shotId: "shot_001" }], usage: {} };
    },
  });
  try {
    for (const action of ["name", "resume-naming"]) {
      const runId = `run_completed_${action.replaceAll("-", "_")}`;
      const runDir = path.join(fx.runsDir, runId);
      await fsp.mkdir(path.join(runDir, "artifacts"), { recursive: true });
      const input = path.join(runDir, "input.mp4");
      await fsp.writeFile(input, "original input");
      await fsp.writeFile(path.join(runDir, "clean.mp4"), "existing clean result");
      await fsp.writeFile(path.join(runDir, "artifacts", "run.json"), JSON.stringify({
        runId, input, status: "completed", stage: "completed", autoName: false, workflow: "ffmpeg_only",
        removeSubtitles: true, subtitleProvider: "wuhen", subtitleOptions: options, threshold: 12, minDurationSec: 0.2, ...shotResult,
      }));
      const previousNamingCalls = namingCalls;
      assert.equal((await fx.post(`/api/runs/${runId}/${action}`)).status, 202);
      const result = await waitFor(() => fx.json(`/api/runs/${runId}`), (value) => value.run.status === "completed" && value.run.namedShotCount === 1 && !value.run.active);
      assert.equal(result.run.autoName, true);
      assert.equal(namingCalls - previousNamingCalls, 1);
      assert.equal(splitCalls, 0);
    }
  } finally { await fx.close(); }
});

test("unconfigured naming still reports historical detection version before asking for a key", async () => {
  const fx = await fixture({ gemini: false });
  try {
    const runId = "run_old_without_key";
    const artifacts = path.join(fx.runsDir, runId, "artifacts");
    await fsp.mkdir(artifacts, { recursive: true });
    const record = JSON.stringify({ runId, status: "failed", shotDetectionVersion: "2-primary-threshold" });
    await fsp.writeFile(path.join(artifacts, "run.json"), record);
    for (const action of ["name", "resume-naming"]) {
      const response = await fx.post(`/api/runs/${runId}/${action}`);
      assert.equal(response.status, 400);
      assert.match((await response.json()).error, /版本不一致.*创建新任务/);
    }
    assert.equal(await fsp.readFile(path.join(artifacts, "run.json"), "utf8"), record);
  } finally { await fx.close(); }
});
