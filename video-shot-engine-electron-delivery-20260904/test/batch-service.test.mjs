import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { processBatchItem, sumUsage } from "../src/batch-service.mjs";

test("sums completed batch usage without inventing missing tokens", () => {
  const usage = sumUsage([
    { usage: { total_tokens: 100, total_input_tokens: 70, total_output_tokens: 30, total_thought_tokens: 0 } },
    { status: "failed" },
    { usage: { total_tokens: 50, total_input_tokens: 40, total_output_tokens: 10, total_thought_tokens: 0 } },
  ]);
  assert.deepEqual(usage, { total_tokens: 150, total_input_tokens: 110, total_output_tokens: 40, total_thought_tokens: 0, estimated_cost_yuan: 0.000465 });
});

test("a cancelled batch item stops before starting FFmpeg or the provider", async () => {
  const batchDir = await fsp.mkdtemp(path.join(os.tmpdir(), "shot-cancel-item-"));
  const controller = new AbortController();
  controller.abort(new Error("用户取消任务"));
  try {
    const item = await processBatchItem({
      batchDir,
      item: { videoId: "video_001", status: "queued", stage: "queued", sourceFilename: "video.mp4", input: path.join(batchDir, "input.mp4"), attempts: [] },
      gemini: { analyze: () => { throw new Error("provider must not run"); } },
      thresholds: {},
      onUpdate: async () => {},
      signal: controller.signal,
    });
    assert.equal(item.status, "cancelled");
    assert.equal(item.attempts[0].status, "cancelled");
  } finally { await fsp.rm(batchDir, { recursive: true, force: true }); }
});
