import "dotenv/config";
import express from "express";
import multer from "multer";
import fsp from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { processVideo, SHOT_DETECTION_VERSION, assertCurrentShotDetection } from "./shot-service.mjs";
import { createXinhankrService } from "./xinhankr-service.mjs";
import { executeShotNaming } from "./naming-service.mjs";
import { configureHttpsProxy, serializeError } from "./network.mjs";
import { loadBatch, saveBatch, processBatchItem, sumUsage, writeBatchJson, subtitleSummary } from "./batch-service.mjs";
import { XINHANKR_PRICING } from "./pricing.mjs";
import { publicDir } from "./runtime-paths.mjs";
import { cleanupAnalysisInput, cleanupRunInputs, cleanupStaleInputs } from "./input-cleanup.mjs";
import { createWuhenService, validateWuhenOptions } from "./wuhen-service.mjs";
import { createWuhenTransport } from "./wuhen-transport.mjs";

export async function createShotServer(overrides = {}) {
const app = express();
const port = Number(overrides.port ?? process.env.PORT ?? 3141);
const host = overrides.host || process.env.HOST || "127.0.0.1";
const runsDir = path.resolve(overrides.runsDir || process.env.RUNS_DIR || "./runs-v1");
const uploadsDir = path.join(runsDir, "_uploads");
const apiKey = process.env.XINHANKR_API_KEY || "";
let wuhenApiKey = overrides.subtitleApiKey ?? process.env.WUHEN_API_KEY ?? "";
const model = process.env.XINHANKR_MODEL || "gemini-3.6-flash";
const proxyConfigured = configureHttpsProxy(process.env.GEMINI_HTTPS_PROXY || "");
const gemini = overrides.gemini ?? (apiKey ? createXinhankrService({ apiKey, model, baseUrl: process.env.XINHANKR_BASE_URL }) : null);
const transportManager = overrides.transportManager || await createWuhenTransport({ runsDir });
const subtitleService = overrides.subtitleService || createWuhenService({ transportManager }).removeVideoSubtitles;
const itemServices = { subtitleService, videoProcessor: overrides.videoProcessor || processVideo, namingService: overrides.namingService || executeShotNaming };
const activeNamingRuns = new Set();
const activeBatches = new Set();
const batchExecutions = new Map();
const runExecutions = new Map();
const booleanField = (value) => value === true || value === "true" || value === "on" || value === "1";
const requireSubtitleKey = (enabled) => { if (enabled && !wuhenApiKey) throw new Error("请先配置无痕 API Key，再开启去字幕"); };
const publicItem = (item) => item?.subtitle ? { ...item, subtitle: subtitleSummary(item.subtitle) } : item;
const isLocalRequest = (req) => ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress) && (!req.get("origin") || req.get("origin") === `http://${req.get("host")}`);
const parseSubtitleOptions = (value) => {
  if (value == null || value === "") return {};
  if (typeof value === "string") { try { value = JSON.parse(value); } catch { throw new Error("subtitleOptions 必须是有效 JSON"); } }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("subtitleOptions 必须是对象");
  return value;
};

await fsp.mkdir(uploadsDir, { recursive: true });
await cleanupStaleInputs(runsDir);
const upload = multer({ dest: uploadsDir, limits: { fileSize: 500 * 1024 * 1024 }, defParamCharset: "utf8" });
app.use(express.json({ limit: "1mb" }));
app.use(express.static(publicDir));
app.use("/runs", (req, res, next) => {
  let relative;
  try { relative = decodeURIComponent(req.path).replaceAll("\\", "/"); } catch { return res.sendStatus(400); }
  const parts = relative.split("/");
  const subtitleIndex = parts.findIndex((part) => part.toLowerCase() === "subtitle-removal");
  if (subtitleIndex >= 0 && (parts.length !== subtitleIndex + 2 || parts.at(-1) !== "output.mp4")) return res.sendStatus(404);
  next();
}, express.static(runsDir));

const runRoot = (runId) => path.join(runsDir, runId);
const artifactsPath = (runId) => path.join(runRoot(runId), "artifacts");
const runPath = (runId) => path.join(artifactsPath(runId), "run.json");
const legacyRunPath = (runId) => path.join(runRoot(runId), "run.json");

