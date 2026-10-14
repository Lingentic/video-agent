import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, opendir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const LOG_LIMIT = 2 * 1024 * 1024;
const LOG_DAYS = 7;
const LOG_VERSIONS = 3;
const BUNDLE_LIMIT = 20 * 1024 * 1024;
const FILE_LIMIT = 1024 * 1024;
const MAX_TASKS = 10;
const MAX_DEPTH = 8;
const MAX_ITEMS = 100;
const MAX_STRING = 4096;
const MAX_PENDING_RECORDS = 1000;
const MAX_TASK_BYTES = 8 * 1024 * 1024;
const ERROR_DAYS = 30;
const MAX_ERRORS = 100;
const ERROR_LIMIT = 64 * 1024;
const taskDescriptors = [
  { name: "kling-h3", rel: path.join("kling-h3", "runs"), kind: "run" },
  { name: "video-shot", rel: path.join("video-shot", "runs-v1"), kind: "shot" }
];

const sensitiveKey = /(?:secret|password|passwd|authorization|apikey|accesskey|privatekey|credential|cookie|signature|signingkey|token|\.env)/i;
const allowedUsageTokenKeys = new Set(["totaltokens", "totalinputtokens", "totaloutputtokens", "totalthoughttokens", "inputtokens", "outputtokens"]);
const safeTaskKeys = new Set(`id index runId batchId videoId taskId videoTaskId providerTaskId remoteTaskId cloudTaskId requestId stage failedStage status state model imageModel videoModel provider providerId providerIds imageProvider imageProviderId videoProvider videoProviderId imageTasks imageHistory imageTask imageTaskId createdAt updatedAt startedAt finishedAt completedAt submittedAt timestamp inspectedAt httpStatus httpErrorCode statusCode errorCode errorMessage errorStack code message stack error errorRecord cause namingError width height duration durationSec fps frameRate frameRateAvg usage billing attempts requestAttempts requestNumber level repeat schemaMode outcome validationError costStatus transportError attempt count amount currency totalTokens inputTokens outputTokens totalInputTokens totalOutputTokens totalThoughtTokens cost costYuan billed charged unit estimatedCost estimatedCostYuan unknownCostAttempts inputMedia media input source versionLine available ffmpeg ffprobe`.toLowerCase().split(/\s+/));
const safeDetailKeys = new Set(`id index taskId videoTaskId providerTaskId remoteTaskId cloudTaskId requestId providerId providerIds imageProviderId videoProviderId stage failedStage status state model imageModel videoModel provider imageProvider videoProvider imageTasks imageHistory imageTask imageTaskId createdAt updatedAt startedAt finishedAt completedAt submittedAt timestamp inspectedAt httpStatus httpErrorCode statusCode errorCode errorMessage errorStack code message stack error errorRecord cause namingError width height duration durationSec fps frameRate frameRateAvg usage billing attempts requestAttempts requestNumber level repeat schemaMode outcome validationError costStatus transportError attempt count amount currency totalTokens inputTokens outputTokens totalInputTokens totalOutputTokens totalThoughtTokens cost costYuan billed charged unit estimatedCost estimatedCostYuan unknownCostAttempts inputMedia media input name source versionLine available ffmpeg ffprobe`.toLowerCase().split(/\s+/));

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zipStored(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const time = new Date();
  const dosTime = (time.getHours() << 11) | (time.getMinutes() << 5) | (time.getSeconds() >> 1);
  const dosDate = ((Math.max(1980, time.getFullYear()) - 1980) << 9) | ((time.getMonth() + 1) << 5) | time.getDate();
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, ...centralParts, end]);
}

