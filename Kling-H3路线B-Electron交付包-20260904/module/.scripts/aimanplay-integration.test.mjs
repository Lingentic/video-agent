import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const moduleRoot = fileURLToPath(new URL("..", import.meta.url));
const execFileAsync = promisify(execFile);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
let validPngBytes;

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function delayedJsonPost(url) {
  let resolveResponse;
  let rejectResponse;
  let ended = false;
  const response = new Promise((resolve, reject) => { resolveResponse = resolve; rejectResponse = reject; });
  const request = http.request(url, { method: "POST", headers: { "Content-Type": "application/json" } }, (res) => {
    const chunks = [];
    res.on("data", chunk => chunks.push(chunk));
    res.on("end", () => resolveResponse({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
  });
  request.on("error", rejectResponse);
  request.write("{");
  return { response, finish: () => { if (!ended) { ended = true; request.end("}"); } } };
}

async function prepareRun(runsDir, id, prompt) {
  const runDir = path.join(runsDir, id);
  await mkdir(runDir, { recursive: true });
  await mkdir(path.join(runDir, "kling-output"), { recursive: true });
  if (!validPngBytes) {
    const fixturePath = path.join(runDir, "valid-png-fixture.png");
    await execFileAsync(process.env.FFMPEG_PATH || "ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=black:s=16x16", "-frames:v", "1", "-update", "1", "-y", fixturePath], { windowsHide: true });
    validPngBytes = await readFile(fixturePath);
    await rm(fixturePath, { force: true });
  }
  const editedKeyframes = [];
  for (let index = 0; index < 4; index += 1) {
    const file = path.join(runDir, `frame-${index}.png`);
    await writeFile(file, validPngBytes);
    editedKeyframes.push({ id: `frame-${index}`, name: `frame-${index}.png`, path: file, mime: "image/png", size: validPngBytes.length });
  }
  const audioPath = path.join(runDir, "voice.wav");
  const sourceAudio = makeWav();
  await writeFile(audioPath, sourceAudio);
  const run = {
    id, stage: "image", status: "SUCCEEDED", imageStatus: "SUCCEEDED", videoMode: "multi_keyframes",
    videoPrompt: prompt, voiceScript: "你好", duration: 5, resolution: "768P", ratio: "9:16", audioMode: "voice", voiceName: "测试音色",
    keyframes: editedKeyframes.map(item => ({ ...item })), editedKeyframes,
    voiceAudio: { id: "voice", name: "voice.wav", path: audioPath, mime: "audio/wav", size: sourceAudio.length },
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  await writeFile(path.join(runDir, "run.json"), JSON.stringify(run));
  return run;
}

function makeWav({ sampleRate = 24000, seconds = 0.25 } = {}) {
  const channels = 1;
  const bitsPerSample = 16;
  const frameCount = Math.floor(sampleRate * seconds);
  const dataSize = frameCount * channels * bitsPerSample / 8;
  const wav = Buffer.alloc(44 + dataSize);
  wav.write("RIFF", 0); wav.writeUInt32LE(36 + dataSize, 4); wav.write("WAVE", 8);
  wav.write("fmt ", 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(channels, 22); wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * channels * bitsPerSample / 8, 28);
  wav.writeUInt16LE(channels * bitsPerSample / 8, 32); wav.writeUInt16LE(bitsPerSample, 34);
  wav.write("data", 36); wav.writeUInt32LE(dataSize, 40);
  for (let index = 0; index < frameCount; index += 1) {
    wav.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 440 * index / sampleRate) * 5000), 44 + index * 2);
  }
  return wav;
}

async function seedPreparedAudio(run, runsDir, cacheUrl) {
  const directory = path.join(runsDir, run.id, "inputs", "voice-audio");
  await mkdir(directory, { recursive: true });
  const preparedPath = path.join(directory, "prepared-fixture.mp3");
  await execFileAsync(process.env.FFMPEG_PATH || "ffmpeg", ["-v", "error", "-y", "-i", run.voiceAudio.path, "-map", "0:a:0", "-vn", "-ac", "1", "-ar", "24000", "-c:a", "libmp3lame", "-b:a", "96k", preparedPath], { windowsHide: true });
  const bytes = await readFile(preparedPath);
  run.aimanplayAudio = {
    id: `prepared-${run.id}`, name: "reference-voice-prepared.mp3", path: preparedPath,
    category: "inputs/voice-audio", mime: "audio/mpeg", size: bytes.length, duration: 0.25,
    sourceId: run.voiceAudio.id, sourceSha256: sha256(await readFile(run.voiceAudio.path)),
    sha256: sha256(bytes), formatVersion: "mp3-24k-mono-v1",
  };
  if (cacheUrl) run.aimanplayUploads = { [run.aimanplayAudio.id]: cacheUrl };
  await writeFile(path.join(runsDir, run.id, "run.json"), JSON.stringify(run));
}

