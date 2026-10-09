import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../../../electron/renderer/app.js", import.meta.url), "utf8");
const functions = source.slice(source.indexOf("function newRemakeState("), source.indexOf("function imageRetryMarkup("));
const recovery = source.slice(source.indexOf("async function loadLatestInterruptedRemake("), source.indexOf("async function loadKlingConfig("));
const exports = ["newRemakeState", "pollKlingRun", "completeRemakeResult", "runRemake", "recoverRemake", "confirmRemakeImage", "retrySavedRemakeVideo", "retryRemakeImages", "openRemakeStop", "dismissRemakeStop", "stopRemake", "remakeStopStage", "renderRemakeStopDialog", "loadLatestInterruptedRemake"];
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const completed = { id: "old", stage: "video", status: "SUCCEEDED", baseUrl: "http://local/", output: { id: "output", url: "out.mp4" } };
function setup(client = {}) {
  const state = { active: "remake", library: [] }, renders = [], messages = [], calls = [];
  const videoClient = {
    stopKlingRun: async (...args) => { calls.push(args); },
    startKlingVideo: async () => ({ id: "old", videoTaskId: "paid-task" }),
    getKlingRun: async () => completed,
    revoiceVideo: async () => { calls.push("revoice"); return {}; },
    ...client
  };
  const deps = {
    state, videoClient, render: options => renders.push(options), notify: message => messages.push(message),
    workspace: { querySelector: () => null }, document: { querySelector: () => null },
    wait: async () => {}, sortLibraryNewestFirst: () => {},
    friendlyRemakeError: error => error.message || String(error), cleanRemoteError: error => error.message || String(error)
  };
  const api = Function("deps", `const {${Object.keys(deps)}} = deps; let voicePreviewAudio = null; let latestRemakeChecked = false; let klingAssetsRevision = 0; ${functions}\n${recovery}\nreturn {${exports}};`)(deps);
  state.remake = api.newRemakeState({ config: { configured: true }, voices: [{ id: "v", name: "Voice" }], selectedVoiceId: "v", voiceScript: "台词", duration: 10 });
  Object.assign(state.remake, { runId: "old", imageReady: true, editedKeyframes: [{ url: "image.png" }], reference: { name: "input.mp4", file: {} }, products: [{ file: {} }], serviceBaseUrl: "http://local/" });
  return { ...api, state, renders, messages, calls, videoClient };
}

for (const outcome of ["success", "failure"]) {
  test(`stopped poll ignores late ${outcome}, caller catch/finally, TTS and library writes`, async () => {
    const get = deferred();
    const h = setup({ getKlingRun: () => get.promise });
    const old = h.state.remake;
    const work = h.confirmRemakeImage();
    await tick();
    assert.equal(h.remakeStopStage(old), "video");
    h.openRemakeStop();
    await h.stopRemake();
    const fresh = h.state.remake;
    Object.assign(fresh, { runId: "new", running: true, progress: 12, stage: "新任务" });
    const expected = structuredClone(fresh), renderCount = h.renders.length, messageCount = h.messages.length;
    if (outcome === "success") get.resolve(completed); else get.reject(new Error("late network error"));
    await work;
    assert.notEqual(fresh, old);
    assert.deepEqual(fresh, expected);
    assert.equal(h.renders.length, renderCount);
    assert.equal(h.messages.length, messageCount);
    assert.deepEqual(h.state.library, []);
    assert.deepEqual(h.calls, [["old", "video"]]);
  });
}

test("no video stop before submission acknowledgement; polling can expose it after task ID arrives", async () => {
  const start = deferred(), get = deferred();
  const h = setup({ startKlingVideo: () => start.promise, getKlingRun: () => get.promise });
  const work = h.confirmRemakeImage();
  assert.equal(h.remakeStopStage(h.state.remake), null);
  h.openRemakeStop();
  await h.stopRemake();
  assert.equal(h.calls.length, 0);
  start.resolve({ id: "old", stage: "video" });
  await tick();
  assert.equal(h.remakeStopStage(h.state.remake), null);
  const next = deferred();
  h.videoClient.getKlingRun = () => next.promise;
  const count = h.renders.length;
  get.resolve({ id: "old", stage: "video", status: "PROCESSING", videoTaskId: "paid-task" });
  await tick();
  assert.equal(h.remakeStopStage(h.state.remake), "video");
  assert.ok(h.renders.slice(count).some(options => options?.preserveControls === false));
  h.openRemakeStop();
  await h.stopRemake();
  next.resolve(completed);
  await work;
});

