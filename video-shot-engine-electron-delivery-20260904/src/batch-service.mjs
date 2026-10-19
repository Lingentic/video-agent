import fsp from "node:fs/promises";
import path from "node:path";
import { processVideo, assertCurrentShotDetection } from "./shot-service.mjs";
import { executeShotNaming } from "./naming-service.mjs";
import { serializeError } from "./network.mjs";
import { calculateCostYuan } from "./pricing.mjs";
import { cleanupAnalysisInput, cleanupRunInputs } from "./input-cleanup.mjs";
import { randomUUID } from "node:crypto";
import { validateWuhenOptions } from "./wuhen-service.mjs";
import { finalizeNamedSegments } from "./named-output-storage.mjs";

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(signal.reason);
  const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
  const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
  signal?.addEventListener("abort", onAbort, { once: true });
});
const nowIso = () => new Date().toISOString();
const isQuotaError = (error) => /quota|rate.?limit|too many requests|429/i.test(error?.message || "") || error?.status === 429;
const quotaDelayMs = (error, attempt) => {
  const seconds = Number(/retry in\s+([\d.]+)s/i.exec(error?.message || "")?.[1]);
  return Number.isFinite(seconds) ? Math.ceil((seconds + 2) * 1000) : Math.min(120000, 30000 * (attempt + 1));
};

export async function writeBatchJson(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fsp.writeFile(temporary, json(value), "utf8");
    for (let attempt = 0; ; attempt += 1) {
      try { await fsp.rename(temporary, file); break; }
      catch (error) {
        // Windows readers can briefly hold the destination open during client polling.
        if (process.platform !== "win32" || !["EPERM", "EBUSY"].includes(error.code) || attempt >= 3) throw error;
        await sleep(20 * (attempt + 1));
      }
    }
  }
  finally { await fsp.rm(temporary, { force: true }); }
}
export async function loadBatch(batchDir) { return JSON.parse(await fsp.readFile(path.join(batchDir, "batch.json"), "utf8")); }
export async function saveBatch(batchDir, batch) { await writeBatchJson(path.join(batchDir, "batch.json"), batch); return batch; }

export function sumUsage(items) {
  return items.reduce((sum, item) => {
    const usage = item.usage || {};
    sum.total_tokens += Number(usage.total_tokens || 0);
    sum.total_input_tokens += Number(usage.total_input_tokens || 0);
    sum.total_output_tokens += Number(usage.total_output_tokens || 0);
    sum.total_thought_tokens += Number(usage.total_thought_tokens || 0);
    sum.estimated_cost_yuan += calculateCostYuan(usage);
    return sum;
  }, { total_tokens: 0, total_input_tokens: 0, total_output_tokens: 0, total_thought_tokens: 0, estimated_cost_yuan: 0 });
}

export function subtitleSummary(job) {
  if (!job) return null;
  const fields = ["id", "jobId", "provider", "stage", "status", "taskId", "model", "method", "rect", "schedule", "progress", "queueAhead", "createdAt", "updatedAt", "submittedAt", "completedAt", "errorCode", "durationDeltaSec"];
  return Object.fromEntries(fields.filter((field) => job[field] !== undefined).map((field) => [field, job[field]]));
}

