import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const moduleRoot = fileURLToPath(new URL("..", import.meta.url));

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function prepareRun(runsDir, id, prompt) {
  const runDir = path.join(runsDir, id);
  await mkdir(runDir, { recursive: true });
  const editedKeyframes = [];
  for (let index = 0; index < 4; index += 1) {
    const file = path.join(runDir, `frame-${index}.png`);
    await writeFile(file, `image ${index}`);
    editedKeyframes.push({ id: `frame-${index}`, name: `frame-${index}.png`, path: file, mime: "image/png", size: 7 });
  }
  const audioPath = path.join(runDir, "voice.wav");
  await writeFile(audioPath, "reference audio");
  const run = {
    id, stage: "image", status: "SUCCEEDED", imageStatus: "SUCCEEDED", videoMode: "multi_keyframes",
    videoPrompt: prompt, voiceScript: "你好", duration: 5, resolution: "768P", ratio: "9:16", audioMode: "voice", voiceName: "测试音色",
    editedKeyframes, voiceAudio: { id: "voice", name: "voice.wav", path: audioPath, mime: "audio/wav", size: 15 },
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  await writeFile(path.join(runDir, "run.json"), JSON.stringify(run));
  return run;
}

test("Aimanplay video route uses OSS, persists task ID, downloads result, and never auto-resubmits uncertain calls", async () => {
  const runsDir = await mkdtemp(path.join(os.tmpdir(), "aimanplay-client-test-"));
  const providerCalls = { sts: 0, uploads: 0, create: 0, query: 0, content: 0, requests: [], uploadBodies: [] };
  const provider = http.createServer(async (req, res) => {
    const base = `http://127.0.0.1:${provider.address().port}`;
    if (req.url === "/api/video-upload/oss-sts") {
      providerCalls.sts += 1;
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ success: true, enabled: true, host: base, dir: "uploads", bucket: "test-bucket", accessKeyId: "test-id", accessKeySecret: "test-secret", securityToken: "test-security-token" }));
    }
    if (req.method === "PUT" && req.url.startsWith("/uploads/")) { providerCalls.uploadBodies.push((await readFileFromRequest(req)).toString()); providerCalls.uploads += 1; res.statusCode = 200; return res.end(); }
    if (req.url === "/v1/videos" && req.method === "POST") {
      providerCalls.create += 1;
      const request = JSON.parse((await readFileFromRequest(req)).toString());
      providerCalls.requests.push(request);
      if (request.prompt === "uncertain submission") return req.socket.destroy();
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ id: "video_test_1", status: "queued" }));
    }
    if (req.url === "/v1/videos/video_test_1") { providerCalls.query += 1; res.setHeader("Content-Type", "application/json"); return res.end(JSON.stringify({ id: "video_test_1", status: "completed" })); }
    if (req.url === "/v1/videos/video_test_1/content") { providerCalls.content += 1; res.setHeader("Content-Type", "video/mp4"); return res.end(Buffer.from("0000ftypisom0000")); }
    res.statusCode = 404;
    res.end();
  });
  let client;
  try {
    await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
    await prepareRun(runsDir, "run_success", "successful submission");
    await prepareRun(runsDir, "run_uncertain", "uncertain submission");
    await prepareRun(runsDir, "run_silent", "silent submission");
    const switching = await prepareRun(runsDir, "run_switch", "switch voice");
    switching.audioMode = "silent";
    await writeFile(path.join(runsDir, "run_switch", "run.json"), JSON.stringify(switching));
    const port = await freePort();
    client = spawn(process.execPath, ["server.mjs"], {
      cwd: moduleRoot,
      env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), RUNS_DIR: runsDir, AIMANPLAY_API_BASE: `http://127.0.0.1:${provider.address().port}`, AIMANPLAY_TOKEN: "test-token", MOCK_PIPELINE: "false", NODE_ENV: "test", BAILIAN_API_KEY: "unused", XINHANKR_API_KEY: "", KLING_API_KEY: "" },
      stdio: "ignore",
      windowsHide: true,
    });
    const base = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try { ready = (await fetch(`${base}/api/health`)).ok; if (ready) break; } catch {}
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(ready, "client service did not start");
    const config = await (await fetch(`${base}/api/config`)).json();
    assert.equal(config.videoModel, "minimax_h3_image_audio_to_video_v2_15s");
    const submit = (id) => fetch(`${base}/api/runs/${id}/video`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ videoMode: "multi_keyframes", videoPrompt: id === "run_success" ? "successful submission" : "uncertain submission", duration: 5, resolution: "768P", audioMode: "voice" }) });
    const accepted = await submit("run_success");
    assert.equal(accepted.status, 201);
    const submittedRun = await accepted.json();
    assert.equal(submittedRun.videoTaskId, "video_test_1");
    assert.equal(submittedRun.videoSubmission.status, "accepted");
    assert.equal(providerCalls.uploads, 5);
    assert.deepEqual(Object.keys(providerCalls.requests[0]).sort(), ["duration", "model", "prompt", "ref_audio_0", "ref_image_0", "ref_image_1", "ref_image_2", "ref_image_3", "resolution"].sort());
    assert.equal(providerCalls.requests[0].resolution, "768p竖");
    assert.equal((await readFile(path.join(runsDir, "run_success", "run.json"), "utf8")).includes("video_test_1"), true);
    const finished = await (await fetch(`${base}/api/runs/run_success`)).json();
    assert.equal(finished.status, "SUCCEEDED");
    assert.ok(finished.output?.url);
    assert.equal(providerCalls.query, 1);
    assert.equal(providerCalls.content, 1);

    const upload = await fetch(`${base}/api/media?runId=run_switch&kind=audio&category=inputs%2Fvoice-audio&name=new-voice.wav&attach=false`, { method: "POST", headers: { "Content-Type": "audio/wav" }, body: "new reference audio" });
    assert.equal(upload.status, 201);
    const newAudio = await upload.json();
    const original = JSON.parse(await readFile(path.join(runsDir, "run_switch", "run.json"), "utf8"));
    assert.equal(original.voiceAudio.id, "voice", "staged upload must preserve existing voice binding");
    const switched = await fetch(`${base}/api/runs/run_switch/video`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ videoMode: "multi_keyframes", videoPrompt: "switch voice", duration: 5, resolution: "768P", audioMode: "voice", voiceScript: "使用新的声音", voiceAudioId: newAudio.id, voiceName: "新音色" }) });
    assert.equal(switched.status, 201);
    const switchedRun = await switched.json();
    assert.equal(switchedRun.audioMode, "voice");
    assert.equal(switchedRun.voiceName, "新音色");
    assert.equal(switchedRun.voiceAudio.id, newAudio.id);
    assert.equal(providerCalls.uploadBodies.at(-1), "new reference audio");
    assert.ok(providerCalls.requests.at(-1).ref_audio_0);
    const silent = await fetch(`${base}/api/runs/run_silent/video`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ videoMode: "multi_keyframes", videoPrompt: "silent submission", duration: 5, resolution: "768P", audioMode: "silent", voiceScript: "" }) });
    assert.equal(silent.status, 201);
    assert.equal(providerCalls.requests.at(-1).ref_audio_0, undefined);
    const silentRecord = JSON.parse(await readFile(path.join(runsDir, "run_silent", "run.json"), "utf8"));
    assert.ok(silentRecord.voiceAudio?.path, "disabling sound retains the saved sample for later retries");

    const uncertain = await submit("run_uncertain");
    assert.equal(uncertain.status, 502);
    const uncertainRun = JSON.parse(await readFile(path.join(runsDir, "run_uncertain", "run.json"), "utf8"));
    assert.equal(uncertainRun.videoSubmission.status, "uncertain");
    const beforeRetry = providerCalls.create;
    assert.equal((await submit("run_uncertain")).status, 409);
    assert.equal(providerCalls.create, beforeRetry);
    const uncertainBefore = JSON.parse(await readFile(path.join(runsDir, "run_uncertain", "run.json"), "utf8"));
    const staged = await fetch(`${base}/api/media?runId=run_uncertain&kind=audio&category=inputs%2Fvoice-audio&name=staged.wav&attach=false`, { method: "POST", headers: { "Content-Type": "audio/wav" }, body: "staged voice" });
    const stagedAudio = await staged.json();
    const denied = await fetch(`${base}/api/runs/run_uncertain/video`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ videoMode: "multi_keyframes", voiceAudioId: stagedAudio.id, voiceName: "other voice", audioMode: "voice" }) });
    assert.equal(denied.status, 409);
    const uncertainAfter = JSON.parse(await readFile(path.join(runsDir, "run_uncertain", "run.json"), "utf8"));
    assert.deepEqual(uncertainAfter.voiceAudio, uncertainBefore.voiceAudio);
    assert.equal(uncertainAfter.voiceName, uncertainBefore.voiceName);
  } finally {
    if (client && client.exitCode === null && client.signalCode === null) {
      client.kill();
      await new Promise((resolve) => client.once("exit", resolve));
    }
    await new Promise((resolve) => provider.close(resolve));
    await rm(runsDir, { recursive: true, force: true });
  }
});

