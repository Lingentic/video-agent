import http from "node:http";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { appendFile, copyFile, mkdir, open, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const ROOT = fileURLToPath(new URL(".", import.meta.url));
await loadEnv(join(ROOT, ".env"));

const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || 8794);
const RUNS_DIR = process.env.RUNS_DIR ? join(process.env.RUNS_DIR) : join(ROOT, "runs");
const PUBLIC_DIR = process.env.PUBLIC_DIR ? join(process.env.PUBLIC_DIR) : join(ROOT, "public");
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES || 220 * 1024 * 1024);
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 60_000);
const MOCK = /^true$/i.test(process.env.MOCK_PIPELINE || "");
const KLING_API_BASE = (process.env.KLING_API_BASE || "https://api-singapore.klingai.com").replace(/\/$/, "");
const BAILIAN_API_BASE = (process.env.BAILIAN_API_BASE || "https://dashscope.aliyuncs.com").replace(/\/$/, "");
const BAILIAN_IMAGE_MODEL = process.env.BAILIAN_IMAGE_MODEL || "kling/kling-v3-omni-image-generation";
const BAILIAN_IMAGE_RESOLUTION = process.env.BAILIAN_IMAGE_RESOLUTION || "1k";
const KLING_VIDEO_OMNI_MODEL = process.env.KLING_VIDEO_OMNI_MODEL || "kling-3.0-omni";
const H3_API_BASE = (process.env.XINHANKR_API_BASE || "https://token.xinhankr.com").replace(/\/$/, "");
const H3_OPEN_MODEL = process.env.XINHANKR_H3_OPEN_MODEL || "MiniMax-H3";
const FFMPEG_PATH = process.env.FFMPEG_PATH || "ffmpeg";
const H3_OPEN_DISCOUNT = 0.35;
const KLING_OMNI_PROMPT_MAX_BYTES = 3072;
const KLING_REFERENCE_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const KLING_REFERENCE_VIDEO_MAX_BYTES = 200 * 1024 * 1024;

function videoModelForMode(videoMode) {
  return videoMode === "reference_video" ? KLING_VIDEO_OMNI_MODEL : H3_OPEN_MODEL;
}

function videoResolutionsForMode(videoMode) {
  return videoMode === "reference_video" ? ["720P", "1080P"] : ["768P"];
}

function estimatedH3Cost(duration, resolution, model) {
  if (model !== "MiniMax-H3-open") return null;
  const baseRate = resolution === "480P" ? 0.3 : 0.5;
  return Number((duration * baseRate * H3_OPEN_DISCOUNT).toFixed(6));
}

await mkdir(RUNS_DIR, { recursive: true });
const runs = new Map();
const media = new Map();
const runWriteQueues = new Map();
await restoreRuns();

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(payload));
}

function safePart(value, fallback) {
  return String(value || "").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 100) || fallback;
}

function makeRunId() {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${stamp}-${randomUUID().slice(0, 8)}`;
}

function mediaCategory(value) {
  const categories = new Map([
    ["inputs/source-video", join("inputs", "source-video")],
    ["inputs/product-image", join("inputs", "product-image")],
    ["inputs/voice-audio", join("inputs", "voice-audio")],
    ["first-frame", "first-frame"],
    ["keyframes/source", join("keyframes", "source")],
    ["kling-output", "kling-output"],
    ["output", "output"]
  ]);
  const category = categories.get(String(value || ""));
  if (!category) throw new HttpError(400, "媒体目录类型无效");
  return category;
}

async function ensureRunLayout(runId) {
  for (const category of [join("inputs", "source-video"), join("inputs", "product-image"), join("inputs", "voice-audio"), "first-frame", join("keyframes", "source"), "kling-output", "output"]) {
    await mkdir(join(RUNS_DIR, runId, category), { recursive: true });
  }
}

function allowedMedia(kind, mime, name) {
  const ext = extname(name).toLowerCase();
  if (kind === "video") return ["video/mp4", "video/quicktime"].includes(mime) || [".mp4", ".mov"].includes(ext);
  if (kind === "audio") return ["audio/mpeg", "audio/wav", "audio/x-wav", "audio/mp4", "audio/x-m4a"].includes(mime) || [".mp3", ".wav", ".m4a"].includes(ext);
  return ["image/jpeg", "image/png", "image/webp"].includes(mime) || [".jpg", ".jpeg", ".png", ".webp"].includes(ext);
}

function publicMedia(item) {
  return item ? { id: item.id, name: item.name, mime: item.mime, size: item.size, url: `/media/${item.id}/${encodeURIComponent(item.name)}` } : null;
}

function publicRun(run) {
  ensureRunMetrics(run);
  return {
    ...run,
    sourceVideo: publicMedia(run.sourceVideo),
    productImage: publicMedia(run.productImage),
    voiceAudio: publicMedia(run.voiceAudio),
    firstFrame: publicMedia(run.firstFrame),
    editedImage: publicMedia(run.editedImage),
    keyframes: (run.keyframes || []).map(publicMedia),
    editedKeyframes: (run.editedKeyframes || []).map(publicMedia),
    imageTasks: (run.imageTasks || []).map((task) => ({ index: task.index, taskId: task.taskId, status: task.status, editedImage: publicMedia(task.editedImage) })),
    output: publicMedia(run.output)
  };
}

function ensureRunMetrics(run) {
  run.timing ||= {};
  Object.assign(run.timing, {
    runStartedAt: run.timing.runStartedAt || run.createdAt || null,
    imageStartedAt: run.timing.imageStartedAt || null,
    imageSubmittedAt: run.timing.imageSubmittedAt || null,
    imageCompletedAt: run.timing.imageCompletedAt || null,
    imageElapsedMs: run.timing.imageElapsedMs ?? null,
    videoStartedAt: run.timing.videoStartedAt || null,
    videoSubmittedAt: run.timing.videoSubmittedAt || null,
    videoCompletedAt: run.timing.videoCompletedAt || null,
    videoElapsedMs: run.timing.videoElapsedMs ?? null,
    totalElapsedMs: run.timing.totalElapsedMs ?? null
  });
  run.billing ||= {};
  run.billing.estimate ||= { provider: "xinhankr", currency: "CNY", videoAmount: run.estimatedVideoCostCny ?? null, basis: "output_seconds_x_base_rate_x_0.35_discount" };
  run.billing.kling ||= usageFrom(null, "kling", null);
  run.billing.h3 ||= usageFrom(null, "xinhankr", "CNY");
  return run;
}

function indexRunMedia(run) {
  for (const item of [run.sourceVideo, run.productImage, run.voiceAudio, run.firstFrame, run.editedImage, ...(run.keyframes || []), ...(run.editedKeyframes || []), ...(run.imageTasks || []).map((task) => task.editedImage), run.output]) {
    if (item?.id && item?.path) media.set(item.id, item);
  }
}

async function restoreRuns() {
  const entries = await readdir(RUNS_DIR, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const run = JSON.parse(await readFile(join(RUNS_DIR, entry.name, "run.json"), "utf8"));
      ensureRunMetrics(run);
      runs.set(run.id, run);
      indexRunMedia(run);
    } catch {}
  }
}

async function persistRun(run) {
  ensureRunMetrics(run);
  const serialized = JSON.stringify(run, null, 2);
  const previous = runWriteQueues.get(run.id) || Promise.resolve();
  const current = previous.catch(() => {}).then(async () => {
    const dir = join(RUNS_DIR, run.id);
    await mkdir(dir, { recursive: true });
    const path = join(dir, "run.json");
    const temp = `${path}.${randomUUID()}.tmp`;
    await writeFile(temp, serialized, "utf8");
    await rename(temp, path);
  });
  runWriteQueues.set(run.id, current);
  try {
    await current;
  } finally {
    if (runWriteQueues.get(run.id) === current) runWriteQueues.delete(run.id);
  }
}

async function logRun(run, event, fields = {}) {
  await appendFile(join(RUNS_DIR, run.id, "events.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), event, ...fields })}\n`, "utf8");
}