async function loadRun(runId) {
  if (!/^run_[a-zA-Z0-9_]+$/.test(runId)) throw new Error("运行 ID 无效");
  try { return JSON.parse(await fsp.readFile(runPath(runId), "utf8")); }
  catch { return JSON.parse(await fsp.readFile(legacyRunPath(runId), "utf8")); }
}

async function saveRun(run) {
  await fsp.mkdir(artifactsPath(run.runId), { recursive: true });
  await writeBatchJson(runPath(run.runId), run);
  try { await fsp.rm(legacyRunPath(run.runId), { force: true }); } catch {}
  return run;
}

async function updateRun(runId, patch) {
  const current = await loadRun(runId);
  return saveRun({ ...current, ...patch, updatedAt: new Date().toISOString() });
}

async function readOptionalJson(filePath) {
  try { return JSON.parse(await fsp.readFile(filePath, "utf8")); } catch { return null; }
}

async function readRunArtifact(runId, fileName) {
  return await readOptionalJson(path.join(artifactsPath(runId), fileName))
    ?? await readOptionalJson(path.join(runRoot(runId), fileName));
}

async function resultFor(runId) {
  const run = await loadRun(runId);
  return {
    run: { ...publicItem(run), namingActive: activeNamingRuns.has(runId), active: runExecutions.has(runId) || activeNamingRuns.has(runId) },
    shotLabels: await readRunArtifact(runId, "shot_labels_normalized.json"),
    renameManifest: await readRunArtifact(runId, "rename_manifest.json"),
    namingError: run.status === "failed" ? await readRunArtifact(runId, "naming_error.json") : null,
  };
}

async function latestRunId() {
  const entries = await fsp.readdir(runsDir, { withFileTypes: true });
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^(run|batch)_[a-zA-Z0-9_]+$/.test(entry.name)) continue;
    try {
      let stat;
      if (entry.name.startsWith("batch_")) stat = await fsp.stat(path.join(runsDir, entry.name, "batch.json"));
      else try { stat = await fsp.stat(runPath(entry.name)); } catch { stat = await fsp.stat(legacyRunPath(entry.name)); }
      candidates.push({ runId: entry.name, mtimeMs: stat.mtimeMs });
    } catch {}
  }
  return candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)[0]?.runId || null;
}

async function executeNaming(runId) {
  if (!gemini) throw new Error("XINHANKR_API_KEY 未配置");
  if (activeNamingRuns.has(runId)) return;
  try { assertCurrentShotDetection(await loadRun(runId)); }
  catch (error) { if (error.code === "SHOT_DETECTION_VERSION_MISMATCH") return; throw error; }
  if (activeNamingRuns.has(runId)) return;
  activeNamingRuns.add(runId);
  const runDir = path.join(runsDir, runId);
  const namingStartedAt = Date.now();
  let run;
  let succeeded = false;
  let previousNamingMs = 0;
  try {
    run = await updateRun(runId, { status: "processing", stage: "naming_prepare", namingError: null });
    previousNamingMs = Number(run.namingDurationMs || 0);
    const result = await executeShotNaming({
      runDir,
      initialRun: run,
      gemini,
      onStage: async (stage, patch = {}) => {
        run = await updateRun(runId, { ...patch, status: "processing", stage });
        return run;
      },
    });
    await updateRun(runId, {
      status: "completed",
      stage: "completed",
      geminiFileName: result.geminiFileName,
      geminiFileUri: result.geminiFileUri,
      namedShotCount: result.manifest.length,
      namingCompletedAt: new Date().toISOString(),
      namingError: null,
      namingDurationMs: previousNamingMs + Date.now() - namingStartedAt,
      usage: result.usage,
      providerAttempts: result.requestAttempts || [],
      providerSuccessMode: result.requestAttempts?.find((entry) => entry.accepted)?.schemaMode || null,
      providerSuccessRepeat: result.requestAttempts?.find((entry) => entry.accepted)?.repeat || null,
      unknownCostAttempts: Number(result.requestAttempts?.filter((entry) => entry.costStatus === "unknown").length || 0),
    });
    succeeded = true;
  } catch (error) {
    const serialized = serializeError(error);
    await fsp.mkdir(path.join(runDir, "artifacts"), { recursive: true });
    await fsp.writeFile(path.join(runDir, "artifacts", "naming_error.json"), `${JSON.stringify(serialized, null, 2)}\n`, "utf8");
    await updateRun(runId, { status: "failed", stage: "naming_failed", namingError: serialized.message, namingDurationMs: previousNamingMs + Date.now() - namingStartedAt, usage: error.usage || run?.usage || null, providerAttempts: error.requestAttempts || run?.providerAttempts || [], unknownCostAttempts: Number(error.requestAttempts?.filter((entry) => entry.costStatus === "unknown").length || error.unknownCostAttempts || 0) });
  } finally {
    if (succeeded) await cleanupRunInputs(runDir, run?.input, { preserveInput: run?.removeSubtitles });
    else await cleanupAnalysisInput(runDir);
    activeNamingRuns.delete(runId);
  }
}

