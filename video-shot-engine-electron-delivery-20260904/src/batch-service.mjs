import fsp from "node:fs/promises";
import path from "node:path";
import { processVideo } from "./shot-service.mjs";
import { executeShotNaming } from "./naming-service.mjs";
import { serializeError } from "./network.mjs";
import { calculateCostYuan } from "./pricing.mjs";
import { cleanupAnalysisInput, cleanupRunInputs } from "./input-cleanup.mjs";

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const nowIso = () => new Date().toISOString();
const isQuotaError = (error) => /quota|rate.?limit|too many requests|429/i.test(error?.message || "") || error?.status === 429;
const quotaDelayMs = (error, attempt) => {
  const seconds = Number(/retry in\s+([\d.]+)s/i.exec(error?.message || "")?.[1]);
  return Number.isFinite(seconds) ? Math.ceil((seconds + 2) * 1000) : Math.min(120000, 30000 * (attempt + 1));
};

export async function writeBatchJson(file, value) { await fsp.writeFile(file, json(value), "utf8"); }
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

export async function processBatchItem({ batchDir, item, gemini, thresholds, onUpdate }) {
  const itemDir = path.join(batchDir, "items", item.videoId);
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
    await writeBatchJson(path.join(itemDir, "item.json"), item);
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
    if (!item.shots || item.shotDetectionVersion !== "2-primary-threshold") {
      await fsp.rm(path.join(artifactsDir, "shot_segments"), { recursive: true, force: true });
      await fsp.rm(path.join(itemDir, "named_segments"), { recursive: true, force: true });
      for (const name of ["shot_labels_raw.json", "shot_labels_normalized.json", "rename_manifest.json", "gemini_response.json", "usage.json", "provider_attempts.json"]) await fsp.rm(path.join(artifactsDir, name), { force: true });
      const ffmpegStartedAt = Date.now();
      await update({ status: "processing", stage: "ffmpeg_processing", error: null, failedStage: null });
      const result = await processVideo({ runDir: itemDir, artifactsDir, inputPath: item.input, ...thresholds, keepAudio: item.keepAudio });
      item = await update({ ...result, status: "processing", stage: "ffmpeg_completed", ffmpegDurationMs: Number(item.ffmpegDurationMs || 0) + Date.now() - ffmpegStartedAt });
    }

    if (item.autoName && gemini) {
      await update({ status: "processing", stage: "naming_processing", error: null, failedStage: null });
      let naming;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          naming = await executeShotNaming({ runDir: itemDir, initialRun: item, gemini, onStage: async (stage, patch = {}) => update({ status: "processing", stage, ...patch }) });
          break;
        } catch (error) {
          if (!isQuotaError(error) || attempt === 2) throw error;
          const delayMs = quotaDelayMs(error, attempt);
          await update({ status: "quota_wait", stage: "quota_wait", quotaRetryAttempt: attempt + 1, quotaRetryDelayMs: delayMs, quotaRetryAt: new Date(Date.now() + delayMs).toISOString(), error: error.message });
          const waitStartedAt = Date.now();
          await sleep(delayMs);
          invocationQuotaWaitMs += Date.now() - waitStartedAt;
          await update({ status: "processing", stage: "gemini_analysis_retry", error: null });
        }
      }
      if (!naming) throw new Error("xinhankr 重试结束但未获得命名结果");
      const activeDurationMs = previousActiveMs + Date.now() - invocationStartedAt - invocationQuotaWaitMs;
      const quotaWaitDurationMs = previousQuotaWaitMs + invocationQuotaWaitMs;
      const completed = await update({
        status: "completed", stage: "completed", completedAt: nowIso(), namedShotCount: naming.manifest.length,
        activeDurationMs, totalDurationMs: activeDurationMs, quotaWaitDurationMs,
        namingDurationMs: Math.max(0, activeDurationMs - Number(item.ffmpegDurationMs || 0)), usage: naming.usage,
        providerAttempts: naming.requestAttempts || [], providerSuccessMode: naming.requestAttempts?.find((entry) => entry.accepted)?.schemaMode || null,
        providerSuccessRepeat: naming.requestAttempts?.find((entry) => entry.accepted)?.repeat || null, unknownCostAttempts: Number(naming.requestAttempts?.filter((entry) => entry.costStatus === "unknown").length || 0),
        attempts: finishAttempt("completed", { usage: naming.usage }), error: null, failedStage: null,
      });
      await cleanupRunInputs(itemDir, completed.input);
      return completed;
    }

    const activeDurationMs = previousActiveMs + Date.now() - invocationStartedAt;
    const completed = await update({ status: "completed", stage: "completed", completedAt: nowIso(), activeDurationMs, totalDurationMs: activeDurationMs, attempts: finishAttempt("completed") });
    await cleanupRunInputs(itemDir, completed.input);
    return completed;
  } catch (error) {
    const serialized = serializeError(error);
    const activeDurationMs = previousActiveMs + Date.now() - invocationStartedAt - invocationQuotaWaitMs;
    const quotaWaitDurationMs = previousQuotaWaitMs + invocationQuotaWaitMs;
    const errorRecord = { ...serialized, videoId: item.videoId, sourceFilename: item.sourceFilename, failedStage: item.stage, occurredAt: nowIso() };
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