function escapeRegExp(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

function redactString(input, secrets, privatePaths = []) {
  let value = String(input);
  for (const secret of secrets) {
    if (!secret || secret.length < 3) continue;
    value = value.replaceAll(secret, "[REDACTED]");
  }
  value = value.replace(/\bBearer\s+[^"'`]+(?=["'`]|$)/gi, "Bearer [REDACTED]");
  value = value.replace(/\bBearer\s+[^\s,;"'`]+/gi, "Bearer [REDACTED]");
  value = value.replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|key_[A-Za-z0-9_-]{8,})\b/g, "[REDACTED]");
  value = value.replace(/https?:\/\/[^\s<>"'`]+/gi, (raw) => {
    try { return new URL(raw.replace(/[),.;]+$/, "")).hostname || "[URL]"; } catch { return "[URL]"; }
  });
  value = value.replace(/\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s<>"'`]+/g, "[URL]");
  value = value.replace(/\b[A-Za-z]:[\\/][^\r\n"'<>|]*/g, "[LOCAL_PATH]");
  value = value.replace(/\\\\[^\\\s]+\\[^\r\n"'<>|]*/g, "[LOCAL_PATH]");
  value = value.replace(/(?:^|[\s=(])\/(?:[^\s"'<>]+\/?)+/g, (match) => `${match[0] === "/" ? "" : match[0]}[LOCAL_PATH]`);
  for (const privatePath of [...privatePaths].filter((item) => typeof item === "string" && item.length >= 3).sort((a, b) => b.length - a.length)) {
    value = value.replace(new RegExp(escapeRegExp(privatePath), process.platform === "win32" ? "gi" : "g"), "[LOCAL_PATH]");
  }
  value = value.replace(/(["']?authorization["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^"'`]+(?=["'`]|$))/gi, "$1[REDACTED]");
  value = value.replace(/(["']?(?:api[_-]?key|token|password|secret|credential|signature)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^"'`]+(?=["'`]|$))/gi, "$1[REDACTED]");
  return value.slice(0, MAX_STRING);
}

function safeJsonSyntaxError(input) {
  if (typeof input !== "string" || !/(?:SyntaxError|unexpected token|not valid JSON|expected .* in JSON|JSON.{0,30}position)/i.test(input)) return input;
  const parts = [];
  const position = input.match(/\bposition\s+(\d+)\b/i)?.[1];
  const line = input.match(/\bline\s+(\d+)\b/i)?.[1];
  const column = input.match(/\bcolumn\s+(\d+)\b/i)?.[1];
  if (position) parts.push(`position ${position}`);
  if (line) parts.push(`line ${line}`);
  if (column) parts.push(`column ${column}`);
  return `SyntaxError: invalid JSON${parts.length ? ` (${parts.join(", ")})` : ""}`;
}

function safeErrorField(input, key) {
  if (typeof input !== "string") return input;
  const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
  if (normalized === "stack" || normalized === "errorstack") {
    const lines = input.split(/\r?\n/);
    const firstFrame = lines.findIndex((line) => /^\s+at\s/.test(line));
    const headerEnd = firstFrame < 0 ? lines.length : firstFrame;
    const safeHeader = safeJsonSyntaxError(lines.slice(0, headerEnd).join("\n"));
    return [safeHeader, ...lines.slice(headerEnd)].join("\n");
  }
  const safe = safeJsonSyntaxError(input);
  if (safe !== input) return safe;
  if (normalized === "validationerror") return input.replace(/("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/g, "[quoted excerpt redacted]");
  return input;
}

function redact(value, secrets, privatePaths = [], depth = 0, allowedKeys = null) {
  if (depth > MAX_DEPTH) return "[TRUNCATED]";
  if (typeof value === "string") return redactString(value, secrets, privatePaths);
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    const childKeys = allowedKeys === safeTaskKeys ? safeDetailKeys : allowedKeys;
    return value.slice(0, MAX_ITEMS).map((item) => redact(item, secrets, privatePaths, depth + 1, childKeys));
  }
  if (typeof value !== "object") return undefined;
  const result = {};
  for (const [key, item] of Object.entries(value).slice(0, MAX_ITEMS)) {
    const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
    if ((!allowedUsageTokenKeys.has(normalized) && sensitiveKey.test(key)) || (allowedKeys && !allowedKeys.has(normalized))) continue;
    const childKeys = allowedKeys === safeTaskKeys ? safeDetailKeys : allowedKeys;
    let safeItem = item;
    if (typeof item === "string" && ["message", "errormessage", "validationerror", "transporterror", "namingerror", "stack", "errorstack", "error"].includes(normalized)) {
      safeItem = safeErrorField(item, normalized);
    }
    const safe = redact(safeItem, secrets, privatePaths, depth + 1, childKeys);
    if (safe !== undefined) result[redactString(key, secrets, privatePaths)] = safe;
  }
  return result;
}

function dayString(date = new Date()) { return date.toISOString().slice(0, 10); }
function logName(day, version = 0) { return `client-${day}${version ? `.${version}` : ""}.jsonl`; }
function inside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function assertSafeDirectory(rootReal, directory) {
  const root = path.resolve(rootReal);
  const target = path.resolve(directory);
  if (!inside(root, target)) throw new Error("path outside dataRoot");
  const rel = path.relative(root, target);
  let current = root;
  for (const part of rel ? rel.split(path.sep) : []) {
    current = path.join(current, part);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new Error("symbolic link skipped");
    if (!info.isDirectory()) throw new Error("not a directory");
  }
  const actual = await realpath(target);
  if (!inside(root, actual)) throw new Error("real path outside dataRoot");
  return actual;
}

async function assertSafeFile(rootReal, file, maxSize = FILE_LIMIT) {
  const target = path.resolve(file);
  await assertSafeDirectory(rootReal, path.dirname(target));
  const actual = await realpath(target);
  if (!inside(path.resolve(rootReal), actual)) throw new Error("real path outside dataRoot");
  const info = await stat(actual);
  if (!info.isFile()) throw new Error("not a regular file");
  if (info.size > maxSize) throw new Error("file exceeds size limit");
  return info;
}

function safeTask(value, secrets, privatePaths) { return redact(value, secrets, privatePaths, 0, safeTaskKeys); }

export function createDiagnostics({ dataRoot, metadata = {}, privatePaths = [], secrets = [] } = {}) {
  if (!dataRoot) throw new TypeError("dataRoot is required");
  const root = path.resolve(dataRoot);
  let logRoot = path.join(root, "diagnostics");
  const privateValues = privatePaths.map((item) => String(item));
  const sessionId = randomUUID();
  let secretValues = [...secrets].filter((item) => typeof item === "string" && item.length >= 3);
  let queue = Promise.resolve();
  let pendingRecords = 0;
  let cleanupDay = null;

  async function initLogs() {
    await mkdir(root, { recursive: true });
    const rootReal = await realpath(root);
    logRoot = path.join(rootReal, "diagnostics");
    await mkdir(logRoot, { recursive: true });
    await assertSafeDirectory(rootReal, logRoot);
    const today = dayString();
    if (cleanupDay !== today) {
      const cutoff = Date.now() - LOG_DAYS * 86400000;
      for (const name of await readdir(logRoot)) {
        const match = /^client-(\d{4}-\d{2}-\d{2})(?:\.\d+)?\.jsonl$/.exec(name);
        if (!match) continue;
        const when = Date.parse(`${match[1]}T00:00:00Z`);
        if (Number.isFinite(when) && when < cutoff) await rm(path.join(logRoot, name), { force: true });
      }
      cleanupDay = today;
    }
  }

  async function writeLog(line) {
    await initLogs();
    const day = dayString();
    const current = path.join(logRoot, logName(day));
    let size = 0;
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isFile()) throw new Error("unsafe diagnostics log target");
      size = info.size;
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    const bytes = Buffer.byteLength(line);
    if (size && size + bytes > LOG_LIMIT) {
      await rm(path.join(logRoot, logName(day, LOG_VERSIONS - 1)), { force: true });
      for (let version = LOG_VERSIONS - 2; version >= 1; version -= 1) {
        const from = path.join(logRoot, logName(day, version));
        const to = path.join(logRoot, logName(day, version + 1));
        try { await rename(from, to); } catch (error) { if (error.code !== "ENOENT") throw error; }
      }
      await rename(current, path.join(logRoot, logName(day, 1)));
    }
    await writeFile(current, line, { flag: "a" });
    return true;
  }

  async function collectTasks(warnings) {
    const rootReal = await realpath(root);
    const selected = [];
    const recentCutoff = Date.now() - LOG_DAYS * 86400000;
    for (const descriptor of taskDescriptors) {
      const recentCandidates = [];
      let newestCandidate = null;
      const dir = path.join(rootReal, descriptor.rel);
      try {
        await assertSafeDirectory(rootReal, dir);
      } catch (error) {
        if (error.code !== "ENOENT") warnings.push(`${descriptor.name}: 目录无法读取`);
        continue;
      }
      try {
        const runDirs = await opendir(dir);
        for await (const entry of runDirs) {
          if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
          const full = path.join(dir, entry.name);
          const candidate = { descriptor, dir: full, name: entry.name, mtime: 0 };
          try { await assertSafeDirectory(rootReal, full); } catch { continue; }
          const paths = await taskPaths(candidate, rootReal, warnings, false);
          for (const relative of paths) {
            try {
              const info = await assertSafeFile(rootReal, path.join(full, relative), Number.POSITIVE_INFINITY);
              candidate.mtime = Math.max(candidate.mtime, info.mtimeMs);
            } catch { /* Individual missing or unsafe files are ignored during ranking. */ }
          }
          if (!newestCandidate || candidate.mtime > newestCandidate.mtime) newestCandidate = candidate;
          if (candidate.mtime >= recentCutoff) {
            recentCandidates.push(candidate);
            recentCandidates.sort((a, b) => b.mtime - a.mtime);
            if (recentCandidates.length > MAX_TASKS) recentCandidates.pop();
          }
        }
      } catch (error) {
        if (error.code !== "ENOENT") warnings.push(`${descriptor.name}: 目录无法遍历`);
      }
      selected.push(...(recentCandidates.length ? recentCandidates : (newestCandidate ? [newestCandidate] : [])));
    }
    const tasks = [];
    const readBytes = new Map();
    for (const item of selected) {
      const task = { service: item.descriptor.name, files: {} };
      const paths = await taskPaths(item, rootReal, warnings);
      for (const relative of paths) {
        const file = path.join(item.dir, relative);
        try {
          const info = await assertSafeFile(rootReal, file);
          const serviceBytes = readBytes.get(item.descriptor.name) || 0;
          if (serviceBytes + info.size > MAX_TASK_BYTES / taskDescriptors.length) {
            warnings.push(`${item.descriptor.name}: 任务诊断数据超过 4 MiB，后续文件已截断`);
            break;
          }
          readBytes.set(item.descriptor.name, serviceBytes + info.size);
          const parsed = JSON.parse(await readFile(file, "utf8"));
          const clean = safeTask(parsed, secretValues, privateValues);
          if (clean && Object.keys(clean).length) task.files[relative.replaceAll("\\", "/")] = clean;
        } catch (error) {
          if (error.code !== "ENOENT") warnings.push(`${item.descriptor.name}: ${error.message === "file exceeds size limit" ? "任务文件超过 1 MiB，已跳过" : error.message === "symbolic link skipped" ? "符号链接任务文件，已跳过" : "任务文件无法读取或 JSON 无效，已跳过"}`);
        }
      }
      if (Object.keys(task.files).length) tasks.push(task);
    }
    return tasks;
  }

  async function errorFiles() {
    const rootReal = await realpath(root);
    const directory = path.join(logRoot, "errors");
    await mkdir(directory, { recursive: true });
    await assertSafeDirectory(rootReal, directory);
    const files = [];
    for (const name of await readdir(directory)) {
      if (!/^error-[a-f0-9]{64}\.json$/.test(name)) continue;
      const file = path.join(directory, name);
      try {
        const info = await assertSafeFile(rootReal, file, ERROR_LIMIT);
        files.push({ file, mtime: info.mtimeMs });
      } catch { /* Never follow unsafe diagnostic files. */ }
    }
    files.sort((a, b) => b.mtime - a.mtime);
    const kept = [];
    for (const file of files) {
      if (file.mtime < Date.now() - ERROR_DAYS * 86400000 || kept.length >= MAX_ERRORS) await rm(file.file, { force: true });
      else kept.push(file);
    }
    return { rootReal, directory, files: kept };
  }

  async function captureError(row) {
    const fields = row.fields && typeof row.fields === "object" ? row.fields : {};
    const runId = fields.runId || fields.endpoint?.match(/^api\/(?:runs|batches)\/([A-Za-z0-9_.-]+)(?:\/|$)/)?.[1];
    const identity = { event: row.event, module: fields.module, channel: fields.channel, endpoint: fields.endpoint, runId,
      stage: fields.stage, status: fields.status, error: fields.error, namingError: fields.namingError, failedItems: fields.failedItems,
      message: fields.message, code: fields.code, stack: fields.stack, failedAt: fields.failedAt, cloudTaskId: fields.cloudTaskId };
    const key = createHash("sha256").update(JSON.stringify(identity)).digest("hex");
    const { rootReal, directory } = await errorFiles();
    const target = path.join(directory, `error-${key}.json`);
    try { await assertSafeFile(rootReal, target, ERROR_LIMIT); return; } catch (error) { if (error.code !== "ENOENT") return; }
    const boundedFields = {};
    for (const [name, value] of Object.entries(fields).filter(([name]) => name !== "failedItems")) {
      if (Buffer.byteLength(JSON.stringify(value) || "") > 8192) {
        boundedFields[name] = { message: String(value?.message || "[TRUNCATED]").slice(0, 4096), code: value?.code, truncated: true };
      } else boundedFields[name] = value;
      if (Buffer.byteLength(JSON.stringify(boundedFields)) > 24 * 1024) { delete boundedFields[name]; boundedFields.truncated = true; }
    }
    if (Array.isArray(fields.failedItems)) {
      boundedFields.failedItems = [];
      for (const item of fields.failedItems) {
        boundedFields.failedItems.push({ videoId: item.videoId, stage: item.stage, status: item.status, failedAt: item.failedAt,
          error: typeof item.error === "string" ? item.error.slice(0, 4096) : item.error?.message, namingError: item.namingError?.message || (typeof item.namingError === "string" ? item.namingError.slice(0, 4096) : undefined) });
        if (Buffer.byteLength(JSON.stringify(boundedFields)) > 32 * 1024) {
          boundedFields.failedItems.pop(); boundedFields.omittedFailedItems = fields.failedItems.length - boundedFields.failedItems.length; break;
        }
      }
    }
    const snapshot = { ...row, fields: boundedFields, runId, task: { files: {} }, warnings: [] };
    const descriptor = taskDescriptors.find(item => item.name === ({ shot: "video-shot", remake: "kling-h3", kling: "kling-h3" }[fields.module]));
    if (descriptor && /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(runId || "")) {
      const candidate = { descriptor, dir: path.join(rootReal, descriptor.rel, runId) };
      try {
        await assertSafeDirectory(rootReal, candidate.dir);
        snapshot.task.service = descriptor.name;
        const paths = await taskPaths(candidate, rootReal, snapshot.warnings);
        for (const relative of paths) {
          const file = path.join(candidate.dir, relative);
          try {
            await assertSafeFile(rootReal, file);
            const clean = safeTask(JSON.parse(await readFile(file, "utf8")), secretValues, privateValues);
            if (!clean || !Object.keys(clean).length) continue;
            const name = relative.replaceAll("\\", "/");
            snapshot.task.files[name] = clean;
            if (Buffer.byteLength(JSON.stringify(snapshot)) > ERROR_LIMIT - 4096) {
              delete snapshot.task.files[name];
              snapshot.warnings.push("错误快照达到 64 KiB 上限，部分任务摘要未保存");
              break;
            }
          } catch (error) { if (error.code !== "ENOENT") snapshot.warnings.push("部分任务诊断文件无法读取"); }
        }
      } catch { snapshot.warnings.push("当时的任务目录不可用，仅保存错误事件"); }
    }
    let data = JSON.stringify(snapshot);
    if (Buffer.byteLength(data) > ERROR_LIMIT) data = JSON.stringify({ ...row, fields: boundedFields, runId, truncated: true });
    if (Buffer.byteLength(data) > ERROR_LIMIT) data = JSON.stringify({ time: row.time, sessionId, event: row.event, truncated: true });
    const temporary = `${target}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, data, { flag: "wx" }); await rename(temporary, target); }
    finally { await rm(temporary, { force: true }); }
    await errorFiles();
  }

  async function collectErrors(warnings) {
    try {
      const { files } = await errorFiles();
      const errors = [];
      for (const item of files) {
        try { errors.push(redact(JSON.parse(await readFile(item.file, "utf8")), secretValues, privateValues)); }
        catch { warnings.push("部分错误快照无法读取，已跳过"); }
      }
      return errors;
    } catch { warnings.push("错误快照目录无法读取"); return []; }
  }

  async function taskPaths(candidate, rootReal, warnings, reportWarnings = true) {
    const base = ["run.json", "artifacts/run.json", "artifacts/error.json", "artifacts/naming_error.json", "artifacts/provider_attempts.json", "artifacts/usage.json", "artifacts/ffmpeg_runtime.json", "artifacts/subtitle-removal/job.json"];
    if (candidate.descriptor.kind === "run") return base;
    const paths = ["batch.json", ...base];
    const itemsDir = path.join(candidate.dir, "items");
    try {
      await assertSafeDirectory(rootReal, itemsDir);
      const items = await opendir(itemsDir);
      let itemCount = 0;
      for await (const item of items) {
        if (!/^video_[A-Za-z0-9_-]+$/.test(item.name)) continue;
        if (itemCount >= 100) {
          if (reportWarnings) warnings.push("镜头任务项超过 100 个，后续项目未扫描");
          break;
        }
        itemCount += 1;
        const itemDir = path.join(itemsDir, item.name);
        try {
          await assertSafeDirectory(rootReal, itemDir);
          paths.push(path.join("items", item.name, "item.json"));
          for (const artifact of ["error.json", "naming_error.json", "provider_attempts.json", "usage.json", "ffmpeg_runtime.json", "run.json", path.join("subtitle-removal", "job.json")]) {
            paths.push(path.join("items", item.name, "artifacts", artifact));
          }
        } catch { if (reportWarnings) warnings.push("镜头任务项路径不安全，已跳过"); }
      }
    } catch (error) {
      if (reportWarnings && error.code !== "ENOENT") warnings.push("镜头任务 items 目录不可用或不安全，已跳过");
    }
    return paths;
  }

  async function collectLogs(warnings) {
    const entries = [];
    let total = 0;
    const rootReal = await realpath(root);
    try { await assertSafeDirectory(rootReal, logRoot); } catch (error) { if (error.code === "ENOENT") return entries; throw error; }
    const names = (await readdir(logRoot)).filter((name) => /^client-\d{4}-\d{2}-\d{2}(?:\.\d+)?\.jsonl$/.test(name));
    const sorted = await Promise.all(names.map(async (name) => ({ name, mtime: (await stat(path.join(logRoot, name)).catch(() => ({ mtimeMs: 0 }))).mtimeMs })));
    sorted.sort((a, b) => b.mtime - a.mtime);
    for (const { name } of sorted) {
      if (total >= 4 * 1024 * 1024) { warnings.push("诊断日志已截断至 4 MiB"); break; }
      const file = path.join(logRoot, name);
      try {
        const info = await assertSafeFile(rootReal, file, Number.POSITIVE_INFINITY);
        const remaining = 4 * 1024 * 1024 - total;
        const readSize = Math.min(info.size, remaining);
        const handle = await open(file, "r");
        let raw;
        try {
          raw = Buffer.alloc(readSize);
          const { bytesRead } = await handle.read(raw, 0, readSize, info.size - readSize);
          raw = raw.subarray(0, bytesRead);
        } finally { await handle.close(); }
        let text = raw.toString("utf8");
        if (info.size > readSize) {
          const firstLine = text.indexOf("\n");
          text = firstLine < 0 ? "" : text.slice(firstLine + 1);
          warnings.push("诊断日志仅导出尾部内容，已截断较旧记录");
        }
        const cleanedLines = [];
        for (const line of text.split("\n")) {
          if (!line) continue;
          try {
            const parsed = JSON.parse(line);
            const cleaned = JSON.stringify(redact(parsed, secretValues, privateValues));
            const candidate = `${cleaned}\n`;
            if (Buffer.byteLength(candidate) + total > 4 * 1024 * 1024) {
              warnings.push("诊断日志达到 4 MiB 上限，较旧记录已截断");
              break;
            }
            cleanedLines.push(candidate);
            total += Buffer.byteLength(candidate);
          } catch { warnings.push("诊断日志包含无效 JSON 行，已跳过"); }
        }
        if (cleanedLines.length) entries.push({ name: `logs/${name}`, data: cleanedLines.join("") });
      } catch (error) { warnings.push(`诊断日志 ${name} 无法读取，已跳过`); }
    }
    return entries;
  }

  async function flush() { await queue; }

  return {
    record(event, fields = {}, level = "info") {
      if (pendingRecords >= MAX_PENDING_RECORDS) return Promise.resolve(false);
      pendingRecords += 1;
      const result = queue.then(async () => {
        try {
          const row = { time: new Date().toISOString(), sessionId, event: redactString(event, secretValues, privateValues), level: redactString(level, secretValues, privateValues), fields: redact(fields, secretValues, privateValues) };
          let encoded = `${JSON.stringify(row)}\n`;
          if (Buffer.byteLength(encoded) > 64 * 1024) encoded = `${JSON.stringify({ ...row, fields: "[TRUNCATED: record size limit]" })}\n`;
          let written = false;
          try { written = await writeLog(encoded); } catch { /* Error snapshots have their own storage. */ }
          if (level === "error") await captureError(row);
          return written;
        } catch { return false; }
      }).catch(() => false).finally(() => { pendingRecords -= 1; });
      queue = result.catch(() => {});
      return result;
    },
    flush,
    setSecrets(values) { secretValues = [...new Set([...secretValues, ...(Array.isArray(values) ? values : [values])].filter((item) => typeof item === "string" && item.length >= 3))]; },
    async exportBundle(destination, { services = [] } = {}) {
      const warnings = [];
      try {
        await flush();
        const tasks = await collectTasks(warnings).catch(() => { warnings.push("任务目录扫描失败"); return []; });
        const errors = await collectErrors(warnings);
        let logEntries = await collectLogs(warnings);
        const taskEntry = { name: "tasks.json", data: Buffer.from(JSON.stringify(tasks)) };
        const errorEntry = { name: "errors.json", data: Buffer.from(JSON.stringify(errors)) };
        const summary = {
          version: 1,
          generatedAt: new Date().toISOString(),
          platform: os.platform(),
          release: os.release(),
          arch: os.arch(),
          node: process.versions.node,
          electron: process.versions.electron || null,
          metadata: redact(metadata, secretValues, privateValues),
          services: [],
          tasks: tasks.map((task) => ({ service: task.service, files: Object.keys(task.files) })),
          errorCount: errors.length,
          retention: { recentTasksPerService: MAX_TASKS, errorDays: ERROR_DAYS, maxErrors: MAX_ERRORS },
          warnings
        };
        const serviceFields = new Set(["key", "label", "status", "port", "url", "error", "pid", "referenceVideoReady"]);
        const safeServices = (Array.isArray(services) ? services : []).slice(0, 20).map((service) => Object.fromEntries(
          Object.entries(service || {}).filter(([key]) => serviceFields.has(key))
        ));
        summary.services = redact(safeServices, secretValues, privateValues);
        let archive;
        while (true) {
          const summaryEntry = { name: "summary.json", data: Buffer.from(JSON.stringify({ ...summary, warnings }, null, 2)) };
          archive = zipStored([summaryEntry, ...logEntries, taskEntry, errorEntry]);
          if (archive.length <= BUNDLE_LIMIT) break;
          if (!logEntries.length) throw new Error("诊断 ZIP 超过 20 MiB");
          logEntries.pop();
          warnings.push("日志因导出大小限制被截断");
        }
        const target = path.resolve(destination);
        await mkdir(path.dirname(target), { recursive: true });
        const temp = `${target}.${randomUUID()}.tmp`;
        try {
          await writeFile(temp, archive, { flag: "wx" });
          await rename(temp, target);
        } catch (error) {
          await rm(temp, { force: true }).catch(() => {});
          throw error;
        }
        return { path: target, fileCount: logEntries.length + 2, taskCount: tasks.length, warnings };
      } catch (error) {
        throw new Error(`无法导出诊断包: ${error.message}`, { cause: error });
      }
    }
  };
}