app.get("/api/config", (_req, res) => res.json({
  host, port, mode: "ffmpeg-gemini-naming", model, mediaResolution: "medium", videoProcessing: "model-default",
  apiKeyConfigured: Boolean(apiKey), subtitleProvider: "wuhen", subtitleConfigured: Boolean(wuhenApiKey), subtitleTransportPort: transportManager.port, proxyConfigured, uploadLimitMb: 500, pricing: XINHANKR_PRICING,
}));

app.post("/api/subtitle-config", (req, res) => {
  if (!isLocalRequest(req)) return res.status(403).json({ error: "只允许本地客户端配置无痕密钥" });
  if (typeof req.body?.apiKey !== "string") return res.status(400).json({ error: "apiKey 必须为字符串" });
  wuhenApiKey = req.body.apiKey.trim();
  res.json({ subtitleProvider: "wuhen", subtitleConfigured: Boolean(wuhenApiKey) });
});

app.post("/api/subtitle-transport", (req, res) => {
  if (!isLocalRequest(req)) return res.status(403).json({ error: "只允许本地客户端配置去字幕传输" });
  try {
    const value = req.body?.publicBaseUrl;
    const url = new URL(value);
    if (typeof value !== "string" || url.protocol !== "https:" || !/^[a-z0-9-]+\.trycloudflare\.com$/i.test(url.hostname) || url.username || url.password || url.port || url.search || url.hash || url.pathname !== "/") throw new Error("invalid transport URL");
    transportManager.setPublicBaseUrl(url.origin);
    res.json({ configured: true });
  } catch { res.status(400).json({ error: "去字幕传输需要官方 HTTPS Quick Tunnel 地址" }); }
});

app.get("/api/health", (_req, res) => res.json({ ok: true, service: "video-shot-engine", version: "0.1.0" }));

app.get("/api/runs/latest", async (_req, res) => {
  const runId = await latestRunId();
  if (!runId) return res.status(404).json({ error: "暂无运行" });
  res.json({ runId });
});

const batchDirFor = (batchId) => { if (!/^batch_[a-zA-Z0-9_]+$/.test(batchId)) throw new Error("批次 ID 无效"); return path.join(runsDir, batchId); };
async function assertBatchDetection(batchDir, batch, onlyVideoId = null) {
  assertCurrentShotDetection(batch);
  for (const ref of batch.items) {
    if (onlyVideoId && ref.videoId !== onlyVideoId) continue;
    const item = JSON.parse(await fsp.readFile(path.join(batchDir, "items", ref.videoId, "item.json"), "utf8"));
    if (item.status !== "completed") assertCurrentShotDetection(item);
  }
}
app.get("/api/batches/:batchId", async (req, res) => { try { const batchDir = batchDirFor(req.params.batchId); const batch = await loadBatch(batchDir); const items=[]; for (const item of batch.items) { try { const itemDir=path.join(batchDir,"items",item.videoId); const full=JSON.parse(await fsp.readFile(path.join(itemDir,"item.json"),"utf8")); full.renameManifest=await readOptionalJson(path.join(itemDir,"artifacts","rename_manifest.json")); full.errorRecord=await readOptionalJson(path.join(itemDir,"artifacts","error.json")); items.push(publicItem(full)); } catch { items.push(publicItem(item)); } } res.json({ batch: { ...batch, active: activeBatches.has(batch.batchId) }, items }); } catch { res.status(404).json({ error: "批次不存在" }); } });

