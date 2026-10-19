import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDiagnostics } from "../diagnostics.mjs";

const renderer = await readFile(new URL("../renderer/app.js", import.meta.url), "utf8");
const service = await readFile(new URL("../../Kling-H3路线B-Electron交付包-20260904/module/server.mjs", import.meta.url), "utf8");
const main = await readFile(new URL("../main.mjs", import.meta.url), "utf8");
const tempRoots = [];

test.after(async () => { await Promise.all(tempRoots.map(root => rm(root, { recursive: true, force: true }))); });

async function tempRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), "video-remake-error-"));
  tempRoots.push(root);
  return root;
}

function readZip(buffer) {
  const files = new Map();
  let end = buffer.length - 22;
  while (end >= 0 && buffer.readUInt32LE(end) !== 0x06054b50) end -= 1;
  assert.ok(end >= 0, "ZIP end record exists");
  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  for (let i = 0; i < count; i += 1) {
    assert.equal(buffer.readUInt32LE(offset), 0x02014b50);
    const size = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    files.set(name, buffer.subarray(dataStart, dataStart + size));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `expected ${name} to exist`);
  const end = source.indexOf("\n}", start);
  assert.notEqual(end, -1, `expected ${name} to end`);
  return source.slice(start, end + 2);
}

function rendererError() {
  const cleanStart = renderer.indexOf("const cleanRemoteError =");
  assert.notEqual(cleanStart, -1);
  const cleanEnd = renderer.indexOf("\n", cleanStart) + 1;
  assert.ok(cleanEnd > cleanStart);
  return Function(`${renderer.slice(cleanStart, cleanEnd)}\n${extractFunction(renderer, "friendlyImageError")}\n${extractFunction(renderer, "friendlyRemakeError")}\nreturn friendlyRemakeError;`)();
}

function serviceError() {
  return Function(`${extractFunction(service, "friendlyVideoServiceError")}\nreturn friendlyVideoServiceError;`)();
}

function serviceErrorRecord() {
  return Function(`${extractFunction(service, "videoServiceErrorRecord")}\nreturn videoServiceErrorRecord;`)();
}

const friendlyRendererError = rendererError();
const friendlyServiceError = serviceError();
const recordVideoServiceError = serviceErrorRecord();

function assertSafeMessage(message, forbidden = []) {
  assert.equal(typeof message, "string");
  assert.ok(message.length > 0);
  for (const value of forbidden) assert.ok(!message.includes(value), `message leaked ${value}`);
}

test("renderer translates frame-rate causes without confusing audio sample rates or image resolution", () => {
  for (const detail of ["fps must be between 1 and 30", "framerate is unsupported"]) {
    assert.match(friendlyRendererError(detail, "video"), /播放设置/);
  }
  assert.match(friendlyRendererError("frame rate limit exceeded", "video"), /播放设置/);
  assert.match(friendlyRendererError(JSON.stringify({ detail: [{ loc: ["body", "fps"], msg: "Field required" }] }), "video"), /播放设置/);
  assert.doesNotMatch(friendlyRendererError("Stream #0: Video h264 25 fps\nError opening output file: Permission denied", "video"), /帧率/);
  assert.doesNotMatch(friendlyRendererError("audio sample_rate 44100 is unsupported", "video"), /帧率|FPS/i);
  assert.doesNotMatch(friendlyRendererError("image resolution 1920x1080 is unsupported", "video"), /帧率|FPS/i);
});

test("renderer gives audio format, sample-rate, and duration errors their own guidance", () => {
  assert.match(friendlyRendererError("audio sample_rate is unsupported", "video"), /声音已自动处理.*生成服务仍不支持/);
  assert.match(friendlyRendererError("supported_audio_formats: wav, mp3", "video"), /声音已自动处理.*生成服务仍不支持/);
  assert.match(friendlyRendererError("audio duration exceeds limit", "video"), /声音长度不符合生成要求/);
});

test("image compression failures describe image processing, not missing keyframes or a finished video", () => {
  const message = friendlyRendererError("关键帧图片无法读取或压缩，请导出诊断日志并联系工作人员。", "video");
  assert.match(message, /图片压缩失败/);
  assert.doesNotMatch(message, /视频已经生成|找不到|还没生成好/);
});

test("image format errors do not become audio errors from later sample-rate metadata", () => {
  const raw = "invalid image format; audio metadata: sample_rate=44100";
  const serviceMessage = friendlyServiceError({ message: raw }, 400);
  for (const message of [serviceMessage, friendlyRendererError(raw, "video"), friendlyRendererError(serviceMessage, "video")]) {
    assert.match(message, /关键帧|图片/);
    assert.doesNotMatch(message, /参考音频|音频/);
  }
});

test("renderer treats ENOSPC from ffmpeg stderr as a disk-space failure despite media metadata", () => {
  const stderr = "ffmpeg stderr: Input #0, mov,mp4: Duration: 00:00:12.00, start: 0.000000, bitrate: 800 kb/s\nStream #0: Video: h264, 25 fps\nError opening output file: No space left on device (ENOSPC)";
  const message = friendlyRendererError(stderr, "video");
  assert.match(message, /磁盘|空间/);
  assert.doesNotMatch(message, /帧率|fps|时长/);
});

