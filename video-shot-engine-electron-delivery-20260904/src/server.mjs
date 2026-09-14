import "dotenv/config";
import express from "express";
import multer from "multer";
import fsp from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import { processVideo } from "./shot-service.mjs";
import { createXinhankrService } from "./xinhankr-service.mjs";
import { executeShotNaming } from "./naming-service.mjs";
import { configureHttpsProxy, serializeError } from "./network.mjs";
import { loadBatch, saveBatch, processBatchItem, sumUsage, writeBatchJson } from "./batch-service.mjs";
import { XINHANKR_PRICING } from "./pricing.mjs";
import { publicDir } from "./runtime-paths.mjs";
import { cleanupAnalysisInput, cleanupRunInputs, cleanupStaleInputs } from "./input-cleanup.mjs";

const app = express();
const port = Number(process.env.PORT || 3141);
const host = process.env.HOST || "127.0.0.1";
const runsDir = path.resolve(process.env.RUNS_DIR || "./runs-v1");
const uploadsDir = path.join(runsDir, "_uploads");
const apiKey = process.env.XINHANKR_API_KEY || "";
const model = process.env.XINHANKR_MODEL || "gemini-3.6-flash";
const pollMs = Math.max(1000, Number(process.env.POLL_INTERVAL_MS || 5000));
const proxyConfigured = configureHttpsProxy(process.env.GEMINI_HTTPS_PROXY || "");
const gemini = apiKey ? createXinhankrService({ apiKey, model, baseUrl: process.env.XINHANKR_BASE_URL }) : null;
const activeNamingRuns = new Set();
const activeBatches = new Set();

await fsp.mkdir(uploadsDir, { recursive: true });
await cleanupStaleInputs(runsDir);
const upload = multer({ dest: uploadsDir, limits: { fileSize: 500 * 1024 * 1024 }, defParamCharset: "utf8" });
app.use(express.json({ limit: "1mb" }));
app.use(express.static(publicDir));
app.use("/runs", express.static(runsDir));

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
  await fsp.writeFile(runPath(run.runId), `${JSON.stringify(run, null, 2)}\n`, "utf8");
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
    run: { ...run, namingActive: activeNamingRuns.has(runId) },
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
    if (succeeded) await cleanupRunInputs(runDir, run?.input);
    else await cleanupAnalysisInput(runDir);
    activeNamingRuns.delete(runId);
  }
}

app.get("/api/config", (_req, res) => res.json({
  host, port, mode: "ffmpeg-gemini-naming", model, mediaResolution: "medium", videoProcessing: "model-default",
  apiKeyConfigured: Boolean(apiKey), proxyConfigured, uploadLimitMb: 500, pricing: XINHANKR_PRICING,
}));

app.get("/api/health", (_req, res) => res.json({ ok: true, service: "video-shot-engine", version: "0.1.0" }));

app.get("/api/runs/latest", async (_req, res) => {
  const runId = await latestRunId();
  if (!runId) return res.status(404).json({ error: "暂无运行" });
  res.json({ runId });
});

const batchDirFor = (batchId) => { if (!/^batch_[a-zA-Z0-9_]+$/.test(batchId)) throw new Error("批次 ID 无效"); return path.join(runsDir, batchId); };
app.get("/api/batches/:batchId", async (req, res) => { try { const batchDir = batchDirFor(req.params.batchId); const batch = await loadBatch(batchDir); const items=[]; for (const item of batch.items) { try { const itemDir=path.join(batchDir,"items",item.videoId); const full=JSON.parse(await fsp.readFile(path.join(itemDir,"item.json"),"utf8")); full.renameManifest=await readOptionalJson(path.join(itemDir,"artifacts","rename_manifest.json")); full.errorRecord=await readOptionalJson(path.join(itemDir,"artifacts","error.json")); items.push(full); } catch { items.push(item); } } res.json({ batch: { ...batch, active: activeBatches.has(batch.batchId) }, items }); } catch { res.status(404).json({ error: "批次不存在" }); } });

