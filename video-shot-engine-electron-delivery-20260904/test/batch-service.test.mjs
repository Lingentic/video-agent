import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SHOT_DETECTION_VERSION } from "../src/shot-service.mjs";
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
      item: { shotDetectionVersion: SHOT_DETECTION_VERSION, videoId: "video_001", status: "queued", stage: "queued", sourceFilename: "video.mp4", input: path.join(batchDir, "input.mp4"), attempts: [] },
      gemini: { analyze: () => { throw new Error("provider must not run"); } },
      thresholds: {},
      onUpdate: async () => {},
      signal: controller.signal,
    });
    assert.equal(item.status, "cancelled");
    assert.equal(item.attempts[0].status, "cancelled");
  } finally { await fsp.rm(batchDir, { recursive: true, force: true }); }
});

test("old or unversioned unfinished items reject before filesystem, detector, subtitle or naming work", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "shot-version-guard-"));
  try {
    for (const version of ["2-primary-threshold", undefined]) {
      const runDir = path.join(root, version ? "old" : "missing");
      await fsp.mkdir(path.join(runDir, "artifacts", "shot_segments"), { recursive: true });
      await fsp.mkdir(path.join(runDir, "named_segments"));
      const item = { videoId: "video_001", status: "failed", stage: "naming_failed", shotDetectionVersion: version, removeSubtitles: true, autoName: true };
      const files = [
        ["item.json", JSON.stringify(item)], ["artifacts/shot_labels_normalized.json", "cached labels"],
        ["artifacts/shot_segments/shot_001.mp4", "old segment"], ["named_segments/old.mp4", "named result"],
        ["artifacts/analysis_input_numbered.mp4", "cached analysis"],
      ];
      for (const [file, value] of files) await fsp.writeFile(path.join(runDir, file), value);
      let calls = 0;
      const forbidden = async () => { calls += 1; throw new Error("must not run"); };
      await assert.rejects(processBatchItem({ runDir, item, gemini: {}, thresholds: {}, onUpdate: forbidden, subtitleService: forbidden, videoProcessor: forbidden, namingService: forbidden }), /版本不一致.*创建新任务/);
      assert.equal(calls, 0);
      for (const [file, value] of files) assert.equal(await fsp.readFile(path.join(runDir, file), "utf8"), value);
      assert.deepEqual((await fsp.readdir(path.join(runDir, "artifacts"))).sort(), ["analysis_input_numbered.mp4", "shot_labels_normalized.json", "shot_segments"]);
      await assert.rejects(processBatchItem({ runDir, item: { ...item, status: "completed" } }), /版本不一致.*创建新任务/);
    }
  } finally { await fsp.rm(root, { recursive: true, force: true }); }
});