async function receiveMedia(req, kind, runId, category, originalName) {
  const mime = String(req.headers["content-type"] || "application/octet-stream").split(";")[0];
  const name = safePart(originalName, kind === "video" ? "source.mp4" : kind === "audio" ? "voice.mp3" : "image.png");
  if (!allowedMedia(kind, mime, name)) throw new HttpError(415, kind === "video" ? "视频仅支持 MP4/MOV" : kind === "audio" ? "声音样本仅支持 MP3/WAV/M4A" : "图片仅支持 JPG/PNG/WebP");
  const id = randomUUID();
  const ext = extname(name) || (kind === "video" ? ".mp4" : kind === "audio" ? ".mp3" : ".png");
  const dir = join(RUNS_DIR, runId, category);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${id}${ext}`);
  const temp = `${path}.uploading`;
  const handle = await open(temp, "w");
  let size = 0;
  try {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_UPLOAD_BYTES) throw new HttpError(413, "上传文件超过大小限制");
      await handle.write(chunk);
    }
  } finally { await handle.close(); }
  if (!size) throw new HttpError(400, "上传文件为空");
  await rename(temp, path);
  const item = { id, name, mime, size, path, category };
  media.set(id, item);
  return item;
}

async function cloneMediaItem(item, runId, category) {
  if (!item?.path) return null;
  const id = randomUUID();
  const extension = extname(item.path) || extname(item.name);
  const dir = join(RUNS_DIR, runId, category);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${id}${extension}`);
  await copyFile(item.path, path);
  const info = await stat(path);
  const cloned = { ...item, id, path, size: info.size, category };
  media.set(id, cloned);
  return cloned;
}

async function extractVoiceAudio(sourceVideo, runId, maxSeconds = 15) {
  if (!sourceVideo?.path) throw new HttpError(400, "参考视频不存在，无法提取声音");
  const id = randomUUID();
  const category = join("inputs", "voice-audio");
  const dir = join(RUNS_DIR, runId, category);
  const path = join(dir, `${id}.mp3`);
  await mkdir(dir, { recursive: true });
  try {
    await execFileAsync(FFMPEG_PATH, ["-y", "-i", sourceVideo.path, "-map", "0:a:0", "-t", String(Math.min(15, Math.max(1, Number(maxSeconds) || 15))), "-vn", "-ac", "1", "-ar", "24000", "-c:a", "libmp3lame", "-b:a", "96k", path], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  } catch {
    throw new HttpError(422, "参考视频没有可提取的音轨，请关闭声音与口型或改用上传样本");
  }
  const info = await stat(path);
  if (!info.size) throw new HttpError(422, "从参考视频提取的声音样本为空，请改用上传样本");
  const item = { id, name: "reference-voice.mp3", mime: "audio/mpeg", size: info.size, path, category, extractedFrom: sourceVideo.id };
  media.set(id, item);
  return item;
}

async function providerFetch(base, path, key, provider, options = {}) {
  if (!key) throw new HttpError(500, `服务端缺少 ${provider} API Key`);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(`${base}${path}`, {
      ...options,
      signal: controller.signal,
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...(options.headers || {}) }
    });
  } catch (error) {
    if (error.name === "AbortError") throw new HttpError(504, `${provider} API 请求超时`);
    throw new HttpError(502, `无法连接 ${provider} API：${error.message}`);
  } finally { clearTimeout(timeout); }
  const text = await response.text();
  let payload;
  try { payload = JSON.parse(text); } catch { payload = { raw: text }; }
  if (!response.ok || (provider === "Kling" && payload?.code !== 0) || payload?.error) {
    throw new HttpError(response.status >= 400 ? response.status : 502, payload?.error?.message || payload?.message || `${provider} API HTTP ${response.status}`, payload);
  }
  return payload;
}

function taskId(payload) {
  return payload?.task_id || payload?.output?.task_id || payload?.task?.id || payload?.id || payload?.data?.id || payload?.data?.task_id || payload?.data?.task_info?.task_id;
}

function normalized(value) {
  const status = String(value || "").toUpperCase();
  if (["SUCCEEDED", "SUCCEED", "SUCCESS", "COMPLETED"].includes(status)) return "succeeded";
  if (["FAILED", "FAIL", "ERROR", "CANCELLED"].includes(status)) return "failed";
  if (["RUNNING", "PROCESSING"].includes(status)) return "processing";
  return "submitted";
}

