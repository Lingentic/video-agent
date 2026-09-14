import { config } from "dotenv";
import { execFile } from "node:child_process";
import { rmSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

config();
if (!process.env.XINHANKR_API_KEY) config({ path: "../video-shot-segmentation-ffmpeg/.env", override: false, quiet: true });

const execFileAsync = promisify(execFile);
const apiKey = process.env.XINHANKR_API_KEY;
const baseUrl = (process.env.XINHANKR_BASE_URL || "https://token.xinhankr.com").replace(/\/$/, "");
const model = process.env.XINHANKR_MODEL || "gemini-3.6-flash";
const videoUrl = process.env.XINHANKR_TEST_VIDEO_URL || "https://storage.googleapis.com/cloud-samples-data/generative-ai/video/pixel8.mp4";
const usageTypes = ["商品展示", "功能讲解", "使用演示", "效果展示", "人物口播", "开场钩子", "问题引入", "场景过渡", "结尾收束", "其他"];

if (!apiKey) throw new Error("缺少 XINHANKR_API_KEY");

const startedAt = Date.now();
const tempDir = await mkdtemp(path.join(os.tmpdir(), "xinhankr-shot-proof-"));
process.on("exit", () => { try { rmSync(tempDir, { recursive: true, force: true }); } catch {} });
const localVideo = path.join(tempDir, "pixel8.mp4");
const videoResponse = await fetch(videoUrl, { signal: AbortSignal.timeout(180_000) });
if (!videoResponse.ok) throw new Error(`测试视频下载失败：HTTP ${videoResponse.status}`);
await writeFile(localVideo, new Uint8Array(await videoResponse.arrayBuffer()));
const { stdout: probeOutput } = await execFileAsync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "json", localVideo], { maxBuffer: 1024 * 1024 });
const durationSec = Number(JSON.parse(probeOutput).format.duration);
const ffmpegStartedAt = Date.now();
const { stderr } = await execFileAsync("ffmpeg", ["-hide_banner", "-nostats", "-i", localVideo, "-vf", "scdet=threshold=5", "-an", "-f", "null", "-"], { maxBuffer: 32 * 1024 * 1024 });
const detected = [];
const pattern = /lavfi\.scd\.score:\s*([\d.]+),\s*lavfi\.scd\.time:\s*([\d.]+)/g;
for (const match of stderr.matchAll(pattern)) detected.push({ score: Number(match[1]), timeSec: Number(match[2]) });

const clustered = [];
for (const cut of detected.sort((a, b) => a.timeSec - b.timeSec)) {
  const last = clustered.at(-1);
  if (last && cut.timeSec - last.timeSec <= 0.3) {
    if (cut.score > last.score) clustered[clustered.length - 1] = cut;
  } else {
    clustered.push(cut);
  }
}
const boundaries = [
  { candidate_id: "boundary_start", time_sec: 0 },
  ...clustered.map((cut, index) => ({ candidate_id: `cut_${String(index + 1).padStart(4, "0")}`, time_sec: cut.timeSec, score: cut.score })),
  { candidate_id: "boundary_end", time_sec: durationSec },
];
const ffmpegDurationMs = Date.now() - ffmpegStartedAt;

const prompt = `你是专业的视频物理镜头切分复核助手。请完整观看原视频，从 FFmpeg 低阈值候选边界中保留真实镜头切换并排除闪光、快速运动、遮挡等误报。

候选边界：
${JSON.stringify(boundaries, null, 2)}

要求：
1. 只能使用候选 ID，不能创造时间点。
2. 输出 shots 按时间连续覆盖全片；第一个从 boundary_start 开始，最后一个到 boundary_end 结束；相邻镜头共享同一边界 ID。
3. shot_id 按 shot_001、shot_002 顺序编号。
4. content_title 用 6 到 24 个汉字描述镜头实际主体和动作。
5. usage_type 只能选：${usageTypes.join("、")}。
6. 只按物理镜头变化切分，不按话题、台词或语义分段。
7. 只返回 JSON：{"shots":[{"shot_id":"shot_001","start_candidate_id":"boundary_start","end_candidate_id":"cut_0001","content_title":"...","usage_type":"商品展示"}]}`;

