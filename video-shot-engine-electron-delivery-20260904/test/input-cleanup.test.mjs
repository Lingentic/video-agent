import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { cleanupRunInputs, cleanupStaleInputs, FAILED_INPUT_RETENTION_MS } from "../src/input-cleanup.mjs";

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
      await fsp.writeFile(path.join(runDir, "artifacts", "run.json"), JSON.stringify({ runId: record.id, input, status: record.status, updatedAt: new Date(Date.now() - record.age).toISOString() }));
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