test("image end preserves settings, records and library; clears only current task and inputs", async () => {
  const h = setup();
  const old = h.state.remake;
  h.state.library.push({ name: "retained.png" });
  h.openRemakeStop();
  const markup = h.renderRemakeStopDialog(old);
  assert.match(markup, /图片已保存/);
  assert.match(markup, /不会扣除视频生成费用/);
  assert.match(markup, /aria-modal="true"/);
  await h.stopRemake();
  const fresh = h.state.remake;
  for (const key of ["config", "voices", "selectedVoiceId", "duration", "voiceScript", "videoMode", "audio", "voiceEnabled"]) assert.deepEqual(fresh[key], old[key]);
  assert.equal(fresh.runId, null);
  assert.equal(fresh.reference, null);
  assert.deepEqual(fresh.products, []);
  assert.deepEqual(fresh.editedKeyframes, []);
  assert.equal(fresh.result, null);
  assert.deepEqual(h.calls, [["old", "image"]]);
  assert.equal(h.state.library[0].name, "retained.png");
  old.running = true;
  assert.equal(h.remakeStopStage(old), null);
});

test("duplicate confirmation submits stop once and completion waits for acknowledgement", async () => {
  const stop = deferred(), get = deferred();
  const h = setup({ stopKlingRun: (...args) => { h.calls.push(args); return stop.promise; }, getKlingRun: () => get.promise });
  const work = h.confirmRemakeImage();
  await tick();
  h.openRemakeStop();
  assert.match(h.renderRemakeStopDialog(h.state.remake), /云端任务可能继续运行/);
  const pending = h.stopRemake();
  await h.stopRemake();
  assert.equal(h.calls.length, 1);
  assert.match(h.renderRemakeStopDialog(h.state.remake), /disabled/);
  get.resolve(completed);
  await tick();
  assert.equal(h.state.remake.result, null);
  assert.equal(h.state.library.length, 0);
  stop.resolve({ userStopped: true });
  await pending;
  await work;
  assert.equal(h.state.remake.runId, null);
  assert.equal(h.state.library.length, 0);
});

test("failed stop keeps task and lets the pending completed result finish", async () => {
  const stop = deferred(), get = deferred();
  const h = setup({ stopKlingRun: () => stop.promise, getKlingRun: () => get.promise });
  const old = h.state.remake;
  old.voiceEnabled = false;
  const work = h.confirmRemakeImage();
  await tick();
  h.openRemakeStop();
  const pending = h.stopRemake();
  get.resolve(completed);
  await tick();
  assert.equal(old.result, null);
  stop.reject(new Error("disk write failed"));
  await pending;
  await work;
  assert.equal(h.state.remake, old);
  assert.equal(old.userStopped, false);
  assert.equal(old.stopping, false);
  assert.equal(old.result.runId, "old");
  assert.equal(h.state.library.length, 1);
  assert.ok(h.messages.some(message => /中止失败.*disk write failed/.test(message)));
});

test("completed task invalidates open dialog before stop confirmation", async () => {
  const get = deferred();
  const h = setup({ getKlingRun: () => get.promise });
  h.state.remake.voiceEnabled = false;
  const work = h.confirmRemakeImage();
  await tick();
  h.openRemakeStop();
  get.resolve(completed);
  await work;
  await h.stopRemake();
  assert.equal(h.calls.length, 0);
  assert.equal(h.state.remake.stopConfirm, null);
  assert.equal(h.state.remake.result.runId, "old");
});

test("late startup recovery cannot populate the new upload task or revive userStopped records", async () => {
  for (const stopped of [false, true]) {
    const latest = deferred();
    const h = setup({ getLatestRecoverableKlingRun: () => latest.promise });
    h.state.remake = h.newRemakeState();
    const work = h.loadLatestInterruptedRemake();
    if (!stopped) h.state.remake = h.newRemakeState();
    latest.resolve({ baseUrl: "http://local/", run: { id: "old", stage: "video", userStopped: stopped, editedKeyframes: [{ url: "image.png" }] } });
    await work;
    assert.equal(h.state.remake.runId, null);
    assert.equal(h.state.remake.error, null);
    assert.equal(h.messages.length, 0);
  }
});