async function executeBatch(batchId, onlyVideoId = null) {
  if (activeBatches.has(batchId)) return;
  activeBatches.add(batchId);
  const batchDir = batchDirFor(batchId);
  try {
    let batch = await loadBatch(batchDir);
    const executionStartedAt = new Date().toISOString(); const previousWallMs = Number(batch.wallDurationMs || 0);
    batch.status = "processing"; batch.startedAt ||= executionStartedAt; batch.executionStartedAt = executionStartedAt; batch.executionHistory = [...(batch.executionHistory || []), { startedAt: executionStartedAt, mode: onlyVideoId ? "single_retry" : "batch", videoId: onlyVideoId }]; await saveBatch(batchDir, batch);
    for (const itemRef of batch.items) {
      if (onlyVideoId && itemRef.videoId !== onlyVideoId) continue;
      const item = JSON.parse(await fsp.readFile(path.join(batchDir, "items", itemRef.videoId, "item.json"), "utf8"));
      if (["completed"].includes(item.status)) continue;
      await processBatchItem({ batchDir, item, gemini, thresholds: { threshold: batch.threshold, minDurationSec: batch.minDurationSec }, onUpdate: async (updated) => { batch.items = batch.items.map((x) => x.videoId === updated.videoId ? { videoId: x.videoId, status: updated.status, sourceFilename: x.sourceFilename } : x); await saveBatch(batchDir, batch); } });
    }
    const finalItems = (await Promise.all(batch.items.map(async (x) => { try { return JSON.parse(await fsp.readFile(path.join(batchDir,"items",x.videoId,"item.json"),"utf8")); } catch { return x; } })));
    const failed = finalItems.filter((x) => x.status === "failed").length;
    batch.status = failed ? (failed === finalItems.length ? "failed" : "partial") : "completed";
    batch.finishedAt = new Date().toISOString(); batch.processingDurationMs = finalItems.reduce((sum, item) => sum + Number(item.activeDurationMs || item.totalDurationMs || 0), 0); batch.wallDurationMs = previousWallMs + Date.parse(batch.finishedAt) - Date.parse(executionStartedAt); batch.quotaWaitDurationMs = finalItems.reduce((sum,item)=>sum+Number(item.quotaWaitDurationMs||0),0); batch.queueDurationMs = finalItems.reduce((sum,item)=>sum+Number(item.queueDurationMs||0),0); batch.items = finalItems.map((x) => ({ videoId: x.videoId, status: x.status, sourceFilename: x.sourceFilename }));
    const catalog = finalItems.flatMap((x) => { try { return JSON.parse(fs.readFileSync(path.join(batchDir,"items",x.videoId,"artifacts","rename_manifest.json"),"utf8")).map((m) => ({ ...m, videoId:x.videoId, sourceFilename:x.sourceFilename })); } catch { return []; } });
    batch.usage = sumUsage(finalItems);
    await writeBatchJson(path.join(batchDir,"catalog.json"), catalog);
    const csvHeader="video_id,source_filename,shot_id,start_sec,end_sec,filename,usage_type";
    const csvEscape=(value)=>`"${String(value??"").replaceAll('"','""')}"`;
    const csvRows=catalog.map((x)=>[x.videoId,x.sourceFilename,x.shotId,x.startSec??"",x.endSec??"",x.namedFilename,x.usageType||""].map(csvEscape).join(","));
    await fsp.writeFile(path.join(batchDir,"catalog.csv"),`\uFEFF${[csvHeader,...csvRows].join("\r\n")}\r\n`,"utf8");
    const lastExecution=batch.executionHistory.at(-1); Object.assign(lastExecution,{finishedAt:batch.finishedAt,status:batch.status,durationMs:Date.parse(batch.finishedAt)-Date.parse(lastExecution.startedAt)}); await saveBatch(batchDir, batch);
  } catch (error) { const batch=await loadBatch(batchDir); batch.status="failed"; batch.error=serializeError(error); batch.finishedAt=new Date().toISOString(); await writeBatchJson(path.join(batchDir,"batch_error.json"),batch.error); await saveBatch(batchDir,batch); } finally { activeBatches.delete(batchId); }
}