async function finalizeCancelledBatch(batchDir, batch) {
  const itemRefs = [...batch.items];
  const knownIds = new Set(itemRefs.map((item) => item.videoId));
  for (const entry of await fsp.readdir(path.join(batchDir, "items"), { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^video_\d+$/.test(entry.name) || knownIds.has(entry.name)) continue;
    try {
      const item = JSON.parse(await fsp.readFile(path.join(batchDir, "items", entry.name, "item.json"), "utf8"));
      itemRefs.push({ videoId: entry.name, sourceFilename: item.sourceFilename, sourceFolderId: item.sourceFolderId || null, sourceFolderName: item.sourceFolderName || null, sourceRelativePath: item.sourceRelativePath || item.sourceFilename });
    } catch {}
  }
  const cancelledAt = new Date().toISOString();
  const finalItems = [];
  for (const ref of itemRefs) {
    const itemPath = path.join(batchDir, "items", ref.videoId, "item.json");
    let item;
    try { item = JSON.parse(await fsp.readFile(itemPath, "utf8")); }
    catch { item = { ...ref, status: "queued" }; }
    if (item.status !== "completed" && item.status !== "cancelled" && !(batch.removeSubtitles && ["queued", "failed", "paused"].includes(item.status))) {
      item = { ...item, status: batch.removeSubtitles ? "paused" : "cancelled", stage: batch.removeSubtitles ? "subtitle_waiting_paused" : "cancelled", cancelledAt };
      await writeBatchJson(itemPath, item);
    }
    finalItems.push(item);
  }
  batch.items = finalItems.map((item) => ({ videoId: item.videoId, status: item.status, sourceFilename: item.sourceFilename, sourceFolderId: item.sourceFolderId || null, sourceFolderName: item.sourceFolderName || null, sourceRelativePath: item.sourceRelativePath || item.sourceFilename, ...(item.subtitleOptions ? { subtitleOptions: item.subtitleOptions } : {}) }));
  batch.status = finalItems.every((item) => item.status === "completed") ? "completed" : batch.removeSubtitles ? "paused" : "cancelled";
  if (["cancelled", "paused"].includes(batch.status)) batch.cancelledAt = cancelledAt;
  batch.finishedAt = cancelledAt;
  batch.usage = sumUsage(finalItems);
  const lastExecution = batch.executionHistory?.at(-1);
  if (lastExecution && !lastExecution.finishedAt) Object.assign(lastExecution, { finishedAt: cancelledAt, status: batch.status, durationMs: Date.parse(cancelledAt) - Date.parse(lastExecution.startedAt) });
  await saveBatch(batchDir, batch);
  return batch;
}

async function executeBatch(batchId, onlyVideoId = null) {
  if (activeBatches.has(batchId)) return;
  activeBatches.add(batchId);
  const controller = new AbortController();
  let resolveDone;
  const done = new Promise((resolve) => { resolveDone = resolve; });
  batchExecutions.set(batchId, { controller, done });
  const batchDir = batchDirFor(batchId);
  const subtitleApiKey = wuhenApiKey;
  try {
    let batch = await loadBatch(batchDir);
    if (batch.status === "cancelled") return;
    await assertBatchDetection(batchDir, batch, onlyVideoId);
    const executionStartedAt = new Date().toISOString(); const previousWallMs = Number(batch.wallDurationMs || 0);
    batch.status = "processing"; batch.startedAt ||= executionStartedAt; batch.executionStartedAt = executionStartedAt; batch.executionHistory = [...(batch.executionHistory || []), { startedAt: executionStartedAt, mode: onlyVideoId ? "single_retry" : "batch", videoId: onlyVideoId }]; await saveBatch(batchDir, batch);
    for (const itemRef of batch.items) {
      if (controller.signal.aborted) break;
      if (onlyVideoId && itemRef.videoId !== onlyVideoId) continue;
      const item = JSON.parse(await fsp.readFile(path.join(batchDir, "items", itemRef.videoId, "item.json"), "utf8"));
      if (["completed"].includes(item.status)) continue;
      await processBatchItem({ batchDir, item, gemini, subtitleApiKey, ...itemServices, thresholds: { threshold: batch.threshold, minDurationSec: batch.minDurationSec }, signal: controller.signal, onUpdate: async (updated) => { batch.items = batch.items.map((x) => x.videoId === updated.videoId ? { videoId: x.videoId, status: updated.status, sourceFilename: x.sourceFilename, sourceFolderId: x.sourceFolderId || updated.sourceFolderId || null, sourceFolderName: x.sourceFolderName || updated.sourceFolderName || null, sourceRelativePath: x.sourceRelativePath || updated.sourceRelativePath || x.sourceFilename, ...(updated.subtitleOptions ? { subtitleOptions: updated.subtitleOptions } : {}) } : x); await saveBatch(batchDir, batch); } });
    }
    if (controller.signal.aborted) { await finalizeCancelledBatch(batchDir, batch); return; }
    const finalItems = (await Promise.all(batch.items.map(async (x) => { try { return JSON.parse(await fsp.readFile(path.join(batchDir,"items",x.videoId,"item.json"),"utf8")); } catch { return x; } })));
    const failed = finalItems.filter((x) => x.status === "failed").length;
    batch.status = finalItems.every((item) => item.status === "completed") ? "completed"
      : batch.removeSubtitles && finalItems.some((item) => ["paused", "queued"].includes(item.status)) ? "paused"
      : failed === finalItems.length ? "failed" : "partial";
    batch.finishedAt = new Date().toISOString(); batch.processingDurationMs = finalItems.reduce((sum, item) => sum + Number(item.activeDurationMs || item.totalDurationMs || 0), 0); batch.wallDurationMs = previousWallMs + Date.parse(batch.finishedAt) - Date.parse(executionStartedAt); batch.quotaWaitDurationMs = finalItems.reduce((sum,item)=>sum+Number(item.quotaWaitDurationMs||0),0); batch.queueDurationMs = finalItems.reduce((sum,item)=>sum+Number(item.queueDurationMs||0),0); batch.items = finalItems.map((x) => ({ videoId: x.videoId, status: x.status, sourceFilename: x.sourceFilename, sourceFolderId: x.sourceFolderId || null, sourceFolderName: x.sourceFolderName || null, sourceRelativePath: x.sourceRelativePath || x.sourceFilename, ...(x.subtitleOptions ? { subtitleOptions: x.subtitleOptions } : {}) }));
    const catalog = finalItems.flatMap((x) => { try { return JSON.parse(fs.readFileSync(path.join(batchDir,"items",x.videoId,"artifacts","rename_manifest.json"),"utf8")).map((m) => ({ ...m, videoId:x.videoId, sourceFilename:x.sourceFilename, sourceFolderId:x.sourceFolderId||null, sourceFolderName:x.sourceFolderName||null })); } catch { return []; } });
    batch.usage = sumUsage(finalItems);
    await writeBatchJson(path.join(batchDir,"catalog.json"), catalog);
    const csvHeader="video_id,source_filename,shot_id,start_sec,end_sec,filename,usage_type";
    const csvEscape=(value)=>`"${String(value??"").replaceAll('"','""')}"`;
    const csvRows=catalog.map((x)=>[x.videoId,x.sourceFilename,x.shotId,x.startSec??"",x.endSec??"",x.namedFilename,x.usageType||""].map(csvEscape).join(","));
    await fsp.writeFile(path.join(batchDir,"catalog.csv"),`\uFEFF${[csvHeader,...csvRows].join("\r\n")}\r\n`,"utf8");
    const lastExecution=batch.executionHistory.at(-1); Object.assign(lastExecution,{finishedAt:batch.finishedAt,status:batch.status,durationMs:Date.parse(batch.finishedAt)-Date.parse(lastExecution.startedAt)}); await saveBatch(batchDir, batch);
  } catch (error) { if (error.code !== "SHOT_DETECTION_VERSION_MISMATCH") { const batch=await loadBatch(batchDir); if (controller.signal.aborted) await finalizeCancelledBatch(batchDir, batch); else { batch.status="failed"; batch.error=serializeError(error); batch.finishedAt=new Date().toISOString(); await writeBatchJson(path.join(batchDir,"batch_error.json"),batch.error); await saveBatch(batchDir,batch); } } } finally { activeBatches.delete(batchId); batchExecutions.delete(batchId); resolveDone(); }
}

app.post("/api/batches", upload.array("videos", 100), async (req, res) => {
  if (!req.files?.length) return res.status(400).json({ error: "请选择至少一个视频" });
  try {
    const removeSubtitles = booleanField(req.body?.removeSubtitles);
    requireSubtitleKey(removeSubtitles);
    const workflow = req.body?.workflow === "ffmpeg_only" ? "ffmpeg_only" : "ffmpeg_gemini_naming";
    let folderManifest = [];
    try { folderManifest = JSON.parse(req.body?.folderManifest || "[]"); } catch { throw new Error("folderManifest 必须是有效 JSON"); }
    if (!Array.isArray(folderManifest)) throw new Error("folderManifest 必须为数组");
    const commonOptions = removeSubtitles ? parseSubtitleOptions(req.body?.subtitleOptions) : null;
    const itemOptions = req.files.map((_file, index) => removeSubtitles ? validateWuhenOptions({ ...commonOptions, ...(commonOptions.method !== "all_area" && folderManifest[index]?.subtitleRectNormalized ? { rectNormalized: folderManifest[index].subtitleRectNormalized } : {}) }) : null);
    const batchId = `batch_${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}_${Math.random().toString(36).slice(2, 8)}`;
    const batchDir = path.join(runsDir, batchId); await fsp.mkdir(path.join(batchDir, "items"), { recursive: true });
    const batch = { batchId, shotDetectionVersion: SHOT_DETECTION_VERSION, workflow, removeSubtitles, ...(removeSubtitles ? { subtitleProvider: "wuhen", subtitleOptions: { model: itemOptions[0].model, method: itemOptions[0].method } } : {}), status: "queued", createdAt: new Date().toISOString(), threshold: Math.max(0, Number(req.body?.threshold || 12)), minDurationSec: Math.max(0.1, Number(req.body?.minDurationSec || 0.2)), autoName: workflow === "ffmpeg_gemini_naming", keepAudio: req.body?.keepAudio === "on", processingMode: "serial", folderMode: folderManifest.some((entry) => entry?.sourceFolderId), items: [] };
    if (batch.autoName && !gemini) throw new Error("XINHANKR_API_KEY 未配置，无法执行批量自动命名");
    for (let index=0; index<req.files.length; index++) { const file=req.files[index]; const folderMeta=folderManifest[index]||{}; const videoId=`video_${String(index+1).padStart(3,"0")}`; const itemDir=path.join(batchDir,"items",videoId); await fsp.mkdir(itemDir,{recursive:true}); const ext=path.extname(file.originalname)||".mp4"; const input=path.join(itemDir,`input${ext}`); await fsp.copyFile(file.path,input); await fsp.rm(file.path,{force:true}); const queuedAt=new Date().toISOString(); const item={videoId,shotDetectionVersion:SHOT_DETECTION_VERSION,workflow,removeSubtitles,...(removeSubtitles ? { subtitleProvider: "wuhen", subtitleOptions: itemOptions[index] } : {}),sourceFilename:file.originalname,sourceFolderId:folderMeta.sourceFolderId||null,sourceFolderName:folderMeta.sourceFolderName||null,sourceRelativePath:folderMeta.sourceRelativePath||file.originalname,input,status:"queued",stage:"queued",queuedAt,autoName:batch.autoName,keepAudio:batch.keepAudio,attempts:[],activeDurationMs:0,quotaWaitDurationMs:0}; await writeBatchJson(path.join(itemDir,"item.json"),item); batch.items.push({videoId,status:"queued",sourceFilename:file.originalname,sourceFolderId:item.sourceFolderId,sourceFolderName:item.sourceFolderName,sourceRelativePath:item.sourceRelativePath,...(removeSubtitles ? { subtitleOptions: item.subtitleOptions } : {})}); }
    await saveBatch(batchDir,batch); void executeBatch(batchId); res.status(202).json({batchId,itemCount:batch.items.length});
  } catch (error) { for(const file of req.files||[]) await fsp.rm(file.path,{force:true}); res.status(500).json({error:serializeError(error).message}); }
});

app.post("/api/batches/:batchId/resume", async (req,res)=>{ try { const batch=await loadBatch(batchDirFor(req.params.batchId)); if (["cancelled","completed"].includes(batch.status)) throw new Error("任务已结束，不能继续处理"); await assertBatchDetection(batchDirFor(req.params.batchId), batch); requireSubtitleKey(batch.removeSubtitles); void executeBatch(req.params.batchId); res.status(202).json({batchId:req.params.batchId,resumed:true}); } catch(error){ res.status(400).json({error:error.message}); } });
app.post("/api/batches/:batchId/cancel", async (req, res) => {
  try {
    const batchDir = batchDirFor(req.params.batchId);
    const batch = await loadBatch(batchDir);
    const execution = batchExecutions.get(batch.batchId);
    if (execution) {
      execution.controller.abort(new Error("用户取消任务"));
      await execution.done;
    } else {
      if (["cancelled", "completed", "paused"].includes(batch.status)) return res.json({ batchId: batch.batchId, status: batch.status });
      await finalizeCancelledBatch(batchDir, batch);
    }
    const latest = await loadBatch(batchDir);
    res.json({ batchId: latest.batchId, status: latest.status });
  } catch (error) { res.status(500).json({ error: error.message }); }
});
app.post("/api/batches/:batchId/items/:videoId/retry", async (req,res)=>{ try { const batch=await loadBatch(batchDirFor(req.params.batchId)); if(activeBatches.has(req.params.batchId)) throw new Error("批次正在处理，请等待当前视频结束"); const ref=batch.items.find((item)=>item.videoId===req.params.videoId); if(!ref) throw new Error("批次中不存在该视频"); const itemPath=path.join(batchDirFor(req.params.batchId),"items",ref.videoId,"item.json"); const item=JSON.parse(await fsp.readFile(itemPath,"utf8")); if(item.status!=="failed" && !(item.removeSubtitles && item.status==="paused")) throw new Error("只能重试失败或暂停的视频"); await assertBatchDetection(batchDirFor(req.params.batchId), batch, req.params.videoId); requireSubtitleKey(item.removeSubtitles); void executeBatch(req.params.batchId,req.params.videoId); res.status(202).json({batchId:req.params.batchId,videoId:req.params.videoId,retried:true}); } catch(error){ res.status(400).json({error:error.message}); } });

app.get("/api/runs/:runId", async (req, res) => {
  try { res.json(await resultFor(req.params.runId)); }
  catch { res.status(404).json({ error: "运行不存在" }); }
});

async function executeSubtitleRun(runId) {
  if (runExecutions.has(runId)) return;
  const controller = new AbortController();
  const subtitleApiKey = wuhenApiKey;
  let resolveDone;
  const done = new Promise((resolve) => { resolveDone = resolve; });
  runExecutions.set(runId, { controller, done });
  try {
    const run = await loadRun(runId);
    await processBatchItem({ runDir: runRoot(runId), stateFile: runPath(runId), item: run, gemini, subtitleApiKey, ...itemServices,
      thresholds: { threshold: run.threshold, minDurationSec: run.minDurationSec }, signal: controller.signal,
      onUpdate: async () => {} });
  } catch (error) {
    if (error.code !== "SHOT_DETECTION_VERSION_MISMATCH") await updateRun(runId, { status: "failed", stage: "processing_failed", error: serializeError(error).message });
  } finally { runExecutions.delete(runId); resolveDone(); }
}

app.post("/api/runs/:runId/resume", async (req, res) => {
  try {
    const run = await loadRun(req.params.runId);
    if (!run.removeSubtitles) throw new Error("此接口仅用于恢复去字幕拆分任务");
    if (run.status === "completed") return res.json({ runId: run.runId, status: run.status, active: false });
    assertCurrentShotDetection(run);
    requireSubtitleKey(true);
    void executeSubtitleRun(run.runId);
    res.status(202).json({ runId: run.runId, resumed: true, active: true });
  } catch (error) { res.status(400).json({ error: error.message }); }
});

app.post("/api/runs/:runId/cancel", async (req, res) => {
  try {
    const run = await loadRun(req.params.runId);
    if (!run.removeSubtitles) throw new Error("此接口仅用于暂停去字幕拆分任务");
    const execution = runExecutions.get(run.runId);
    if (execution) { execution.controller.abort(new Error("用户停止本地等待")); await execution.done; }
    else if (!["completed", "paused"].includes(run.status)) await updateRun(run.runId, { status: "paused", stage: "subtitle_waiting_paused" });
    const current = await loadRun(run.runId);
    res.json({ runId: run.runId, status: current.status, active: false });
  } catch (error) { res.status(400).json({ error: error.message }); }
});

app.post("/api/runs", upload.single("video"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "请选择视频" });
  try {
    const removeSubtitles = booleanField(req.body?.removeSubtitles);
    requireSubtitleKey(removeSubtitles);
    const subtitleOptions = removeSubtitles ? validateWuhenOptions(parseSubtitleOptions(req.body?.subtitleOptions)) : null;
    const runId = `run_${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}_${Math.random().toString(36).slice(2, 8)}`;
    const runDir = path.join(runsDir, runId);
    await fsp.mkdir(runDir);
    const artifactsDir = path.join(runDir, "artifacts");
    await fsp.mkdir(artifactsDir);
    const ext = path.extname(req.file.originalname) || ".mp4";
    const input = path.join(runDir, `input${ext}`);
    await fsp.copyFile(req.file.path, input);
    await fsp.rm(req.file.path, { force: true });
    const threshold = Math.max(0, Number(req.body?.threshold || 12));
    const minDurationSec = Math.max(0.1, Number(req.body?.minDurationSec || 0.2));
    const keepAudio = req.body?.keepAudio === "on";
    const workflow = req.body?.workflow === "ffmpeg_only" ? "ffmpeg_only" : "ffmpeg_gemini_naming";
    const autoName = workflow === "ffmpeg_gemini_naming";
    if (removeSubtitles) {
      if (autoName && !gemini) throw new Error("XINHANKR_API_KEY 未配置，无法执行自动命名");
      const queuedAt = new Date().toISOString();
      await saveRun({ runId, shotDetectionVersion: SHOT_DETECTION_VERSION, removeSubtitles, subtitleProvider: "wuhen", subtitleOptions, workflow, sourceFilename: req.file.originalname, input,
        mode: autoName ? "ffmpeg-gemini-naming" : "ffmpeg-only", model: autoName ? model : null,
        threshold, minDurationSec, keepAudio, autoName, status: "queued", stage: "queued", createdAt: queuedAt, queuedAt, attempts: [] });
      void executeSubtitleRun(runId);
      return res.status(202).json({ runId, status: "queued", active: true });
    }
    const processingStartedAt = Date.now();
    const result = await processVideo({ runDir, artifactsDir, inputPath: input, threshold, minDurationSec, keepAudio });
    const completedStatus = autoName ? "shots_completed" : "completed";
    const run = await saveRun({
      runId, removeSubtitles: false, workflow, sourceFilename: req.file.originalname, input, mode: workflow === "ffmpeg_only" ? "ffmpeg-only" : "ffmpeg-gemini-naming", model: autoName ? model : null,
      status: completedStatus, stage: completedStatus, autoName, createdAt: new Date().toISOString(), ...result, ffmpegDurationMs: Date.now() - processingStartedAt,
    });
    if (autoName && gemini) void executeNaming(runId);
    if (!autoName) await cleanupRunInputs(runDir, run.input);
    res.json({ runId, ...result, status: run.status, namingStarted: autoName && Boolean(gemini) });
  } catch (error) {
    await fsp.rm(req.file?.path || "", { force: true });
    res.status(500).json({ error: serializeError(error).message });
  }
});