test("renderer maps review, authorization, balance, rate-limit, and upload-network errors", () => {
  assert.match(friendlyRendererError("content moderation rejected", "video"), /审核|检查|素材/);
  assert.match(friendlyRendererError("HTTP 401 invalid credential", "video"), /无法使用.*工作人员/);
  assert.match(friendlyRendererError("HTTP 403 forbidden", "video"), /无法使用.*工作人员/);
  assert.match(friendlyRendererError("HTTP 402 insufficient balance", "video"), /余额/);
  assert.match(friendlyRendererError("HTTP 429 too many requests", "video"), /频繁|稍后/);
  assert.match(friendlyRendererError("upload failed: ECONNRESET", "video"), /网络|连接|上传/);
});

test("service maps provider frame-rate, audio, moderation, and HTTP status causes to fixed Chinese messages", () => {
  assert.match(friendlyServiceError({ error: { message: "fps must be between 1 and 30" } }, 400), /帧率|FPS/i);
  assert.match(friendlyServiceError({ message: "framerate is unsupported" }, 400), /帧率|FPS/i);
  assert.match(friendlyServiceError({ message: "frame rate limit exceeded" }, 400), /帧率/);
  assert.match(friendlyServiceError({ detail: [{ loc: ["body", "fps"], msg: "Field required" }] }, 400), /帧率/);
  assert.doesNotMatch(friendlyServiceError({ message: "Stream #0: Video h264 25 fps\nError opening output file: Permission denied" }, 400), /帧率/);
  assert.doesNotMatch(friendlyServiceError({ message: "audio sample_rate 44100 is unsupported" }, 400), /帧率|FPS/i);
  assert.doesNotMatch(friendlyServiceError({ message: "image resolution 1920x1080 is unsupported" }, 400), /帧率|FPS/i);
  assert.match(friendlyServiceError({ detail: "audio sample_rate is unsupported" }, 400), /音频|采样率/);
  assert.match(friendlyServiceError({ code: "unsupported_audio_format" }, 400), /音频|格式/);
  assert.match(friendlyServiceError({ error: "audio duration exceeds limit" }, 400), /音频|时长/);
  assert.match(friendlyServiceError({ message: "content moderation rejected" }, 400), /审核|检查|素材/);
  const mixedValidation = { detail: [
    { loc: ["body", "duration"], msg: "Input should be <=15" },
    { loc: ["body", "ref_audio_0"], msg: "Input should be a valid URL" }
  ] };
  const mixedMessage = friendlyServiceError(mixedValidation, 400);
  assert.match(mixedMessage, /多项问题/);
  assert.match(mixedMessage, /参考音频地址/);
  assert.doesNotMatch(mixedMessage, /参考音频的时长/);
  const rendererMessage = friendlyRendererError(mixedMessage, "video");
  assert.match(rendererMessage, /视频长度/);
  assert.match(rendererMessage, /声音已上传.*没能读取/);
  assert.doesNotMatch(rendererMessage, /参考音频的时长/);
  assert.match(friendlyServiceError({ message: "private provider detail" }, 401), /凭证|授权|权限/);
  assert.match(friendlyServiceError({ message: "private provider detail" }, 403), /凭证|授权|权限/);
  assert.match(friendlyServiceError({ message: "private provider detail" }, 402), /余额/);
  assert.match(friendlyServiceError({ message: "private provider detail" }, 429), /频繁|稍后/);
});

test("service distinguishes upload network failures from unknown HTTP 400 responses and never echoes provider details", () => {
  const secret = "sk-test-secret";
  const url = "https://upload.example/private/object?token=secret";
  const network = friendlyServiceError({ error: { message: `upload failed ECONNRESET ${secret} ${url}` } }, 0);
  assert.match(network, /网络|连接|上传/);
  assertSafeMessage(network, [secret, url, "ECONNRESET"]);

  const raw = `opaque provider failure ${secret} ${url}`;
  const unknown = friendlyServiceError({ error: { message: raw } }, 400);
  assert.doesNotMatch(unknown, /网络|连接/);
  assertSafeMessage(unknown, [raw, secret, url, "opaque provider failure"]);
});

test("unknown renderer errors point users to logs without leaking the raw message", () => {
  const raw = "opaque provider failure sk-test-secret https://upload.example/private?token=secret";
  const message = friendlyRendererError(raw, "video");
  assert.match(message, /日志/);
  assertSafeMessage(message, [raw, "sk-test-secret", "https://upload.example"]);
});

