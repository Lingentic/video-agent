import http from "node:http";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { appendFile, copyFile, lstat, mkdir, open, readFile, readdir, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHmac, randomUUID } from "node:crypto";
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
const WAW_API_BASE = (process.env.WAW_API_BASE || "https://wawapii.com/v1").replace(/\/$/, "");
const WAW_IMAGE_MODEL = "gpt-image-2";
const imageWorkers = new Set();
const submissionClaims = new Set();
const KLING_API_BASE = (process.env.KLING_API_BASE || "https://api-singapore.klingai.com").replace(/\/$/, "");
const BAILIAN_API_BASE = (process.env.BAILIAN_API_BASE || "https://dashscope.aliyuncs.com").replace(/\/$/, "");
const BAILIAN_IMAGE_MODEL = process.env.BAILIAN_IMAGE_MODEL || "kling/kling-v3-omni-image-generation";
const BAILIAN_IMAGE_RESOLUTION = process.env.BAILIAN_IMAGE_RESOLUTION || "1k";
const BAILIAN_IMAGE_API_BASE = (process.env.BAILIAN_IMAGE_API_BASE || BAILIAN_API_BASE).replace(/\/$/, "");
const BAILIAN_IMAGE_POLL_MS = Math.max(20, Number(process.env.BAILIAN_IMAGE_POLL_MS) || 5000);
const KLING_VIDEO_OMNI_MODEL = process.env.KLING_VIDEO_OMNI_MODEL || "kling-3.0-omni";
const H3_API_BASE = (process.env.XINHANKR_API_BASE || "https://token.xinhankr.com").replace(/\/$/, "");
const H3_OPEN_MODEL = process.env.XINHANKR_H3_OPEN_MODEL || "MiniMax-H3";
const AIMANPLAY_API_BASE = (process.env.AIMANPLAY_API_BASE || "https://aimanplay.cn").replace(/\/$/, "");
const AIMANPLAY_VIDEO_MODEL = "minimax_h3_image_audio_to_video_v2_15s";
const AIMANPLAY_VIDEO_RATE_CNY = 0.06;
const FFMPEG_PATH = process.env.FFMPEG_PATH || "ffmpeg";
const H3_OPEN_DISCOUNT = 0.35;
const KLING_OMNI_PROMPT_MAX_BYTES = 3072;
const KLING_REFERENCE_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const KLING_REFERENCE_VIDEO_MAX_BYTES = 200 * 1024 * 1024;

function videoModelForMode(videoMode) {
  return videoMode === "reference_video" ? KLING_VIDEO_OMNI_MODEL : videoMode === "multi_keyframes" ? AIMANPLAY_VIDEO_MODEL : H3_OPEN_MODEL;
}

function videoResolutionsForMode(videoMode) {
  return videoMode === "reference_video" ? ["720P", "1080P"] : ["768P"];
}

function estimatedVideoCost(duration, resolution, model) {
  if (model === AIMANPLAY_VIDEO_MODEL) return Number((duration * AIMANPLAY_VIDEO_RATE_CNY).toFixed(6));
  if (model !== "MiniMax-H3-open") return null;
  const baseRate = resolution === "480P" ? 0.3 : 0.5;
  return Number((duration * baseRate * H3_OPEN_DISCOUNT).toFixed(6));
}

await mkdir(RUNS_DIR, { recursive: true });
const runs = new Map();
const media = new Map();
const runWriteQueues = new Map();
const frameCleanupWorkers = new Map();
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
  return item && !item.localDeletedAt ? { id: item.id, name: item.name, mime: item.mime, size: item.size, url: `/media/${item.id}/${encodeURIComponent(item.name)}` } : null;
}

