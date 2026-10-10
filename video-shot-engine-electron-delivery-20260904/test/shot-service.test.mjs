import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { processVideo, SHOT_DETECTION_VERSION, parseSceneCuts, planShots } from "../src/shot-service.mjs";
import { classifyToolSource } from "../src/runtime-paths.mjs";

test("parses FFmpeg scene scores", () => {
  assert.deepEqual(parseSceneCuts("lavfi.scd.score: 24.500, lavfi.scd.time: 6.433333"), [{ timeSec: 6.433333, score: 24.5 }]);
});

test("keeps threshold-qualified events and filters only short fragments", () => {
  const shots = planShots([
    { timeSec: 0.1, score: 31 },
    { timeSec: 3, score: 25 },
    { timeSec: 3.2, score: 30 },
    { timeSec: 7, score: 28 },
  ], 10, { minDurationSec: 0.4 });
  assert.deepEqual(shots.map((shot) => [shot.startSec, shot.endSec]), [[0, 3], [3, 7], [7, 10]]);
});

test("classifies FFmpeg from the client directory separately from system PATH", () => {
  assert.equal(classifyToolSource("C:\\App\\resources\\bin\\ffmpeg.exe", { requestedPath: "C:\\App\\resources\\bin\\ffmpeg.exe", clientResourcesDir: "C:\\App\\resources" }), "client_directory");
  assert.equal(classifyToolSource("C:\\Tools\\ffmpeg\\bin\\ffmpeg.exe", { requestedPath: "ffmpeg", clientResourcesDir: "C:\\App\\resources" }), "system_path");
  assert.equal(classifyToolSource("D:\\MediaTools\\ffmpeg.exe", { requestedPath: "D:\\MediaTools\\ffmpeg.exe", clientResourcesDir: "C:\\App\\resources" }), "configured_path");
});

async function detectWithMock(cuts, options = {}) {
  const runDir = await fsp.mkdtemp(path.join(os.tmpdir(), "shot-detection-"));
  const commands = [];
  try {
    const result = await processVideo({ runDir, inputPath: "mock.mp4", threshold: 12, minDurationSec: 0.2, ...options }, {
      inspectTools: async () => ({ ffmpeg: { available: true }, ffprobe: { available: true } }),
      runCommand: async (_file, args) => {
        commands.push(args);
        if (args.includes("-show_entries")) return { stdout: JSON.stringify({ format: { duration: 4 }, streams: [{ r_frame_rate: "30/1" }] }) };
        if (args.includes("-vf")) {
          const threshold = Number(args[args.indexOf("-vf") + 1].split("=").at(-1));
          // Model scdet's threshold-qualified event output, not a second application-side filter.
          return { stderr: cuts.filter((cut) => cut.score >= threshold).map((cut) => `lavfi.scd.score: ${cut.score}, lavfi.scd.time: ${cut.timeSec}`).join("\n") };
        }
        return { stdout: "", stderr: "" };
      },
    });
    const diagnostic = JSON.parse(await fsp.readFile(path.join(runDir, "scene_cuts.json"), "utf8"));
    return { result, diagnostic, commands };
  } finally { await fsp.rm(runDir, { recursive: true, force: true }); }
}

test("threshold 12 drops score 8 during scanning without suppressing next-frame score 20", async () => {
  const { result, diagnostic, commands } = await detectWithMock([{ timeSec: 1, score: 8 }, { timeSec: 31 / 30, score: 20 }]);
  assert.deepEqual(diagnostic.rawCuts, [{ timeSec: 31 / 30, score: 20 }]);
  assert.equal(result.shots[1].startFrame, 31);
  assert.equal(result.shotDetectionVersion, SHOT_DETECTION_VERSION);
  assert.equal(diagnostic.candidateThreshold, 12);
  assert.equal(diagnostic.clusterWindowFrames, 0);
  assert.ok(commands.some((args) => args.includes("scdet=threshold=12")));
  for (const args of commands.filter((args) => args.includes("-frames:v"))) {
    assert.ok(args.includes("libx264"));
    assert.ok(Number.isInteger(Number(args[args.indexOf("-frames:v") + 1])));
  }
});

test("qualified adjacent events are both recorded and only minimum duration removes a cut", async () => {
  const cuts = [{ timeSec: 1, score: 13 }, { timeSec: 31 / 30, score: 20 }];
  const { result, diagnostic } = await detectWithMock(cuts);
  assert.deepEqual(diagnostic.rawCuts, cuts);
  assert.deepEqual(diagnostic.candidateCuts, cuts);
  assert.deepEqual(result.shots.map((shot) => shot.startFrame), [0, 30]);
  const unrestricted = await detectWithMock(cuts, { minDurationSec: 0 });
  assert.deepEqual(unrestricted.result.shots.map((shot) => shot.startFrame), [0, 30, 31]);
});

test("spaced qualified events survive in chronological order", async () => {
  const { result } = await detectWithMock([{ timeSec: 2, score: 20 }, { timeSec: 1, score: 13 }, { timeSec: 3, score: 12 }]);
  assert.deepEqual(result.shots.map((shot) => [shot.startFrame, shot.endFrame]), [[0, 30], [30, 60], [60, 90], [90, 120]]);
});

test("changing task threshold changes the single scan threshold and diagnostic value together", async () => {
  for (const threshold of [7, 18, 25]) {
    const { result, diagnostic, commands } = await detectWithMock([{ timeSec: 1, score: 8 }, { timeSec: 2, score: 20 }], { threshold });
    assert.equal(diagnostic.threshold, threshold);
    assert.equal(diagnostic.candidateThreshold, threshold);
    assert.ok(commands.some((args) => args.includes(`scdet=threshold=${threshold}`)));
    assert.deepEqual(result.cuts.map((cut) => cut.score), [8, 20].filter((score) => score >= threshold));
  }
});
