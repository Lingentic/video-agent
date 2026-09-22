import fsp from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createNamingProfile } from "./naming-profile.mjs";
import { createNamedFilename, createUniqueFilename } from "./filename-service.mjs";
import { calculateCostYuan } from "./pricing.mjs";
import { ffmpegPath } from "./runtime-paths.mjs";
const execFileAsync = promisify(execFile);
const SHOT_END_TOLERANCE_SEC = 2;

async function writeJson(filePath, value) { await fsp.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8"); }
async function readOptionalJson(filePath) { try { return JSON.parse(await fsp.readFile(filePath, "utf8")); } catch (error) { if (error?.code === "ENOENT") return null; throw error; } }
const normalizeShotId = (value) => { const text = String(value || "").trim().toLowerCase(); const match = /^shot_(\d+)$/.exec(text); return match ? `shot_${match[1].padStart(3, "0")}` : text; };
const mergeUsage = (...values) => {
  const usage = values.filter(Boolean).reduce((sum, value) => {
    sum.total_tokens += Number(value.total_tokens || 0);
    sum.total_input_tokens += Number(value.total_input_tokens || 0);
    sum.total_output_tokens += Number(value.total_output_tokens || 0);
    sum.total_thought_tokens += Number(value.total_thought_tokens || 0);
    return sum;
  }, { total_tokens: 0, total_input_tokens: 0, total_output_tokens: 0, total_thought_tokens: 0 });
  usage.estimated_cost_yuan = calculateCostYuan(usage);
  return usage;
};

export function validateAndNormalizeLabels(raw, shots, durationSec = Math.max(...shots.map((shot) => Number(shot.endSec))), profile = null) {
  if (Array.isArray(raw)) raw = { shots: raw };
  if (!Array.isArray(raw?.shots)) throw new Error("Gemini 命名结果缺少 shots 数组");
  const expected = shots.map((shot) => shot.shotId); const byId = new Map();
  for (const value of raw.shots) {
    const id = normalizeShotId(value?.shot_id); if (!expected.includes(id)) throw new Error(`Gemini 返回了未知镜头：${value?.shot_id || "空 ID"}`); if (byId.has(id)) throw new Error(`Gemini 重复返回镜头：${id}`);
    byId.set(id, value);
  }
  if (byId.size !== expected.length) throw new Error(`Gemini 遗漏镜头：${expected.filter((id) => !byId.has(id)).join(", ")}`);
  return expected.map((id, index) => {
    const value = byId.get(id);
    const startSec = Number(shots[index].startSec);
    const endSec = Number(shots[index].endSec);
    const contentTitle = String(value.content_title || "").trim();
    const usageType = String(value.usage_type || "").trim();
    const allowedUsageTypes = profile?.schema?.properties?.shots?.items?.properties?.usage_type?.enum || [];
    if (!Number.isFinite(endSec) || endSec <= startSec || endSec > durationSec + SHOT_END_TOLERANCE_SEC) throw new Error(`Gemini 返回了非法边界：${id}`);
    if (!contentTitle) throw new Error(`Gemini 返回了空内容标题：${id}`);
    if (!usageType || (allowedUsageTypes.length && !allowedUsageTypes.includes(usageType))) throw new Error(`Gemini 返回了非法用途标签：${id}`);
    const label = { shotId: id, startSec, endSec, contentTitle, usageType, recommendedUsages: [usageType] };
    if (index === expected.length - 1 && Math.abs(endSec - durationSec) > SHOT_END_TOLERANCE_SEC) throw new Error("最后一个镜头未覆盖到视频结尾");
    return label;
  });
}

function parseJsonText(value) { return JSON.parse(String(value || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")); }

export async function createAnnotatedAnalysisVideo(inputPath, shots, outputPath) {
  const durationSec = Math.max(0.1, Number(shots.at(-1)?.endSec || 1));
  const totalKbps = Math.max(96, Math.min(900, Math.floor((7 * 8192) / durationSec)));
  const videoKbps = Math.max(48, totalKbps - 48);
  const overlays = shots.map((shot) => {
    const label = shot.shotId.toUpperCase();
    return `drawtext=text='${label}':x=16:y=16:fontsize=34:fontcolor=white:box=1:boxcolor=black@0.78:boxborderw=10:enable='between(t,${shot.startSec},${shot.endSec})'`;
  }).join(",");
  const filters = `fps=15,scale=480:-2,${overlays}`;
  await execFileAsync(ffmpegPath, ["-y", "-i", inputPath, "-vf", filters, "-map", "0:v:0", "-map", "0:a?", "-c:v", "libx264", "-preset", "veryfast", "-b:v", `${videoKbps}k`, "-maxrate", `${videoKbps}k`, "-bufsize", `${videoKbps * 2}k`, "-c:a", "aac", "-b:a", "48k", "-movflags", "+faststart", outputPath], { maxBuffer: 8 * 1024 * 1024 });
  const stat = await fsp.stat(outputPath);
  return { targetMaxBytes: 7 * 1024 * 1024, actualBytes: stat.size, base64EstimatedBytes: Math.ceil(stat.size * 4 / 3), fps: 15, width: 480, videoKbps, audioKbps: 48 };
}

export async function executeShotNaming({ runDir, initialRun, gemini, onStage }) {
  let run = initialRun; const artifactsDir = path.join(runDir, "artifacts"); await fsp.mkdir(artifactsDir, { recursive: true }); const stage = async (name, patch = {}) => { run = await onStage(name, patch); return run; };
  const profile = createNamingProfile(run.shots, run.durationSec, run.cuts || [], run.fps || 30); await fsp.writeFile(path.join(artifactsDir, "naming_prompt_snapshot.txt"), profile.prompt, "utf8"); await writeJson(path.join(artifactsDir, "naming_schema_snapshot.json"), profile.schema); await writeJson(path.join(artifactsDir, "shot_manifest_for_gemini.json"), profile.manifest);
  let raw; let result;
  try {
    raw = JSON.parse(await fsp.readFile(path.join(artifactsDir, "shot_labels_raw.json"), "utf8"));
    validateAndNormalizeLabels(raw, run.shots, run.durationSec, profile);
    result = { usage: await readOptionalJson(path.join(artifactsDir, "usage.json")), requestAttempts: await readOptionalJson(path.join(artifactsDir, "provider_attempts.json")) || [] };
  }
  catch {
    await stage("analysis_video_processing");
    const analysisInput = path.join(artifactsDir, "analysis_input_numbered.mp4");
    const analysisConfig = await createAnnotatedAnalysisVideo(run.input, run.shots, analysisInput);
    await writeJson(path.join(artifactsDir, "analysis_input_config.json"), { source: run.input, output: analysisInput, overlay: "persistent shot_id", timelineChanged: false, audioPreserved: true, uploadMethod: "google-native-inlineData-compressed-proxy", ...analysisConfig });
    await stage("analysis_video_completed");
    const file = await gemini.uploadVideo(analysisInput, path.basename(analysisInput), "video/mp4");
    await writeJson(path.join(artifactsDir, "gemini_file_created.json"), file);
    await stage("provider_processing", { geminiFileName: file.name, geminiFileUri: file.uri });
    await gemini.waitForFile(file.name, async (value) => writeJson(path.join(artifactsDir, "gemini_file_status.json"), value));
    const priorAttempts = await readOptionalJson(path.join(artifactsDir, "provider_attempts.json")) || [];
    const priorResponses = await readOptionalJson(path.join(artifactsDir, "provider_responses.json")) || [];
    const priorUsage = await readOptionalJson(path.join(artifactsDir, "usage.json"));
    const persistAttempts = async ({ requestAttempts, providerResponses, usage, latest }) => {
      const allAttempts = [...priorAttempts, ...requestAttempts];
      await writeJson(path.join(artifactsDir, "provider_attempts.json"), allAttempts);
      await writeJson(path.join(artifactsDir, "provider_responses.json"), [...priorResponses, ...providerResponses]);
      await writeJson(path.join(artifactsDir, "usage.json"), mergeUsage(priorUsage, usage));
      await stage(latest.waitMs ? "provider_retry" : "provider_processing", { providerAttemptCount: allAttempts.length, providerAttemptLevel: latest.level, providerAttemptRepeat: latest.repeat, providerAttemptMode: latest.schemaMode, providerRetryDelayMs: latest.waitMs || 0 });
    };
    try {
      result = await gemini.analyze(file.uri, profile, { validateParsed: (value) => validateAndNormalizeLabels(value, run.shots, run.durationSec, profile), onAttempt: persistAttempts });
    } catch (error) {
      if (error.requestAttempts) error.requestAttempts = [...priorAttempts, ...error.requestAttempts];
      if (error.providerResponses) error.providerResponses = [...priorResponses, ...error.providerResponses];
      error.usage = mergeUsage(priorUsage, error.usage);
      if (error.requestAttempts) await writeJson(path.join(artifactsDir, "provider_attempts.json"), error.requestAttempts);
      if (error.providerResponses) await writeJson(path.join(artifactsDir, "provider_responses.json"), error.providerResponses);
      await writeJson(path.join(artifactsDir, "usage.json"), error.usage);
      throw error;
    }
    result.usage = mergeUsage(priorUsage, result.usage);
    result.requestAttempts = [...priorAttempts, ...(result.requestAttempts || [])];
    result.providerResponses = [...priorResponses, ...(result.providerResponses || [])];
    raw = result.parsed || parseJsonText(result.interaction?.output_text || result.interaction?.text);
    if (Array.isArray(raw)) raw = { shots: raw };
    await writeJson(path.join(artifactsDir, "gemini_response.json"), result.interaction);
    await writeJson(path.join(artifactsDir, "shot_labels_raw.json"), raw);
    await writeJson(path.join(artifactsDir, "usage.json"), result.usage || null);
    await writeJson(path.join(artifactsDir, "provider_attempts.json"), result.requestAttempts || []);
    await stage("provider_completed");
  }
  const labels = validateAndNormalizeLabels(raw, run.shots, run.durationSec, profile); await writeJson(path.join(artifactsDir, "shot_labels_raw.json"), raw); await writeJson(path.join(artifactsDir, "shot_labels_normalized.json"), labels);
  await stage("naming_export"); const namedDir = path.join(runDir, "named_segments"); await fsp.mkdir(namedDir, { recursive: true }); const manifest = [];
  const fps = Math.max(1, Number(run.fps || 30));
  const usedFilenames = new Set();
  for (const [index, label] of labels.entries()) {
    const filename = createUniqueFilename(createNamedFilename(label, index, ".mp4"), usedFilenames);
    const output = path.join(namedDir, filename);
    const startFrame = Math.max(0, Math.round(label.startSec * fps));
    const endFrame = Math.max(startFrame + 1, Math.round(label.endSec * fps));
    const frameCount = endFrame - startFrame;
    const startSec = startFrame / fps;
    const durationSec = frameCount / fps;
    await execFileAsync(ffmpegPath, ["-y", "-i", run.input, "-ss", String(startSec), "-t", String(durationSec), "-map", "0:v:0", "-map", "0:a?", "-frames:v", String(frameCount), "-c:v", "libx264", "-c:a", "aac", "-preset", "veryfast", "-crf", "20", "-movflags", "+faststart", output], { maxBuffer: 4 * 1024 * 1024 });
    manifest.push({ ...label, startFrame, endFrame, frameCount, startSec, endSec: endFrame / fps, durationSec, namedPath: `named_segments/${filename}`, namedFilename: filename });
  }
  const requestAttempts = result?.requestAttempts || [];
  await writeJson(path.join(artifactsDir, "rename_manifest.json"), manifest); return { labels, manifest, geminiFileName: run.geminiFileName, geminiFileUri: run.geminiFileUri, usage: result?.usage || run.usage || null, requestAttempts, unknownCostAttempts: requestAttempts.filter((entry) => entry.costStatus === "unknown").length };
}
