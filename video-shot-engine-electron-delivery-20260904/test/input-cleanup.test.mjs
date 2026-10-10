import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { cleanupRunInputs, cleanupStaleInputs, FAILED_INPUT_RETENTION_MS } from "../src/input-cleanup.mjs";
import { SHOT_DETECTION_VERSION } from "../src/shot-service.mjs";

async function exists(file) {
  try { await fsp.access(file); return true; } catch { return false; }
}

test("cleans only input copies inside the run directory", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "shot-cleanup-"));
  try {
    const runDir = path.join(root, "run_test");
    const input = path.join(runDir, "input.mp4");
    const analysis = path.join(runDir, "artifacts", "analysis_input_numbered.mp4");
    const outside = path.join(root, "user-original.mp4");
    await fsp.mkdir(path.dirname(analysis), { recursive: true });
    await Promise.all([fsp.writeFile(input, "input"), fsp.writeFile(analysis, "analysis"), fsp.writeFile(outside, "original")]);
    await cleanupRunInputs(runDir, input);
    await cleanupRunInputs(runDir, outside);
    assert.equal(await exists(input), false);
    assert.equal(await exists(analysis), false);
    assert.equal(await exists(outside), true);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("cleans completed and expired failed inputs but keeps recent failed inputs and outputs", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "shot-retention-"));
  try {
    const records = [
      { id: "run_completed", status: "completed", age: 0 },
      { id: "run_recent_failed", status: "failed", age: FAILED_INPUT_RETENTION_MS - 1000 },
      { id: "run_expired_failed", status: "failed", age: FAILED_INPUT_RETENTION_MS + 1000 }
    ];
    for (const record of records) {
      const runDir = path.join(root, record.id);
      const input = path.join(runDir, "input.mp4");
      const output = path.join(runDir, "artifacts", "shot_segments", "shot_001.mp4");
      await fsp.mkdir(path.dirname(output), { recursive: true });
      await Promise.all([fsp.writeFile(input, "input"), fsp.writeFile(output, "output")]);
      await fsp.writeFile(path.join(runDir, "artifacts", "run.json"), JSON.stringify({ runId: record.id, shotDetectionVersion: SHOT_DETECTION_VERSION, input, status: record.status, updatedAt: new Date(Date.now() - record.age).toISOString() }));
    }
    await cleanupStaleInputs(root);
    assert.equal(await exists(path.join(root, "run_completed", "input.mp4")), false);
    assert.equal(await exists(path.join(root, "run_recent_failed", "input.mp4")), true);
    assert.equal(await exists(path.join(root, "run_expired_failed", "input.mp4")), false);
    for (const record of records) assert.equal(await exists(path.join(root, record.id, "artifacts", "shot_segments", "shot_001.mp4")), true);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("cleans an expired orphan input regardless of its video extension", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "shot-orphan-"));
  try {
    const runDir = path.join(root, "run_orphan");
    const input = path.join(runDir, "input.mov");
    await fsp.mkdir(runDir, { recursive: true });
    await fsp.writeFile(input, "input");
    const old = new Date(Date.now() - FAILED_INPUT_RETENTION_MS - 1000);
    await fsp.utimes(runDir, old, old);
    await cleanupStaleInputs(root);
    assert.equal(await exists(input), false);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("startup retention leaves all old or unversioned task inputs and analysis copies intact", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "shot-history-retention-"));
  try {
    const sentinels = [];
    for (const kind of ["run", "batch"]) for (const status of ["completed", "failed"]) for (const version of ["2-primary-threshold", undefined]) {
      const id = `${kind}_${status}_${version ? "old" : "missing"}`;
      const runDir = kind === "run" ? path.join(root, id) : path.join(root, id, "items", "video_001");
      const artifacts = path.join(runDir, "artifacts");
      await fsp.mkdir(artifacts, { recursive: true });
      const input = path.join(runDir, "input.mp4");
      const stateFile = kind === "run" ? path.join(artifacts, "run.json") : path.join(runDir, "item.json");
      const record = JSON.stringify({ input, status, shotDetectionVersion: version, updatedAt: new Date(Date.now() - FAILED_INPUT_RETENTION_MS - 1000).toISOString() });
      for (const [file, value] of [[stateFile, record], [input, "original input"], [path.join(artifacts, "analysis_input_numbered.mp4"), "analysis input"]]) {
        await fsp.writeFile(file, value);
        sentinels.push([file, value]);
      }
    }
    await cleanupStaleInputs(root);
    for (const [file, value] of sentinels) assert.equal(await fsp.readFile(file, "utf8"), value);
  } finally { await fsp.rm(root, { recursive: true, force: true }); }
});