function publicRun(run) {
  ensureRunMetrics(run);
  return {
    ...run,
    productSubject: run.productSubject || "",
    sourceVideo: publicMedia(run.sourceVideo),
    productImage: publicMedia(run.productImage),
    productImages: run.productImages.map(publicMedia),
    fallbackProductImages: undefined,
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
  run.productImages = Array.isArray(run.productImages) ? run.productImages : run.productImage ? [run.productImage] : [];
  run.productImage = run.productImages[0] || null;
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
  run.billing.estimate ||= { provider: run.videoModel === AIMANPLAY_VIDEO_MODEL ? "aimanplay" : "xinhankr", currency: "CNY", videoAmount: run.estimatedVideoCostCny ?? null, basis: run.videoModel === AIMANPLAY_VIDEO_MODEL ? "declared_seconds_x_0.06" : "output_seconds_x_base_rate_x_0.35_discount" };
  run.billing.kling ||= usageFrom(null, "kling", null);
  run.billing.h3 ||= usageFrom(null, "xinhankr", "CNY");
  return run;
}

function rejectUserStoppedRun(run) {
  if (run.userStopped) throw new HttpError(409, "任务已在本地结束，不能再次提交付费生成");
  if (frameCleanupWorkers.has(run.id)) throw new HttpError(409, "成片关键帧正在清理，请稍后再试");
  if (submissionClaims.has(run.id)) throw new HttpError(409, "任务提交正在准备中，请稍后再试");
}

function claimRunSubmission(...runsToClaim) {
  const uniqueRuns = [...new Map(runsToClaim.map((run) => [run.id, run])).values()];
  for (const run of uniqueRuns) rejectUserStoppedRun(run);
  for (const run of uniqueRuns) submissionClaims.add(run.id);
  return () => { for (const run of uniqueRuns) submissionClaims.delete(run.id); };
}

function indexRunMedia(run) {
  for (const item of [run.sourceVideo, ...(run.productImages || []), ...(run.fallbackProductImages || []), run.voiceAudio, run.firstFrame, run.editedImage, ...(run.keyframes || []), ...(run.editedKeyframes || []), ...(run.imageTasks || []).map((task) => task.editedImage), run.output]) {
    if (item?.id && item?.path && !item.localDeletedAt) media.set(item.id, item);
  }
}

async function cleanupRunKeyframes(run) {
  if (run.stage !== "video" || normalized(run.status) !== "succeeded" || !run.output?.path || imageWorkers.has(run.id) || submissionClaims.has(run.id)) return;
  if (run.keyframeCleanup?.completedAt && run.keyframeCleanup.outputId === run.output.id) return;
  if (frameCleanupWorkers.has(run.id)) return frameCleanupWorkers.get(run.id);
  const work = (async () => {
    const inside = (root, target) => { const rel = relative(root, target); return Boolean(rel) && !rel.startsWith("..") && !isAbsolute(rel); };
    if (!/^[a-zA-Z0-9_.-]+$/.test(run.id) || [".", ".."].includes(run.id)) return;
    const runRoot = resolve(RUNS_DIR, run.id);
    if (!inside(resolve(RUNS_DIR), runRoot)) return;
    let rootReal;
    try {
      if ((await lstat(runRoot)).isSymbolicLink()) return;
      rootReal = await realpath(runRoot);
      if (!inside(await realpath(RUNS_DIR), rootReal)) return;
      const output = resolve(run.output.path);
      const outputRoot = resolve(runRoot, "output");
      if (!inside(outputRoot, output) || (await lstat(outputRoot)).isSymbolicLink() || (await lstat(output)).isSymbolicLink()) return;
      const outputReal = await realpath(output);
      if (!inside(resolve(rootReal, "output"), outputReal) || !(await stat(outputReal)).isFile() || !(await stat(outputReal)).size) return;
      const { stdout } = await execFileAsync(process.env.FFPROBE_PATH || "ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height", "-of", "json", outputReal], { windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
      const info = JSON.parse(stdout);
      if (!(Number(info.format?.duration) > 0) || !info.streams?.some(stream => stream.codec_type === "video" && stream.width > 0 && stream.height > 0)) return;
    } catch { return; } // Missing or invalid final video: keep recoverable images.
    // Save the successful output receipt before removing any paid image result.
    await persistRun(run);
    const items = [run.firstFrame, run.editedImage, ...(run.keyframes || []), ...(run.editedKeyframes || []), ...(run.imageTasks || []).map(task => task.editedImage), ...(run.imageHistory || []).map(task => task.editedImage)].filter(Boolean);
    const knownPaths = new Set([...items.map(item => item.path), ...(run.imageTasks || []).flatMap(task => [task.rawPath, task.responsePath]), ...(run.imageHistory || []).flatMap(task => [task.rawPath, task.responsePath])].filter(Boolean).map(file => resolve(file)));
    const protectedPaths = new Set([run.sourceVideo, run.productImage, ...(run.productImages || []), run.voiceAudio, run.output, run.outputWithAudio].filter(item => item?.path).map(item => resolve(item.path)));
    const frameDirectories = [join("keyframes", "source"), "first-frame", "kling-output"].map(category => resolve(runRoot, category));
    const deletedPaths = new Set();
    const stamp = new Date().toISOString();
    try {
      for (const directory of frameDirectories) {
        if (!inside(runRoot, directory)) continue;
        try {
          if ((await lstat(directory)).isSymbolicLink() || !inside(rootReal, await realpath(directory))) continue;
        } catch (error) { if (error.code === "ENOENT") continue; throw error; }
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          const file = resolve(directory, entry.name);
          // Include orphaned retry outputs/cache files only with provider-generated UUID names.
          const generated = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}(?:-original)?\.(?:png|jpg|jpeg|webp|json)$/i.test(entry.name);
          if (!inside(directory, file) || protectedPaths.has(file) || !entry.isFile() || (!knownPaths.has(file) && !generated)) continue;
          if ((await lstat(file)).isSymbolicLink() || !inside(rootReal, await realpath(file))) continue;
          await unlink(file);
          deletedPaths.add(file);
        }
      }
      for (const item of items) {
        if (!item.path || protectedPaths.has(resolve(item.path)) || !frameDirectories.some(directory => inside(directory, resolve(item.path)))) continue;
        let missing = deletedPaths.has(resolve(item.path));
        if (!missing) { try { await lstat(item.path); } catch (error) { missing = error.code === "ENOENT"; } }
        if (missing) { item.localDeletedAt = stamp; media.delete(item.id); }
      }
      for (const task of [...(run.imageTasks || []), ...(run.imageHistory || [])]) {
        for (const field of ["rawPath", "responsePath"]) {
          if (!task[field] || protectedPaths.has(resolve(task[field])) || !frameDirectories.some(directory => inside(directory, resolve(task[field])))) continue;
          let missing = deletedPaths.has(resolve(task[field]));
          if (!missing) { try { await lstat(task[field]); } catch (error) { missing = error.code === "ENOENT"; } }
          if (missing) task[field] = null;
        }
      }
      run.keyframeCleanup = { outputId: run.output.id, completedAt: stamp, deletedFileCount: Number(run.keyframeCleanup?.deletedFileCount || 0) + deletedPaths.size };
    } catch {
      // Cleanup failure never turns a successfully archived video into a generation failure.
      run.keyframeCleanup = { outputId: run.output.id, pending: true, deletedFileCount: Number(run.keyframeCleanup?.deletedFileCount || 0) + deletedPaths.size };
    }
    await persistRun(run);
  })();
  const tracked = work.catch(() => {}); // Includes concurrent callers: cleanup must not fail video delivery.
  frameCleanupWorkers.set(run.id, tracked);
  try { await tracked; }
  finally { frameCleanupWorkers.delete(run.id); }
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
      await cleanupRunKeyframes(run);
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
  const fallbackName = kind === "video" ? "source.mp4" : kind === "audio" ? "voice.mp3" : "image.png";
  // Display names retain Unicode; on-disk files still use UUIDs and safe extensions.
  const name = String(originalName || "").split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f]/g, "").trim() || fallbackName;
  if (!allowedMedia(kind, mime, name)) throw new HttpError(415, kind === "video" ? "视频仅支持 MP4/MOV" : kind === "audio" ? "声音样本仅支持 MP3/WAV/M4A" : "图片仅支持 JPG/PNG/WebP");
  const id = randomUUID();
  const ext = extname(safePart(name, fallbackName)) || (kind === "video" ? ".mp4" : kind === "audio" ? ".mp3" : ".png");
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

function aimanplayToken() {
  const token = String(process.env.AIMANPLAY_TOKEN || "").trim();
  if (!token || token === "sk-your-token") throw new HttpError(503, "视频生成服务尚未配置，请稍后再试");
  return token;
}

function aimanplayConfigured() {
  const token = String(process.env.AIMANPLAY_TOKEN || "").trim();
  return Boolean(token && token !== "sk-your-token");
}