async function startNaming(req, res, resumed = false) {
  try {
    const run = await loadRun(req.params.runId);
    assertCurrentShotDetection(run);
    if (!gemini) throw new Error("请先在 .env 中配置 XINHANKR_API_KEY 并重启服务");
    if (run.removeSubtitles) {
      requireSubtitleKey(true);
      if (!runExecutions.has(run.runId)) {
        await updateRun(run.runId, { autoName: true, workflow: "ffmpeg_gemini_naming" });
        void executeSubtitleRun(run.runId);
      }
      return res.status(202).json({ runId: run.runId, active: true, resumed });
    }
    if (!activeNamingRuns.has(req.params.runId)) void executeNaming(req.params.runId);
    res.status(202).json({ runId: req.params.runId, active: true, resumed });
  } catch (error) { res.status(400).json({ error: serializeError(error).message }); }
}

app.post("/api/runs/:runId/name", (req, res) => startNaming(req, res, false));
app.post("/api/runs/:runId/resume-naming", (req, res) => startNaming(req, res, true));

return { app, transportManager, async listen() {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => resolve(server));
    server.once("error", reject);
  });
} };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const runtime = await createShotServer();
  const server = await runtime.listen();
  console.log(`FFmpeg shot segmentation and Gemini naming: http://${server.address().address}:${server.address().port}`);
}