const requestStartedAt = Date.now();
const videoBase64 = (await readFile(localVideo)).toString("base64");
const response = await fetch(`${baseUrl}/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
  method: "POST",
  headers: { "X-Goog-Api-Key": apiKey, "Content-Type": "application/json" },
  body: JSON.stringify({
    contents: [{ role: "user", parts: [{ inlineData: { mimeType: "video/mp4", data: videoBase64 } }, { text: prompt }] }],
    generationConfig: { temperature: 0, maxOutputTokens: 5000, responseMimeType: "application/json", thinkingConfig: { thinkingBudget: 0 } },
  }),
  signal: AbortSignal.timeout(300_000),
});
const responseBody = await response.json();
const requestDurationMs = Date.now() - requestStartedAt;
const content = responseBody?.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("") || "";
const normalized = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
let parsed = null;
let validationError = null;
try { parsed = JSON.parse(normalized); } catch (error) { validationError = `JSON 解析失败：${error.message}`; }

if (parsed && !Array.isArray(parsed.shots)) validationError = "响应缺少 shots 数组";
const byId = new Map(boundaries.map((item) => [item.candidate_id, item]));
if (parsed?.shots) {
  for (let index = 0; index < parsed.shots.length; index += 1) {
    const shot = parsed.shots[index];
    if (shot.shot_id !== `shot_${String(index + 1).padStart(3, "0")}`) validationError ||= `shot_id 顺序错误：${shot.shot_id}`;
    if (!byId.has(shot.start_candidate_id) || !byId.has(shot.end_candidate_id)) validationError ||= `未知候选 ID：${shot.shot_id}`;
    if (!usageTypes.includes(shot.usage_type)) validationError ||= `未知用途标签：${shot.usage_type}`;
    if (index && shot.start_candidate_id !== parsed.shots[index - 1].end_candidate_id) validationError ||= `相邻镜头不连续：${shot.shot_id}`;
  }
  if (parsed.shots[0]?.start_candidate_id !== "boundary_start") validationError ||= "首镜头没有从视频开始";
  if (parsed.shots.at(-1)?.end_candidate_id !== "boundary_end") validationError ||= "末镜头没有覆盖视频结尾";
}

const finalShots = (parsed?.shots || []).map((shot) => ({ ...shot, start_sec: byId.get(shot.start_candidate_id)?.time_sec, end_sec: byId.get(shot.end_candidate_id)?.time_sec }));
const report = {
  provider: "xinhankr",
  model,
  videoUrl,
  httpStatus: response.status,
  ok: response.ok && !validationError,
  validationError,
  durationSec,
  detectedCandidateCount: detected.length,
  clusteredCandidateCount: clustered.length,
  finalShotCount: finalShots.length,
  usage: responseBody?.usageMetadata || null,
  timings: { ffmpegDurationMs, requestDurationMs, totalDurationMs: Date.now() - startedAt },
  candidates: boundaries,
  rawResponse: responseBody,
  finalShots,
};
const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
const outputDir = path.resolve("provider-tests", "xinhankr-shot-proof", timestamp);
await mkdir(outputDir, { recursive: true });
const reportPath = path.join(outputDir, "report.json");
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
const reportRoot = path.dirname(outputDir);
const oldReports = (await readdir(reportRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort().slice(0, -5);
for (const name of oldReports) await rm(path.join(reportRoot, name), { recursive: true, force: true });

console.log(`HTTP ${response.status}; 候选 ${clustered.length}; 最终镜头 ${finalShots.length}`);
console.log(`Token ${report.usage?.totalTokenCount ?? "未返回"}; 推理 Token ${report.usage?.thoughtsTokenCount ?? 0}; FFmpeg ${ffmpegDurationMs} ms; API ${requestDurationMs} ms`);
console.log(`验收：${report.ok ? "通过" : `失败 - ${validationError || responseBody?.error?.message || "未知错误"}`}`);
console.log(`报告：${reportPath}`);
if (!report.ok) process.exitCode = 1;
