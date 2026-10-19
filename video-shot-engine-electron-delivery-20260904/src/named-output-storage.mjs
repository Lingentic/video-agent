import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ffprobePath } from "./runtime-paths.mjs";

const execFileAsync = promisify(execFile);
const inside = (root, file) => { const relative = path.relative(root, file); return !!relative && !relative.startsWith("..") && !path.isAbsolute(relative); };

export async function writeNamedJson(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
    for (let attempt = 0; ; attempt += 1) {
      try { await fsp.rename(temporary, file); break; }
      catch (error) {
        if (process.platform !== "win32" || !["EPERM", "EBUSY"].includes(error.code) || attempt >= 3) throw error;
        await new Promise(resolve => setTimeout(resolve, 20 * (attempt + 1)));
      }
    }
  } finally { await fsp.rm(temporary, { force: true }); }
}

// A receipt alone is not enough: every expected shot must have a playable local result.
export async function readNamedManifest(runDir, run) {
  try {
    if (!run.shots?.length || !(Number(run.fps) > 0)) return null;
    const root = path.resolve(runDir);
    for (const dir of [root, path.join(root, "artifacts"), path.join(root, "named_segments")]) {
      if ((await fsp.lstat(dir)).isSymbolicLink() || (dir !== root && !inside(await fsp.realpath(root), await fsp.realpath(dir)))) return null;
    }
    const manifestFile = path.join(root, "artifacts", "rename_manifest.json");
    if (!(await fsp.lstat(manifestFile)).isFile()) return null;
    const manifest = JSON.parse(await fsp.readFile(manifestFile, "utf8"));
    if (!Array.isArray(manifest) || manifest.length !== run.shots.length) return null;
    const byId = new Map(manifest.map(entry => [entry.shotId, entry]));
    if (byId.size !== manifest.length || new Set(run.shots.map(shot => shot.shotId)).size !== run.shots.length) return null;
    const files = new Set();
    for (const shot of run.shots) {
      const entry = byId.get(shot.shotId);
      if (!entry || !/^shot_\d+$/.test(shot.shotId) || !/^named_segments\/[^/\\]+\.mp4$/i.test(entry.namedPath || "")) return null;
      if (entry.startFrame !== Math.round(Number(shot.startSec) * run.fps) || entry.endFrame !== Math.round(Number(shot.endSec) * run.fps)) return null;
      const file = path.resolve(root, entry.namedPath);
      if (!inside(path.join(root, "named_segments"), file) || files.has(file.toLowerCase())) return null;
      files.add(file.toLowerCase());
      const stat = await fsp.lstat(file);
      if (!stat.isFile() || !stat.size) return null;
      const { stdout, stderr } = await execFileAsync(ffprobePath, ["-v", "error", "-select_streams", "v:0", "-count_frames", "-show_entries", "format=duration:stream=codec_type,width,height,duration,nb_read_frames", "-of", "json", file], { windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024 });
      const media = JSON.parse(stdout);
      const stream = media.streams?.find(stream => stream.codec_type === "video" && stream.width > 0 && stream.height > 0);
      const expectedFrames = Math.max(1, entry.endFrame - entry.startFrame);
      const duration = Number(stream?.duration ?? media.format?.duration);
      if (!stream || stderr.trim() || !Number.isFinite(Number(stream.nb_read_frames)) || Math.abs(Number(stream.nb_read_frames) - expectedFrames) > 1 ||
          !Number.isFinite(duration) || duration <= 0 || Math.abs(duration - expectedFrames / run.fps) > Math.max(2 / run.fps, 0.1)) return null;
    }
    return manifest;
  } catch { return null; }
}

export async function finalizeNamedSegments(runDir, run, saveRun) {
  if (run.status !== "completed") return { run, ready: false };
  let ready = false;
  try {
    const root = path.resolve(runDir);
    const rawDir = path.join(root, "artifacts", "shot_segments");
    let entries;
    try { entries = await fsp.readdir(rawDir); } catch (error) { if (error.code !== "ENOENT") throw error; entries = []; }
    const alreadyNamed = run.shots?.length > 0 && run.shots.every(shot => /^named_segments\//.test(shot.filePath || ""));
    const manifest = await readNamedManifest(root, run);
    if (!manifest) return { run, ready: false };
    ready = true;
    // Even after raw cleanup, validate before allowing the caller to remove the source.
    if (alreadyNamed && !entries.some(name => /^shot_\d+\.mp4$/i.test(name))) return { run, ready };
    const byId = new Map(manifest.map(entry => [entry.shotId, entry]));
    const shots = run.shots.map(shot => ({ ...shot, filePath: byId.get(shot.shotId).namedPath }));
    // Persist canonical paths first. A crash during unlink can then safely resume this cleanup.
    run = await saveRun({ ...run, shots }) || { ...run, shots };
    try {
      if ((await fsp.lstat(rawDir)).isSymbolicLink() || !inside(await fsp.realpath(root), await fsp.realpath(rawDir))) return { run, ready };
    } catch (error) { if (error.code === "ENOENT") return { run, ready }; throw error; }
    const protectedFiles = new Set([run.input, run.processingInput, ...manifest.map(entry => path.join(root, entry.namedPath))].filter(Boolean).map(file => path.resolve(file).toLowerCase()));
    for (const shot of run.shots) {
      const file = path.join(rawDir, `${shot.shotId}.mp4`);
      if (!inside(rawDir, file) || protectedFiles.has(file.toLowerCase())) continue;
      try { if ((await fsp.lstat(file)).isFile()) await fsp.unlink(file); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    // Keep shot_segments.json and all provider/error receipts for diagnosis and recovery.
  } catch { /* Cleanup must never turn a delivered result into a failed task. */ }
  return { run, ready };
}
