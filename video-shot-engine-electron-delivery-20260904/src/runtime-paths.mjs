import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

export const ffmpegPath = process.env.FFMPEG_PATH || "ffmpeg";
export const ffprobePath = process.env.FFPROBE_PATH || "ffprobe";
export const publicDir = path.resolve(process.env.PUBLIC_DIR || "./public");

const execFileAsync = promisify(execFile);

export function classifyToolSource(resolvedPath, { requestedPath, clientResourcesDir = process.env.CLIENT_RESOURCES_DIR } = {}) {
  if (clientResourcesDir && path.isAbsolute(resolvedPath)) {
    const relative = path.relative(path.resolve(clientResourcesDir), path.resolve(resolvedPath));
    if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return "client_directory";
  }
  return path.isAbsolute(requestedPath) || /[\\/]/.test(requestedPath) ? "configured_path" : "system_path";
}

async function resolveExecutable(requestedPath) {
  if (path.isAbsolute(requestedPath) || /[\\/]/.test(requestedPath)) return path.resolve(requestedPath);
  const locator = process.platform === "win32" ? "where.exe" : "which";
  const { stdout } = await execFileAsync(locator, [requestedPath], { windowsHide: true });
  return String(stdout).split(/\r?\n/).map((value) => value.trim()).find(Boolean) || requestedPath;
}

async function inspectTool(name, requestedPath) {
  try {
    const resolvedPath = await resolveExecutable(requestedPath);
    const { stdout, stderr } = await execFileAsync(resolvedPath, ["-version"], { windowsHide: true, maxBuffer: 1024 * 1024 });
    const versionLine = String(stdout || stderr).split(/\r?\n/).find(Boolean) || "unknown";
    return { name, requestedPath, resolvedPath, source: classifyToolSource(resolvedPath, { requestedPath }), versionLine, available: true };
  } catch (error) {
    return { name, requestedPath, resolvedPath: null, source: "unavailable", versionLine: null, available: false, error: error.message };
  }
}

let mediaToolInfoPromise;

export function inspectMediaTools() {
  mediaToolInfoPromise ||= Promise.all([
    inspectTool("ffmpeg", ffmpegPath),
    inspectTool("ffprobe", ffprobePath),
  ]).then(([ffmpeg, ffprobe]) => ({
    inspectedAt: new Date().toISOString(),
    host: { hostname: os.hostname(), platform: process.platform, release: os.release(), arch: process.arch, node: process.version },
    clientResourcesDir: process.env.CLIENT_RESOURCES_DIR ? path.resolve(process.env.CLIENT_RESOURCES_DIR) : null,
    ffmpeg,
    ffprobe,
  }));
  return mediaToolInfoPromise;
}