async function aimanplayJson(pathname, options = {}, timeoutMs = 30_000) {
  const token = aimanplayToken();
  let response;
  try {
    response = await fetch(`${AIMANPLAY_API_BASE}${pathname}`, {
      ...options,
      headers: { Authorization: `Bearer ${token}`, ...(options.body ? { "Content-Type": "application/json" } : {}) },
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    const failure = new HttpError(502, "视频服务连接暂时不稳定，请稍后再试");
    failure.transport = true;
    failure.cause = error;
    throw failure;
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = response.status === 401 ? "视频服务凭证无效" : response.status === 402 ? "视频服务余额不足" : response.status === 429 ? "视频服务请求过于频繁，请稍后再试" : "视频服务暂时未能处理请求";
    throw new HttpError(response.status, message, body);
  }
  return body;
}

function aimanplayMime(item) {
  const extension = extname(item?.path || "").toLowerCase();
  if (extension === ".png") return "image/png";
  if ([".jpg", ".jpeg"].includes(extension)) return "image/jpeg";
  if (extension === ".wav") return "audio/wav";
  if (extension === ".mp3") return "audio/mpeg";
  throw new HttpError(400, "视频服务暂不支持当前关键帧或声音格式");
}

async function aimanplayUpload(item, sts) {
  const mime = aimanplayMime(item);
  const isAudio = mime.startsWith("audio/");
  const limit = Number(isAudio ? sts.maxAudioBytes : sts.maxImageBytes) || (isAudio ? 20 : 10) * 1024 * 1024;
  if (Number(item.size) > limit) throw new HttpError(413, isAudio ? "参考音频过大" : "替换关键帧过大");
  const required = ["host", "dir", "bucket", "accessKeyId", "accessKeySecret", "securityToken"];
  if (required.some((key) => !sts[key])) throw new HttpError(502, "视频服务素材通道未就绪");
  const host = String(sts.host).replace(/\/$/, "");
  const loopbackTestHost = process.env.NODE_ENV === "test" && AIMANPLAY_API_BASE.startsWith("http://127.0.0.1:") && host.startsWith("http://127.0.0.1:");
  if (!host.startsWith("https://") && !loopbackTestHost) throw new HttpError(502, "视频服务素材通道地址无效");
  const dir = String(sts.dir).replace(/^\/+|\/+$/g, "");
  const key = `${dir}/${randomUUID().replaceAll("-", "")}${extname(item.path).toLowerCase()}`;
  const date = new Date().toUTCString();
  const canonicalHeaders = [`x-oss-date:${date}`, "x-oss-object-acl:public-read", `x-oss-security-token:${sts.securityToken}`].sort().join("\n");
  const stringToSign = ["PUT", "", mime, date, canonicalHeaders, `/${sts.bucket}/${key}`].join("\n");
  const signature = createHmac("sha1", sts.accessKeySecret).update(stringToSign).digest("base64");
  const url = `${host}/${key}`;
  let response;
  try {
    response = await fetch(url, {
      method: "PUT",
      headers: { Authorization: `OSS ${sts.accessKeyId}:${signature}`, "Content-Type": mime, "x-oss-date": date, "x-oss-object-acl": "public-read", "x-oss-security-token": sts.securityToken },
      body: await readFile(item.path),
      signal: AbortSignal.timeout(120_000)
    });
  } catch { throw new HttpError(502, "视频素材上传暂时失败，请稍后再试"); }
  if (!response.ok) throw new HttpError(502, "视频素材上传暂时失败，请稍后再试");
  return url;
}

async function aimanplayUploadInputs(run) {
  run.aimanplayUploads ||= {};
  const inputs = [...(run.editedKeyframes || []), ...(run.audioMode === "voice" ? [run.voiceAudio] : [])];
  let sts;
  const urls = [];
  for (const item of inputs) {
    if (!item?.id || !item?.path) throw new HttpError(409, "视频生成素材不完整");
    let url = run.aimanplayUploads[item.id];
    if (!url) {
      sts ||= await aimanplayJson("/api/video-upload/oss-sts", { method: "POST" });
      if (!sts.success || !sts.enabled) throw new HttpError(503, "视频服务素材通道暂时不可用");
      url = await aimanplayUpload(item, sts);
      run.aimanplayUploads[item.id] = url;
      await persistRun(run);
    }
    urls.push(url);
  }
  return { imageUrls: urls.slice(0, run.editedKeyframes.length), audioUrl: run.audioMode === "voice" ? urls.at(-1) : null };
}

async function archiveAimanplayVideo(run) {
  let response;
  try {
    response = await fetch(`${AIMANPLAY_API_BASE}/v1/videos/${encodeURIComponent(run.videoTaskId)}/content`, {
      headers: { Authorization: `Bearer ${aimanplayToken()}` }, signal: AbortSignal.timeout(120_000)
    });
  } catch { throw new HttpError(502, "视频已生成，但下载暂时失败；可以稍后恢复原任务"); }
  if (!response.ok) throw new HttpError(502, "视频已生成，但下载暂时失败；可以稍后恢复原任务");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < 12 || bytes.toString("ascii", 4, 8) !== "ftyp") throw new HttpError(502, "视频已生成，但下载结果无效；可以稍后恢复原任务");
  const id = randomUUID();
  const outputPath = join(RUNS_DIR, run.id, "output", `${id}.mp4`);
  await mkdir(join(RUNS_DIR, run.id, "output"), { recursive: true });
  await writeFile(outputPath, bytes);
  const item = { id, name: "minimax-h3-output.mp4", mime: "video/mp4", size: bytes.length, path: outputPath, category: "output" };
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

async function prepareWawProductImages(products, { opaque = false } = {}) {
  return Promise.all(products.map(async (item, index) => {
    let stdout;
    try {
      ({ stdout } = await execFileAsync(FFMPEG_PATH, [
        "-v", "error", "-i", item.path, "-frames:v", "1",
        "-filter_complex", "scale=800:800:force_original_aspect_ratio=decrease:flags=lanczos,pad=800:800:(ow-iw)/2:(oh-ih)/2:color=white,setsar=1" + (opaque ? ",format=rgba,split[fg][bg];[bg]lutrgb=r=255:g=255:b=255,format=rgb24[white];[white][fg]overlay=shortest=1:format=auto,format=rgb24" : ""),
        "-f", "image2pipe", "-vcodec", "png", "pipe:1"
      ], { encoding: "buffer", windowsHide: true, maxBuffer: 8 * 1024 * 1024, timeout: 30_000 }));
    } catch (error) {
      throw new Error(`第 ${index + 1} 张商品参考图预处理失败，请检查图片后重新上传`, { cause: error });
    }
    return { bytes: stdout, mime: "image/png", name: `product-reference-${index + 1}.png` };
  }));
}

function recoverableKlingImage(task) {
  return Boolean(task?.fallback?.taskId && !["FAILED", "CANCELED", "CANCELLED", "UNKNOWN"].includes(task.fallback.status));
}

async function klingImageFetch(path, options = {}) {
  const key = (process.env.BAILIAN_IMAGE_API_KEY || process.env.BAILIAN_API_KEY || "").trim();
  if (!key) throw new HttpError(409, "备用图片服务尚未配置");
  const response = await fetch(BAILIAN_IMAGE_API_BASE + path, {
    ...options, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...options.headers }
  });
  const raw = await response.text();
  let body;
  try { body = JSON.parse(raw); } catch { body = { message: raw.slice(0, 1000) }; }
  if (!response.ok || body.code || body.error) throw new HttpError(response.status >= 400 ? response.status : 502, body.message || body.error?.message || "备用图片服务请求失败", body);
  return body;
}

async function fallbackKlingImage(run, task, frame) {
  task.provider = "aliyun-bailian-kling";
  task.fallback ||= { status: "PREPARING", taskId: null, model: BAILIAN_IMAGE_MODEL };
  if (!task.fallback.taskId) {
    if (!run.publicBaseUrl) {
      run.imageTransport = { status: "WAITING", requestedAt: new Date().toISOString() };
      await persistRun(run);
      const deadline = Date.now() + 10 * 60_000;
      while (!run.publicBaseUrl && run.imageTransport.status === "WAITING" && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      if (!run.publicBaseUrl) { task.status = "FAILED"; throw new Error("备用图片通道暂时无法连接，请重试"); }
    }
    if (run.fallbackProductImages?.length !== run.productImages.length) {
      // Kling accepts public JPEG/PNG URLs, not the WebP uploads accepted by the primary.
      const uploads = await prepareWawProductImages(run.productImages, { opaque: true });
      const prepared = [];
      for (const upload of uploads) {
        const id = randomUUID();
        const path = join(RUNS_DIR, run.id, "inputs", "product-image", `${id}.png`);
        await writeFile(path, upload.bytes);
        const item = { id, name: upload.name, mime: "image/png", size: upload.bytes.length, path, category: "inputs/product-image" };
        prepared.push(item);
      }
      run.fallbackProductImages = prepared;
      prepared.forEach(item => media.set(item.id, item));
    }
    const imageUrl = item => new URL(publicMedia(item).url, run.publicBaseUrl).toString();
    const request = {
      model: BAILIAN_IMAGE_MODEL,
      input: { messages: [{ role: "user", content: [{ text: run.imagePrompt }, { image: imageUrl(frame) }, ...run.fallbackProductImages.map(item => ({ image: imageUrl(item) }))] }] },
      parameters: { n: 1, result_type: "single", aspect_ratio: run.ratio || "9:16", resolution: BAILIAN_IMAGE_RESOLUTION, watermark: false }
    };
    task.status = "SUBMITTING";
    task.fallback.status = "SUBMITTING";
    await persistRun(run); // Never submit before the attempt is durably recorded.
    let response;
    try {
      response = await klingImageFetch("/api/v1/services/aigc/image-generation/generation", { method: "POST", headers: { "X-DashScope-Async": "enable" }, body: JSON.stringify(request) });
    } catch (error) {
      task.fallback.error = error.message;
      task.fallback.details = error.details;
      task.status = error instanceof HttpError && error.status < 500 && error.status !== 408 ? "FAILED" : "UNCERTAIN";
      task.fallback.status = task.status;
      throw error;
    }
    task.fallback.taskId = taskId(response);
    task.taskId = task.fallback.taskId;
    task.fallback.lastResponse = response;
    task.fallback.status = response.output?.task_status || "PENDING";
    if (!task.fallback.taskId) { task.status = task.fallback.status = "UNCERTAIN"; throw new Error("备用图片服务未返回任务编号，请稍后重试"); }
    task.status = "PROCESSING";
    await persistRun(run);
  }
  const deadline = Date.now() + 12 * 60_000;
  while (true) {
    const response = await klingImageFetch(`/api/v1/tasks/${encodeURIComponent(task.fallback.taskId)}`);
    task.fallback.lastResponse = response;
    task.fallback.status = String(response.output?.task_status || "UNKNOWN").toUpperCase();
    run.billing.kling = mergeUsage(run.billing.kling, response, "aliyun-bailian-kling", "CNY");
    await persistRun(run);
    if (["FAILED", "CANCELED", "CANCELLED", "UNKNOWN"].includes(task.fallback.status)) {
      task.status = "FAILED";
      throw new Error(response.output?.message || "备用图片生成失败，请重试");
    }
    if (normalized(task.fallback.status) === "succeeded") {
      const url = bailianImageResult(response);
      if (!url) throw new Error("备用图片结果暂不可用，请重试获取");
      return { data: [{ url }], usage: response.usage };
    }
    if (Date.now() >= deadline) throw new Error("图片仍在生成，请稍后重试获取结果");
    await new Promise(resolve => setTimeout(resolve, BAILIAN_IMAGE_POLL_MS));
  }
}

async function startWawImages(run, retryIndexes, { recoverOnly = false } = {}) {
  if (imageWorkers.has(run.id)) throw new HttpError(409, "关键帧仍在生成，请等待完成");
  if (!process.env.WAW_API_KEY?.trim()) throw new HttpError(409, "图片生成服务尚未配置，请配置 WAW_API_KEY");
  const frames = run.videoMode === "multi_keyframes" ? run.keyframes || [] : [run.firstFrame];
  const indexes = recoverOnly ? frames.map((_, i) => i).filter(i => run.imageTasks?.[i]?.status !== "SUCCEEDED" && recoverableKlingImage(run.imageTasks?.[i])) : run.imageProvider === "wawapi" && run.status === "FAILED"
    ? frames.map((_, i) => i).filter(i => run.imageTasks?.[i]?.status !== "SUCCEEDED")
    : retryIndexes ?? frames.map((_, i) => i);
  if (!indexes.length || indexes.some(i => !Number.isInteger(i) || !frames[i])) throw new HttpError(400, "关键帧序号无效");
  run.imageTasks ||= [];
  run.editedKeyframes ||= [];
  for (const i of indexes) {
    if (run.imageTasks[i] && !recoverOnly && !recoverableKlingImage(run.imageTasks[i]) && !run.imageTasks[i].responsePath && !run.imageTasks[i].rawPath) {
      run.imageHistory ||= [];
      run.imageHistory.push(structuredClone(run.imageTasks[i]));
    } else if (run.imageTasks[i]?.editedImage) {
      run.imageHistory ||= [];
      run.imageHistory.push(run.imageTasks[i]);
    }
    const previous = run.imageTasks[i];
    run.imageTasks[i] = (previous?.responsePath || previous?.rawPath || recoverableKlingImage(previous)) && previous.status !== "SUCCEEDED"
      ? { ...previous, status: "QUEUED" }
      : { index: i, provider: "wawapi", status: "QUEUED", taskId: null, editedImage: null };
    run.editedKeyframes[i] = null;
  }
  Object.assign(run, { imageProvider: "wawapi", imageModel: WAW_IMAGE_MODEL, stage: "image", status: "PROCESSING", imageStatus: "PROCESSING", editedImage: null, message: "正在替换关键帧", updatedAt: new Date().toISOString() });
  run.timing.imageStartedAt = run.updatedAt;
  imageWorkers.add(run.id);
  try { await persistRun(run); } catch (error) { imageWorkers.delete(run.id); throw error; }
  void (async () => {
    let productUploads;
    for (const i of indexes) {
      const task = run.imageTasks[i];
      try {
        if (!task.responsePath && !task.rawPath) {
        let body;
        if (recoverableKlingImage(task)) {
          body = await fallbackKlingImage(run, task, frames[i]);
        } else {
        const form = new FormData();
        // Keep the scene and original uploads intact; normalize only product references.
        productUploads ||= await prepareWawProductImages(run.productImages);
        form.append("image", new Blob([await readFile(frames[i].path)], { type: frames[i].mime }), "scene.png");
        for (const item of productUploads) {
          form.append("image", new Blob([item.bytes], { type: item.mime }), item.name);
        }
        task.productImagePreprocessing = { width: 800, height: 800, fit: "contain", padding: "white", format: "png", sourceIds: run.productImages.map(item => item.id) };
        task.request = { model: WAW_IMAGE_MODEL, prompt: run.imagePrompt, size: "864x1536", quality: "medium", n: 1 };
        for (const [name, value] of Object.entries(task.request)) form.append(name, String(value));
        task.status = "SUBMITTING";
        task.startedAt = new Date().toISOString();
        await persistRun(run);
        const response = await fetch(WAW_API_BASE + "/images/edits", {
          method: "POST", headers: { Authorization: "Bearer " + process.env.WAW_API_KEY.trim() }, body: form,
          signal: AbortSignal.timeout(600000)
        });
        task.httpStatus = response.status;
        task.requestId = response.headers.get("x-request-id");
        const raw = await response.text();
        try { body = JSON.parse(raw); } catch { body = { error: { message: raw.slice(0, 1000) } }; }
        if (!response.ok) {
          task.status = response.status >= 500 || response.status === 408 ? "UNCERTAIN" : "FAILED";
          task.providerError = body.error || body;
          if (response.status === 400) {
            // A definite rejection, not a timeout: switch only this frame, without exposing a retry screen.
            task.status = "PROCESSING";
            await persistRun(run);
            await logRun(run, "image_fallback_started", { index: i, from: "wawapi", to: "aliyun-bailian-kling", httpStatus: 400, requestId: task.requestId });
            body = await fallbackKlingImage(run, task, frames[i]);
          } else throw new Error(response.status === 401 || response.status === 403 ? "图片服务密钥无效或无权限，请检查配置" : response.status === 402 ? "图片服务余额不足，请充值后重试" : response.status === 429 ? "图片服务繁忙，请稍后重试" : "图片服务连接异常，请重试");
        }
        }
        // Save the receipt before decoding/downloading: a failed archive must not trigger another paid edit.
        task.status = "RESPONSE_RECEIVED";
        task.responsePath = join(RUNS_DIR, run.id, "kling-output", randomUUID() + ".json");
        await writeFile(task.responsePath, JSON.stringify(body));
        await persistRun(run);
        }
        let body;
        try { body = task.rawPath ? {} : JSON.parse(await readFile(task.responsePath, "utf8")); }
        catch (error) { task.responsePath = null; throw error; }
        const item = Array.isArray(body.data) ? body.data[0] : body.data;
        let bytes;
        if (task.rawPath) { try { bytes = await readFile(task.rawPath); } catch { task.rawPath = null; } }
        if (bytes) { /* Reuse a downloaded original after normalization failure. */ }
        else if (item?.b64_json) bytes = Buffer.from(item.b64_json, "base64");
        else if (item?.url) {
          const download = await fetch(item.url, { signal: AbortSignal.timeout(60000) });
          if (!download.ok) {
            if ([403, 404, 410].includes(download.status)) task.responsePath = null;
            throw new Error("结果图片下载失败");
          }
          bytes = Buffer.from(await download.arrayBuffer());
        }
        if (!bytes?.length) { task.responsePath = null; throw new Error("服务未返回有效图片"); }
        const imageSignature = bytes.subarray(0, 12);
        if (!(imageSignature.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || (bytes[0] === 255 && bytes[1] === 216) || (imageSignature.toString("ascii", 0, 4) === "RIFF" && imageSignature.toString("ascii", 8, 12) === "WEBP"))) {
          task.responsePath = null; task.rawPath = null;
          throw new Error("返回的图片数据无效，请重试");
        }
        const id = randomUUID();
        const rawPath = join(RUNS_DIR, run.id, "kling-output", id + "-original.png");
        const path = join(RUNS_DIR, run.id, "kling-output", id + ".png");
        await writeFile(rawPath, bytes);
        task.rawPath = rawPath;
        await persistRun(run);
        // Normalize provider size drift without cropping or stretching the product.
        await execFileAsync(FFMPEG_PATH, ["-y", "-i", rawPath, "-frames:v", "1", "-vf", "scale=864:1536:force_original_aspect_ratio=decrease,pad=864:1536:(ow-iw)/2:(oh-ih)/2,setsar=1", path], { maxBuffer: 4 * 1024 * 1024 });
        task.editedImage = { id, name: "edited-keyframe-" + (i + 1) + ".png", path, mime: "image/png", size: (await stat(path)).size, category: "kling-output" };
        media.set(id, task.editedImage);
        task.status = "SUCCEEDED";
        task.finishedAt = new Date().toISOString();
        task.usage = body.usage || null;
        run.editedKeyframes[i] = task.editedImage;
      } catch (error) {
        if (task.status === "SUBMITTING") task.status = "UNCERTAIN";
        else if (!["FAILED", "UNCERTAIN"].includes(task.status)) task.status = "ARCHIVE_FAILED";
        task.error = error.message;
      }
      run.message = "正在替换关键帧（" + run.imageTasks.filter(t => t?.status === "SUCCEEDED").length + "/" + frames.length + "）";
      run.updatedAt = new Date().toISOString();
      await persistRun(run);
      // Stop after a failure; keep completed frames and leave later frames queued.
      if (task.status !== "SUCCEEDED") break;
    }
    finishWawImages(run);
    await persistRun(run);
  })().catch(async error => {
    run.status = "FAILED"; run.imageStatus = "FAILED";
    run.message = "关键帧处理已暂停，已完成图片已保留";
    await logRun(run, "image_worker_failed", { message: error.message });
    await persistRun(run);
  }).finally(() => imageWorkers.delete(run.id));
}

function finishWawImages(run) {
  const tasks = run.imageTasks || [];
  const succeeded = tasks.length && tasks.every(t => t?.status === "SUCCEEDED" && t.editedImage);
  run.editedKeyframes = tasks.map(t => t?.editedImage || null);
  run.editedImage = run.editedKeyframes[0] || null;
  run.status = run.imageStatus = succeeded ? "SUCCEEDED" : "FAILED";
  run.message = succeeded ? "替换关键帧已全部保存，请确认后生成视频" : tasks.some(t => t?.status === "UNCERTAIN")
    ? "连接中断，部分图片是否生成暂时无法确认。已完成图片已保留；再次生成可能重复计费，请先核对记录。"
    : "部分关键帧未完成，已完成图片已保留；重试只处理未完成图片";
  run.updatedAt = new Date().toISOString();
  finishStageTiming(run, "image");
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
          ...run.productImages.map((item, productIndex) => ({ image: MOCK ? `https://mock.invalid/product-${productIndex + 1}.png` : publicMediaUrl(item) }))
        ]
      }]
    },
    parameters: { n: 1, result_type: "single", aspect_ratio: run.ratio || "9:16", resolution: BAILIAN_IMAGE_RESOLUTION, watermark: false }
  };
  const loggedRequest = structuredClone(request);
  loggedRequest.input.messages[0].content[1].image = `[temporary HTTPS keyframe ${index + 1}]`;
  for (const item of loggedRequest.input.messages[0].content.slice(2)) item.image = "[temporary HTTPS product image]";
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
  if (!MOCK) return startWawImages(run, retryIndexes);
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

