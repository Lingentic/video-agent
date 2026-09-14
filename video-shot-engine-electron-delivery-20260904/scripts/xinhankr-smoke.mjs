import "dotenv/config";

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const baseUrl = (process.env.XINHANKR_BASE_URL || "https://token.xinhankr.com").replace(/\/$/, "");
const apiKey = process.env.XINHANKR_API_KEY;
const model = process.env.XINHANKR_MODEL || "gemini-3.6-flash";
const videoUrl = process.env.XINHANKR_TEST_VIDEO_URL
  || "https://storage.googleapis.com/cloud-samples-data/generative-ai/video/pixel8.mp4";

if (!apiKey) {
  console.error("缺少 XINHANKR_API_KEY。请把它写入项目 .env 后重试；不要把 Key 发到聊天或日志中。");
  process.exit(2);
}

const startedAt = new Date();
const report = {
  provider: "xinhankr",
  baseUrl,
  model,
  videoUrl,
  startedAt: startedAt.toISOString(),
  tests: [],
};

async function request(name, url, init = {}) {
  const requestStartedAt = performance.now();
  let response;
  let body;

  try {
    response = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...init.headers,
      },
      signal: AbortSignal.timeout(180_000),
    });
    const text = await response.text();
    try {
      body = JSON.parse(text);
    } catch {
      body = { rawText: text.slice(0, 20_000) };
    }
  } catch (error) {
    const result = {
      name,
      ok: false,
      durationMs: Math.round(performance.now() - requestStartedAt),
      transportError: error instanceof Error ? error.message : String(error),
    };
    report.tests.push(result);
    console.log(`${name}: 网络失败 (${result.durationMs} ms)`);
    return result;
  }

  const result = {
    name,
    ok: response.ok,
    status: response.status,
    durationMs: Math.round(performance.now() - requestStartedAt),
    usage: body?.usage || body?.usageMetadata || null,
    body,
  };
  report.tests.push(result);
  console.log(`${name}: HTTP ${response.status} (${result.durationMs} ms)`);
  if (result.usage) console.log(`${name} Token: ${JSON.stringify(result.usage)}`);
  return result;
}

const models = await request("models", `${baseUrl}/v1/models`, { method: "GET" });
if (models.ok) {
  const ids = Array.isArray(models.body?.data) ? models.body.data.map((item) => item?.id) : [];
  models.modelListed = ids.includes(model);
  models.validation = { passed: models.modelListed, reason: models.modelListed ? null : "模型列表中没有目标模型" };
  console.log(`模型列表包含 ${model}: ${models.modelListed ? "是" : "否"}`);
}

const textTest = await request("text", `${baseUrl}/v1/chat/completions`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    model,
    messages: [{ role: "user", content: "只回复：连通成功" }],
    temperature: 0,
    max_tokens: 100,
    stream: false,
  }),
});
const textContent = textTest.body?.choices?.[0]?.message?.content?.trim() || "";
textTest.validation = {
  passed: textContent.includes("连通成功"),
  reason: textContent.includes("连通成功")
    ? null
    : `正文不完整：${JSON.stringify(textContent)}，finish_reason=${textTest.body?.choices?.[0]?.finish_reason || "unknown"}`,
};

const videoTest = await request("video_structured", `${baseUrl}/v1/chat/completions`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    model,
    messages: [{
      role: "user",
      content: [
        {
          type: "text",
          text: [
            "分析这段视频，并只返回 JSON 对象。",
            "字段必须包含：summary（中文内容概括）、product（主要商品或主体）、",
            "visible_text（画面中可辨识文字数组）、audio_summary（声音或语音概括）、",
            "editing_uses（适合用于什么剪辑场景的数组）、confidence（0到1）。",
          ].join(""),
        },
        { type: "video_url", video_url: { url: videoUrl } },
      ],
    }],
    response_format: { type: "json_object" },
    temperature: 0,
    max_tokens: 800,
    stream: false,
  }),
});
const videoContent = videoTest.body?.choices?.[0]?.message?.content?.trim() || "";
const unfencedVideoContent = videoContent.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
let parsedVideo = null;
try {
  parsedVideo = JSON.parse(unfencedVideoContent);
} catch {
  // Validation below records the parse failure without hiding the provider response.
}
const requiredVideoFields = ["summary", "product", "visible_text", "audio_summary", "editing_uses", "confidence"];
videoTest.validation = {
  passed: Boolean(parsedVideo) && requiredVideoFields.every((field) => Object.hasOwn(parsedVideo, field)),
  directJson: videoContent.startsWith("{"),
  markdownFenceRemoved: videoContent.startsWith("```"),
  reason: parsedVideo ? null : "视频响应无法解析为 JSON（即使移除 Markdown 代码围栏后）",
};

report.finishedAt = new Date().toISOString();
report.durationMs = new Date(report.finishedAt).getTime() - startedAt.getTime();
report.summary = {
  total: report.tests.length,
  httpPassed: report.tests.filter((item) => item.ok).length,
  validated: report.tests.filter((item) => item.ok && item.validation?.passed).length,
  failed: report.tests.filter((item) => !item.ok || !item.validation?.passed).length,
};

const timestamp = report.finishedAt.replace(/[-:.TZ]/g, "").slice(0, 14);
const outputDir = path.resolve("provider-tests", "xinhankr", timestamp);
await mkdir(outputDir, { recursive: true });
const reportPath = path.join(outputDir, "report.json");
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

console.log(`测试完成：HTTP ${report.summary.httpPassed}/${report.summary.total}，验收 ${report.summary.validated}/${report.summary.total}`);
console.log(`报告：${reportPath}`);
if (report.summary.failed > 0) process.exitCode = 1;