test("legacy mock adapters without stop support do not expose the action", () => {
  const h = setup({ stopKlingRun: undefined });
  assert.equal(h.remakeStopStage(h.state.remake), null);
  h.openRemakeStop();
  assert.equal(h.state.remake.stopConfirm, null);
});

for (const [entry, request] of [["runRemake", "createKlingRun"], ["recoverRemake", "resumeKlingRun"], ["retrySavedRemakeVideo", "startKlingVideo"], ["retryRemakeImages", "retryKlingImage"]]) {
  test(`${entry} ignores an initial request returning after its item was replaced`, async () => {
    const pending = deferred();
    const h = setup({ [request]: () => pending.promise });
    const work = h[entry]();
    h.state.remake = h.newRemakeState();
    Object.assign(h.state.remake, { runId: "new", running: true, progress: 33 });
    const snapshot = structuredClone(h.state.remake), renderCount = h.renders.length;
    pending.resolve({ id: "old", stage: "video", videoTaskId: "paid-task" });
    await work;
    assert.deepEqual(h.state.remake, snapshot);
    assert.equal(h.renders.length, renderCount);
    assert.equal(h.state.library.length, 0);
    assert.equal(h.messages.length, 0);
  });
}

for (const outcome of ["success", "failure"]) {
  test(`error-detail read ignores late ${outcome} after a successful stop`, async () => {
    const saved = deferred();
    let reads = 0;
    const h = setup({ getKlingRun: () => ++reads === 1 ? Promise.reject(new Error("temporary disconnection")) : saved.promise });
    const work = h.confirmRemakeImage();
    await tick();
    assert.equal(reads, 2);
    h.openRemakeStop();
    await h.stopRemake();
    const fresh = h.state.remake, snapshot = structuredClone(fresh), renderCount = h.renders.length;
    if (outcome === "success") saved.resolve({ videoTaskId: "paid-task", stage: "video" });
    else saved.reject(new Error("late failed read"));
    await work;
    assert.deepEqual(fresh, snapshot);
    assert.equal(h.renders.length, renderCount);
    assert.equal(h.state.library.length, 0);
  });
}

test("late revoice result cannot add the old result to the current item or library", async () => {
  const voice = deferred();
  const h = setup({ revoiceVideo: () => voice.promise });
  const old = h.state.remake;
  const work = h.completeRemakeResult(completed, old);
  h.state.remake = h.newRemakeState();
  const snapshot = structuredClone(h.state.remake);
  voice.resolve({ voiceName: "old voice" });
  await assert.rejects(work, /任务已结束/);
  assert.deepEqual(h.state.remake, snapshot);
  assert.equal(h.state.library.length, 0);
});

test("steady video polling preserves an open modal instead of rebuilding it", async () => {
  const responses = [deferred(), deferred(), deferred()];
  let read = 0;
  const h = setup({ getKlingRun: () => responses[read++].promise });
  const work = h.confirmRemakeImage();
  await tick();
  h.openRemakeStop();
  const confirm = h.state.remake.stopConfirm, renderCount = h.renders.length;
  responses[0].resolve({ id: "old", stage: "video", status: "PROCESSING", videoTaskId: "paid-task" });
  await tick();
  assert.equal(h.state.remake.stopConfirm, confirm);
  assert.deepEqual(h.renders.slice(renderCount), [{ preserveControls: true }]);
  await h.stopRemake();
  responses[1].resolve(completed);
  await work;
});

test("failed image end leaves all saved images and the confirmation page available", async () => {
  const h = setup({ stopKlingRun: async () => { throw new Error("cannot persist stop"); } });
  const old = h.state.remake;
  h.openRemakeStop();
  await h.stopRemake();
  assert.equal(h.state.remake, old);
  assert.equal(old.imageReady, true);
  assert.equal(old.editedKeyframes.length, 1);
  assert.equal(old.stopping, false);
  assert.equal(old.stopConfirm, null);
  assert.equal(h.remakeStopStage(old), "image");
});
