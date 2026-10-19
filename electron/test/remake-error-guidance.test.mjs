import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const renderer = await readFile(new URL("../renderer/app.js", import.meta.url), "utf8");
const server = await readFile(new URL("../../Kling-H3路线B-Electron交付包-20260904/module/server.mjs", import.meta.url), "utf8");
function fn(source, name) {
  const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf("\n}", start) + 2);
}
const cleanRemoteError = error => String(error?.message || error || "");
const esc = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const api = Function("cleanRemoteError", "esc", ["friendlyImageError", "friendlyRemakeError", "friendlyOperationError", "friendlyVoiceCreateError", "imageRetryMarkup"].map(name => fn(renderer, name)).join("\n") + "\nreturn {friendlyImageError,friendlyRemakeError,friendlyOperationError,friendlyVoiceCreateError,imageRetryMarkup};")(cleanRemoteError, esc);
const imageFailureInfo = Function(fn(server, "imageFailureInfo") + "\nreturn imageFailureInfo;")();
const secret = "sk-private-marker https://private.invalid/image?token=secret C:\\private\\sample.wav";
function failure(task) { return imageFailureInfo({ stage: "image", status: "FAILED", imageTasks: [{ index: 0, status: "SUCCEEDED", error: "old timeout" }, { index: 1, status: "FAILED", ...task }, { index: 2, status: "QUEUED" }] }); }

test("image failures retain the actual current route's reason, not stale successful or primary errors", () => {
  const cases = [
    [{ httpStatus: 401 }, "auth"], [{ httpStatus: 402 }, "balance"], [{ httpStatus: 429 }, "busy"],
    [{ httpStatus: 503, error: "图片服务连接异常，请重试" }, "service"],
    [{ httpStatus: 503, providerError: { message: "No available compatible accounts" } }, "busy"],
    [{ httpStatus: 400, providerError: { message: "may be content policy, invalid parameters or unknown issue" } }, "rejected"],
    [{ httpStatus: 400, providerError: { message: "content_policy_violation" } }, "review"],
    [{ httpStatus: 400, error: "fetch failed", fallback: { status: "UNCERTAIN" } }, "network"],
    [{ httpStatus: 400, error: "quota exhausted", failureHttpStatus: 402, fallback: { status: "FAILED" } }, "balance"],
    [{ httpStatus: 400, providerError: { message: "content policy" }, error: "结果图片下载失败", fallback: { status: "SUCCEEDED" } }, "download"],
    [{ error: "returned image invalid", fallback: { status: "FAILED", lastResponse: { output: { code: "InvalidParameter", message: "invalid parameter" } } } }, "rejected"],
    [{ error: `ENOSPC ${secret}` }, "disk"], [{ error: `ENOENT ${secret}` }, "missing_input"],
    [{ error: `Command failed: ffmpeg Invalid data ${secret}` }, "invalid_result"],
    [{ error: `unknown ${secret}` }, "unknown"]
  ];
  for (const [task, reason] of cases) {
    const info = failure(task);
    assert.deepEqual(info, { index: 1, reason });
    const text = api.friendlyImageError("generic old error", info);
    assert.match(text, /请/);
    assert.doesNotMatch(text, /sk-private|private.invalid|C:\\private|No available compatible accounts|HTTP|ECONN|ffmpeg/);
    if (!["network", "tunnel", "download"].includes(reason)) assert.doesNotMatch(text, /网络/);
  }
  assert.equal(imageFailureInfo({ stage: "image", status: "SUCCEEDED", imageTasks: [{ status: "SUCCEEDED", error: "fetch failed" }] }), null);
  assert.equal(imageFailureInfo({ stage: "video", status: "FAILED", imageTasks: [{ status: "FAILED" }] }), null);
  assert.match(api.friendlyImageError("网络异常", { reason: "unknown" }), /不知道原因/);
});

test("keyframe retry markup shows the concrete reason and frame index, including after a second failure", () => {
  const item = { error: { technicalMessage: secret, imageFailure: { index: 1, reason: "busy" } }, imageCompleted: 1, imageTotal: 4 };
  const markup = api.imageRetryMarkup(item);
  assert.match(markup, /服务现在较忙/);
  assert.match(markup, /第 2 张未完成/);
  assert.match(markup, /已完成的图片不会重新生成/);
  assert.doesNotMatch(markup, /网络连接不稳定|sk-private|private.invalid/);
  item.error.imageFailure.reason = "balance";
  assert.match(api.imageRetryMarkup(item), /余额不足.*工作人员充值/);
  const progress = api.imageRetryMarkup(item, true);
  assert.match(progress, /已完成 1\/4 张/);
  assert.match(progress, /disabled/);
  assert.doesNotMatch(progress, /余额不足/);
});

