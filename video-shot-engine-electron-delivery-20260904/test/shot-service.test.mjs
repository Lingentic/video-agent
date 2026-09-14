import test from "node:test";
import assert from "node:assert/strict";
import { clusterSceneCuts, parseSceneCuts, planShots } from "../src/shot-service.mjs";
import { classifyToolSource } from "../src/runtime-paths.mjs";

test("parses FFmpeg scene scores", () => {
  assert.deepEqual(parseSceneCuts("lavfi.scd.score: 24.500, lavfi.scd.time: 6.433333"), [{ timeSec: 6.433333, score: 24.5 }]);
});

test("keeps significant cuts and filters short fragments", () => {
  const shots = planShots([
    { timeSec: 0.1, score: 31 },
    { timeSec: 2, score: 19 },
    { timeSec: 3, score: 25 },
    { timeSec: 3.2, score: 30 },
    { timeSec: 7, score: 28 },
  ], 10, { threshold: 20, minDurationSec: 0.4 });
  assert.deepEqual(shots.map((shot) => [shot.startSec, shot.endSec]), [[0, 3], [3, 7], [7, 10]]);
});

test("clusters duplicate events within the window and keeps the earliest frame", () => {
  const cuts = clusterSceneCuts([
    { timeSec: 1, score: 12 }, { timeSec: 1.03, score: 31 }, { timeSec: 1.06, score: 20 },
    { timeSec: 1.14, score: 25 },
  ], 30, { clusterWindowFrames: 2 });
  assert.deepEqual(cuts, [{ timeSec: 1, score: 12 }, { timeSec: 1.14, score: 25 }]);
});

test("classifies FFmpeg from the client directory separately from system PATH", () => {
  assert.equal(classifyToolSource("C:\\App\\resources\\bin\\ffmpeg.exe", { requestedPath: "C:\\App\\resources\\bin\\ffmpeg.exe", clientResourcesDir: "C:\\App\\resources" }), "client_directory");
  assert.equal(classifyToolSource("C:\\Tools\\ffmpeg\\bin\\ffmpeg.exe", { requestedPath: "ffmpeg", clientResourcesDir: "C:\\App\\resources" }), "system_path");
  assert.equal(classifyToolSource("D:\\MediaTools\\ffmpeg.exe", { requestedPath: "D:\\MediaTools\\ffmpeg.exe", clientResourcesDir: "C:\\App\\resources" }), "configured_path");
});
