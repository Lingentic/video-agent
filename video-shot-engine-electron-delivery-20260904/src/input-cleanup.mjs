import fsp from "node:fs/promises";
import path from "node:path";
import { SHOT_DETECTION_VERSION } from "./shot-service.mjs";
import { finalizeNamedSegments, writeNamedJson } from "./named-output-storage.mjs";

export const FAILED_INPUT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

function safePath(rootDir, targetPath) {
  if (!targetPath || typeof targetPath !== "string") return null;
  const root = path.resolve(rootDir);
  const target = path.isAbsolute(targetPath) ? path.resolve(targetPath) : path.resolve(root, targetPath);
  const relative = path.relative(root, target);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? target : null;
}

export async function cleanupAnalysisInput(runDir) {
  try { await fsp.rm(path.join(runDir, "artifacts", "analysis_input_numbered.mp4"), { force: true }); } catch {}
}

export async function cleanupRunInputs(runDir, inputPath, { preserveInput = false } = {}) {
  const safeInput = safePath(runDir, inputPath);
  if (safeInput && !preserveInput) try { await fsp.rm(safeInput, { force: true }); } catch {}
  await cleanupAnalysisInput(runDir);
}

async function readJson(...parts) {
  try { return JSON.parse(await fsp.readFile(path.join(...parts), "utf8")); } catch { return null; }
}

async function directoryTimestamp(dir) {
  try { return (await fsp.stat(dir)).mtimeMs; } catch { return 0; }
}

async function cleanupOrphanInputs(runDir) {
  let entries = [];
  try { entries = await fsp.readdir(runDir, { withFileTypes: true }); } catch {}
  for (const entry of entries) {
    if (entry.isFile() && /^input\.[a-zA-Z0-9]+$/.test(entry.name)) await cleanupRunInputs(runDir, path.join(runDir, entry.name));
  }
  await cleanupAnalysisInput(runDir);
}

function timestampOf(record) {
  return Date.parse(record?.updatedAt || record?.finishedAt || record?.createdAt || record?.queuedAt || "") || 0;
}

export async function cleanupStaleInputs(runsDir, now = Date.now()) {
  let entries;
  try { entries = await fsp.readdir(runsDir, { withFileTypes: true }); } catch { return; }
  const cutoff = now - FAILED_INPUT_RETENTION_MS;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(runsDir, entry.name);
    if (/^run_[a-zA-Z0-9_]+$/.test(entry.name)) {
      const currentFile = path.join(dir, "artifacts", "run.json");
      let run = await readJson(currentFile);
      const stateFile = run ? currentFile : path.join(dir, "run.json");
      run ||= await readJson(stateFile);
      if (!run) {
        if (await directoryTimestamp(dir) < cutoff) await cleanupOrphanInputs(dir);
        continue;
      }
      if (run.shotDetectionVersion !== SHOT_DETECTION_VERSION) continue;
      if (run.status === "completed" && (run.autoName || run.namedShotCount || run.workflow === "ffmpeg_gemini_naming")) {
        const finalized = await finalizeNamedSegments(dir, run, async next => { await writeNamedJson(stateFile, next); return next; });
        if (!finalized.ready) { await cleanupAnalysisInput(dir); continue; }
        run = finalized.run;
      }
      if (run.status === "completed" || (["failed", "processing", "queued"].includes(run.status) && timestampOf(run) < cutoff)) {
        await cleanupRunInputs(dir, run.input, { preserveInput: run.removeSubtitles });
      }
      continue;
    }
    if (!/^batch_[a-zA-Z0-9_]+$/.test(entry.name)) continue;
    const itemsDir = path.join(dir, "items");
    let items;
    try { items = await fsp.readdir(itemsDir, { withFileTypes: true }); } catch { continue; }
    for (const itemEntry of items) {
      if (!itemEntry.isDirectory() || !/^video_[a-zA-Z0-9_]+$/.test(itemEntry.name)) continue;
      const itemDir = path.join(itemsDir, itemEntry.name);
      const stateFile = path.join(itemDir, "item.json");
      let item = await readJson(stateFile);
      if (!item) continue;
      if (item.shotDetectionVersion !== SHOT_DETECTION_VERSION) continue;
      if (item.status === "completed" && (item.autoName || item.namedShotCount || item.workflow === "ffmpeg_gemini_naming")) {
        const finalized = await finalizeNamedSegments(itemDir, item, async next => { await writeNamedJson(stateFile, next); return next; });
        if (!finalized.ready) { await cleanupAnalysisInput(itemDir); continue; }
        item = finalized.run;
      }
      if (item.status === "completed" || (["failed", "processing", "queued"].includes(item.status) && timestampOf(item) < cutoff)) {
        await cleanupRunInputs(itemDir, item.input, { preserveInput: item.removeSubtitles });
      }
    }
  }
}
