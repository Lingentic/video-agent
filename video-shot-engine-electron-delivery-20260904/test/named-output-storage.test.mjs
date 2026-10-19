import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { ffmpegPath } from "../src/runtime-paths.mjs";
import { SHOT_DETECTION_VERSION } from "../src/shot-service.mjs";
import { executeShotNaming } from "../src/naming-service.mjs";
import { finalizeNamedSegments, readNamedManifest, writeNamedJson } from "../src/named-output-storage.mjs";
import { cleanupStaleInputs } from "../src/input-cleanup.mjs";
import { processBatchItem } from "../src/batch-service.mjs";
import { createShotServer } from "../src/server.mjs";

const exec = promisify(execFile);
const tempRoots = [];
const hash = async file => createHash("sha256").update(await fsp.readFile(file)).digest("hex");
const exists = async file => { try { await fsp.access(file); return true; } catch { return false; } };
const forbiddenProvider = { uploadVideo() { assert.fail("must reuse saved labels/results"); }, analyze() { assert.fail("must not submit a new provider request"); } };
test.after(async () => { for (const root of tempRoots) await fsp.rm(root, { recursive: true, force: true }); });

async function fixture(parent, id = "run_test") {
  if (!parent) { parent = await fsp.mkdtemp(path.join(os.tmpdir(), "named-storage-")); tempRoots.push(parent); }
  const runDir = path.join(parent, id);
  const artifacts = path.join(runDir, "artifacts");
  const rawDir = path.join(artifacts, "shot_segments");
  await fsp.mkdir(rawDir, { recursive: true });
  const input = path.join(runDir, "input.mp4");
  await exec(ffmpegPath, ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "testsrc2=s=64x64:r=24:d=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", input], { windowsHide: true });
  const shots = [];
  for (let index = 0; index < 2; index += 1) {
    const shotId = `shot_00${index + 1}`;
    const filePath = `artifacts/shot_segments/${shotId}.mp4`;
    await exec(ffmpegPath, ["-nostdin", "-v", "error", "-i", input, "-ss", String(index), "-t", "1", "-c:v", "libx264", path.join(runDir, filePath)], { windowsHide: true });
    shots.push({ shotId, startSec: index, endSec: index + 1, startFrame: index * 24, endFrame: (index + 1) * 24, frameCount: 24, filePath });
  }
  let run = { runId: id, videoId: id, shots, input, fps: 24, durationSec: 2, keepAudio: false, autoName: true, workflow: "ffmpeg_gemini_naming", shotDetectionVersion: SHOT_DETECTION_VERSION, status: "processing", stage: "naming_processing", usage: { total_tokens: 50 }, createdAt: new Date().toISOString() };
  const stateFile = id.startsWith("run_") ? path.join(artifacts, "run.json") : path.join(runDir, "item.json");
  const save = async next => { run = next; await writeNamedJson(stateFile, next); return next; };
  await save(run);
  await writeNamedJson(path.join(rawDir, "shot_segments.json"), shots);
  await writeNamedJson(path.join(artifacts, "shot_labels_raw.json"), { shots: shots.map(shot => ({ shot_id: shot.shotId, content_title: "展示商品", usage_type: "功能讲解" })) });
  await writeNamedJson(path.join(artifacts, "usage.json"), { total_tokens: 50 });
  const naming = async () => executeShotNaming({ runDir, initialRun: run, gemini: forbiddenProvider, onStage: async (stage, patch = {}) => save({ ...run, ...patch, stage }) });
  return { parent, runDir, artifacts, rawDir, input, shots, stateFile, save, naming, get run() { return run; } };
}