test("operation failures never echo native errors and always give a usable next action", () => {
  for (const operation of ["preview", "revoice", "stop", "stop-images", "export", "library", "directory"]) {
    for (const raw of [`Error invoking remote method 'secret': ${secret}`, `fetch failed ${secret}`, `ENOENT ${secret}`, `ENOSPC ${secret}`, `EACCES ${secret}`]) {
      const message = api.friendlyOperationError(raw, operation);
      assert.match(message, /请/);
      assert.doesNotMatch(message, /sk-private|private.invalid|C:\\private|remote method|ENOENT|EACCES|ENOSPC/);
    }
  }
  assert.match(api.friendlyOperationError("ENOSPC", "export"), /清理空间.*导出/);
  assert.match(api.friendlyOperationError("EACCES", "export"), /选择桌面/);
  assert.match(api.friendlyOperationError("fetch failed", "revoice"), /更换声音并重新配音.*原视频已保留/);
  assert.match(api.friendlyOperationError("error", "stop"), /没能中止.*中止任务/);
  assert.match(api.friendlyOperationError("error", "stop-images"), /没能结束.*保留图片并结束/);
  assert.match(api.friendlyVoiceCreateError("试听音频下载失败"), /检查网络.*创建并生成试听/);
  assert.match(api.friendlyVoiceCreateError("HTTP 401"), /服务暂时用不了/);
});

test("image failure information reaches initial, retry and reopened task views", () => {
  assert.match(fn(server, "publicRun"), /imageFailure: imageFailureInfo\(run\)/);
  for (const name of ["pollKlingRun", "runRemake", "recoverRemake", "retryRemakeImages", "loadLatestInterruptedRemake"]) {
    assert.match(fn(renderer, name), /imageFailure/);
  }
  assert.doesNotMatch(renderer, /notify\(`(?:试听失败|重新配音失败|中止失败|导出失败|素材库读取失败|运行目录打开失败)：\$\{/);
  assert.doesNotMatch(renderer, /item\.revoiceError = error\.message/);
});

test("rendered image failures keep the cause after retry and only continue unfinished images", { skip: !process.env.RECOVERY_UI_URL }, async () => {
  const { chromium } = await import(process.env.RECOVERY_PLAYWRIGHT_MODULE);
  const browser = await chromium.connectOverCDP(process.env.RECOVERY_CDP_URL);
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  try {
    for (const [key, cause] of [["image-busy", "服务现在较忙"], ["image-balance", "余额不足"], ["image-rejected", "没有接受这次请求"], ["image-network", "连接中断或等待太久"]]) {
      await page.goto(process.env.RECOVERY_UI_URL + "?case=" + key);
      await page.getByRole("heading", { name: "关键帧生成未完成", exact: true }).waitFor({ state: "attached" });
      await page.screenshot();
      assert.match(await page.getByRole("alert").innerText(), new RegExp(cause));
      await page.getByRole("button", { name: "重试", exact: true }).click();
      await page.waitForFunction(() => window.fixtureImageRetries === 1);
      await page.getByRole("heading", { name: "关键帧生成未完成", exact: true }).waitFor({ state: "attached" });
      await page.screenshot();
      assert.match(await page.getByRole("alert").innerText(), new RegExp(cause));
      assert.match(await page.locator(".network-retry-preview").innerText(), /第 2 张未完成/);
      if (key === "image-busy") await page.screenshot({ path: "test-results/remake-image-error-guidance.png", fullPage: true });
      await page.getByRole("button", { name: "重试", exact: true }).click();
      await page.getByRole("heading", { name: "请逐张确认商品替换是否正确", exact: true }).waitFor({ state: "attached" });
      await page.screenshot();
      assert.equal(await page.evaluate(() => window.fixtureImageRetries), 2);
      assert.equal(await page.evaluate(() => window.fixtureVideoSubmissions), 0);
      assert.equal(await page.locator(".keyframe-review-grid article").count(), 4);
    }
    assert.deepEqual(errors, []);
  } finally { await context.close(); await browser.close(); }
});