export async function processBatchItem({ batchDir, runDir, stateFile, item, gemini, thresholds, onUpdate, signal, subtitleApiKey, subtitleService, videoProcessor = processVideo, namingService = executeShotNaming }) {
  assertCurrentShotDetection(item);
  const itemDir = runDir || path.join(batchDir, "items", item.videoId);
  const artifactsDir = path.join(itemDir, "artifacts");
  await fsp.mkdir(artifactsDir, { recursive: true });
  const invocationStartedAt = Date.now();
  const previousActiveMs = Number(item.activeDurationMs || 0);
  const previousQuotaWaitMs = Number(item.quotaWaitDurationMs || 0);
  let invocationQuotaWaitMs = 0;
  const attemptRecord = { attempt: Number(item.attempts?.length || 0) + 1, startedAt: nowIso(), resumedFromStage: item.stage || "queued" };
  const firstStartedAt = item.firstStartedAt || nowIso();
  item = { ...item, attempts: [...(item.attempts || []), attemptRecord], firstStartedAt, queueDurationMs: Number(item.queueDurationMs ?? Math.max(0, Date.parse(firstStartedAt) - Date.parse(item.queuedAt || firstStartedAt))) };

  const update = async (patch) => {
    item = { ...item, ...patch, updatedAt: nowIso() };
    await writeBatchJson(stateFile || path.join(itemDir, "item.json"), item);
    await onUpdate(item);
    return item;
  };
  const finishAttempt = (status, patch = {}) => {
    const finishedAt = nowIso();
    const attempts = item.attempts.map((entry, index) => index === item.attempts.length - 1 ? {
      ...entry, status, finishedAt, activeDurationMs: Date.now() - invocationStartedAt - invocationQuotaWaitMs,
      quotaWaitDurationMs: invocationQuotaWaitMs, ...patch,
    } : entry);
    return attempts;
  };

  try {
    signal?.throwIfAborted();
    if (item.removeSubtitles) {
      if ((item.subtitleProvider && item.subtitleProvider !== "wuhen") || (item.subtitle?.provider && item.subtitle.provider !== "wuhen")) throw new Error("此任务属于旧去字幕供应商，不能作为无痕任务重新提交");
      validateWuhenOptions(item.subtitleOptions);
      await update({ status: "processing", error: null, failedStage: null });
      const subtitleStartedAt = Date.now();
      if (typeof subtitleService !== "function") throw new Error("无痕去字幕服务未初始化");
      const subtitle = await subtitleService({
        runDir: itemDir, inputPath: item.input, apiKey: subtitleApiKey, options: item.subtitleOptions, recoveryJob: item.subtitle, signal,
        onStage: async (stage, job) => update({ status: "processing", stage, subtitle: subtitleSummary(job) }),
      });
      signal?.throwIfAborted();
      await update({ processingInput: subtitle.outputPath, originalMedia: subtitle.inputMedia, subtitleMedia: subtitle.outputMedia,
        subtitle: subtitleSummary(subtitle.job), subtitleDurationMs: Number(item.subtitleDurationMs || 0) + Date.now() - subtitleStartedAt });
    }
    if (!item.shots) {
      await fsp.rm(path.join(artifactsDir, "shot_segments"), { recursive: true, force: true });
      await fsp.rm(path.join(itemDir, "named_segments"), { recursive: true, force: true });
      for (const name of ["shot_labels_raw.json", "shot_labels_normalized.json", "rename_manifest.json", "gemini_response.json", "usage.json", "provider_attempts.json"]) await fsp.rm(path.join(artifactsDir, name), { force: true });
      const ffmpegStartedAt = Date.now();
      await update({ status: "processing", stage: "ffmpeg_processing", error: null, failedStage: null });
      const result = await videoProcessor({ runDir: itemDir, artifactsDir, inputPath: item.processingInput || item.input, ...thresholds, keepAudio: item.keepAudio, signal });
      signal?.throwIfAborted();
      item = await update({ ...result, status: "processing", stage: "ffmpeg_completed", ffmpegDurationMs: Number(item.ffmpegDurationMs || 0) + Date.now() - ffmpegStartedAt });
    }

    if (item.autoName && gemini) {
      signal?.throwIfAborted();
      await update({ status: "processing", stage: "naming_processing", error: null, failedStage: null });
      let naming;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        signal?.throwIfAborted();
        try {
          naming = await namingService({ runDir: itemDir, initialRun: item, gemini, onStage: async (stage, patch = {}) => update({ status: "processing", stage, ...patch }), signal });
          break;
        } catch (error) {
          if (!isQuotaError(error) || attempt === 2) throw error;
          const delayMs = quotaDelayMs(error, attempt);
          await update({ status: "quota_wait", stage: "quota_wait", quotaRetryAttempt: attempt + 1, quotaRetryDelayMs: delayMs, quotaRetryAt: new Date(Date.now() + delayMs).toISOString(), error: error.message });
          const waitStartedAt = Date.now();
          await sleep(delayMs, signal);
          invocationQuotaWaitMs += Date.now() - waitStartedAt;
          await update({ status: "processing", stage: "gemini_analysis_retry", error: null });
        }
      }
      signal?.throwIfAborted();
      if (!naming) throw new Error("xinhankr 重试结束但未获得命名结果");
      const activeDurationMs = previousActiveMs + Date.now() - invocationStartedAt - invocationQuotaWaitMs;
      const quotaWaitDurationMs = previousQuotaWaitMs + invocationQuotaWaitMs;
      let completed = await update({
        status: "completed", stage: "completed", completedAt: nowIso(), namedShotCount: naming.manifest.length,
        activeDurationMs, totalDurationMs: activeDurationMs, quotaWaitDurationMs,
        namingDurationMs: Math.max(0, activeDurationMs - Number(item.ffmpegDurationMs || 0)), usage: naming.usage,
        providerAttempts: naming.requestAttempts || [], providerSuccessMode: naming.requestAttempts?.find((entry) => entry.accepted)?.schemaMode || null,
        providerSuccessRepeat: naming.requestAttempts?.find((entry) => entry.accepted)?.repeat || null, unknownCostAttempts: Number(naming.requestAttempts?.filter((entry) => entry.costStatus === "unknown").length || 0),
        attempts: finishAttempt("completed", { usage: naming.usage }), error: null, failedStage: null,
      });
      const finalized = await finalizeNamedSegments(itemDir, completed, next => update(next));
      completed = finalized.run;
      if (finalized.ready) await cleanupRunInputs(itemDir, completed.input, { preserveInput: completed.removeSubtitles });
      return completed;
    }

    signal?.throwIfAborted();
    const activeDurationMs = previousActiveMs + Date.now() - invocationStartedAt;
    const completed = await update({ status: "completed", stage: "completed", completedAt: nowIso(), activeDurationMs, totalDurationMs: activeDurationMs, attempts: finishAttempt("completed") });
    await cleanupRunInputs(itemDir, completed.input, { preserveInput: completed.removeSubtitles });
    return completed;
  } catch (error) {
    if (error.job?.provider === "wuhen") item.subtitle = subtitleSummary(error.job);
    if (signal?.aborted) {
      const status = item.removeSubtitles ? "paused" : "cancelled";
      const cancelled = await update({ status, stage: item.removeSubtitles ? "subtitle_waiting_paused" : "cancelled", cancelledAt: nowIso(), attempts: finishAttempt(status), error: null, usage: error.usage || item.usage || null, providerAttempts: error.requestAttempts || item.providerAttempts || [] });
      await cleanupAnalysisInput(itemDir);
      return cancelled;
    }
    const serialized = serializeError(error);
    const activeDurationMs = previousActiveMs + Date.now() - invocationStartedAt - invocationQuotaWaitMs;
    const quotaWaitDurationMs = previousQuotaWaitMs + invocationQuotaWaitMs;
    const errorRecord = { ...serialized, ...(item.subtitle ? { subtitle: item.subtitle } : {}), videoId: item.videoId, sourceFilename: item.sourceFilename, failedStage: item.stage, occurredAt: nowIso() };
    await writeBatchJson(path.join(artifactsDir, "error.json"), errorRecord);
    const failed = await update({
      status: "failed", failedStage: item.stage, stage: `${item.stage || "unknown"}_failed`, error: serialized.message,
      activeDurationMs, totalDurationMs: activeDurationMs, quotaWaitDurationMs,
      usage: error.usage || item.usage || null, providerAttempts: error.requestAttempts || item.providerAttempts || [], unknownCostAttempts: Number(error.requestAttempts?.filter((entry) => entry.costStatus === "unknown").length || error.unknownCostAttempts || 0),
      attempts: finishAttempt("failed", { failedStage: item.stage, error: serialized }),
    });
    await cleanupAnalysisInput(itemDir);
    return failed;
  }
}