test("successful naming commits canonical references before removing raw videos, retaining playable named results and receipts", async () => {
  const f = await fixture();
  const original = await hash(f.input);
  const result = await f.naming();
  assert.equal(result.manifest.length, 2);
  assert.equal((await fsp.readdir(f.rawDir)).filter(file => file.endsWith(".mp4")).length, 2);
  await finalizeNamedSegments(f.runDir, f.run, () => assert.fail("unfinished task must not be cleaned"));
  await f.save({ ...f.run, status: "completed" });
  const { run: final } = await finalizeNamedSegments(f.runDir, f.run, async next => {
    for (const shot of next.shots) assert.match(shot.filePath, /^named_segments\//);
    for (const shot of f.shots) assert.equal(await exists(path.join(f.runDir, shot.filePath)), true, "raw files must remain until the record is saved");
    return f.save(next);
  });
  assert.deepEqual(final.shots.map(shot => shot.filePath), result.manifest.map(shot => shot.namedPath));
  assert.equal((await fsp.readdir(f.rawDir)).filter(file => file.endsWith(".mp4")).length, 0);
  assert.equal(await exists(path.join(f.rawDir, "shot_segments.json")), true);
  assert.equal(await exists(path.join(f.artifacts, "shot_labels_raw.json")), true);
  assert.equal(await hash(f.input), original);
  assert.equal((await readNamedManifest(f.runDir, final)).length, 2);
  await finalizeNamedSegments(f.runDir, final, () => assert.fail("already finalized task must not be written again"));
});

test("failed, paused or cancelled tasks retain both raw clips and source even if a valid manifest exists", async () => {
  const f = await fixture();
  await f.naming();
  for (const status of ["failed", "paused", "cancelled", "processing"]) {
    await finalizeNamedSegments(f.runDir, { ...f.run, status }, () => assert.fail("must not save"));
    for (const shot of f.shots) assert.equal(await exists(path.join(f.runDir, shot.filePath)), true);
    assert.equal(await exists(f.input), true);
  }
});

test("missing, corrupt, incomplete, mismatched or outside-task named results never authorize deletion", async () => {
  const f = await fixture();
  const result = await f.naming();
  const receipt = path.join(f.artifacts, "rename_manifest.json");
  const badManifests = [result.manifest.slice(0, 1), result.manifest.map(entry => ({ ...entry, shotId: "shot_001" })), result.manifest.map(entry => ({ ...entry, startFrame: 9 })), result.manifest.map(entry => ({ ...entry, namedPath: "../outside.mp4" }))];
  for (const manifest of badManifests) {
    await writeNamedJson(receipt, manifest);
    await finalizeNamedSegments(f.runDir, { ...f.run, status: "completed" }, () => assert.fail("invalid manifest must not be committed"));
    for (const shot of f.shots) assert.equal(await exists(path.join(f.runDir, shot.filePath)), true);
  }
  await writeNamedJson(receipt, result.manifest);
  const output = path.join(f.runDir, result.manifest[1].namedPath);
  await fsp.writeFile(output, "not a video");
  assert.equal(await readNamedManifest(f.runDir, f.run), null);
  await finalizeNamedSegments(f.runDir, { ...f.run, status: "completed" }, () => assert.fail("corrupt result must not be committed"));
  await fsp.unlink(output);
  await finalizeNamedSegments(f.runDir, { ...f.run, status: "completed" }, () => assert.fail("missing result must not be committed"));
  for (const shot of f.shots) assert.equal(await exists(path.join(f.runDir, shot.filePath)), true);
});

test("a failed state commit leaves every raw clip intact", async () => {
  const f = await fixture();
  await f.naming();
  const { run: final } = await finalizeNamedSegments(f.runDir, { ...f.run, status: "completed" }, async () => { throw Error("simulated disk write failure"); });
  assert.equal(final.status, "completed", "cleanup must not fail an otherwise delivered task");
  for (const shot of f.shots) assert.equal(await exists(path.join(f.runDir, shot.filePath)), true);
});

test("playable but truncated named video preserves raw clips and source through restart, then can be re-exported", async () => {
  const f = await fixture();
  const result = await f.naming();
  const short = path.join(f.runDir, result.manifest[0].namedPath);
  await exec(ffmpegPath, ["-nostdin", "-v", "error", "-y", "-i", f.input, "-t", "0.2", "-an", "-c:v", "libx264", short], { windowsHide: true });
  await f.save({ ...f.run, status: "completed" });
  assert.equal(await readNamedManifest(f.runDir, f.run), null);
  await cleanupStaleInputs(f.parent);
  assert.equal(await exists(f.input), true, "unverified named results must not trigger source cleanup");
  for (const shot of f.shots) assert.equal(await exists(path.join(f.runDir, shot.filePath)), true);
  await f.save({ ...f.run, status: "failed" });
  await f.naming();
  const finalized = await finalizeNamedSegments(f.runDir, { ...f.run, status: "completed" }, f.save);
  assert.equal(finalized.ready, true);
  assert.equal((await readNamedManifest(f.runDir, finalized.run)).length, 2);
});

test("restart finishes cleanup after a committed state and a partially deleted raw set", async () => {
  const f = await fixture();
  await f.naming();
  await finalizeNamedSegments(f.runDir, { ...f.run, status: "completed" }, async next => {
    await f.save(next);
    await fsp.unlink(path.join(f.runDir, f.shots[0].filePath));
    throw Error("simulate termination after commit and first unlink");
  });
  await cleanupStaleInputs(f.parent);
  const disk = JSON.parse(await fsp.readFile(f.stateFile, "utf8"));
  assert.equal(disk.status, "completed");
  for (const shot of disk.shots) { assert.match(shot.filePath, /^named_segments\//); assert.equal(await exists(path.join(f.runDir, shot.filePath)), true); }
  assert.equal((await fsp.readdir(f.rawDir)).some(name => name.endsWith(".mp4")), false);
});

test("restart after raw cleanup preserves the remaining source if a named result is truncated or missing", async () => {
  for (const damage of ["truncated", "missing"]) {
    const f = await fixture();
    const result = await f.naming();
    await finalizeNamedSegments(f.runDir, { ...f.run, status: "completed" }, f.save);
    assert.equal((await fsp.readdir(f.rawDir)).some(name => name.endsWith(".mp4")), false);
    const output = path.join(f.runDir, result.manifest[0].namedPath);
    if (damage === "missing") await fsp.unlink(output);
    else await exec(ffmpegPath, ["-nostdin", "-v", "error", "-y", "-i", f.input, "-t", "0.2", "-an", "-c:v", "libx264", output], { windowsHide: true });
    await cleanupStaleInputs(f.parent);
    assert.equal(await exists(f.input), true, `${damage} named result must not allow source cleanup`);
    await f.save({ ...f.run, status: "failed" });
    await f.naming();
    assert.equal((await readNamedManifest(f.runDir, f.run)).length, 2, "saved source and labels must still recover the named set");
  }
});

test("retry can re-export missing raw clips from source and saved labels without provider calls", async () => {
  const f = await fixture();
  await fsp.unlink(path.join(f.runDir, f.shots[0].filePath));
  const result = await f.naming();
  assert.equal(result.manifest.length, 2);
  await finalizeNamedSegments(f.runDir, { ...f.run, status: "completed" }, f.save);
  assert.equal((await readNamedManifest(f.runDir, f.run)).length, 2);
});

test("complete manifest before completion state can recover without source, raw clips, labels or new exports", async () => {
  const f = await fixture();
  const first = await f.naming();
  const hashes = await Promise.all(first.manifest.map(entry => hash(path.join(f.runDir, entry.namedPath))));
  await fsp.unlink(f.input);
  await fsp.unlink(path.join(f.artifacts, "shot_labels_raw.json"));
  for (const shot of f.shots) await fsp.unlink(path.join(f.runDir, shot.filePath));
  const reused = await f.naming();
  assert.equal(reused.usage.total_tokens, 50);
  assert.deepEqual(await Promise.all(reused.manifest.map(entry => hash(path.join(f.runDir, entry.namedPath)))), hashes);
});

test("batch success finalizes only that item; startup cleans a completed item inside an unfinished batch", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "named-batch-")); tempRoots.push(root);
  const batchDir = path.join(root, "batch_test");
  const good = await fixture(path.join(batchDir, "items"), "video_001");
  const failed = await fixture(path.join(batchDir, "items"), "video_002");
  const completed = await processBatchItem({ batchDir, item: good.run, gemini: forbiddenProvider, thresholds: {}, onUpdate: async () => {} });
  assert.equal(completed.status, "completed");
  for (const shot of completed.shots) assert.match(shot.filePath, /^named_segments\//);
  assert.equal((await fsp.readdir(good.rawDir)).some(name => name.endsWith(".mp4")), false);
  // Recreate raw cache to model termination just before unlink; batch completion has not been saved.
  for (const [index, shot] of good.shots.entries()) await fsp.copyFile(path.join(good.runDir, completed.shots[index].filePath), path.join(good.runDir, shot.filePath));
  await failed.save({ ...failed.run, status: "failed", updatedAt: new Date().toISOString() });
  await writeNamedJson(path.join(batchDir, "batch.json"), { status: "processing", items: [{ videoId: "video_001" }, { videoId: "video_002" }] });
  await cleanupStaleInputs(root);
  assert.equal((await fsp.readdir(good.rawDir)).some(name => name.endsWith(".mp4")), false);
  for (const shot of failed.shots) assert.equal(await exists(path.join(failed.runDir, shot.filePath)), true);
  assert.equal(await exists(failed.input), true);
});

test("completed ordinary and subtitle runs resume locally without keys, input or new subtitle jobs", async () => {
  const f = await fixture();
  await f.naming();
  await f.save({ ...f.run, status: "completed" });
  await fsp.unlink(f.input);
  const oldKey = process.env.XINHANKR_API_KEY;
  delete process.env.XINHANKR_API_KEY;
  let runtime, server;
  try {
    runtime = await createShotServer({ runsDir: f.parent, port: 0, host: "127.0.0.1", gemini: null, subtitleApiKey: "", subtitleService() { assert.fail("completed run must not restart subtitle removal"); } });
    server = await runtime.listen();
    for (const removeSubtitles of [false, true]) {
      const disk = JSON.parse(await fsp.readFile(f.stateFile, "utf8"));
      await f.save({ ...disk, removeSubtitles });
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/runs/run_test/resume-naming`, { method: "POST" });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { runId: "run_test", status: "completed", active: false, resumed: true });
    }
  } finally {
    if (oldKey === undefined) delete process.env.XINHANKR_API_KEY; else process.env.XINHANKR_API_KEY = oldKey;
    if (server) await new Promise(resolve => server.close(resolve));
    await runtime?.transportManager.close();
  }
});
