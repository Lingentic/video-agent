import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../renderer/app.js", import.meta.url), "utf8");
const preload = await readFile(new URL("../preload.cjs", import.meta.url), "utf8");
function fn(name) {
  const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf("\n}", start) + 2);
}
function harness(item, client = {}) {
  let renders = 0;
  const messages = [];
  const state = { remake: item };
  const cleanRemoteError = error => String(error?.message || error || "");
  const render = () => { renders += 1; };
  const names = ["remakeRecovery", "canRepairRemake", "remakeKeyframeProblems", "applyRemakeRecovery", "reviewRemakeKeyframes", "completeRemakeVoiceRecovery", "replaceRemakeKeyframe", "prepareRemakeRecovery", "validateVoiceSourceFile", "friendlyImageError", "friendlyRemakeError"];
  const api = Function("state", "videoClient", "render", "notify", "assertCurrentRemake", "isCurrentRemake", "cleanRemoteError", `${names.map(fn).join("\n")}\nreturn {${names.join(",")}}`)(state, client, render, text => messages.push(text), () => {}, current => state.remake === current, cleanRemoteError);
  return { ...api, renders: () => renders, messages };
}
function item() {
  return { runId: "preserved-run", running: false, stopping: false, videoTaskSubmitted: false, videoSubmissionStatus: "rejected", serviceBaseUrl: "http://localhost/", editedKeyframes: [{ url: "/frame0.png" }, null, { url: "/frame2.png" }], keyframeTimes: [0, 2, 4], voices: [{ id: "new-voice", name: "新声音" }], selectedVoiceId: "new-voice", useSavedVoice: true, error: {} };
}

test("structured recovery wins over prose and retains sparse indexes on restore", () => {
  const current = item();
  const api = harness(current);
  const recovery = api.applyRemakeRecovery(current, { editedKeyframes: current.editedKeyframes, keyframeTimes: [0, 2, 4], recovery: { kind: "keyframes", reason: "invalid", indexes: [1] } }, "audio duration error");
  assert.equal(recovery.kind, "keyframes");
  api.reviewRemakeKeyframes(current);
  assert.equal(current.runId, "preserved-run");
  assert.equal(current.editedKeyframes[1], null);
  assert.deepEqual(current.selectedRetryIndexes, [1]);
  assert.deepEqual(api.remakeKeyframeProblems(current), [1]);
});

test("unspecified remote frame index marks all candidates and original product errors stay in materials", () => {
  const current = item();
  const api = harness(current);
  api.applyRemakeRecovery(current, { recovery: { kind: "keyframes", reason: "invalid", indexes: [] } }, "image error");
  assert.deepEqual(current.keyframeProblems, [0, 1, 2]);
  assert.equal(api.remakeRecovery("第 2 张商品参考图无法打开，请重新选择 JPG"), null);
  assert.equal(api.remakeRecovery("invalid image format; audio metadata: sample_rate=44100").kind, "keyframes");
});

test("voice recovery returns to explicit frame confirmation without starting video", () => {
  const current = item();
  current.editedKeyframes[1] = { url: "/frame1.png" };
  current.voiceRecoveryPending = true;
  const api = harness(current, { startKlingVideo() { assert.fail("must wait for confirmation"); } });
  assert.equal(api.completeRemakeVoiceRecovery(current), true);
  assert.equal(current.runId, "preserved-run");
  assert.equal(current.editedKeyframes.length, 3);
  assert.equal(current.selectedVoiceId, "new-voice");
  assert.equal(current.useSavedVoice, false);
  assert.equal(current.voicePanel, null);
  assert.equal(current.imageReady, true);
});

