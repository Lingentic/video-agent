import test from "node:test";
import assert from "node:assert/strict";
import { createNamedFilename, sanitizeFilenamePart } from "../src/filename-service.mjs";
import { validateAndNormalizeLabels } from "../src/naming-service.mjs";

const shots = [
  { shotId: "shot_001", startSec: 0, endSec: 1 },
  { shotId: "shot_002", startSec: 1, endSec: 2 },
];
const profile = { manifest: [
  { shot_id: "shot_001", end_candidates: [{ candidate_id: "cut_001_a", time_sec: 0.98 }, { candidate_id: "cut_001_b", time_sec: 1 }] },
  { shot_id: "shot_002", end_candidates: [{ candidate_id: "boundary_end", time_sec: 2 }] },
] };

const label = (shotId, endCandidateId) => ({ shot_id: shotId, end_candidate_id: endCandidateId, content_title: "主播展示水杯杯盖", usage_type: "功能讲解" });

test("keeps the fixed FFmpeg boundaries regardless of Gemini candidate output", () => {
  const labels = validateAndNormalizeLabels({ shots: [label("shot_002", "boundary_end"), label("shot_001", "cut_001_a")] }, shots, 2, profile);
  assert.deepEqual(labels.map((item) => item.shotId), ["shot_001", "shot_002"]);
  assert.deepEqual(labels.map((item) => [item.startSec, item.endSec]), [[0, 1], [1, 2]]);
});

test("ignores legacy provider boundary fields", () => {
  const raw = { shots: [label("shot_001", "cut_001_a=0.98"), label("shot_002", "boundary_end=2")] };
  const labels = validateAndNormalizeLabels(raw, shots, 2, profile);
  assert.deepEqual(labels.map((item) => [item.startSec, item.endSec]), [[0, 1], [1, 2]]);
});

test("allows a frame-rounded final boundary within two seconds of the source duration", () => {
  const roundedShots = [{ shotId: "shot_001", startSec: 0, endSec: 92.5 }];
  const labels = validateAndNormalizeLabels({ shots: [label("shot_001", "boundary_end")] }, roundedShots, 92.485011, profile);
  assert.equal(labels[0].endSec, 92.5);
});

test("accepts upper-case shot ids from the provider", () => {
  const raw = { shots: [{ ...label("shot_001", "cut_001_a"), shot_id: "SHOT_001" }, { ...label("shot_002", "boundary_end"), shot_id: "SHOT_002" }] };
  assert.deepEqual(validateAndNormalizeLabels(raw, shots, 2, profile).map((item) => item.shotId), ["shot_001", "shot_002"]);
});

test("accepts an unpadded numeric shot id", () => {
  const raw = { shots: [label("shot_1", "cut_001_a"), label("shot_2", "boundary_end")] };
  assert.deepEqual(validateAndNormalizeLabels(raw, shots, 2, profile).map((item) => item.shotId), ["shot_001", "shot_002"]);
});

test("accepts a top-level array as the equivalent shots envelope", () => {
  const raw = [label("shot_001", "cut_001_a"), label("shot_002", "boundary_end")];
  assert.deepEqual(validateAndNormalizeLabels(raw, shots, 2, profile).map((item) => item.shotId), ["shot_001", "shot_002"]);
});

test("rejects missing and duplicate shots but ignores unknown legacy candidate IDs", () => {
  assert.throws(() => validateAndNormalizeLabels({ shots: [label("shot_001", "cut_001_a")] }, shots, 2, profile), /遗漏镜头/);
  assert.throws(() => validateAndNormalizeLabels({ shots: [label("shot_001", "cut_001_a"), label("shot_001", "cut_001_a")] }, shots, 2, profile), /重复返回镜头/);
  assert.deepEqual(validateAndNormalizeLabels({ shots: [label("shot_001", "wrong"), label("shot_002", "wrong")] }, shots, 2, profile).map((item) => item.endSec), [1, 2]);
});

test("rejects empty titles and usage types outside the contract", () => {
  const emptyTitle = { shots: [{ ...label("shot_001", "cut_001_a"), content_title: "" }, label("shot_002", "boundary_end")] };
  assert.throws(() => validateAndNormalizeLabels(emptyTitle, shots, 2, profile), /空内容标题/);
  const profileWithUsageEnum = { ...profile, schema: { properties: { shots: { items: { properties: { usage_type: { enum: ["功能讲解"] } } } } } } };
  const badUsage = { shots: [label("shot_001", "cut_001_a"), { ...label("shot_002", "boundary_end"), usage_type: "随便写" }] };
  assert.throws(() => validateAndNormalizeLabels(badUsage, shots, 2, profileWithUsageEnum), /非法用途标签/);
});

test("creates a Windows-safe title and usage filename", () => {
  const filename = createNamedFilename({ contentTitle: "杯盖:双饮口/展示", usageType: "功能讲解" }, 0, ".mp4");
  assert.equal(filename, "001_杯盖 双饮口 展示_功能讲解.mp4");
  assert.equal(sanitizeFilenamePart("CON"), "CON_素材");
});