test("Aimanplay video route uses OSS, persists task ID, downloads result, and never auto-resubmits uncertain calls", async () => {
  const runsDir = await mkdtemp(path.join(os.tmpdir(), "aimanplay-client-test-"));
  const providerCalls = { sts: 0, uploads: 0, create: 0, query: 0, content: 0, imageCalls: 0, audioGets: 0, audioReadFailures: [], requests: [], uploadBodies: [], objects: new Map() };
  const provider = http.createServer(async (req, res) => {
    const base = `http://127.0.0.1:${provider.address().port}`;
    if (req.url === "/api/video-upload/oss-sts") {
      providerCalls.sts += 1;
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ success: true, enabled: true, host: base, dir: "uploads", bucket: "test-bucket", accessKeyId: "test-id", accessKeySecret: "test-secret", securityToken: "test-security-token" }));
    }
    if (req.method === "PUT" && req.url.startsWith("/uploads/")) {
      const bytes = await readFileFromRequest(req);
      providerCalls.uploadBodies.push(bytes);
      providerCalls.objects.set(req.url, { bytes, mime: req.headers["content-type"] });
      providerCalls.uploads += 1;
      res.statusCode = 200;
      return res.end();
    }
    if (req.method === "GET" && req.url.startsWith("/uploads/")) {
      const failure = providerCalls.audioReadFailures.shift();
      if (failure === "html") { res.setHeader("Content-Type", "text/html"); return res.end("<html>expired</html>"); }
      if (failure === "404") { res.statusCode = 404; return res.end("not found"); }
      const object = providerCalls.objects.get(req.url);
      if (!object) { res.statusCode = 404; return res.end("not found"); }
      if (object.mime?.startsWith("audio/")) providerCalls.audioGets += 1;
      res.setHeader("Content-Type", object.mime || "application/octet-stream");
      return res.end(object.bytes);
    }
    if (req.url === "/v1/videos" && req.method === "POST") {
      providerCalls.create += 1;
      const request = JSON.parse((await readFileFromRequest(req)).toString());
      providerCalls.requests.push(request);
      if (request.prompt === "uncertain submission") return req.socket.destroy();
      res.setHeader("Content-Type", "application/json");
      if (request.prompt === "rejected fps") {
        res.statusCode = 400;
        return res.end(JSON.stringify({ error: { code: "invalid_fps", message: "fps must be set" } }));
      }
      if (request.prompt === "failed fps") return res.end(JSON.stringify({ id: "video_failed_fps", status: "queued" }));
      return res.end(JSON.stringify({ id: "video_test_1", status: "queued" }));
    }
    if (req.url === "/v1/videos/video_failed_fps") { res.setHeader("Content-Type", "application/json"); return res.end(JSON.stringify({ id: "video_failed_fps", status: "failed", error: { code: "invalid_fps", message: "fps must be set" } })); }
    if (req.url === "/v1/videos/video_test_1") { providerCalls.query += 1; res.setHeader("Content-Type", "application/json"); return res.end(JSON.stringify({ id: "video_test_1", status: "completed" })); }
    if (req.url === "/v1/videos/video_copy_race") { providerCalls.query += 1; res.setHeader("Content-Type", "application/json"); return res.end(JSON.stringify({ id: "video_copy_race", status: "in_progress" })); }
    if (req.url === "/v1/videos/video_test_1/content") { providerCalls.content += 1; res.setHeader("Content-Type", "video/mp4"); return res.end(Buffer.from("0000ftypisom0000")); }
    if (req.url.startsWith("/api/v1/")) providerCalls.imageCalls += 1;
    res.statusCode = 404;
    res.end();
  });
  let client;
  try {
    await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
    const providerBase = `http://127.0.0.1:${provider.address().port}`;
    await prepareRun(runsDir, "run_success", "successful submission");
    await prepareRun(runsDir, "run_uncertain", "uncertain submission");
    await prepareRun(runsDir, "run_silent", "silent submission");
    await prepareRun(runsDir, "run_rejected_fps", "rejected fps");
    await prepareRun(runsDir, "run_failed_fps", "failed fps");
    const staleRun = await prepareRun(runsDir, "run_stale_audio_url", "stale audio URL");
    const retryRun = await prepareRun(runsDir, "run_audio_read_retry", "retry audio read");
    const exhaustedRun = await prepareRun(runsDir, "run_audio_read_exhausted", "exhaust audio reads");
    const badKeyframesRun = await prepareRun(runsDir, "run_bad_keyframes", "bad keyframes");
    const missingVoiceRun = await prepareRun(runsDir, "run_missing_voice", "missing voice");
    const recoverySource = await prepareRun(runsDir, "run_recovery_source", "failed source with broken frames");
    const recoveryRaceSource = await prepareRun(runsDir, "run_recovery_copy_race", "source changes while copy body is pending");
    const queuedRecoverySource = await prepareRun(runsDir, "run_recovery_queued", "queued source");
    const uncertainRecoverySource = await prepareRun(runsDir, "run_recovery_uncertain", "uncertain source");
    await writeFile(badKeyframesRun.editedKeyframes[1].path, "corrupted PNG bytes");
    await unlink(badKeyframesRun.editedKeyframes[3].path);
    await unlink(missingVoiceRun.voiceAudio.path);
    Object.assign(recoverySource, {
      productImages: [], sourceVideo: null, editedImage: null, stage: "video", status: "FAILED", videoStatus: "failed", videoTaskId: "video_bad_input",
      recovery: { kind: "keyframes", reason: "invalid", indexes: [1, 3] },
    });
    await writeFile(recoverySource.editedKeyframes[1].path, "corrupted PNG bytes");
    await unlink(recoverySource.editedKeyframes[3].path);
    Object.assign(recoveryRaceSource, { productImages: [], sourceVideo: null, editedImage: null, stage: "video", status: "FAILED", videoProvider: "aimanplay", videoStatus: "failed", videoTaskId: "video_copy_race", recovery: { kind: "keyframes", reason: "invalid", indexes: [1] } });
    for (const source of [queuedRecoverySource, uncertainRecoverySource]) {
      Object.assign(source, { productImages: [], sourceVideo: null, editedImage: null, stage: "video", status: "FAILED", videoTaskId: `task-${source.id}`, recovery: { kind: "keyframes", reason: "invalid", indexes: [1] } });
    }
    queuedRecoverySource.videoStatus = "in_progress";
    uncertainRecoverySource.videoStatus = "uncertain";
    uncertainRecoverySource.videoSubmission = { status: "uncertain" };
    for (const source of [recoverySource, recoveryRaceSource, queuedRecoverySource, uncertainRecoverySource]) await writeFile(path.join(runsDir, source.id, "run.json"), JSON.stringify(source));
    const switching = await prepareRun(runsDir, "run_switch", "switch voice");
    switching.audioMode = "silent";
    await writeFile(path.join(runsDir, "run_switch", "run.json"), JSON.stringify(switching));
    await seedPreparedAudio(staleRun, runsDir, `${providerBase}/uploads/expired-audio.mp3`);
    await seedPreparedAudio(retryRun, runsDir);
    await seedPreparedAudio(exhaustedRun, runsDir);
    const port = await freePort();
    client = spawn(process.execPath, ["server.mjs"], {
      cwd: moduleRoot,
      env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), RUNS_DIR: runsDir, AIMANPLAY_API_BASE: `http://127.0.0.1:${provider.address().port}`, BAILIAN_API_BASE: providerBase, BAILIAN_IMAGE_API_BASE: providerBase, AIMANPLAY_TOKEN: "test-token", MOCK_PIPELINE: "false", NODE_ENV: "test", BAILIAN_API_KEY: "unused", XINHANKR_API_KEY: "", KLING_API_KEY: "" },
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
    const uploadReplacement = async (runId) => {
      const uploaded = await fetch(`${base}/api/media?runId=${runId}&kind=image&category=keyframes%2Fsource&name=repair.png`, { method: "POST", headers: { "Content-Type": "image/png" }, body: validPngBytes });
      assert.equal(uploaded.status, 201);
      return uploaded.json();
    };
    const recoverySourcePath = path.join(runsDir, recoverySource.id, "run.json");
    const recoverySourceBefore = await readFile(recoverySourcePath);
    const createBeforeRecoveryCopy = providerCalls.create;
    const recoveryCopyResponse = await fetch(`${base}/api/runs/${recoverySource.id}/recovery-copy`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal(recoveryCopyResponse.status, 201);
    const recoveryCopy = await recoveryCopyResponse.json();
    assert.notEqual(recoveryCopy.id, recoverySource.id);
    assert.equal(recoveryCopy.videoTaskId, null);
    assert.equal(recoveryCopy.editedKeyframes[3], null);
    assert.equal(recoveryCopy.editedKeyframes[2].name, "frame-2.png", "a missing edited frame does not shift later indexes");
    assert.deepEqual(recoveryCopy.recovery, { kind: "keyframes", reason: "invalid", indexes: [1, 3] });
    assert.equal(providerCalls.create, createBeforeRecoveryCopy, "recovery copy does not submit a provider video task");
    const imageCallsBeforeResume = providerCalls.imageCalls;
    const createBeforeResume = providerCalls.create;
    const recoveryCopyResume = await fetch(`${base}/api/runs/${recoveryCopy.id}/resume`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal(recoveryCopyResume.status, 200);
    const resumedRecoveryCopy = await recoveryCopyResume.json();
    assert.equal(resumedRecoveryCopy.editedKeyframes[3], null);
    assert.equal(resumedRecoveryCopy.editedKeyframes[2].name, "frame-2.png");
    assert.deepEqual(resumedRecoveryCopy.recovery, { kind: "keyframes", reason: "invalid", indexes: [1, 3] });
    assert.equal(providerCalls.imageCalls, imageCallsBeforeResume, "resume does not query or resubmit missing manual image tasks");
    assert.equal(providerCalls.create, createBeforeResume, "resume does not submit a video task");
    assert.deepEqual(await readFile(recoverySourcePath), recoverySourceBefore, "copy creation leaves the failed source run JSON byte-identical");
    const sourcePathsBefore = [recoverySource.keyframes[1].path, recoverySource.editedKeyframes[0].path, recoverySource.editedKeyframes[1].path, recoverySource.editedKeyframes[2].path];
    const sourceFiles = await Promise.all(sourcePathsBefore.map(file => readFile(file)));
    assert.deepEqual(await Promise.all(sourcePathsBefore.map(file => readFile(file))), sourceFiles, "copy creation leaves source media bytes intact");
    await assert.rejects(readFile(recoverySource.editedKeyframes[3].path), error => error.code === "ENOENT", "the missing source frame remains missing after copying");
    const recoveryCopyFrame3Upload = await uploadReplacement(recoveryCopy.id);
    const recoveryCopyFrame3 = await fetch(`${base}/api/runs/${recoveryCopy.id}/keyframes/3/replace`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mediaId: recoveryCopyFrame3Upload.id }) });
    assert.equal(recoveryCopyFrame3.status, 200, "missing frame can be repaired on the recovery copy");
    assert.deepEqual((await recoveryCopyFrame3.json()).recovery, { kind: "keyframes", reason: "invalid", indexes: [1] });
    const recoveryCopyFrame1Upload = await uploadReplacement(recoveryCopy.id);
    const recoveryCopyFrame1 = await fetch(`${base}/api/runs/${recoveryCopy.id}/keyframes/1/replace`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mediaId: recoveryCopyFrame1Upload.id }) });
    assert.equal(recoveryCopyFrame1.status, 200, "damaged frame can be repaired on the recovery copy");
    assert.equal((await recoveryCopyFrame1.json()).recovery, null);
    assert.deepEqual(await readFile(recoverySourcePath), recoverySourceBefore, "repairing the copy still leaves source run JSON unchanged");
    assert.deepEqual(await Promise.all(sourcePathsBefore.map(file => readFile(file))), sourceFiles, "repairing the copy leaves all existing source media unchanged");
    await assert.rejects(readFile(recoverySource.editedKeyframes[3].path), error => error.code === "ENOENT", "repairing the copy does not recreate the source run's missing frame");
    for (const source of [queuedRecoverySource, uncertainRecoverySource]) {
      const sourcePath = path.join(runsDir, source.id, "run.json");
      const before = await readFile(sourcePath);
      const rejected = await fetch(`${base}/api/runs/${source.id}/recovery-copy`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      assert.equal(rejected.status, 409);
      assert.deepEqual(await readFile(sourcePath), before, "ineligible source run remains unchanged");
    }
    const createBeforeCopyRace = providerCalls.create;
    const delayedCopy = delayedJsonPost(`${base}/api/runs/${recoveryRaceSource.id}/recovery-copy`);
    try {
      await new Promise(resolve => setTimeout(resolve, 30));
      const refreshedRaceSource = await (await fetch(`${base}/api/runs/${recoveryRaceSource.id}/resume`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json();
      assert.equal(refreshedRaceSource.videoStatus, "in_progress", "provider refresh changes source state while copy body is incomplete");
      delayedCopy.finish();
      const racedCopyResponse = await delayedCopy.response;
      assert.equal(racedCopyResponse.status, 409, "recovery copy rechecks source status after reading a delayed body");
      assert.equal(providerCalls.create, createBeforeCopyRace, "the recovery-copy race never submits a new video task");
    } finally {
      delayedCopy.finish();
      await delayedCopy.response.catch(() => {});
    }
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
    const persistedSuccess = JSON.parse(await readFile(path.join(runsDir, "run_success", "run.json"), "utf8"));
    const originalBytes = await readFile(persistedSuccess.voiceAudio.path);
    const originalHash = sha256(originalBytes);
    const preparedAudio = persistedSuccess.aimanplayAudio;
    assert.equal(preparedAudio.sourceId, persistedSuccess.voiceAudio.id);
    assert.equal(preparedAudio.sourceSha256, originalHash);
    assert.equal(preparedAudio.formatVersion, "mp3-24k-mono-v1");
    const preparedBytes = await readFile(preparedAudio.path);
    assert.equal(preparedAudio.sha256, sha256(preparedBytes));
    assert.equal(preparedAudio.mime, "audio/mpeg");
    assert.equal(preparedBytes.subarray(0, 3).toString(), "ID3");
    const probe = await execFileAsync(process.env.FFPROBE_PATH || "ffprobe", ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=codec_name,sample_rate,channels", "-of", "json", preparedAudio.path], { windowsHide: true });
    const probedAudio = JSON.parse(probe.stdout).streams[0];
    assert.deepEqual({ codec: probedAudio.codec_name, sampleRate: Number(probedAudio.sample_rate), channels: Number(probedAudio.channels) }, { codec: "mp3", sampleRate: 24000, channels: 1 });
    await execFileAsync(process.env.FFMPEG_PATH || "ffmpeg", ["-v", "error", "-i", preparedAudio.path, "-f", "null", "-"], { windowsHide: true });
    assert.equal(sha256(await readFile(persistedSuccess.voiceAudio.path)), originalHash, "source WAV stays unchanged");
    assert.equal(providerCalls.uploadBodies.at(-1).subarray(0, 3).toString(), "ID3");
    assert.equal(providerCalls.audioGets, 1, "audio public URL is read back and verified");
    const queryBeforeRecovery = providerCalls.query;
    const finished = await (await fetch(`${base}/api/runs/run_success`)).json();
    assert.equal(finished.status, "SUCCEEDED");
    assert.ok(finished.output?.url);
    assert.equal(providerCalls.query, queryBeforeRecovery + 1);
    assert.equal(providerCalls.content, 1);
    assert.equal(providerCalls.create, 1, "restoring an existing task only queries its saved task ID");
    const acceptedFrameUpload = await uploadReplacement("run_success");
    const acceptedFrameReplace = await fetch(`${base}/api/runs/run_success/keyframes/0/replace`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mediaId: acceptedFrameUpload.id }) });
    assert.equal(acceptedFrameReplace.status, 409, "accepted video task cannot be edited");

    const createBeforeBadFrames = providerCalls.create;
    const badFramesResponse = await fetch(`${base}/api/runs/${badKeyframesRun.id}/video`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ videoMode: "multi_keyframes", videoPrompt: "bad keyframes", duration: 5, resolution: "768P", audioMode: "voice" }) });
    assert.equal(badFramesResponse.status, 422);
    const badFramesRecord = JSON.parse(await readFile(path.join(runsDir, badKeyframesRun.id, "run.json"), "utf8"));
    assert.deepEqual(badFramesRecord.recovery, { kind: "keyframes", reason: "invalid", indexes: [1, 3] });
    assert.equal(providerCalls.create, createBeforeBadFrames, "invalid or missing keyframes block video submission");
    const originalFrames = await Promise.all([0, 2].map(index => readFile(badKeyframesRun.editedKeyframes[index].path)));
    const replacementUpload = await uploadReplacement(badKeyframesRun.id);
    const replacedFrameResponse = await fetch(`${base}/api/runs/${badKeyframesRun.id}/keyframes/1/replace`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mediaId: replacementUpload.id }) });
    assert.equal(replacedFrameResponse.status, 200, await replacedFrameResponse.clone().text());
    const replacedRun = await replacedFrameResponse.json();
    assert.deepEqual(replacedRun.recovery, { kind: "keyframes", reason: "invalid", indexes: [3] });
    assert.deepEqual(await Promise.all([0, 2].map(index => readFile(badKeyframesRun.editedKeyframes[index].path))), originalFrames, "replacement leaves neighboring valid frames unchanged");
    const replacementPath = path.join(runsDir, badKeyframesRun.id, "kling-output", `${replacedRun.editedKeyframes[1].id}.png`);
    const replacementProbe = await execFileAsync(process.env.FFPROBE_PATH || "ffprobe", ["-v", "error", "-show_entries", "stream=width,height", "-of", "json", replacementPath], { windowsHide: true });
    assert.deepEqual(JSON.parse(replacementProbe.stdout).streams[0], { width: 864, height: 1536 });

    const createBeforeMissingVoice = providerCalls.create;
    const missingVoiceResponse = await fetch(`${base}/api/runs/${missingVoiceRun.id}/video`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ videoMode: "multi_keyframes", videoPrompt: "missing voice", duration: 5, resolution: "768P", audioMode: "voice" }) });
    assert.equal(missingVoiceResponse.status, 422);
    const missingVoiceRecord = JSON.parse(await readFile(path.join(runsDir, missingVoiceRun.id, "run.json"), "utf8"));
    assert.equal(missingVoiceRecord.recovery?.kind, "voice");
    assert.equal(missingVoiceRecord.recovery?.reason, "missing");
    assert.equal(providerCalls.create, createBeforeMissingVoice, "missing reference audio blocks video submission");

    const staleBefore = { creates: providerCalls.create, uploads: providerCalls.uploads };
    const staleResponse = await fetch(`${base}/api/runs/${staleRun.id}/video`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ videoMode: "multi_keyframes", videoPrompt: "stale audio URL", duration: 5, resolution: "768P", audioMode: "voice" }) });
    assert.equal(staleResponse.status, 201);
    assert.equal(providerCalls.create, staleBefore.creates + 1);
    assert.equal(providerCalls.uploads, staleBefore.uploads + 5, "four images and one replacement audio object are uploaded");

    providerCalls.audioReadFailures.push("html");
    const retryBefore = { creates: providerCalls.create, uploads: providerCalls.uploads };
    const retryResponse = await fetch(`${base}/api/runs/${retryRun.id}/video`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ videoMode: "multi_keyframes", videoPrompt: "retry audio read", duration: 5, resolution: "768P", audioMode: "voice" }) });
    assert.equal(retryResponse.status, 201);
    assert.equal(providerCalls.create, retryBefore.creates + 1);
    assert.equal(providerCalls.uploads, retryBefore.uploads + 6, "an unreadable first audio upload is replaced once");

    providerCalls.audioReadFailures.push("404", "html");
    const exhaustedBefore = { creates: providerCalls.create, uploads: providerCalls.uploads };
    const exhaustedResponse = await fetch(`${base}/api/runs/${exhaustedRun.id}/video`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ videoMode: "multi_keyframes", videoPrompt: "exhaust audio reads", duration: 5, resolution: "768P", audioMode: "voice" }) });
    assert.equal(exhaustedResponse.status, 502);
    assert.equal(providerCalls.create, exhaustedBefore.creates, "video task is not submitted unless uploaded audio verifies");
    assert.equal(providerCalls.uploads, exhaustedBefore.uploads + 6);

    const newVoiceWav = makeWav({ sampleRate: 16000, seconds: 0.4 });
    const upload = await fetch(`${base}/api/media?runId=run_switch&kind=audio&category=inputs%2Fvoice-audio&name=new-voice.wav&attach=false`, { method: "POST", headers: { "Content-Type": "audio/wav" }, body: newVoiceWav });
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
    assert.equal(providerCalls.uploadBodies.at(-1).subarray(0, 3).toString(), "ID3");
    assert.ok(providerCalls.requests.at(-1).ref_audio_0);
    const audioGetsBeforeSilent = providerCalls.audioGets;
    const silent = await fetch(`${base}/api/runs/run_silent/video`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ videoMode: "multi_keyframes", videoPrompt: "silent submission", duration: 5, resolution: "768P", audioMode: "silent", voiceScript: "" }) });
    assert.equal(silent.status, 201);
    const silentAudioGets = providerCalls.audioGets;
    assert.equal(silentAudioGets, audioGetsBeforeSilent, "silent generation never fetches or verifies an audio URL");
    assert.equal(providerCalls.requests.at(-1).ref_audio_0, undefined);
    const silentRecord = JSON.parse(await readFile(path.join(runsDir, "run_silent", "run.json"), "utf8"));
    assert.ok(silentRecord.voiceAudio?.path, "disabling sound retains the saved sample for later retries");

    const uncertain = await submit("run_uncertain");
    assert.equal(uncertain.status, 502);
    const uncertainRun = JSON.parse(await readFile(path.join(runsDir, "run_uncertain", "run.json"), "utf8"));
    assert.equal(uncertainRun.videoSubmission.status, "uncertain");
    const uncertainFrameUpload = await uploadReplacement("run_uncertain");
    const uncertainFrameReplace = await fetch(`${base}/api/runs/run_uncertain/keyframes/0/replace`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mediaId: uncertainFrameUpload.id }) });
    assert.equal(uncertainFrameReplace.status, 409, "uncertain video submission cannot be edited");
    const beforeRetry = providerCalls.create;
    assert.equal((await submit("run_uncertain")).status, 409);
    assert.equal(providerCalls.create, beforeRetry);
    const uncertainBefore = JSON.parse(await readFile(path.join(runsDir, "run_uncertain", "run.json"), "utf8"));
    const staged = await fetch(`${base}/api/media?runId=run_uncertain&kind=audio&category=inputs%2Fvoice-audio&name=staged.wav&attach=false`, { method: "POST", headers: { "Content-Type": "audio/wav" }, body: makeWav() });
    const stagedAudio = await staged.json();
    const denied = await fetch(`${base}/api/runs/run_uncertain/video`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ videoMode: "multi_keyframes", voiceAudioId: stagedAudio.id, voiceName: "other voice", audioMode: "voice" }) });
    assert.equal(denied.status, 409);
    const uncertainAfter = JSON.parse(await readFile(path.join(runsDir, "run_uncertain", "run.json"), "utf8"));
    assert.deepEqual(uncertainAfter.voiceAudio, uncertainBefore.voiceAudio);
    assert.equal(uncertainAfter.voiceName, uncertainBefore.voiceName);

    for (const [id, prompt, status] of [["run_rejected_fps", "rejected fps", 400], ["run_failed_fps", "failed fps", 201]]) {
      const before = providerCalls.create;
      const response = await fetch(`${base}/api/runs/${id}/video`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ videoMode: "multi_keyframes", videoPrompt: prompt, duration: 5, resolution: "768P", audioMode: "voice" }) });
      assert.equal(response.status, status);
      const body = await response.json();
      const failure = status === 201 ? await (await fetch(`${base}/api/runs/${id}`)).json() : body;
      assert.match(failure.message || failure.error, /帧率/);
      const saved = JSON.parse(await readFile(path.join(runsDir, id, "run.json"), "utf8"));
      assert.equal(saved.status, "FAILED");
      assert.equal(saved.errorRecord.code, "invalid_fps");
      assert.match(saved.errorRecord.message, /fps must be set/);
      assert.equal(saved.editedKeyframes.length, 4);
      assert.equal(providerCalls.create, before + 1, "error handling must not resubmit video generation");
    }
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
  const retry = Function("deps", `const {state, videoClient, updateRemakeStage, render, pollKlingRun, completeRemakeResult, notify, assertCurrentRemake, isCurrentRemake, remakeKeyframeProblems} = deps; ${fn}; return retrySavedRemakeVideo;`)({
    state: { remake: item, active: "remake" }, videoClient: { startKlingVideo: async (...args) => { calls.push(args); return { id: "run_saved" }; } },
    updateRemakeStage() {}, render() {}, pollKlingRun: async () => ({}), completeRemakeResult: async () => {}, notify() {}, assertCurrentRemake() {}, isCurrentRemake: current => current === item, remakeKeyframeProblems: () => []
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