app.post("/api/batches", upload.array("videos", 100), async (req, res) => {
  if (!req.files?.length) return res.status(400).json({ error: "请选择至少一个视频" });
  try {
    const batchId = `batch_${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}_${Math.random().toString(36).slice(2, 8)}`;
    const batchDir = path.join(runsDir, batchId); await fsp.mkdir(path.join(batchDir, "items"), { recursive: true });
    const workflow = req.body?.workflow === "ffmpeg_only" ? "ffmpeg_only" : "ffmpeg_gemini_naming";
    const batch = { batchId, workflow, status: "queued", createdAt: new Date().toISOString(), threshold: Math.max(0, Number(req.body?.threshold || 12)), minDurationSec: Math.max(0.1, Number(req.body?.minDurationSec || 0.2)), autoName: workflow === "ffmpeg_gemini_naming", keepAudio: req.body?.keepAudio === "on", processingMode: "serial", items: [] };
    if (batch.autoName && !gemini) throw new Error("XINHANKR_API_KEY 未配置，无法执行批量自动命名");
    for (let index=0; index<req.files.length; index++) { const file=req.files[index]; const videoId=`video_${String(index+1).padStart(3,"0")}`; const itemDir=path.join(batchDir,"items",videoId); await fsp.mkdir(itemDir,{recursive:true}); const ext=path.extname(file.originalname)||".mp4"; const input=path.join(itemDir,`input${ext}`); await fsp.copyFile(file.path,input); await fsp.rm(file.path,{force:true}); const queuedAt=new Date().toISOString(); const item={videoId,workflow,sourceFilename:file.originalname,input,status:"queued",stage:"queued",queuedAt,autoName:batch.autoName,keepAudio:batch.keepAudio,attempts:[],activeDurationMs:0,quotaWaitDurationMs:0}; await writeBatchJson(path.join(itemDir,"item.json"),item); batch.items.push({videoId,status:"queued",sourceFilename:file.originalname}); }
    await saveBatch(batchDir,batch); void executeBatch(batchId); res.status(202).json({batchId,itemCount:batch.items.length});
  } catch (error) { for(const file of req.files||[]) await fsp.rm(file.path,{force:true}); res.status(500).json({error:serializeError(error).message}); }
});

app.post("/api/batches/:batchId/resume", async (req,res)=>{ try { await loadBatch(batchDirFor(req.params.batchId)); void executeBatch(req.params.batchId); res.status(202).json({batchId:req.params.batchId,resumed:true}); } catch(error){ res.status(400).json({error:error.message}); } });
app.post("/api/batches/:batchId/items/:videoId/retry", async (req,res)=>{ try { const batch=await loadBatch(batchDirFor(req.params.batchId)); if(activeBatches.has(req.params.batchId)) throw new Error("批次正在处理，请等待当前视频结束"); const ref=batch.items.find((item)=>item.videoId===req.params.videoId); if(!ref) throw new Error("批次中不存在该视频"); const itemPath=path.join(batchDirFor(req.params.batchId),"items",ref.videoId,"item.json"); const item=JSON.parse(await fsp.readFile(itemPath,"utf8")); if(item.status!=="failed") throw new Error("只能重试失败的视频"); void executeBatch(req.params.batchId,req.params.videoId); res.status(202).json({batchId:req.params.batchId,videoId:req.params.videoId,retried:true}); } catch(error){ res.status(400).json({error:error.message}); } });

app.get("/api/runs/:runId", async (req, res) => {
  try { res.json(await resultFor(req.params.runId)); }
  catch { res.status(404).json({ error: "运行不存在" }); }
});

app.post("/api/runs", upload.single("video"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "请选择视频" });
  try {
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
    const processingStartedAt = Date.now();
    const result = await processVideo({ runDir, artifactsDir, inputPath: input, threshold, minDurationSec, keepAudio });
    const completedStatus = autoName ? "shots_completed" : "completed";
    const run = await saveRun({
      runId, workflow, sourceFilename: req.file.originalname, input, mode: workflow === "ffmpeg_only" ? "ffmpeg-only" : "ffmpeg-gemini-naming", model: autoName ? model : null,
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
    if (!gemini) throw new Error("请先在 .env 中配置 XINHANKR_API_KEY 并重启服务");
    await loadRun(req.params.runId);
    if (!activeNamingRuns.has(req.params.runId)) void executeNaming(req.params.runId);
    res.status(202).json({ runId: req.params.runId, active: true, resumed });
  } catch (error) { res.status(400).json({ error: serializeError(error).message }); }
}

app.post("/api/runs/:runId/name", (req, res) => startNaming(req, res, false));
app.post("/api/runs/:runId/resume-naming", (req, res) => startNaming(req, res, true));

app.listen(port, host, () => console.log(`FFmpeg shot segmentation and Gemini naming: http://${host}:${port}`));