test("audio size limit is decimal and format validation happens before inspection/create", () => {
  const api = harness(item());
  assert.equal(api.validateVoiceSourceFile({ name: "voice.wav", size: 20_000_000 }), "");
  assert.match(api.validateVoiceSourceFile({ name: "voice.wav", size: 20_000_001 }), /20 MB.*20,000,000/);
  assert.match(api.validateVoiceSourceFile({ name: "voice.ogg", size: 123 }), /MP3.*WAV.*M4A/);
  for (const reason of ["missing", "duration", "format", "size"]) {
    const message = api.friendlyRemakeError("opaque", "video", { kind: "voice", reason });
    assert.match(message, /重新上传|选择其他音色/);
    assert.doesNotMatch(message, /工作人员|日志/);
  }
});

test("upload replaces only the selected frame and validates size before IPC", async () => {
  const current = item();
  current.keyframeProblems = [1];
  current.selectedRetryIndexes = [1];
  const untouched = current.editedKeyframes[0];
  let calls = 0;
  const api = harness(current, { async replaceKlingKeyframe(runId, index, file) {
    calls += 1;
    assert.equal(runId, "preserved-run"); assert.equal(index, 1); assert.equal(file.name, "replacement.png");
    return { editedKeyframes: [untouched, { url: "/replacement.png" }, current.editedKeyframes[2]] };
  } });
  await api.replaceRemakeKeyframe(1, { name: "replacement.png", size: 10_000_000 });
  assert.equal(calls, 0);
  assert.match(api.messages.at(-1), /10,000,000/);
  await api.replaceRemakeKeyframe(1, { name: "replacement.png", size: 9_999_999 });
  assert.equal(calls, 1);
  assert.equal(current.editedKeyframes[0], untouched);
  assert.deepEqual(api.remakeKeyframeProblems(current), []);
  assert.equal(current.runId, "preserved-run");
});

test("submitted or uncertain tasks cannot enter material repair", () => {
  for (const status of ["submitting", "uncertain", "accepted"]) {
    const current = item(); current.videoSubmissionStatus = status;
    assert.equal(harness(current).canRepairRemake(current), false);
  }
  const current = item(); current.videoTaskSubmitted = true;
  const api = harness(current);
  api.reviewRemakeKeyframes(current);
  assert.equal(current.imageReady, undefined);
  assert.equal(api.renders(), 0);
  assert.match(preload, /replaceKlingKeyframe:.*kling-replace-keyframe.*webUtils\.getPathForFile\(file\)/);
});

test("confirmed failed task prepares a separate editable run and never submits video", async () => {
  const current = item();
  current.videoTaskSubmitted = true;
  current.videoConfirmedFailed = true;
  current.videoSubmissionStatus = "accepted";
  current.error = { recovery: { kind: "voice", reason: "missing" } };
  const existingFrames = current.editedKeyframes;
  const api = harness(current, { async prepareKlingRecovery(runId) {
    assert.equal(runId, "preserved-run");
    return { id: "recovery-copy", videoTaskId: null, videoStatus: null, videoSubmission: null, editedKeyframes: existingFrames, keyframeTimes: [0, 2, 4], recovery: { kind: "voice", reason: "missing" } };
  }, startKlingVideo() { assert.fail("copy must not submit video"); } });
  await api.prepareRemakeRecovery();
  assert.equal(current.runId, "recovery-copy");
  assert.equal(current.editedKeyframes, existingFrames);
  assert.equal(current.videoTaskSubmitted, false);
  assert.equal(current.error.recovery.kind, "voice");
  assert.equal(api.canRepairRemake(current), true);
  assert.equal(current.error.videoRetryAvailable, true);
  const limited = api.friendlyRemakeError("opaque", "video", { kind: "voice", reason: "size", maxBytes: 5_000_000 });
  assert.match(limited, /5 MB.*5,000,000/);
});