test("provider error records retain raw fps and code without request body or validation input, and ZIP export redacts secrets and URLs", async () => {
  assert.match(main, /error:\s*run\.errorRecord\s*\|\|\s*run\.error\s*\|\|\s*run\.message/);
  const secret = "sk-test-secret";
  const privateUrl = "https://provider.example/private/object?token=sk-test-secret";
  const friendly = "视频生成服务报告帧率参数不符合要求，请联系维护者处理。";
  const payload = {
    error: { code: "fps_error_code_17", message: `raw fps must be <= 30; ${secret}; ${privateUrl}` },
    detail: [{ loc: ["body", "fps"], msg: "Input should be <=30", input: "validation-input-marker" }],
    body: { prompt: "request-body-marker", api_key: secret },
    request: { body: "request-body-marker" }
  };
  const errorRecord = recordVideoServiceError(payload, friendly, 400);
  assert.equal(errorRecord.stage, "video");
  assert.equal(errorRecord.provider, "aimanplay");
  assert.equal(errorRecord.httpStatus, 400);
  assert.equal(errorRecord.code, "fps_error_code_17");
  assert.match(errorRecord.message, /raw fps|body\.fps/);
  assert.doesNotMatch(JSON.stringify(errorRecord), /request-body-marker|validation-input-marker|"input"|"body"/);

  const root = await tempRoot();
  const runDir = path.join(root, "kling-h3", "runs", "run-fps-error");
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(runDir, "run.json"), JSON.stringify({
    runId: "run-fps-error", status: "FAILED", stage: "video", message: friendly, errorRecord
  }));
  const diagnostics = createDiagnostics({ dataRoot: root, privatePaths: [root], secrets: [secret] });
  await diagnostics.record("task.failed", { module: "remake", runId: "run-fps-error", error: errorRecord }, "error");
  const archivePath = path.join(root, "support.zip");
  await diagnostics.exportBundle(archivePath);
  const files = readZip(await readFile(archivePath));
  const tasks = files.get("tasks.json").toString("utf8");
  const errors = files.get("errors.json").toString("utf8");
  assert.match(tasks, /raw fps|body\.fps/);
  assert.match(tasks, /fps_error_code_17/);
  assert.match(tasks, /视频生成服务报告帧率参数不符合要求/);
  assert.doesNotMatch(tasks, /sk-test-secret|https:\/\/|\/private\/object|token=/);
  assert.doesNotMatch(tasks, /request-body-marker|validation-input-marker/);
  assert.match(errors, /fps_error_code_17|raw fps|body\.fps/);
  assert.doesNotMatch(errors, /sk-test-secret|https:\/\/|\/private\/object|token=/);
});

test("recoverable video markup renders the specific error without repeat-payment notices", () => {
  const start = renderer.indexOf("function renderRemake()");
  assert.notEqual(start, -1);
  const end = renderer.indexOf("\nfunction ", start + 1);
  assert.notEqual(end, -1);
  const markup = renderer.slice(start, end);
  assert.doesNotMatch(markup, /视频服务暂时未能响应/);
  assert.match(markup, /item\.error\.message/);
  assert.match(markup, /还没收到上次生成的结果/);
  assert.doesNotMatch(markup, /再次.*扣|重复计费|支付视频生成费用/);
  assert.doesNotMatch(renderer, /重复计费|再次计费|再扣一次费用/);
});

test("video messages use plain words, keep a cause and action, and hide technical terms", () => {
  const cases = ["fps must be set", "audio sample_rate is unsupported", "HTTP 401 unauthorized", "HTTP 402 insufficient balance", "audio duration exceeds limit", "resolution unsupported", "fetch failed", "opaque failure"];
  for (const raw of cases) {
    const message = friendlyRendererError(raw, "video");
    assert.doesNotMatch(message, /采样率|帧率|参数|权限|凭证|维护者|提交|计费/);
    assert.match(message, /请/);
    assert.ok(message.length <= 50, `message is too long: ${message}`);
  }
});

test("audio failures keep plain guidance and recoverable causes offer upload or another voice", () => {
  for (const raw of ["参考声音自动处理失败", "参考声音自动上传失败", "参考音频过大", "所选声音缺少本地参考样本", "参考声音文件无法读取", "audio sample_rate unsupported", "audio format unsupported", "audio duration exceeds limit"]) {
    const message = friendlyRendererError(raw, "video");
    assert.match(message, /声音|音色/);
    assert.doesNotMatch(message, /请换|请更换|重新选择|采样率|MP3|WAV/);
  }
  for (const raw of ["参考音频过大", "所选声音缺少本地参考样本", "参考声音文件无法读取", "audio sample_rate unsupported", "audio format unsupported", "audio duration exceeds limit"]) {
    assert.match(friendlyRendererError(raw, "video"), /重新上传|选择其他音色/);
    assert.doesNotMatch(friendlyRendererError(raw, "video"), /导出诊断日志|工作人员/);
  }
  assert.match(friendlyRendererError("参考声音自动上传失败", "video"), /已自动重试/);
  assert.doesNotMatch(friendlyRendererError("视频提交结果暂时无法确认", "video"), /查看任务记录/);
  assert.doesNotMatch(friendlyRendererError("fetch failed", "video"), /查看任务进度/);
});