async function createAimanplayVideoStage(run) {
  if (!Array.isArray(run.editedKeyframes) || !run.editedKeyframes.length || run.editedKeyframes.length > 9 || run.editedKeyframes.some((item) => !item?.path)) throw new HttpError(409, "替换关键帧尚未全部完成");
  if (run.audioMode === "voice" && !run.voiceAudio?.path) throw new HttpError(409, "声音与口型已开启，但缺少参考声音");
  if (!MOCK) aimanplayToken();
  run.videoProvider = "aimanplay";
  run.videoModel = AIMANPLAY_VIDEO_MODEL;
  run.stage = "video";
  run.status = "submitting";
  run.timing.videoStartedAt = new Date().toISOString();
  run.videoSubmission = { status: "preparing", startedAt: run.timing.videoStartedAt };
  await persistRun(run);
  if (MOCK) {
    run.videoTaskId = `mock-video-${Date.now()}`;
    run.videoStatus = "PENDING";
  } else {
    const { imageUrls, audioUrl } = await aimanplayUploadInputs(run);
    const request = { model: AIMANPLAY_VIDEO_MODEL, prompt: run.videoPrompt, duration: run.duration, resolution: run.resolution === "768P" ? "768p竖" : "480p竖" };
    imageUrls.forEach((url, index) => { request[`ref_image_${index}`] = url; });
    if (audioUrl) request.ref_audio_0 = audioUrl;
    run.videoRequest = { model: request.model, prompt: request.prompt, duration: request.duration, resolution: request.resolution, referenceImageCount: imageUrls.length, hasReferenceAudio: Boolean(audioUrl) };
    run.videoSubmission = { ...run.videoSubmission, status: "submitting", submittedAt: new Date().toISOString() };
    await persistRun(run);
    let task;
    try {
      task = await aimanplayJson("/v1/videos", { method: "POST", body: JSON.stringify(request) }, 60_000);
    } catch (error) {
      run.videoSubmission = { ...run.videoSubmission, status: error.transport || error.status >= 500 ? "uncertain" : "rejected", error: error.message, failedAt: new Date().toISOString() };
      await persistRun(run);
      throw error;
    }
    if (!task?.id) {
      run.videoSubmission = { ...run.videoSubmission, status: "uncertain", error: "视频服务没有返回任务编号", failedAt: new Date().toISOString() };
      await persistRun(run);
      throw new HttpError(502, "视频提交结果暂时无法确认；为避免重复计费，未自动重试");
    }
    run.videoTaskId = task.id;
    run.videoLastResponse = task;
    run.videoStatus = task.status || "queued";
    run.videoSubmission = { ...run.videoSubmission, status: "accepted", acceptedAt: new Date().toISOString() };
  }
  run.timing.videoSubmittedAt = new Date().toISOString();
  run.status = "PENDING";
  run.message = "视频任务已提交";
  run.updatedAt = new Date().toISOString();
  await persistRun(run);
  await logRun(run, "video_task_created", { videoTaskId: run.videoTaskId, videoProvider: "aimanplay", videoMode: run.videoMode });
}