test("all video failure catches and reload carry structured recovery", () => {
  for (const name of ["runRemake", "recoverRemake", "confirmRemakeImage", "retrySavedRemakeVideo", "loadLatestInterruptedRemake"]) {
    assert.match(fn(name), /applyRemakeRecovery\(item,/);
  }
  assert.match(fn("confirmRemakeImage"), /remakeKeyframeProblems\(item\)\.length/);
});

test("rendered recovery interactions preserve task and wait for confirmation", { skip: !process.env.RECOVERY_UI_URL }, async () => {
  const { chromium } = await import(process.env.RECOVERY_PLAYWRIGHT_MODULE);
  const browser = await chromium.connectOverCDP(process.env.RECOVERY_CDP_URL || "http://127.0.0.1:9347");
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  async function open(kind, reason, indexes = [], submitted = false) {
    await context.clearCookies();
    await page.addInitScript(({ kind, reason, indexes, submitted }) => {
      window.mockCalls = [];
      Object.defineProperty(window, "videoClient", { configurable: true, set(client) {
        let run;
        const original = client.getLatestRecoverableKlingRun;
        client.getLatestRecoverableKlingRun = async () => {
          const response = await original();
          run = { ...response.run, voiceScript: "这是一句测试台词", audioMode: "voice", voiceAudio: {}, recovery: kind ? { kind, reason, indexes } : null, videoTaskId: submitted ? "original-task" : null, videoStatus: submitted ? "FAILED" : null, videoSubmission: { status: kind ? "rejected" : "uncertain" } };
          if (kind === "keyframes") run.editedKeyframes[1] = null;
          return { ...response, run };
        };
        client.listVoices = async () => [{ id: "other-voice", name: "其他音色", demo: false }];
        client.inspectReferenceAudio = async () => ({ hasAudio: true, duration: 10 });
        client.createVoice = async () => ({ id: "created-voice", name: "重新上传的声音", demo: false });
        client.startKlingVideo = async (...args) => { window.mockCalls.push(["video", ...args]); throw Error("isolated submit stop"); };
        client.getKlingRun = async () => run;
        client.prepareKlingRecovery = async runId => {
          window.mockCalls.push(["copy", runId]);
          run = { ...run, id: "copied-run", videoTaskId: null, videoStatus: null, videoSubmission: null };
          return run;
        };
        client.replaceKlingKeyframe = async (runId, index) => {
          window.mockCalls.push(["replace", runId, index]);
          run.editedKeyframes[index] = run.editedKeyframes[0];
          return run;
        };
        client.retryKlingImage = async (runId, indexes) => {
          window.mockCalls.push(["retry-images", runId, indexes]);
          for (const index of indexes) run.editedKeyframes[index] = run.editedKeyframes[0];
          Object.assign(run, { stage: "image", status: "SUCCEEDED", recovery: null });
          return run;
        };
        Object.defineProperty(window, "videoClient", { value: client, configurable: true });
      } });
    }, { kind, reason, indexes, submitted });
    await page.goto(process.env.RECOVERY_UI_URL + "?case=unknown");
    await page.getByRole("heading", { name: submitted ? "请修复素材后继续" : kind === "voice" ? "请更新参考声音" : kind === "keyframes" ? "请处理关键帧" : "图片已保存，可以继续生成视频", exact: true }).waitFor({ state: "attached" });
    await page.screenshot();
  }
  try {
    await open("voice", "duration");
    await page.getByRole("button", { name: "选择其他音色", exact: true }).click();
    await page.screenshot();
    await page.locator('[data-action="voice-select"]').click();
    await page.screenshot();
    await page.getByRole("heading", { name: "请逐张确认商品替换是否正确" }).waitFor();
    assert.deepEqual(await page.evaluate(() => window.mockCalls), []);
    await page.getByRole("button", { name: "确认并生成 5 秒视频", exact: true }).click();
    await page.waitForFunction(() => window.mockCalls.length === 1);
    const call = await page.evaluate(() => window.mockCalls[0]);
    assert.equal(call[1], "remake_mock_1");
    assert.equal(call.at(-1), "other-voice");

    await open("voice", "size");
    await page.getByRole("button", { name: "重新上传声音", exact: true }).click();
    await page.screenshot();
    await page.evaluate(() => {
      const input = document.querySelector("#voiceSourceInput");
      const file = new File([new Uint8Array(20_000_001)], "oversize.wav", { type: "audio/wav" });
      Object.defineProperty(input, "files", { value: [file], configurable: true });
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await page.screenshot();
    await page.getByRole("alert").filter({ hasText: "20,000,000" }).waitFor();
    assert.equal(await page.getByRole("button", { name: "创建并生成试听", exact: true }).isDisabled(), true);
    await page.locator("#voiceSourceInput").setInputFiles({ name: "voice.wav", mimeType: "audio/wav", buffer: Buffer.alloc(12) });
    await page.screenshot();
    await page.getByRole("button", { name: "创建并生成试听", exact: true }).click();
    await page.screenshot();
    await page.getByRole("heading", { name: "请逐张确认商品替换是否正确" }).waitFor();
    assert.deepEqual(await page.evaluate(() => window.mockCalls), []);

    await open("keyframes", "missing", [1]);
    await page.getByRole("button", { name: "查看并处理关键帧", exact: true }).click();
    await page.screenshot();
    assert.equal(await page.locator('[data-keyframe-index="1"][data-action="toggle-remake-image"]').getAttribute("aria-pressed"), "true");
    assert.equal(await page.getByRole("button", { name: "确认并生成 5 秒视频", exact: true }).isDisabled(), true);
    await page.screenshot({ path: process.env.RECOVERY_SCREENSHOT || "test-results/remake-recovery-missing.png", fullPage: true });
    await page.locator('[data-replace-keyframe="1"]').setInputFiles({ name: "replacement.png", mimeType: "image/png", buffer: Buffer.from("isolated mock image") });
    await page.waitForFunction(() => window.mockCalls.some(call => call[0] === "replace"));
    assert.equal(await page.getByRole("button", { name: "确认并生成 5 秒视频", exact: true }).isDisabled(), false);

    await open("voice", "missing", [], true);
    await page.getByRole("button", { name: "修改素材后重试", exact: true }).click();
    await page.getByRole("heading", { name: "请更新参考声音", exact: true }).waitFor({ state: "attached" });
    await page.screenshot();
    await page.getByRole("button", { name: "选择其他音色", exact: true }).click();
    await page.screenshot();
    await page.locator('[data-action="voice-select"]').click();
    await page.screenshot();
    assert.deepEqual(await page.evaluate(() => window.mockCalls), [["copy", "remake_mock_1"]]);
    await page.getByRole("button", { name: "确认并生成 5 秒视频", exact: true }).click();
    await page.waitForFunction(() => window.mockCalls.length === 2);
    assert.equal(await page.evaluate(() => window.mockCalls[1][1]), "copied-run");

    await open("keyframes", "invalid", []);
    await page.getByRole("button", { name: "查看并处理关键帧", exact: true }).click();
    await page.screenshot();
    assert.equal(await page.locator('[data-action="toggle-remake-image"][aria-pressed="true"]').count(), 4);
    await page.getByRole("button", { name: "重新生成所选（4）", exact: true }).click();
    await page.waitForFunction(() => window.mockCalls.length === 1);
    await page.screenshot();
    assert.deepEqual(await page.evaluate(() => window.mockCalls[0]), ["retry-images", "remake_mock_1", [0, 1, 2, 3]]);
    assert.equal(await page.getByRole("button", { name: "确认并生成 5 秒视频", exact: true }).isDisabled(), false);

    await open(null, null);
    assert.equal(await page.locator('[data-action="review-saved-keyframes"]').isDisabled(), true);
    await page.getByRole("button", { name: "从当前进度继续 继续生成视频" }).click();
    await page.screenshot();
    assert.doesNotMatch(await page.locator(".failure-state").textContent(), /费用|计费|扣费|任务记录/);
    await page.getByRole("button", { name: "确定再次生成", exact: true }).click();
    await page.waitForFunction(() => window.mockCalls.length === 1);
    assert.equal(await page.evaluate(() => window.mockCalls[0][6]), true);
    assert.equal(errors.length, 0, errors.join("\n"));
  } finally { await context.close(); await browser.close(); }
});