async function readFileFromRequest(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

test("video confirmation uploads the current selected voice, and silent/reference-video bypass the upload", async () => {
  const source = await readFile(path.resolve(moduleRoot, "../../electron/main.mjs"), "utf8");
  const fn = source.slice(source.indexOf("async function startKlingVideo("), source.indexOf("async function resumeKlingRun("));
  const uploads = [], selections = [], requests = [];
  const start = Function("deps", `const {normalizeKlingDuration, ensureQuickTunnel, getReadyKlingService, klingOmniDurations, resolveVoice, uploadKlingMedia, klingVideoPrompt, KLING_OMNI_PROMPT_MAX_BYTES, klingRequest} = deps; ${fn}; return startKlingVideo;`)({
    normalizeKlingDuration: Number, ensureQuickTunnel: async () => "https://test.invalid", getReadyKlingService: () => ({}), klingOmniDurations: new Set([5,10,15]),
    resolveVoice: async id => { selections.push(id); return { id, name: id, samplePath: `${id}.wav` }; },
    uploadKlingMedia: async (...args) => { uploads.push(args); return { id: `uploaded-${args[1]}` }; },
    klingVideoPrompt: text => text, KLING_OMNI_PROMPT_MAX_BYTES: 3072,
    klingRequest: async (_, options) => { const body = JSON.parse(options.body); requests.push(body); return body; }
  });
  await start("run_test", "台词", "multi_keyframes", 5, [0,1,3,4.7], false, true, "new-voice");
  assert.deepEqual(selections, ["new-voice"]);
  assert.equal(uploads[0][1], "new-voice.wav");
  assert.equal(uploads[0][5], false, "upload is staged until the video route accepts it");
  assert.equal(requests[0].voiceAudioId, "uploaded-new-voice.wav");
  assert.equal(requests[0].voiceName, "new-voice");
  assert.equal(requests[0].voiceId, "new-voice");
  await start("run_test", "台词", "multi_keyframes", 5, [], false, true, "new-voice");
  assert.equal(requests[1].voiceName, "new-voice", "unchanged selection stays selected");
  await start("run_test", "", "multi_keyframes", 5, [], false, false, "new-voice");
  await start("run_test", "", "reference_video", 5, [], false, true, "new-voice");
  assert.equal(uploads.length, 2);
  assert.equal(requests[2].audioMode, "silent");
  assert.equal(requests[2].voiceAudioId, undefined);
  assert.equal(requests[3].voiceAudioId, undefined);
  await start("run_test", "台词", "multi_keyframes", 5, [], true, true, null);
  assert.equal(uploads.length, 2, "restored task without a new selection reuses its stored audio");
});

test("restored video retry preserves saved voice until the user selects a different one", async () => {
  const source = await readFile(path.resolve(moduleRoot, "../../electron/renderer/app.js"), "utf8");
  const fn = source.slice(source.indexOf("async function retrySavedRemakeVideo("), source.indexOf("async function retryRemakeImages("));
  const item = { runId: "run_saved", editedKeyframes: [{}], voiceEnabled: true, voiceScript: "台词", videoMode: "multi_keyframes", duration: 5, keyframeTimes: [0], useSavedVoice: true, selectedVoiceId: "library-first" };
  const calls = [];
  const retry = Function("deps", `const {state, videoClient, updateRemakeStage, render, pollKlingRun, completeRemakeResult, notify, assertCurrentRemake, isCurrentRemake} = deps; ${fn}; return retrySavedRemakeVideo;`)({
    state: { remake: item, active: "remake" }, videoClient: { startKlingVideo: async (...args) => { calls.push(args); return { id: "run_saved" }; } },
    updateRemakeStage() {}, render() {}, pollKlingRun: async () => ({}), completeRemakeResult: async () => {}, notify() {}, assertCurrentRemake() {}, isCurrentRemake: current => current === item
  });
  await retry(); assert.equal(calls[0][7], null);
  item.useSavedVoice = false; item.selectedVoiceId = "user-chosen";
  await retry(); assert.equal(calls[1][7], "user-chosen");
});

test("without an Aimanplay token, the paid product-swap route stays disabled", async () => {
  const runsDir = await mkdtemp(path.join(os.tmpdir(), "aimanplay-no-key-test-"));
  const port = await freePort();
  const client = spawn(process.execPath, ["server.mjs"], {
    cwd: moduleRoot,
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), RUNS_DIR: runsDir, AIMANPLAY_TOKEN: "", MOCK_PIPELINE: "false", BAILIAN_API_KEY: "unused" },
    stdio: "ignore",
    windowsHide: true,
  });
  try {
    let config;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try { config = await (await fetch(`http://127.0.0.1:${port}/api/config`)).json(); if (config) break; } catch {}
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(config, "client service did not start");
    assert.equal(config.configured, false);
    assert.equal(config.h3Configured, false);
  } finally {
    if (client.exitCode === null && client.signalCode === null) {
      client.kill();
      await new Promise((resolve) => client.once("exit", resolve));
    }
    await rm(runsDir, { recursive: true, force: true });
  }
});