function elapsedMs(start, end = new Date().toISOString()) {
  if (!start) return null;
  const value = new Date(end).getTime() - new Date(start).getTime();
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function firstDefined(payload, keys) {
  const queue = [payload];
  const visited = new Set();
  while (queue.length) {
    const value = queue.shift();
    if (!value || typeof value !== "object" || visited.has(value)) continue;
    visited.add(value);
    for (const key of keys) {
      if (value[key] !== undefined && value[key] !== null) return value[key];
    }
    queue.push(...Object.values(value).filter((item) => item && typeof item === "object"));
  }
  return null;
}

function numericOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function usageFrom(payload, provider, currency = null) {
  const usage = firstDefined(payload, ["usage", "billing_usage"]);
  const cost = firstDefined(payload, ["cost", "billing", "charge"]);
  const amountValue = typeof cost === "object" && cost ? firstDefined(cost, ["amount", "price", "total"]) : cost;
  return {
    provider,
    currency: firstDefined(payload, ["currency", "currency_code"]) || currency,
    amount: numericOrNull(amountValue),
    credits: numericOrNull(firstDefined(payload, ["credits", "credit", "credit_usage", "credits_used"])),
    tokens: numericOrNull(firstDefined(payload, ["total_tokens", "tokens", "token_count"])),
    inputSeconds: numericOrNull(firstDefined(payload, ["input_seconds", "input_duration"])),
    outputSeconds: numericOrNull(firstDefined(payload, ["output_seconds", "output_duration", "duration"])),
    inputImageCount: numericOrNull(firstDefined(payload, ["input_image_count", "image_count"])),
    rawUsage: usage ?? cost ?? null
  };
}

function mergeUsage(current, payload, provider, currency) {
  const next = usageFrom(payload, provider, currency);
  return Object.fromEntries(Object.entries(next).map(([key, value]) => [key, value ?? current?.[key] ?? null]));
}

function finishStageTiming(run, stage, at = new Date().toISOString()) {
  const prefix = stage === "image" ? "image" : "video";
  run.timing[`${prefix}CompletedAt`] ||= at;
  run.timing[`${prefix}ElapsedMs`] = elapsedMs(run.timing[`${prefix}StartedAt`], run.timing[`${prefix}CompletedAt`]);
  run.timing.totalElapsedMs = elapsedMs(run.timing.runStartedAt, at);
}

function bailianImageResult(payload) {
  const content = payload?.output?.choices?.[0]?.message?.content;
  const officialImage = Array.isArray(content) ? content.find((item) => item?.image)?.image : null;
  if (officialImage) return officialImage;
  const task = payload?.data || payload;
  const values = task?.task_result?.images || task?.images || task?.outputs || [];
  const item = Array.isArray(values) ? values[0] : values;
  return item?.url || item?.image_url || item?.download_url || null;
}

function h3VideoResult(payload) {
  if (Array.isArray(payload?.data)) return payload.data.find((item) => item?.url)?.url;
  if (Array.isArray(payload?.output)) return payload.output.find((item) => typeof item === "string") || payload.output.find((item) => item?.url)?.url;
  return payload?.task?.content?.url || payload?.content?.url || payload?.data?.url || payload?.output?.url || payload?.video_url || payload?.url || null;
}

function klingOmniTask(payload) {
  if (Array.isArray(payload?.data)) return payload.data[0] || null;
  if (Array.isArray(payload?.data?.tasks)) return payload.data.tasks[0] || null;
  return payload?.data && typeof payload.data === "object" ? payload.data : null;
}

function klingOmniVideoResult(task) {
  const candidates = [
    ...(Array.isArray(task?.outputs) ? task.outputs : []),
    ...(Array.isArray(task?.task_result?.videos) ? task.task_result.videos : []),
    ...(Array.isArray(task?.videos) ? task.videos : [])
  ];
  const output = candidates.find((item) => item?.url || item?.video_url || item?.download_url);
  return output?.url || output?.video_url || output?.download_url || null;
}

async function archiveRemote(run, remoteUrl, kind, category, outputName) {
  const response = await fetch(remoteUrl);
  if (!response.ok) throw new HttpError(502, `生成结果下载失败：HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length) throw new HttpError(502, "生成结果为空");
  const headerMime = String(response.headers.get("content-type") || "").split(";")[0];
  const mime = kind === "image" ? (headerMime.startsWith("image/") ? headerMime : "image/png") : (headerMime.startsWith("video/") ? headerMime : "video/mp4");
  const ext = kind === "image" ? (mime.includes("jpeg") ? ".jpg" : ".png") : ".mp4";
  const id = randomUUID();
  const dir = join(RUNS_DIR, run.id, category);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${id}${ext}`);
  await writeFile(path, bytes);
  const item = { id, name: `${outputName}${ext}`, mime, size: bytes.length, path, category, remoteUrl };
  media.set(id, item);
  return item;
}

async function removeOutputAudio(run) {
  const source = run.output;
  if (!source?.path) throw new HttpError(409, "生成视频尚未归档，无法移除音轨");
  const id = randomUUID();
  const outputPath = join(RUNS_DIR, run.id, "output", `${id}.mp4`);
  await execFileAsync(FFMPEG_PATH, ["-y", "-i", source.path, "-map", "0:v:0", "-c:v", "copy", "-an", "-movflags", "+faststart", outputPath], { maxBuffer: 4 * 1024 * 1024 });
  const info = await stat(outputPath);
  const item = { id, name: "product-remake-silent.mp4", mime: "video/mp4", size: info.size, path: outputPath, category: "output", remoteUrl: null };
  media.set(id, item);
  run.outputWithAudio = source;
  run.output = item;
  run.audioRemovedByFfmpeg = true;
}

async function submitImageTask(run, frame, index) {
  if (!run.publicBaseUrl && !MOCK) throw new HttpError(409, "阿里云百炼图片替换需要临时公网素材通道");
  const publicMediaUrl = (item) => new URL(publicMedia(item).url, run.publicBaseUrl).toString();
  const request = {
    model: BAILIAN_IMAGE_MODEL,
    input: {
      messages: [{
        role: "user",
        content: [
          { text: run.imagePrompt },
          { image: MOCK ? `https://mock.invalid/source-${index + 1}.png` : publicMediaUrl(frame) },
          { image: MOCK ? "https://mock.invalid/product.png" : publicMediaUrl(run.productImage) }
        ]
      }]
    },
    parameters: { n: 1, result_type: "single", aspect_ratio: run.ratio || "9:16", resolution: BAILIAN_IMAGE_RESOLUTION, watermark: false }
  };
  const loggedRequest = structuredClone(request);
  loggedRequest.input.messages[0].content[1].image = `[temporary HTTPS keyframe ${index + 1}]`;
  loggedRequest.input.messages[0].content[2].image = "[temporary HTTPS product image]";
  const task = { index, taskId: null, status: "PENDING", editedImage: null, lastResponse: null, request: loggedRequest };
  if (MOCK) {
    task.taskId = `mock-image-${index + 1}-${Date.now()}`;
  } else {
    const response = await providerFetch(BAILIAN_API_BASE, "/api/v1/services/aigc/image-generation/generation", process.env.BAILIAN_API_KEY, "阿里云百炼 Kling", { method: "POST", headers: { "X-DashScope-Async": "enable" }, body: JSON.stringify(request) });
    task.taskId = taskId(response);
    task.lastResponse = response;
    task.status = response?.output?.task_status || response?.data?.task_status || response?.data?.status || "PENDING";
    run.billing.kling = mergeUsage(run.billing.kling, response, "aliyun-bailian-kling", "CNY");
    if (!task.taskId) throw new HttpError(502, `阿里云百炼第 ${index + 1} 张关键帧响应中没有任务 ID`, response);
  }
  return task;
}

async function createImageStage(run, retryIndexes = null) {
  run.timing.imageStartedAt = new Date().toISOString();
  const frames = run.videoMode === "multi_keyframes" ? run.keyframes || [] : [run.firstFrame];
  if (!frames.length) throw new HttpError(409, "缺少待替换关键帧");
  if (retryIndexes === null) {
    run.imageTasks = [];
    for (let index = 0; index < frames.length; index += 1) run.imageTasks.push(await submitImageTask(run, frames[index], index));
  } else {
    if (!Array.isArray(retryIndexes) || !retryIndexes.length || retryIndexes.some((index) => !Number.isInteger(index) || !frames[index])) throw new HttpError(400, "关键帧序号无效");
    run.imageTasks ||= [];
    run.editedKeyframes ||= [];
    for (const index of retryIndexes) {
      run.imageTasks[index] = await submitImageTask(run, frames[index], index);
      run.editedKeyframes[index] = null;
    }
  }
  const firstTask = run.imageTasks[0];
  run.imageTaskId = firstTask?.taskId || null;
  run.imageStatus = "PENDING";
  run.editedImage = null;
  run.imageRequest = firstTask?.request || null;
  run.stage = "image";
  run.timing.imageSubmittedAt = new Date().toISOString();
  run.status = "PENDING";
  run.message = `${run.imageTasks.length} 张关键帧替换任务已提交`;
  run.updatedAt = new Date().toISOString();
  await persistRun(run);
  await logRun(run, "image_tasks_created", { imageTaskIds: run.imageTasks.map((task) => task.taskId), retryIndexes });
}

async function createVideoStage(run) {
  const referenceMode = run.videoMode === "reference_video";
  const multiKeyframeMode = run.videoMode === "multi_keyframes";
  const videoModel = videoModelForMode(run.videoMode);
  if (!referenceMode && !multiKeyframeMode && !run.editedImage?.remoteUrl && !MOCK) throw new HttpError(409, "替换首帧缺少可供 H3 访问的公网 URL");
  if (multiKeyframeMode && (!run.editedKeyframes?.length || run.editedKeyframes.some((item) => !item?.remoteUrl)) && !MOCK) throw new HttpError(409, "替换关键帧尚未全部完成");
  if (!referenceMode && run.audioMode === "voice" && !run.voiceAudio) throw new HttpError(409, "声音与口型已开启，但缺少参考声音");
  if (!referenceMode && run.audioMode === "voice" && !run.publicBaseUrl && !MOCK) throw new HttpError(409, "参考声音公网通道未就绪");
  const content = [{ type: "text", text: run.videoPrompt }];
  const voiceAudioUrl = !referenceMode && run.audioMode === "voice"
    ? MOCK ? "https://mock.invalid/reference-voice.mp3" : new URL(publicMedia(run.voiceAudio).url, run.publicBaseUrl).toString()
    : null;
  let referenceUrls = null;
  if (referenceMode) {
    if (!run.publicBaseUrl && !MOCK) throw new HttpError(409, "Cloudflare 临时公网通道未就绪");
    if (Number(run.productImage?.size) > KLING_REFERENCE_IMAGE_MAX_BYTES) throw new HttpError(413, "商品图片超过 Kling 3.0 Omni 允许的 10MB");
    if (Number(run.sourceVideo?.size) > KLING_REFERENCE_VIDEO_MAX_BYTES) throw new HttpError(413, "参考视频超过 Kling 3.0 Omni 允许的 200MB");
    const publicMediaUrl = (item) => new URL(publicMedia(item).url, run.publicBaseUrl).toString();
    referenceUrls = {
      video: MOCK ? "https://mock.invalid/reference.mp4" : publicMediaUrl(run.sourceVideo),
      image: MOCK ? "https://mock.invalid/product.png" : publicMediaUrl(run.productImage)
    };
  } else if (!multiKeyframeMode) {
    content.push({ type: "image_url", image_url: { url: MOCK ? "https://mock.invalid/kling-result.png" : run.editedImage.remoteUrl }, role: "first_frame" });
  }
  const request = referenceMode ? {
    contents: [
      { type: "prompt", text: run.videoPrompt },
      { type: "base_video", url: referenceUrls.video, id: "source_video" },
      { type: "refer_image", url: referenceUrls.image, id: "product_image" }
    ],
    settings: {
      resolution: run.resolution.toLowerCase(),
      duration: run.duration,
      audio: run.audioMode === "silent" ? "off" : "original",
      multi_shot: false
    },
    options: {
      external_task_id: run.id,
      watermark_info: { enabled: false }
    }
  } : multiKeyframeMode ? {
    model: videoModel,
    prompt: run.videoPrompt,
    images: (run.editedKeyframes || []).map((item, index) => ({ url: MOCK ? `https://mock.invalid/keyframe-${index + 1}.png` : item.remoteUrl, role: "reference_image" })),
    ...(voiceAudioUrl ? { audios: [voiceAudioUrl] } : {}),
    resolution: run.resolution,
    duration: run.duration,
    ratio: run.ratio || "9:16"
  } : { model: videoModel, content, resolution: run.resolution, duration: run.duration, ratio: run.ratio || "9:16" };
  run.videoModel = videoModel;
  run.videoRequest = referenceMode ? {
    ...request,
    contents: request.contents.map((item) => item.type === "base_video"
      ? { ...item, url: "[Cloudflare reference video URL]" }
      : item.type === "refer_image" ? { ...item, url: "[Cloudflare product image URL]" } : item)
  } : multiKeyframeMode ? { ...request, images: request.images.map((_, index) => ({ url: `[Kling keyframe ${index + 1} URL]`, role: "reference_image" })), ...(request.audios ? { audios: ["[Cloudflare reference audio URL]"] } : {}) } : {
    ...request,
    content: request.content.map((item) => item.type === "image_url"
      ? { ...item, image_url: { url: referenceMode ? "[Cloudflare product image URL]" : "[Kling result URL]" } }
      : item.type === "video_url" ? { ...item, video_url: { url: "[Cloudflare reference video URL]" } } : item)
  };
  run.stage = "video";
  run.timing.videoStartedAt = new Date().toISOString();
  if (MOCK) {
    run.videoTaskId = `mock-video-${Date.now()}`;
    run.videoStatus = "PENDING";
  } else {
    const createPath = referenceMode ? "/omni-video/kling-3.0-omni" : "/v1/video/generations";
    const response = referenceMode
      ? await providerFetch(KLING_API_BASE, createPath, process.env.KLING_API_KEY, "Kling 3.0 Omni", { method: "POST", body: JSON.stringify(request) })
      : await providerFetch(H3_API_BASE, createPath, process.env.XINHANKR_API_KEY, "新站 MiniMax-H3", { method: "POST", body: JSON.stringify(request) });
    const task = referenceMode ? klingOmniTask(response) || response : response?.task || response;
    run.videoTaskId = taskId(response);
    run.videoLastResponse = response;
    if (referenceMode) run.billing.kling = mergeUsage(run.billing.kling, response, "kling", null);
    else run.billing.h3 = mergeUsage(run.billing.h3, response, "xinhankr", "CNY");
    run.videoStatus = task?.status || task?.task_status || "PENDING";
    if (!run.videoTaskId) throw new HttpError(502, `${referenceMode ? "Kling 3.0 Omni" : "新站 H3"} 响应中没有视频任务 ID`, response);
  }
  run.timing.videoSubmittedAt = new Date().toISOString();
  run.status = "PENDING";
  run.message = `${referenceMode ? "Kling 3.0 Omni" : "新站 MiniMax-H3"} 视频任务已提交`;
  run.updatedAt = new Date().toISOString();
  await persistRun(run);
  await logRun(run, "video_task_created", { videoTaskId: run.videoTaskId, videoMode: run.videoMode || "first_frame" });
}

async function createVideoVariant(source, videoPrompt, duration, resolution, videoMode) {
  const id = makeRunId();
  const now = new Date().toISOString();
  await ensureRunLayout(id);
  const [sourceVideo, productImage, voiceAudio, firstFrame, editedImage] = await Promise.all([
    cloneMediaItem(source.sourceVideo, id, join("inputs", "source-video")),
    cloneMediaItem(source.productImage, id, join("inputs", "product-image")),
    cloneMediaItem(source.voiceAudio, id, join("inputs", "voice-audio")),
    cloneMediaItem(source.firstFrame, id, "first-frame"),
    cloneMediaItem(source.editedImage, id, "kling-output")
  ]);
  const keyframes = await Promise.all((source.keyframes || []).map((item) => cloneMediaItem(item, id, join("keyframes", "source"))));
  const editedKeyframes = await Promise.all((source.editedKeyframes || []).filter(Boolean).map((item) => cloneMediaItem(item, id, "kling-output")));
  const videoModel = videoModelForMode(videoMode);
  const estimatedVideoCostCny = estimatedH3Cost(duration, resolution, videoModel);
  const run = {
    id,
    derivedFromRunId: source.id,
    lineage: { type: "video_rerun", sourceRunId: source.id, reusedEditedImage: videoMode === "first_frame", reusedEditedKeyframes: videoMode === "multi_keyframes", sourceImageTaskId: source.imageTaskId || null },
    status: "submitting", stage: "video", message: videoMode === "reference_video" ? "已复用参考素材，准备重新提交 Kling 3.0 Omni" : videoMode === "multi_keyframes" ? "已复用替换关键帧，准备提交 H3" : "已复用替换首帧，准备提交 H3", createdAt: now, updatedAt: now,
    imageModel: videoMode === "reference_video" ? null : source.imageModel || BAILIAN_IMAGE_MODEL, videoModel,
    imagePrompt: source.imagePrompt || null, videoPrompt, resolution, duration, ratio: source.ratio || "9:16", videoMode, publicBaseUrl: source.publicBaseUrl || null, audioMode: source.audioMode || "voice", voiceSource: source.voiceSource || "source_video", voiceScript: source.voiceScript || "",
    estimatedVideoCostCny, sourceVideo, productImage, voiceAudio, firstFrame, editedImage, keyframes, editedKeyframes, keyframeTimes: source.keyframeTimes || [], imageTasks: [], output: null,
    imageTaskId: videoMode === "reference_video" ? null : source.imageTaskId || null, imageStatus: videoMode === "reference_video" ? "SKIPPED" : "SUCCEEDED", imageReused: videoMode !== "reference_video",
    videoTaskId: null, videoStatus: null, imageRequest: null, imageLastResponse: null, videoRequest: null, videoLastResponse: null,
    timing: { runStartedAt: now, imageStartedAt: null, imageSubmittedAt: null, imageCompletedAt: null, imageElapsedMs: null, videoStartedAt: null, videoSubmittedAt: null, videoCompletedAt: null, videoElapsedMs: null, totalElapsedMs: null },
    billing: {
      estimate: videoMode === "reference_video"
        ? { provider: "kling", currency: "credits", videoAmount: null, basis: "provider_task_receipt" }
        : { provider: "xinhankr", currency: "CNY", videoAmount: estimatedVideoCostCny, basis: "output_seconds_x_base_rate_x_0.35_discount", discount: H3_OPEN_DISCOUNT },
      kling: { ...usageFrom(null, "kling", null), reusedFromRunId: source.id, chargedInThisRun: false },
      h3: usageFrom(null, "xinhankr", "CNY")
    }
  };
  runs.set(id, run);
  indexRunMedia(run);
  await persistRun(run);
  await logRun(run, "video_run_derived", { derivedFromRunId: source.id, sourceImageTaskId: source.imageTaskId || null });
  return run;
}

async function refreshRun(run, { force = false } = {}) {
  ensureRunMetrics(run);
  if (normalized(run.status) === "succeeded" || (!force && normalized(run.status) === "failed")) return;
  if (MOCK && Date.now() - new Date(run.updatedAt).getTime() > 700) {
    if (run.stage === "image") {
      if (run.videoMode === "multi_keyframes") {
        run.editedKeyframes = (run.keyframes || []).map((frame, index) => ({ ...frame, id: randomUUID(), name: `mock-edited-keyframe-${index + 1}.png`, remoteUrl: `mock://kling-keyframe-${index + 1}` }));
        run.imageTasks = run.editedKeyframes.map((editedImage, index) => ({ ...(run.imageTasks?.[index] || {}), index, status: "SUCCEEDED", editedImage }));
        run.editedKeyframes.forEach((item) => media.set(item.id, item));
      } else {
        run.editedImage = { ...run.firstFrame, id: randomUUID(), name: "mock-edited-first-frame.png", remoteUrl: "mock://kling-result" };
        media.set(run.editedImage.id, run.editedImage);
      }
      run.imageStatus = "SUCCEEDED";
      run.status = "SUCCEEDED";
      run.message = run.videoMode === "multi_keyframes" ? "Mock：替换关键帧已生成，请确认后启动 H3" : "Mock：替换首帧已生成，请确认后启动 H3";
      finishStageTiming(run, "image");
    } else {
      run.output = run.sourceVideo;
      if (run.audioMode === "silent") await removeOutputAudio(run);
      run.videoStatus = "COMPLETED";
      run.status = "SUCCEEDED";
      run.message = "Mock：路线 B 已完成";
      finishStageTiming(run, "video");
    }
    run.updatedAt = new Date().toISOString();
    await persistRun(run);
    return;
  }
  if (MOCK) return;

  if (run.stage === "image") {
    if (run.videoMode === "multi_keyframes") {
      for (const task of run.imageTasks || []) {
        if (normalized(task.status) === "succeeded" || (!force && normalized(task.status) === "failed")) continue;
        const response = await providerFetch(BAILIAN_API_BASE, `/api/v1/tasks/${encodeURIComponent(task.taskId)}`, process.env.BAILIAN_API_KEY, "阿里云百炼 Kling");
        task.lastResponse = response;
        task.status = response?.output?.task_status || response?.data?.task_status || response?.data?.status || "PENDING";
        run.imageLastResponse = response;
        run.billing.kling = mergeUsage(run.billing.kling, response, "aliyun-bailian-kling", "CNY");
        if (normalized(task.status) === "succeeded") {
          const url = bailianImageResult(response);
          if (!url) throw new HttpError(502, `阿里云百炼第 ${task.index + 1} 张关键帧成功但没有图片 URL`, response);
          task.editedImage = await archiveRemote(run, url, "image", "kling-output", `edited-keyframe-${task.index + 1}`);
        }
      }
      const failedTask = (run.imageTasks || []).find((task) => normalized(task.status) === "failed");
      const allSucceeded = run.imageTasks?.length && run.imageTasks.every((task) => normalized(task.status) === "succeeded" && task.editedImage);
      run.editedKeyframes = (run.imageTasks || []).map((task) => task.editedImage || null);
      if (failedTask) {
        run.imageStatus = "FAILED";
        run.status = "FAILED";
        run.message = `第 ${failedTask.index + 1} 张关键帧替换失败`;
        finishStageTiming(run, "image");
      } else if (allSucceeded) {
        run.imageStatus = "SUCCEEDED";
        run.status = "SUCCEEDED";
        run.message = "替换关键帧已全部归档，请确认后启动 H3";
        finishStageTiming(run, "image");
      } else {
        run.imageStatus = "PROCESSING";
        run.status = "PROCESSING";
        const completed = run.imageTasks.filter((task) => normalized(task.status) === "succeeded").length;
        run.message = `正在替换关键帧（${completed}/${run.imageTasks.length}）`;
      }
    } else {
      const response = await providerFetch(BAILIAN_API_BASE, `/api/v1/tasks/${encodeURIComponent(run.imageTaskId)}`, process.env.BAILIAN_API_KEY, "阿里云百炼 Kling");
      run.imageLastResponse = response;
      run.billing.kling = mergeUsage(run.billing.kling, response, "aliyun-bailian-kling", "CNY");
      run.imageStatus = response?.output?.task_status || response?.data?.task_status || response?.data?.status || "PENDING";
      const status = normalized(run.imageStatus);
      if (status === "succeeded") {
        const url = bailianImageResult(response);
        if (!url) throw new HttpError(502, "阿里云百炼图片任务成功但没有图片 URL", response);
        run.editedImage = await archiveRemote(run, url, "image", "kling-output", "edited-first-frame");
        run.status = "SUCCEEDED";
        run.message = "替换首帧已归档，请确认后启动 H3";
        finishStageTiming(run, "image");
      } else if (status === "failed") {
        run.status = "FAILED";
        run.message = response?.output?.message || response?.data?.task_status_msg || response?.message || "阿里云百炼图片任务失败";
        finishStageTiming(run, "image");
      } else {
        run.status = "PROCESSING";
        run.message = "正在替换商品";
      }
    }
  } else {
    let response;
    const referenceMode = run.videoMode === "reference_video";
    const klingOmniMode = referenceMode && run.videoModel === KLING_VIDEO_OMNI_MODEL;
    const queryPath = klingOmniMode
      ? `/tasks?task_ids=${encodeURIComponent(run.videoTaskId)}`
      : referenceMode ? `/v2/query/video_generation/${encodeURIComponent(run.videoTaskId)}` : `/v1/video/generations/${encodeURIComponent(run.videoTaskId)}`;
    try {
      response = klingOmniMode
        ? await providerFetch(KLING_API_BASE, queryPath, process.env.KLING_API_KEY, "Kling 3.0 Omni")
        : await providerFetch(H3_API_BASE, queryPath, process.env.XINHANKR_API_KEY, "新站 MiniMax-H3");
    } catch (error) {
      const failedStatus = klingOmniMode
        ? normalized(klingOmniTask(error.details)?.status || klingOmniTask(error.details)?.task_status)
        : normalized(error.details?.task?.status || error.details?.status);
      if (failedStatus !== "failed") throw error;
      response = error.details;
    }
    const task = klingOmniMode ? klingOmniTask(response) : response?.task || response;
    if (!task) throw new HttpError(502, `${klingOmniMode ? "Kling 3.0 Omni" : "H3"} 查询结果中没有任务`, response);
    run.videoLastResponse = response;
    if (klingOmniMode) run.billing.kling = mergeUsage(run.billing.kling, response, "kling", null);
    else run.billing.h3 = mergeUsage(run.billing.h3, response, "xinhankr", "CNY");
    run.videoStatus = task?.status || task?.task_status || "PENDING";
    const status = normalized(run.videoStatus);
    if (status === "succeeded") {
      const url = klingOmniMode ? klingOmniVideoResult(task) : h3VideoResult(task);
      if (!url) throw new HttpError(502, `${klingOmniMode ? "Kling 3.0 Omni" : "H3"} 视频任务成功但没有视频 URL`, response);
      run.output = await archiveRemote(run, url, "video", "output", klingOmniMode ? "kling-3-omni-output" : "minimax-h3-output");
      if (run.audioMode === "silent") await removeOutputAudio(run);
      run.status = "SUCCEEDED";
      run.message = "路线 B 已完成，视频已归档";
      finishStageTiming(run, "video");
    } else if (status === "failed") {
      run.status = "FAILED";
      run.message = task?.error?.message || task?.message || `${klingOmniMode ? "Kling 3.0 Omni" : "H3"} 视频任务失败`;
      finishStageTiming(run, "video");
    } else {
      run.status = "PROCESSING";
      run.message = `${klingOmniMode ? "Kling 3.0 Omni" : "MiniMax-H3"} 正在生成视频`;
    }
  }
  run.updatedAt = new Date().toISOString();
  await persistRun(run);
  await logRun(run, "run_refreshed", { stage: run.stage, status: run.status });
}

async function readJson(req, limit = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, "请求数据过大");
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); }
  catch { throw new HttpError(400, "请求不是有效 JSON"); }
}

