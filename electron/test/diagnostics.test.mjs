import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDiagnostics } from "../diagnostics.mjs";

const tempRoots = [];
async function tempRoot() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "video-diagnostics-"));
  tempRoots.push(dir);
  return dir;
}
test.after(async () => { await Promise.all(tempRoots.map((dir) => rm(dir, { recursive: true, force: true }))); });

function readZip(buffer) {
  const files = new Map();
  let end = buffer.length - 22;
  while (end >= 0 && buffer.readUInt32LE(end) !== 0x06054b50) end -= 1;
  assert.ok(end >= 0, "ZIP end record exists");
  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  for (let i = 0; i < count; i += 1) {
    assert.equal(buffer.readUInt32LE(offset), 0x02014b50);
    const size = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    files.set(name, buffer.subarray(dataStart, dataStart + size));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

const NativeDate = Date;
function freezeDate(iso) {
  const now = NativeDate.parse(iso);
  globalThis.Date = class extends NativeDate {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  };
}
function restoreDate() { globalThis.Date = NativeDate; }

test("record order, secret/path redaction and Authorization values with spaces", async () => {
  const root = await tempRoot();
  const diagnostics = createDiagnostics({ dataRoot: root, privatePaths: [root], secrets: ["my-known-private-key"] });
  const results = await Promise.all([
    diagnostics.record("first", { nested: { apiKey: "secret-value", note: "my-known-private-key", usage: { total_input_tokens: 120, total_output_tokens: 20 } } }),
    diagnostics.record("second", { auth: 'JSON: {"Authorization":"Bearer abcdefghijklmnop tail secret"}; "authorization": "Basic top-secret rest"', local: "C:/素材 目录/成片 file.mp4", url: "https://user:pass@example.test/private?q=hidden" }),
    diagnostics.record("third", { signed: "https://storage.test/object?X-Amz-Credential=secret&X-Amz-Signature=hidden", key: "sk-ABCDEFGH12345678 key_ABCDEFGHIJK1234" })
  ]);
  await diagnostics.flush();
  assert.deepEqual(results, [true, true, true]);
  const [file] = await readdir(path.join(root, "diagnostics"));
  const content = await readFile(path.join(root, "diagnostics", file), "utf8");
  const rows = content.trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(rows.map((row) => row.event), ["first", "second", "third"]);
  assert.deepEqual(rows[0].fields.nested.usage, { total_input_tokens: 120, total_output_tokens: 20 });
  assert.doesNotMatch(content, /my-known-private-key|secret-value|abcdefghijklmnop|tail secret|top-secret rest|X-Amz-Credential|\/private\?|素材 目录|成片 file\.mp4|sk-ABCDEFGH|key_ABCDEFGHI/);
  assert.match(content, /example\.test/);
  assert.match(content, /LOCAL_PATH/);
});

test("private Windows path prefixes do not leave Chinese child paths visible", async () => {
  const root = await tempRoot();
  const diagnostics = createDiagnostics({ dataRoot: root, privatePaths: ["C:/Users/demo-user"] });
  await diagnostics.record("path-check", {
    slash: "failed to load C:/Users/demo-user/Desktop/私密客户/合同 文件.mp4",
    backslash: "failed to load C:\\Users\\demo-user\\Desktop\\私密客户\\合同 文件.mp4"
  });
  await diagnostics.flush();
  const [name] = await readdir(path.join(root, "diagnostics"));
  const text = await readFile(path.join(root, "diagnostics", name), "utf8");
  assert.doesNotMatch(text, /demo-user|私密客户|合同 文件/);
});

test("actual JSON.parse message, Error string and stack first line are scrubbed", async () => {
  const root = await tempRoot();
  const diagnostics = createDiagnostics({ dataRoot: root });
  let caught;
  try { JSON.parse('{"caption":"ORIGINAL_PRIVATE_DIALOGUE_7e31","broken":}'); } catch (error) { caught = error; }
  let multilineCaught;
  try { JSON.parse("演示私密第一行\n演示私密第二行"); } catch (error) { multilineCaught = error; }
  assert.ok(caught instanceof SyntaxError);
  assert.ok(multilineCaught instanceof SyntaxError);
  await diagnostics.record("parse-failure", {
    error: caught.message,
    errorRecord: { name: caught.name, message: caught.message, stack: caught.stack, errorStack: caught.stack },
    multilineError: { name: multilineCaught.name, message: multilineCaught.message, stack: multilineCaught.stack, errorStack: multilineCaught.stack }
  });
  await diagnostics.flush();
  const [name] = await readdir(path.join(root, "diagnostics"));
  const log = await readFile(path.join(root, "diagnostics", name), "utf8");
  assert.doesNotMatch(log, /ORIGINAL_PRIVATE_DIALOGUE_7e31/);
  assert.doesNotMatch(log, /演示私密第一行|演示私密第二行/);
  assert.match(log, /SyntaxError: invalid JSON/);
  assert.match(log, /at JSON\.parse/);
});

test("record queue is bounded and log write failures do not reject business calls", async () => {
  const parent = await tempRoot();
  const blocker = path.join(parent, "not-a-directory");
  await writeFile(blocker, "x");
  const failed = createDiagnostics({ dataRoot: blocker });
  assert.equal(await failed.record("safe-failure"), false);
  await failed.flush();

  const root = await tempRoot();
  const diagnostics = createDiagnostics({ dataRoot: root });
  const queued = Array.from({ length: 1002 }, (_, index) => diagnostics.record(`queued-${index}`));
  const results = await Promise.all(queued);
  assert.ok(results.some((result) => result === false));
  await diagnostics.flush();
});

test("rotation reaches 2 MiB and keeps no more than three daily files", async () => {
  const root = await tempRoot();
  const diagnostics = createDiagnostics({ dataRoot: root });
  const value = "x".repeat(4000);
  for (let i = 0; i < 1200; i += 1) assert.equal(await diagnostics.record(`event-${i}`, { value }), true);
  await diagnostics.flush();
  const files = await readdir(path.join(root, "diagnostics"));
  assert.ok(files.length >= 2 && files.length <= 3, `expected rotation files, found ${files.length}`);
  const sizes = await Promise.all(files.map(async (file) => (await readFile(path.join(root, "diagnostics", file))).length));
  assert.ok(sizes.some((size) => size > 2 * 1024 * 1024 - 64 * 1024));
  assert.ok(sizes.every((size) => size <= 2 * 1024 * 1024));
});

test("old logs are removed at startup and again when the same instance crosses a date", async () => {
  const root = await tempRoot();
  freezeDate("2026-04-10T12:00:00.000Z");
  try {
    const diagnostics = createDiagnostics({ dataRoot: root });
    const logRoot = path.join(root, "diagnostics");
    await mkdir(logRoot, { recursive: true });
    await writeFile(path.join(logRoot, "client-2026-01-01.jsonl"), "old\n");
    await writeFile(path.join(logRoot, "client-2026-01-01.1.jsonl"), "old-version\n");
    await diagnostics.record("startup");
    assert.ok(!(await readdir(logRoot)).includes("client-2026-01-01.jsonl"));
    assert.ok(!(await readdir(logRoot)).includes("client-2026-01-01.1.jsonl"));
    await writeFile(path.join(logRoot, "client-2026-04-04.jsonl"), "will-expire-next-day\n");
    freezeDate("2026-04-11T12:00:00.000Z");
    await diagnostics.record("next-day");
    assert.ok(!(await readdir(logRoot)).includes("client-2026-04-04.jsonl"));
  } finally { restoreDate(); }
});

test("task scan includes shot batch and single-run artifacts with safe error and usage fields", async () => {
  const root = await tempRoot();
  const kling = path.join(root, "kling-h3", "runs", "run-a");
  await mkdir(path.join(kling, "artifacts", "subtitle-removal"), { recursive: true });
  await writeFile(path.join(kling, "run.json"), JSON.stringify({ runId: "r-1", stage: "video", failedStage: "video", status: "failed", prompt: "private prompt", inputFilename: "secret.mov", imageModel: "image-a", videoModel: "video-a", imageProvider: "provider-image", videoProvider: "provider-video", videoTaskId: "vt-1", unknownCostAttempts: 2, imageTasks: [{ index: 0, requestId: "image-req-1", status: "failed", error: { message: "image request failed" }, request: { prompt: "never include this prompt" }, response: { text: "never include this response" } }], usage: { total_input_tokens: 1024, total_output_tokens: 512 } }));
  await writeFile(path.join(kling, "artifacts", "run.json"), JSON.stringify({ errorRecord: { message: "known-secret-path: https://api.test/v1?token=known-secret-path", stack: "C:/用户 目录/视频.mp4", requestAttempts: [{ code: "E_HTTP", requestId: "req-1" }] } }));
  await writeFile(path.join(kling, "artifacts", "provider_attempts.json"), JSON.stringify([{ requestNumber: 2, level: "strict", repeat: 1, schemaMode: "json-schema", outcome: "invalid", validationError: `SyntaxError: Unexpected token 'private dialogue', "caption": not-json is not valid JSON at position 42 (line 2 column 3)`, costStatus: "unknown", transportError: "socket timeout" }]));
  await writeFile(path.join(kling, "artifacts", "ffmpeg_runtime.json"), JSON.stringify({ inspectedAt: "2026-10-13T00:00:00.000Z", host: { hostname: "private-host" }, clientResourcesDir: "C:/private/resources", ffmpeg: { name: "ffmpeg", source: "bundled", versionLine: "ffmpeg version 7.0", available: true, error: null, requestedPath: "C:/private/ffmpeg.exe", resolvedPath: "C:/private/ffmpeg.exe" }, ffprobe: { name: "ffprobe", source: "system", versionLine: "ffprobe version 7.0", available: true } }));
  await writeFile(path.join(kling, "artifacts", "subtitle-removal", "job.json"), JSON.stringify({ status: "failed", namingError: { message: "named failure" }, cause: { message: "nested cause" } }));

  const shot = path.join(root, "video-shot", "runs-v1", "batch-a");
  const item = path.join(shot, "items", "video_001");
  await mkdir(path.join(item, "artifacts", "subtitle-removal"), { recursive: true });
  await writeFile(path.join(shot, "batch.json"), JSON.stringify({ batchId: "b-1", status: "partial", createdAt: "2026-10-01T00:00:00Z", sourceFilename: "secret.mp4" }));
  await writeFile(path.join(item, "item.json"), JSON.stringify({ videoId: "video_001", stage: "transcribe", status: "failed", error: { code: "E_HTTP", message: "transcription request failed" }, frameRateavg: 29.97, sourceFilename: "secret.mp4", voiceScript: "private" }));
  await writeFile(path.join(item, "artifacts", "run.json"), JSON.stringify({ videoTaskId: "cloud-1", videoModel: "shot-model" }));
  await writeFile(path.join(item, "artifacts", "provider_attempts.json"), JSON.stringify({ requestAttempts: [{ provider: "prov", statusCode: 429, requestId: "req-shot" }] }));
  await writeFile(path.join(item, "artifacts", "usage.json"), JSON.stringify({ usage: { total_input_tokens: 33, total_output_tokens: 9 }, billing: { estimated_cost_yuan: 0.01 } }));
  await writeFile(path.join(item, "artifacts", "ffmpeg_runtime.json"), JSON.stringify({ fps: 29.97, durationSec: 8.3 }));
  await writeFile(path.join(item, "artifacts", "subtitle-removal", "job.json"), JSON.stringify({ status: "done", usage: { billed: false } }));
  await writeFile(path.join(item, "artifacts", "error.json"), "{invalid");

  const diagnostics = createDiagnostics({ dataRoot: root, privatePaths: [root], secrets: ["known-secret-path"] });
  await diagnostics.record("before-export", { source: root });
  const out = path.join(root, "support.zip");
  const result = await diagnostics.exportBundle(out);
  assert.equal(result.taskCount, 2);
  assert.ok(result.warnings.some((itemWarning) => itemWarning.includes("JSON 无效")));
  const files = readZip(await readFile(out));
  const summary = JSON.parse(files.get("summary.json"));
  const tasks = JSON.parse(files.get("tasks.json"));
  assert.equal(summary.tasks.length, 2);
  const text = JSON.stringify(tasks);
  assert.match(text, /video-a|provider-image|videoTaskId|total_input_tokens|requestAttempts|namingError|frameRateavg|29\.97|image-req-1|requestNumber|schemaMode|ffmpeg version 7\.0|inspectedAt/);
  assert.doesNotMatch(text, /private prompt|secret\.mp4|voiceScript|known-secret-path|C:|视频\.mp4|token=|never include this prompt|never include this response|private dialogue|private-host|private\/resources|private\/ffmpeg\.exe/);
  assert.ok(files.has("logs/" + (await readdir(path.join(root, "diagnostics")))[0]));
});

test("task recency follows known status record mtimes rather than run directory mtimes", async () => {
  const root = await tempRoot();
  const runs = path.join(root, "kling-h3", "runs");
  const oldRun = path.join(runs, "run-old-record");
  const recentRun = path.join(runs, "run-recent-record");
  await mkdir(oldRun, { recursive: true });
  await mkdir(recentRun, { recursive: true });
  const oldFile = path.join(oldRun, "run.json");
  const recentFile = path.join(recentRun, "run.json");
  await writeFile(oldFile, JSON.stringify({ runId: "old-by-record", status: "failed" }));
  await writeFile(recentFile, JSON.stringify({ runId: "recent-by-record", status: "completed" }));
  const old = new Date(Date.now() - 9 * 86400000);
  const recent = new Date();
  await utimes(oldFile, old, old);
  await utimes(oldRun, recent, recent);
  await utimes(recentRun, old, old);
  await utimes(recentFile, recent, recent);
  const out = path.join(root, "support.zip");
  await createDiagnostics({ dataRoot: root }).exportBundle(out);
  const tasks = JSON.parse(readZip(await readFile(out)).get("tasks.json"));
  assert.match(JSON.stringify(tasks), /recent-by-record/);
  assert.doesNotMatch(JSON.stringify(tasks), /old-by-record/);
});

test("symlinked run roots and items parents are rejected without crossing dataRoot", async () => {
  const root = await tempRoot();
  const outside = await tempRoot();
  const externalRun = path.join(outside, "batch-outside");
  await mkdir(path.join(externalRun, "items", "video_001"), { recursive: true });
  await writeFile(path.join(externalRun, "batch.json"), JSON.stringify({ batchId: "outside-root-leak" }));
  await writeFile(path.join(externalRun, "items", "video_001", "item.json"), JSON.stringify({ status: "outside-root-leak" }));
  const externalItems = path.join(outside, "items-external");
  await mkdir(path.join(externalItems, "video_001"), { recursive: true });
  await writeFile(path.join(externalItems, "video_001", "item.json"), JSON.stringify({ status: "outside-items-leak" }));
  await mkdir(path.join(root, "kling-h3"), { recursive: true });
  await mkdir(path.join(root, "video-shot", "runs-v1", "batch-items-link"), { recursive: true });
  try {
    await symlink(path.join(outside), path.join(root, "kling-h3", "runs"), "junction");
    await symlink(externalItems, path.join(root, "video-shot", "runs-v1", "batch-items-link", "items"), "junction");
  } catch (error) {
    if (error.code === "EPERM" || error.code === "EACCES") return;
    throw error;
  }
  const diagnostics = createDiagnostics({ dataRoot: root });
  const out = path.join(root, "support.zip");
  await diagnostics.exportBundle(out);
  const tasks = JSON.stringify(JSON.parse(readZip(await readFile(out)).get("tasks.json")));
  assert.doesNotMatch(tasks, /outside-root-leak|outside-items-leak/);
});

test("log export preserves complete JSONL rows, scrubs each row and caps tail at 4 MiB", async () => {
  const root = await tempRoot();
  const diagnostics = createDiagnostics({ dataRoot: root, secrets: ["line-secret"] });
  for (let i = 0; i < 1200; i += 1) await diagnostics.record(`event-${i}`, { detail: "x".repeat(4000), note: "line-secret" });
  const out = path.join(root, "logs.zip");
  const pendingRecord = diagnostics.record("flush-check", { detail: "queued before export" });
  const [pendingResult, result] = await Promise.all([pendingRecord, diagnostics.exportBundle(out)]);
  assert.equal(pendingResult, true);
  const files = readZip(await readFile(out));
  const logBuffers = [...files].filter(([name]) => name.startsWith("logs/")).map(([, data]) => data);
  assert.ok(logBuffers.length > 0);
  assert.ok(logBuffers.reduce((sum, buffer) => sum + buffer.length, 0) <= 4 * 1024 * 1024);
  for (const buffer of logBuffers) {
    const lines = buffer.toString("utf8").trim().split("\n");
    for (const line of lines) assert.doesNotThrow(() => JSON.parse(line));
    assert.doesNotMatch(buffer.toString("utf8"), /line-secret/);
    assert.ok(buffer.length > 4096);
  }
  assert.match(logBuffers.map((buffer) => buffer.toString("utf8")).join(""), /flush-check/);
  assert.ok(result.warnings.some((warning) => warning.includes("截断")));
  const summary = JSON.parse(files.get("summary.json"));
  assert.ok(summary.warnings.some((warning) => warning.includes("截断")));
});

test("failed atomic rename preserves an existing destination directory and contents", async () => {
  const root = await tempRoot();
  const diagnostics = createDiagnostics({ dataRoot: root });
  const target = path.join(root, "existing.zip");
  await mkdir(target);
  await writeFile(path.join(target, "marker.txt"), "preserve-me");
  await assert.rejects(diagnostics.exportBundle(target), /无法导出诊断包/);
  assert.equal(await readFile(path.join(target, "marker.txt"), "utf8"), "preserve-me");
  assert.deepEqual(await readdir(target), ["marker.txt"]);
  assert.ok(!(await readdir(root)).some((name) => name.endsWith(".tmp")));
});

test("recent task allowance is ten per service, not ten combined", async () => {
  const root = await tempRoot();
  for (const [service, subdir] of [["kling-h3", "runs"], ["video-shot", "runs-v1"]]) {
    for (let i = 0; i < 12; i++) {
      const dir = path.join(root, service, subdir, `run_${i}`);
      await mkdir(dir, { recursive: true });
      const file = path.join(dir, "run.json");
      await writeFile(file, JSON.stringify({ runId: `run_${i}`, status: "completed" }));
      const time = new Date(Date.now() - (12 - i) * 1000);
      await utimes(file, time, time);
    }
  }
  const out = path.join(root, "support.zip");
  const result = await createDiagnostics({ dataRoot: root }).exportBundle(out);
  const tasks = JSON.parse(readZip(await readFile(out)).get("tasks.json"));
  assert.equal(result.taskCount, 20);
  for (const service of ["kling-h3", "video-shot"]) {
    const selected = tasks.filter(task => task.service === service);
    assert.equal(selected.length, 10);
    assert.doesNotMatch(JSON.stringify(selected), /"run_[01]"/);
  }
});

test("error snapshots survive task eviction, recovery, log expiration and app restart; polling deduplicates", async () => {
  const root = await tempRoot();
  const dir = path.join(root, "kling-h3", "runs", "run_failed");
  await mkdir(dir, { recursive: true });
  const state = { id: "run_failed", status: "failed", stage: "video", videoTaskId: "cloud-original", error: "socket timeout", prompt: "private-prompt", sourceFilename: "private.mp4" };
  const file = path.join(dir, "run.json");
  await writeFile(file, JSON.stringify(state));
  let diagnostics = createDiagnostics({ dataRoot: root, secrets: ["private-secret"] });
  const fields = { module: "remake", endpoint: "api/runs/run_failed", stage: "video", error: { message: "socket timeout private-secret", stack: "C:/私密 目录/a.js" } };
  await diagnostics.record("task.failed", fields, "error");
  await diagnostics.record("task.failed", { ...fields, durationMs: 123 }, "error");
  await writeFile(file, JSON.stringify({ ...state, status: "completed", error: null }));
  await rm(path.join(root, "diagnostics", `client-${new Date().toISOString().slice(0, 10)}.jsonl`));
  for (let i = 0; i < 11; i++) {
    const next = path.join(root, "kling-h3", "runs", `run_new_${i}`);
    await mkdir(next, { recursive: true });
    await writeFile(path.join(next, "run.json"), JSON.stringify({ id: `run_new_${i}`, status: "completed" }));
  }
  diagnostics = createDiagnostics({ dataRoot: root, secrets: ["private-secret"] });
  await diagnostics.record("task.failed", fields, "error");
  const out = path.join(root, "support.zip");
  await diagnostics.exportBundle(out);
  const files = readZip(await readFile(out));
  assert.doesNotMatch(files.get("tasks.json").toString(), /run_failed/);
  const errors = JSON.parse(files.get("errors.json"));
  assert.equal(errors.length, 1);
  assert.equal(errors[0].runId, "run_failed");
  assert.equal(errors[0].task.files["run.json"].status, "failed");
  assert.equal(errors[0].task.files["run.json"].videoTaskId, "cloud-original");
  assert.doesNotMatch(JSON.stringify(errors), /private-secret|private-prompt|private.mp4|私密|C:/);
});

test("error retention is independent: thirty days and one hundred distinct errors", async () => {
  const root = await tempRoot();
  const diagnostics = createDiagnostics({ dataRoot: root });
  for (let i = 0; i < 103; i++) await diagnostics.record("request.failed", { module: "shot", error: { message: `error-${i}` } }, "error");
  const errorDir = path.join(root, "diagnostics", "errors");
  let files = await readdir(errorDir);
  assert.equal(files.length, 100);
  const old = new Date(Date.now() - 31 * 86400000);
  await utimes(path.join(errorDir, files[0]), old, old);
  const out = path.join(root, "errors.zip");
  await diagnostics.exportBundle(out);
  const errors = JSON.parse(readZip(await readFile(out)).get("errors.json"));
  assert.equal(errors.length, 99);
  assert.ok(!(await readdir(errorDir)).includes(files[0]));
  // An evicted error must be saved again if it actually reoccurs in this process.
  await diagnostics.record("request.failed", { module: "shot", error: { message: "error-0" } }, "error");
  await diagnostics.exportBundle(out);
  const repeated = JSON.parse(readZip(await readFile(out)).get("errors.json"));
  assert.ok(repeated.some(row => row.fields.error.message === "error-0"));
});

test("large failed batches keep task identity and separate snapshots despite log row truncation", async () => {
  const root = await tempRoot();
  const diagnostics = createDiagnostics({ dataRoot: root });
  const failedItems = Array.from({ length: 100 }, (_, i) => ({ videoId: `video_${i}`, status: "failed", error: "x".repeat(4096), errorRecord: { stack: "y".repeat(4096) } }));
  await diagnostics.record("task.failed", { module: "shot", runId: "batch_a", failedItems }, "error");
  await diagnostics.record("task.failed", { module: "shot", runId: "batch_b", failedItems }, "error");
  const out = path.join(root, "large.zip");
  await diagnostics.exportBundle(out);
  const errors = JSON.parse(readZip(await readFile(out)).get("errors.json"));
  assert.equal(errors.length, 2);
  assert.deepEqual(new Set(errors.map(row => row.runId)), new Set(["batch_a", "batch_b"]));
  assert.ok(errors.every(row => row.fields.module === "shot" && row.fields.failedItems.length > 0 && row.fields.omittedFailedItems > 0));
  const errorDir = path.join(root, "diagnostics", "errors");
  for (const file of await readdir(errorDir)) assert.ok((await readFile(path.join(errorDir, file))).length <= 64 * 1024);
});

test("new failed attempt is not confused with repeated polling of the same failure", async () => {
  const root = await tempRoot();
  const diagnostics = createDiagnostics({ dataRoot: root });
  const fields = { module: "remake", runId: "run_retry", status: "FAILED", error: "timeout", failedAt: "2026-10-14T01:00:00Z" };
  await diagnostics.record("task.failed", fields, "error");
  await diagnostics.record("task.failed", fields, "error");
  await diagnostics.record("task.failed", { ...fields, failedAt: "2026-10-14T02:00:00Z" }, "error");
  const out = path.join(root, "attempts.zip");
  await diagnostics.exportBundle(out);
  assert.equal(JSON.parse(readZip(await readFile(out)).get("errors.json")).length, 2);
});