async function createVideoStage(run) {
  if (run.videoMode === "multi_keyframes") return createAimanplayVideoStage(run);
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
  const [sourceVideo, productImages, voiceAudio, firstFrame, editedImage] = await Promise.all([
    cloneMediaItem(source.sourceVideo, id, join("inputs", "source-video")),
    Promise.all(source.productImages.map((item) => cloneMediaItem(item, id, join("inputs", "product-image")))),
    cloneMediaItem(source.voiceAudio, id, join("inputs", "voice-audio")),
    cloneMediaItem(source.firstFrame, id, "first-frame"),
    cloneMediaItem(source.editedImage, id, "kling-output")
  ]);
  const keyframes = await Promise.all((source.keyframes || []).map((item) => cloneMediaItem(item, id, join("keyframes", "source"))));
  const editedKeyframes = await Promise.all((source.editedKeyframes || []).filter(Boolean).map((item) => cloneMediaItem(item, id, "kling-output")));
  const videoModel = videoModelForMode(videoMode);
  const estimatedVideoCostCny = estimatedVideoCost(duration, resolution, videoModel);
  const run = {
    id,
    derivedFromRunId: source.id,
    lineage: { type: "video_rerun", sourceRunId: source.id, reusedEditedImage: videoMode === "first_frame", reusedEditedKeyframes: videoMode === "multi_keyframes", sourceImageTaskId: source.imageTaskId || null },
    status: "submitting", stage: "video", message: videoMode === "reference_video" ? "已复用参考素材，准备生成视频" : videoMode === "multi_keyframes" ? "已复用替换关键帧，准备生成视频" : "已复用替换首帧，准备生成视频", createdAt: now, updatedAt: now,
    imageModel: videoMode === "reference_video" ? null : source.imageModel || BAILIAN_IMAGE_MODEL, videoModel,
    videoProvider: videoMode === "reference_video" ? "kling" : videoMode === "multi_keyframes" ? "aimanplay" : "xinhankr",
    imagePrompt: source.imagePrompt || null, productSubject: source.productSubject || "", videoPrompt, resolution, duration, ratio: source.ratio || "9:16", videoMode, publicBaseUrl: source.publicBaseUrl || null, audioMode: source.audioMode || "voice", voiceSource: source.voiceSource || "source_video", voiceName: source.voiceName || null, voiceScript: source.voiceScript || "",
    estimatedVideoCostCny, sourceVideo, productImages, productImage: productImages[0] || null, voiceAudio, firstFrame, editedImage, keyframes, editedKeyframes, keyframeTimes: source.keyframeTimes || [], imageTasks: [], output: null,
    imageTaskId: videoMode === "reference_video" ? null : source.imageTaskId || null, imageStatus: videoMode === "reference_video" ? "SKIPPED" : "SUCCEEDED", imageReused: videoMode !== "reference_video",
    videoTaskId: null, videoStatus: null, imageRequest: null, imageLastResponse: null, videoRequest: null, videoLastResponse: null,
    timing: { runStartedAt: now, imageStartedAt: null, imageSubmittedAt: null, imageCompletedAt: null, imageElapsedMs: null, videoStartedAt: null, videoSubmittedAt: null, videoCompletedAt: null, videoElapsedMs: null, totalElapsedMs: null },
    billing: {
      estimate: videoMode === "reference_video"
        ? { provider: "kling", currency: "credits", videoAmount: null, basis: "provider_task_receipt" }
        : videoModel === AIMANPLAY_VIDEO_MODEL
          ? { provider: "aimanplay", currency: "CNY", videoAmount: estimatedVideoCostCny, basis: "declared_seconds_x_0.06", discount: null }
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

async function refreshAimanplayVideo(run) {
  if (!run.videoTaskId) return;
  const task = await aimanplayJson(`/v1/videos/${encodeURIComponent(run.videoTaskId)}`);
  run.videoLastResponse = task;
  run.videoStatus = task.status || "unknown";
  if (task.status === "completed") {
    run.output = await archiveAimanplayVideo(run);
    if (run.audioMode === "silent") await removeOutputAudio(run);
    run.status = "SUCCEEDED";
    run.message = "替换视频已生成";
    finishStageTiming(run, "video");
  } else if (task.status === "failed") {
    run.status = "FAILED";
    run.message = task.error?.message || "视频生成失败，请稍后重试";
    finishStageTiming(run, "video");
  } else {
    run.status = "PROCESSING";
    run.message = "正在生成替换视频";
  }
}

async function refreshRun(run, { force = false } = {}) {
  ensureRunMetrics(run);
  if (run.stage === "image" && run.imageProvider === "wawapi" && !MOCK) {
    if (!imageWorkers.has(run.id) && run.status === "PROCESSING") {
      if ((run.imageTasks || []).some(task => task.status !== "SUCCEEDED" && recoverableKlingImage(task))) {
        await startWawImages(run, null, { recoverOnly: true });
        return; // Recover existing async IDs only; a GET must never submit a paid request.
      }
      for (const task of run.imageTasks || []) if (task.status === "SUBMITTING") task.status = "UNCERTAIN";
      finishWawImages(run);
      await persistRun(run);
    }
    return; // Synchronous upstream has no pollable job ID. Never resubmit from a GET.
  }
  if (normalized(run.status) === "succeeded") { await cleanupRunKeyframes(run); return; }
  if (!force && normalized(run.status) === "failed") return;
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
      run.message = run.videoMode === "multi_keyframes" ? "Mock：替换关键帧已生成，请确认后生成视频" : "Mock：替换首帧已生成，请确认后生成视频";
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
    await cleanupRunKeyframes(run);
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
        run.message = "替换关键帧已全部归档，请确认后生成视频";
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
        run.message = "替换首帧已归档，请确认后生成视频";
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
  } else if (run.videoProvider === "aimanplay" || run.videoModel === AIMANPLAY_VIDEO_MODEL) {
    await refreshAimanplayVideo(run);
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
  await cleanupRunKeyframes(run);
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

function requireProductImages(body) {
  const ids = Object.hasOwn(body, "productImageIds") ? body.productImageIds : [body.productImageId];
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 3) throw new HttpError(400, "商品参考图片必须为 1-3 张");
  if (ids.some((id) => typeof id !== "string" || !id) || new Set(ids).size !== ids.length) throw new HttpError(400, "商品参考图片 ID 无效或重复");
  return ids.map((id) => requireMedia(id, "image/", "商品图片"));
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
      configured: MOCK || Boolean(process.env.WAW_API_KEY && aimanplayConfigured()),
      klingConfigured: MOCK || Boolean(process.env.KLING_API_KEY),
      imageConfigured: MOCK || Boolean(process.env.WAW_API_KEY),
      h3Configured: MOCK || aimanplayConfigured(),
      mock: MOCK,
      imageModel: WAW_IMAGE_MODEL,
      videoModel: AIMANPLAY_VIDEO_MODEL,
      videoProvider: "aimanplay",
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
          estimate: { provider: "aimanplay", currency: "CNY", videoAmount: null, basis: "declared_seconds_x_0.06", discount: null },
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
      else if (category === join("inputs", "product-image") && url.searchParams.get("attach") !== "false") {
        run.productImages = [item];
        run.productImage = item;
      }
      else if (category === join("inputs", "voice-audio") && url.searchParams.get("attach") !== "false") run.voiceAudio = item;
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
      if (run) rejectUserStoppedRun(run);
      if (id === "invalid" || !run || run.status !== "draft") throw new HttpError(409, "runId 无效、未创建或已经提交");
      const imagePrompt = String(body.imagePrompt || "").trim();
      const productSubject = String(body.productSubject || "").trim();
      if (productSubject.length > 200) throw new HttpError(400, "替换主体说明不能超过 200 字");
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
      const sourceVideo = requireMedia(body.sourceVideoId, "video/", "原视频");
      const productImages = requireProductImages(body);
      const uploadedVoiceAudio = videoMode !== "reference_video" && audioMode === "voice" && voiceSource === "upload"
        ? requireMedia(body.voiceAudioId, "audio/", "声音样本")
        : null;
      Object.assign(run, {
        status: "submitting", stage: videoMode === "reference_video" ? "video" : "image", message: videoMode === "reference_video" ? "准备提交 Kling 3.0 Omni 参考视频任务" : videoMode === "multi_keyframes" ? "准备提交多张关键帧替换任务" : "准备提交商品替换任务", updatedAt: new Date().toISOString(),
        imageModel: videoMode === "reference_video" ? null : WAW_IMAGE_MODEL, videoModel, imagePrompt, productSubject, videoPrompt, resolution, duration, ratio: videoMode === "reference_video" ? "adaptive" : "9:16", videoMode, publicBaseUrl, audioMode, voiceSource, voiceName: String(body.voiceName || "").trim() || null, voiceScript,
        estimatedVideoCostCny: estimatedVideoCost(duration, resolution, videoModel),
        videoProvider: videoMode === "reference_video" ? "kling" : videoMode === "multi_keyframes" ? "aimanplay" : "xinhankr",
        sourceVideo,
        productImages, productImage: productImages[0],
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
      else if (videoMode === "multi_keyframes") Object.assign(run.billing.estimate, { provider: "aimanplay", currency: "CNY", basis: "declared_seconds_x_0.06", discount: null });
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
      rejectUserStoppedRun(sourceRun);
      const body = await readJson(req);
      rejectUserStoppedRun(sourceRun);
      const requestedVideoMode = body.videoMode === "reference_video" ? "reference_video" : body.videoMode === "multi_keyframes" ? "multi_keyframes" : "first_frame";
      const videoModel = videoModelForMode(requestedVideoMode);
      const allowedResolutions = videoResolutionsForMode(requestedVideoMode);
      const publicBaseInput = String(body.publicBaseUrl || "").trim();
      const publicBaseUrl = publicBaseInput ? publicBaseInput.replace(/\/?$/, "/") : sourceRun.publicBaseUrl || null;
      if (requestedVideoMode === "first_frame" && (!sourceRun.editedImage || normalized(sourceRun.imageStatus) !== "succeeded")) throw new HttpError(409, "请先完成并确认替换首帧");
      if (requestedVideoMode === "multi_keyframes" && (!sourceRun.editedKeyframes?.length || sourceRun.editedKeyframes.some((item) => !item) || normalized(sourceRun.imageStatus) !== "succeeded")) throw new HttpError(409, "请先完成并确认全部替换关键帧");
      if (sourceRun.videoTaskId && ["submitted", "processing", "pending", "in_progress"].includes(normalized(sourceRun.videoStatus))) throw new HttpError(409, "当前视频任务仍在处理中");
      if (sourceRun.videoTaskId && body.confirmResubmit !== true) throw new HttpError(409, "已有视频任务；请先检查并恢复原任务，禁止自动重复提交以避免重复计费");
      if (!sourceRun.videoTaskId && ["submitting", "uncertain"].includes(sourceRun.videoSubmission?.status) && body.confirmResubmit !== true) throw new HttpError(409, "上次视频提交结果不确定；为避免重复计费，未自动重新提交");
      const videoPrompt = String(body.videoPrompt || sourceRun.videoPrompt || "").trim();
      const duration = Number(body.duration || sourceRun.duration);
      const resolution = allowedResolutions.includes(body.resolution) ? body.resolution : sourceRun.resolution;
      const videoMode = requestedVideoMode;
      if (!videoPrompt || videoPrompt.length > 7000) throw new HttpError(400, "视频 Prompt 必填且不能超过 7000 字符");
      if (videoMode === "reference_video" && Buffer.byteLength(videoPrompt, "utf8") > KLING_OMNI_PROMPT_MAX_BYTES) throw new HttpError(400, "Kling 3.0 Omni 提示词不能超过 3072 字节");
      if (!Number.isInteger(duration) || duration < 4 || duration > 15) throw new HttpError(400, "输出时长必须是 4-15 秒整数");
      if (videoMode === "reference_video" && ![5, 10, 15].includes(duration)) throw new HttpError(400, "Kling 3.0 Omni 参考视频模式仅支持 5、10 或 15 秒");
      if (!allowedResolutions.includes(resolution)) throw new HttpError(400, `当前生成方式分辨率必须是 ${allowedResolutions.join(" 或 ")}`);
      const audioMode = body.audioMode === "silent" ? "silent" : body.audioMode === "voice" ? "voice" : sourceRun.audioMode || "voice";
      const voiceScript = String(body.voiceScript ?? sourceRun.voiceScript ?? "").trim();
      const voiceAudio = videoMode !== "reference_video" && audioMode === "voice" && body.voiceAudioId
        ? requireMedia(body.voiceAudioId, "audio/", "声音样本") : sourceRun.voiceAudio;
      if (videoMode !== "reference_video" && audioMode === "voice" && !voiceScript) throw new HttpError(400, "声音与口型开启时必须填写台词");
      const run = sourceRun.videoTaskId ? await createVideoVariant(sourceRun, videoPrompt, duration, resolution, videoMode) : sourceRun;
      try {
        rejectUserStoppedRun(sourceRun);
        rejectUserStoppedRun(run);
      } catch (error) {
        if (run !== sourceRun) {
          run.status = "FAILED";
          run.message = "原任务已在本地结束，派生视频未提交";
          if (sourceRun.userStopped) run.userStopped = { ...sourceRun.userStopped, inheritedFromRunId: sourceRun.id };
          run.updatedAt = new Date().toISOString();
          await persistRun(run);
          await logRun(run, "video_variant_submission_blocked", { sourceRunId: sourceRun.id });
        }
        throw error;
      }
      run.videoPrompt = videoPrompt;
      run.voiceScript = voiceScript;
      run.audioMode = audioMode;
      if (videoMode !== "reference_video") {
        // Keep the selected sample when sound is disabled so a failed silent
        // submission can later be retried with sound. UploadInputs checks audioMode.
        if (audioMode === "voice") run.voiceAudio = voiceAudio;
        if (audioMode === "voice" && body.voiceAudioId) {
          run.voiceName = String(body.voiceName || "").trim() || null;
          run.voiceId = body.voiceId || null;
          run.voiceSource = "upload";
        }
      }
      run.duration = duration;
      run.resolution = resolution;
      run.videoMode = videoMode;
      run.videoModel = videoModel;
      run.videoProvider = videoMode === "reference_video" ? "kling" : videoMode === "multi_keyframes" ? "aimanplay" : "xinhankr";
      run.publicBaseUrl = publicBaseUrl;
      run.estimatedVideoCostCny = estimatedVideoCost(run.duration, run.resolution, videoModel);
      run.billing.estimate.videoAmount = run.estimatedVideoCostCny;
      if (videoMode === "multi_keyframes") Object.assign(run.billing.estimate, { provider: "aimanplay", currency: "CNY", basis: "declared_seconds_x_0.06", discount: null });
      const releaseSubmission = claimRunSubmission(sourceRun, run);
      try {
        try { await createVideoStage(run); }
        catch (error) { run.status = "FAILED"; run.videoStatus = "FAILED"; run.message = error.message; run.videoLastResponse = error.details; if (videoMode === "reference_video") run.billing.kling = mergeUsage(run.billing.kling, error.details, "kling", null); else if (videoMode !== "multi_keyframes") run.billing.h3 = mergeUsage(run.billing.h3, error.details, "xinhankr", "CNY"); finishStageTiming(run, "video"); await persistRun(run); throw error; }
        return sendJson(res, 201, publicRun(run));
      } finally {
        releaseSubmission();
      }
    }
    const stopMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/stop$/);
    if (req.method === "POST" && stopMatch) {
      const run = runs.get(stopMatch[1]);
      if (!run) throw new HttpError(404, "Run 不存在");
      const body = await readJson(req);
      const stage = body.stage;
      if (stage !== "image" && stage !== "video") throw new HttpError(400, "停止阶段无效");
      if (run.userStopped) {
        if (run.userStopped.stage !== stage) throw new HttpError(409, "任务已在其他阶段结束");
        return sendJson(res, 200, publicRun(run));
      }
      if (submissionClaims.has(run.id)) throw new HttpError(409, "任务正在提交，暂时不能结束");
      if (stage === "image") {
        const submissionStatus = String(run.videoSubmission?.status || "").toLowerCase();
        const submissionInFlight = ["preparing", "submitting", "accepted", "uncertain"].includes(submissionStatus);
        const allKeyframesComplete = Array.isArray(run.editedKeyframes) && run.editedKeyframes.length > 0
          && run.editedKeyframes.every((item) => item?.id);
        if (run.stage !== "image" || normalized(run.imageStatus) !== "succeeded" || normalized(run.status) !== "succeeded"
          || !allKeyframesComplete || imageWorkers.has(run.id) || run.videoTaskId || submissionInFlight) {
          throw new HttpError(409, "仅可在全部关键帧完成且视频尚未提交时结束图片阶段");
        }
      } else if (run.stage !== "video" || !run.videoTaskId) {
        throw new HttpError(409, "仅可结束已有服务商任务 ID 的视频阶段");
      }
      run.userStopped = { stage, stoppedAt: new Date().toISOString() };
      run.updatedAt = run.userStopped.stoppedAt;
      await persistRun(run);
      await logRun(run, "run_user_stopped", { stage });
      return sendJson(res, 200, publicRun(run));
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
      if (run.imageProvider === "wawapi" && run.stage === "image") {
        await refreshRun(run, { force: true });
        return sendJson(res, 200, publicRun(run));
      }
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
    const imageTransportMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/image\/transport$/);
    if (req.method === "POST" && imageTransportMatch) {
      const run = runs.get(imageTransportMatch[1]);
      if (!run) throw new HttpError(404, "Run 不存在");
      const body = await readJson(req);
      if (run.stage !== "image" || run.imageTransport?.status !== "WAITING") return sendJson(res, 200, publicRun(run));
      const value = String(body.publicBaseUrl || "").trim();
      if (value && !/^https?:\/\//i.test(value)) throw new HttpError(400, "临时素材地址无效");
      run.publicBaseUrl = value || null;
      run.imageTransport.status = value ? "READY" : "FAILED";
      await persistRun(run);
      return sendJson(res, 200, publicRun(run));
    }
    const retryImageMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/image\/retry$/);
    if (req.method === "POST" && retryImageMatch) {
      const run = runs.get(retryImageMatch[1]);
      if (!run) throw new HttpError(404, "Run 不存在");
      rejectUserStoppedRun(run);
      const body = await readJson(req);
      rejectUserStoppedRun(run);
      if (Object.hasOwn(body, "publicBaseUrl")) run.publicBaseUrl = body.publicBaseUrl || null;
      const retryIndexes = [...new Set((Array.isArray(body.indexes) ? body.indexes : url.searchParams.has("index") ? [Number(url.searchParams.get("index"))] : []).map(Number))].sort((a, b) => a - b);
      if (body.continueOnly === true && run.imageProvider === "wawapi") {
        await refreshRun(run);
        rejectUserStoppedRun(run);
        if (imageWorkers.has(run.id) || run.imageStatus === "SUCCEEDED") return sendJson(res, 200, publicRun(run));
      }
      if (!run.productImage || (run.videoMode === "multi_keyframes" ? !run.keyframes?.length : !run.firstFrame)) throw new HttpError(409, "缺少产品图或原始关键帧");
      if (imageWorkers.has(run.id)) throw new HttpError(409, "关键帧仍在生成，请等待完成");
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
  console.log(`商品替换本地服务: http://127.0.0.1:${PORT}`);
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