function requireMedia(id, prefix, label) {
  const item = media.get(id);
  if (!item || !item.mime.startsWith(prefix)) throw new HttpError(400, `缺少有效的${label}`);
  return item;
}

async function serveStatic(res, pathname) {
  const name = pathname === "/" ? "index.html" : pathname.slice(1);
  if (!new Set(["index.html", "app.js", "styles.css"]).has(name)) throw new HttpError(404, "页面不存在");
  const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
  res.writeHead(200, { "Content-Type": types[extname(name)], "Cache-Control": "no-store" });
  res.end(await readFile(join(PUBLIC_DIR, name)));
}

const server = http.createServer(async (req, res) => {
  const traceId = randomUUID();
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (req.method === "GET" && url.pathname === "/api/health") return sendJson(res, 200, { ok: true, service: "kling-h3-route-b", version: "0.1.0" });
    if (req.method === "GET" && url.pathname === "/api/config") return sendJson(res, 200, {
      configured: MOCK || Boolean(process.env.BAILIAN_API_KEY && process.env.XINHANKR_API_KEY),
      klingConfigured: MOCK || Boolean(process.env.KLING_API_KEY),
      imageConfigured: MOCK || Boolean(process.env.BAILIAN_API_KEY),
      h3Configured: MOCK || Boolean(process.env.XINHANKR_API_KEY),
      mock: MOCK,
      imageModel: BAILIAN_IMAGE_MODEL,
      videoModel: H3_OPEN_MODEL,
      referenceVideoModel: KLING_VIDEO_OMNI_MODEL
    });
    if (req.method === "POST" && url.pathname === "/api/run-id") {
      const runId = makeRunId();
      await ensureRunLayout(runId);
      const now = new Date().toISOString();
      const run = {
        id: runId, status: "draft", stage: "upload", message: "Run 已创建，等待上传素材", createdAt: now, updatedAt: now,
        timing: { runStartedAt: now, imageStartedAt: null, imageSubmittedAt: null, imageCompletedAt: null, imageElapsedMs: null, videoStartedAt: null, videoSubmittedAt: null, videoCompletedAt: null, videoElapsedMs: null, totalElapsedMs: null },
        billing: {
          estimate: { provider: "xinhankr", currency: "CNY", videoAmount: null, basis: "output_seconds_x_base_rate_x_0.35_discount", discount: H3_OPEN_DISCOUNT },
          kling: usageFrom(null, "kling", null),
          h3: usageFrom(null, "xinhankr", "CNY")
        }
      };
      runs.set(runId, run);
      await persistRun(run);
      await logRun(run, "run_allocated");
      return sendJson(res, 201, { runId });
    }
    if (req.method === "GET" && url.pathname === "/api/runs") return sendJson(res, 200, { runs: [...runs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(publicRun) });
    if (req.method === "POST" && url.pathname === "/api/media") {
      const runId = safePart(url.searchParams.get("runId"), "invalid");
      if (runId === "invalid") throw new HttpError(400, "缺少 runId");
      const run = runs.get(runId);
      if (!run) throw new HttpError(404, "Run 不存在，请先创建 Run ID");
      const requestedKind = url.searchParams.get("kind");
      const kind = requestedKind === "video" ? "video" : requestedKind === "audio" ? "audio" : "image";
      const category = mediaCategory(url.searchParams.get("category"));
      const item = await receiveMedia(req, kind, runId, category, url.searchParams.get("name"));
      if (category === join("inputs", "source-video")) run.sourceVideo = item;
      else if (category === join("inputs", "product-image")) run.productImage = item;
      else if (category === join("inputs", "voice-audio")) run.voiceAudio = item;
      else if (category === "first-frame") run.firstFrame = item;
      else if (category === join("keyframes", "source")) (run.keyframes ||= []).push(item);
      run.updatedAt = new Date().toISOString();
      await persistRun(run);
      await logRun(run, "media_uploaded", { category: item.category, mediaId: item.id, size: item.size });
      return sendJson(res, 201, publicMedia(item));
    }
    if (req.method === "POST" && url.pathname === "/api/runs") {
      const body = await readJson(req);
      const id = safePart(body.runId, "invalid");
      const run = runs.get(id);
      if (id === "invalid" || !run || run.status !== "draft") throw new HttpError(409, "runId 无效、未创建或已经提交");
      const imagePrompt = String(body.imagePrompt || "").trim();
      const videoPrompt = String(body.videoPrompt || "").trim();
      const duration = Number(body.duration);
      const resolution = body.resolution;
      const videoMode = body.videoMode === "reference_video" ? "reference_video" : body.videoMode === "multi_keyframes" ? "multi_keyframes" : "first_frame";
      const videoModel = videoModelForMode(videoMode);
      const allowedResolutions = videoResolutionsForMode(videoMode);
      const publicBaseInput = String(body.publicBaseUrl || "").trim();
      const publicBaseUrl = publicBaseInput ? publicBaseInput.replace(/\/?$/, "/") : null;
      const audioMode = body.audioMode === "silent" ? "silent" : "voice";
      const voiceSource = body.voiceSource === "upload" ? "upload" : "source_video";
      const voiceScript = String(body.voiceScript || "").trim();
      if (!imagePrompt || imagePrompt.length > 2500) throw new HttpError(400, "图片 Prompt 必填且不能超过 2500 字符");
      if (!videoPrompt || videoPrompt.length > 7000) throw new HttpError(400, "视频 Prompt 必填且不能超过 7000 字符");
      if (videoMode === "reference_video" && Buffer.byteLength(videoPrompt, "utf8") > KLING_OMNI_PROMPT_MAX_BYTES) throw new HttpError(400, "Kling 3.0 Omni 提示词不能超过 3072 字节");
      if (!Number.isInteger(duration) || duration < 4 || duration > 15) throw new HttpError(400, "输出时长必须是 4-15 秒整数");
      if (videoMode === "reference_video" && ![5, 10, 15].includes(duration)) throw new HttpError(400, "Kling 3.0 Omni 参考视频模式仅支持 5、10 或 15 秒");
      if (!allowedResolutions.includes(resolution)) throw new HttpError(400, `当前生成方式分辨率必须是 ${allowedResolutions.join(" 或 ")}`);
      if (videoMode !== "reference_video" && audioMode === "voice" && !voiceScript) throw new HttpError(400, "声音与口型开启时必须填写台词");
      if (videoMode !== "reference_video" && audioMode === "voice" && !publicBaseUrl && !MOCK) throw new HttpError(400, "声音与口型开启时必须提供参考声音公网通道");
      const sourceVideo = requireMedia(body.sourceVideoId, "video/", "原视频");
      const uploadedVoiceAudio = videoMode !== "reference_video" && audioMode === "voice" && voiceSource === "upload"
        ? requireMedia(body.voiceAudioId, "audio/", "声音样本")
        : null;
      Object.assign(run, {
        status: "submitting", stage: videoMode === "reference_video" ? "video" : "image", message: videoMode === "reference_video" ? "准备提交 Kling 3.0 Omni 参考视频任务" : videoMode === "multi_keyframes" ? "准备提交多张关键帧替换任务" : "准备提交商品替换任务", updatedAt: new Date().toISOString(),
        imageModel: videoMode === "reference_video" ? null : BAILIAN_IMAGE_MODEL, videoModel, imagePrompt, videoPrompt, resolution, duration, ratio: videoMode === "reference_video" ? "adaptive" : "9:16", videoMode, publicBaseUrl, audioMode, voiceSource, voiceScript,
        estimatedVideoCostCny: estimatedH3Cost(duration, resolution, videoModel),
        sourceVideo,
        productImage: requireMedia(body.productImageId, "image/", "商品图片"),
        voiceAudio: uploadedVoiceAudio,
        firstFrame: videoMode === "first_frame" ? requireMedia(body.firstFrameId, "image/", "首帧图片") : null,
        keyframes: videoMode === "multi_keyframes" ? (Array.isArray(body.keyframeIds) ? body.keyframeIds : []).map((mediaId) => requireMedia(mediaId, "image/", "关键帧图片")) : [],
        keyframeTimes: videoMode === "multi_keyframes" && Array.isArray(body.keyframeTimes) ? body.keyframeTimes.map(Number) : [],
        editedImage: null, editedKeyframes: [], imageTasks: [], output: null, imageTaskId: null, imageStatus: null, videoTaskId: null, videoStatus: null,
        imageRequest: null, imageLastResponse: null, videoRequest: null, videoLastResponse: null
      });
      if (videoMode !== "reference_video" && audioMode === "voice" && voiceSource === "source_video") {
        try {
          run.voiceAudio = await extractVoiceAudio(sourceVideo, id, duration);
        } catch (error) {
          run.status = "FAILED";
          run.stage = "upload";
          run.message = error.message;
          run.updatedAt = new Date().toISOString();
          await persistRun(run);
          await logRun(run, "voice_audio_extract_failed", { message: error.message });
          throw error;
        }
      }
      if (videoMode === "multi_keyframes" && (run.keyframes.length < 2 || run.keyframes.length > 9)) throw new HttpError(400, "多参考关键帧必须为 2-9 张");
      run.billing.estimate.videoAmount = run.estimatedVideoCostCny;
      if (videoMode === "reference_video") Object.assign(run.billing.estimate, { provider: "kling", currency: "credits", basis: "provider_task_receipt", discount: null });
      indexRunMedia(run);
      await persistRun(run);
      await logRun(run, "run_created");
      try {
        if (videoMode === "reference_video") {
          run.imageStatus = "SKIPPED";
          await createVideoStage(run);
        } else {
          await createImageStage(run);
        }
      } catch (error) {
        run.status = "FAILED";
        run.message = error.message;
        if (videoMode === "reference_video") {
          run.videoStatus = "FAILED";
          run.videoLastResponse = error.details;
          run.billing.kling = mergeUsage(run.billing.kling, error.details, "kling", null);
          finishStageTiming(run, "video");
        } else {
          run.imageLastResponse = error.details;
          run.billing.kling = mergeUsage(run.billing.kling, error.details, "kling", null);
          finishStageTiming(run, "image");
        }
        await persistRun(run);
        throw error;
      }
      return sendJson(res, 201, publicRun(run));
    }
    const videoMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/video$/);
    if (req.method === "POST" && videoMatch) {
      const sourceRun = runs.get(videoMatch[1]);
      if (!sourceRun) throw new HttpError(404, "Run 不存在");
      const body = await readJson(req);
      const requestedVideoMode = body.videoMode === "reference_video" ? "reference_video" : body.videoMode === "multi_keyframes" ? "multi_keyframes" : "first_frame";
      const videoModel = videoModelForMode(requestedVideoMode);
      const allowedResolutions = videoResolutionsForMode(requestedVideoMode);
      const publicBaseInput = String(body.publicBaseUrl || "").trim();
      const publicBaseUrl = publicBaseInput ? publicBaseInput.replace(/\/?$/, "/") : sourceRun.publicBaseUrl || null;
      if (requestedVideoMode === "first_frame" && (!sourceRun.editedImage || normalized(sourceRun.imageStatus) !== "succeeded")) throw new HttpError(409, "请先完成并确认替换首帧");
      if (requestedVideoMode === "multi_keyframes" && (!sourceRun.editedKeyframes?.length || sourceRun.editedKeyframes.some((item) => !item) || normalized(sourceRun.imageStatus) !== "succeeded")) throw new HttpError(409, "请先完成并确认全部替换关键帧");
      if (sourceRun.videoTaskId && ["submitted", "processing", "pending", "in_progress"].includes(normalized(sourceRun.videoStatus))) throw new HttpError(409, "当前视频任务仍在处理中");
      if (sourceRun.videoTaskId && body.confirmResubmit !== true) throw new HttpError(409, "已有视频任务；请先检查并恢复原任务，禁止自动重复提交以避免重复计费");
      const videoPrompt = String(body.videoPrompt || sourceRun.videoPrompt || "").trim();
      const duration = Number(body.duration || sourceRun.duration);
      const resolution = allowedResolutions.includes(body.resolution) ? body.resolution : sourceRun.resolution;
      const videoMode = requestedVideoMode;
      if (!videoPrompt || videoPrompt.length > 7000) throw new HttpError(400, "视频 Prompt 必填且不能超过 7000 字符");
      if (videoMode === "reference_video" && Buffer.byteLength(videoPrompt, "utf8") > KLING_OMNI_PROMPT_MAX_BYTES) throw new HttpError(400, "Kling 3.0 Omni 提示词不能超过 3072 字节");
      if (!Number.isInteger(duration) || duration < 4 || duration > 15) throw new HttpError(400, "输出时长必须是 4-15 秒整数");
      if (videoMode === "reference_video" && ![5, 10, 15].includes(duration)) throw new HttpError(400, "Kling 3.0 Omni 参考视频模式仅支持 5、10 或 15 秒");
      if (!allowedResolutions.includes(resolution)) throw new HttpError(400, `当前生成方式分辨率必须是 ${allowedResolutions.join(" 或 ")}`);
      const run = sourceRun.videoTaskId ? await createVideoVariant(sourceRun, videoPrompt, duration, resolution, videoMode) : sourceRun;
      run.videoPrompt = videoPrompt;
      run.voiceScript = String(body.voiceScript ?? run.voiceScript ?? "").trim();
      run.audioMode = body.audioMode === "silent" ? "silent" : run.audioMode || "voice";
      run.duration = duration;
      run.resolution = resolution;
      run.videoMode = videoMode;
      run.videoModel = videoModel;
      run.publicBaseUrl = publicBaseUrl;
      run.estimatedVideoCostCny = estimatedH3Cost(run.duration, run.resolution, videoModel);
      run.billing.estimate.videoAmount = run.estimatedVideoCostCny;
      try { await createVideoStage(run); }
      catch (error) { run.status = "FAILED"; run.videoStatus = "FAILED"; run.message = error.message; run.videoLastResponse = error.details; if (videoMode === "reference_video") run.billing.kling = mergeUsage(run.billing.kling, error.details, "kling", null); else run.billing.h3 = mergeUsage(run.billing.h3, error.details, "xinhankr", "CNY"); finishStageTiming(run, "video"); await persistRun(run); throw error; }
      return sendJson(res, 201, publicRun(run));
    }
    const resumeMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/resume$/);
    if (req.method === "POST" && resumeMatch) {
      const run = runs.get(resumeMatch[1]);
      if (!run) throw new HttpError(404, "Run 不存在");
      const hasProviderTask = run.stage === "video"
        ? Boolean(run.videoTaskId)
        : run.videoMode === "multi_keyframes"
          ? Boolean(run.imageTasks?.some((task) => task.taskId))
          : Boolean(run.imageTaskId);
      if (!hasProviderTask) throw new HttpError(409, "原任务没有可查询的任务 ID；为避免重复计费，未自动重新提交");
      await refreshRun(run, { force: true });
      await logRun(run, "run_resume_checked", { stage: run.stage, status: run.status });
      return sendJson(res, 200, publicRun(run));
    }
    const runMatch = url.pathname.match(/^\/api\/runs\/([^/]+)$/);
    if (req.method === "GET" && runMatch) {
      const run = runs.get(runMatch[1]);
      if (!run) throw new HttpError(404, "Run 不存在");
      await refreshRun(run);
      return sendJson(res, 200, publicRun(run));
    }
    const retryImageMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/image\/retry$/);
    if (req.method === "POST" && retryImageMatch) {
      const run = runs.get(retryImageMatch[1]);
      if (!run) throw new HttpError(404, "Run 不存在");
      const body = await readJson(req);
      const retryIndexes = [...new Set((Array.isArray(body.indexes) ? body.indexes : url.searchParams.has("index") ? [Number(url.searchParams.get("index"))] : []).map(Number))].sort((a, b) => a - b);
      if (!run.productImage || (run.videoMode === "multi_keyframes" ? !run.keyframes?.length : !run.firstFrame)) throw new HttpError(409, "缺少产品图或原始关键帧");
      run.status = "submitting";
      run.stage = "image";
      run.imageTaskId = null;
      run.imageStatus = null;
      if (run.videoMode === "multi_keyframes") {
        if (!retryIndexes.length || retryIndexes.some((index) => !Number.isInteger(index) || !run.keyframes[index])) throw new HttpError(400, "请选择需要重试的关键帧");
        run.message = retryIndexes.length === 1 ? `重新提交第 ${retryIndexes[0] + 1} 张关键帧` : `重新提交 ${retryIndexes.length} 张关键帧`;
      } else {
        run.editedImage = null;
        run.message = "重新提交商品替换首帧";
      }
      await persistRun(run);
      await createImageStage(run, run.videoMode === "multi_keyframes" ? retryIndexes : null);
      return sendJson(res, 202, publicRun(run));
    }
    const mediaMatch = url.pathname.match(/^\/media\/([^/]+)\//);
    if (req.method === "GET" && mediaMatch) {
      const item = media.get(mediaMatch[1]);
      if (!item) throw new HttpError(404, "媒体不存在");
      const info = await stat(item.path);
      res.writeHead(200, { "Content-Type": item.mime, "Content-Length": info.size, "Cache-Control": "no-store" });
      return createReadStream(item.path).pipe(res);
    }
    if (req.method === "GET") return await serveStatic(res, url.pathname);
    throw new HttpError(404, "接口不存在");
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    if (!res.headersSent && !res.writableEnded) {
      sendJson(res, status, { error: error.message, details: error.details, traceId });
    } else if (!res.writableEnded) {
      res.end();
    }
  }
});

server.listen(PORT, HOST, () => {
  console.log(`阿里云百炼 Kling Image -> MiniMax H3: http://127.0.0.1:${PORT}`);
  console.log(MOCK ? "Mode: mock" : "Mode: live");
});

class HttpError extends Error {
  constructor(status, message, details) { super(message); this.status = status; this.details = details; }
}

async function loadEnv(path) {
  let text;
  try { text = await readFile(path, "utf8"); } catch { return; }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index < 1) continue;
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (!(key in process.env)) process.env[key] = value;
  }
}
