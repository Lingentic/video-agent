import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createWuhenService, validateWuhenOptions } from "../src/wuhen-service.mjs";
import { createWuhenTransport } from "../src/wuhen-transport.mjs";
import { ffmpegPath, ffprobePath } from "../src/runtime-paths.mjs";

const exec = promisify(execFile);
const media = { hasVideo: true, hasAudio: true, width: 720, height: 1134, durationSec: 27.59, formatName: "mov,mp4", videoCodec: "h264", audioCodec: "aac" };
const options = { model: "video_removal_std", method: "sel_area", rectNormalized: { x1: 0.05, y1: 0.7, x2: 0.95, y2: 0.8 } };
const defaultRect = { x1: 0.05, y1: 0.60, x2: 0.95, y2: 0.85 };
const response = (data, code = 0, status = 200) => new Response(JSON.stringify({ code, message: "ignored potentially secret message", data }), { status, headers: { "content-type": "application/json" } });
async function waitForBilling(statePath) {
  const file = path.join(path.dirname(statePath), "billing.json");
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = await fsp.readFile(file, "utf8").then(JSON.parse).catch(() => null);
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Mock supplementary billing artifact was not persisted");
}

async function fixture(t, overrides = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "wuhen-service-")), runDir = path.join(root, "run");
  await fsp.mkdir(runDir); const inputPath = path.join(runDir, "input.mp4"); await fsp.writeFile(inputPath, "original-video");
  const manager = await createWuhenTransport({ runsDir: root, allowLocalPublicBase: true, transportFetch: fetch, ...overrides.managerDependencies });
  manager.setPublicBaseUrl(`http://127.0.0.1:${manager.port}`);
  const calls = [], stages = []; let submittedBody, sequenceIndex = 0, clock = 1_800_000_000_000;
  const apiKey = "private-api-key", accessToken = "private-access-token", sequence = overrides.sequence || ["queued", "processing", "success"];
  const transport = async (value, init) => {
    const url = new URL(value); calls.push({ url, init });
    if (url.pathname === "/v2/user/access_token") return response({ access_token: accessToken, expired: Math.floor(clock / 1000) + 7 * 86400 });
    if (url.pathname === "/v2/user/me") return response({ balance: overrides.balance ?? 1000 });
    if (url.pathname === "/v2/video_removal") {
      submittedBody = JSON.parse(init.body);
      if (overrides.submit) return overrides.submit({ url, init, submittedBody, runDir });
      return response({ task_id: "cloud-task-1" });
    }
    if (url.pathname === "/v2/status") {
      if (overrides.query) return overrides.query({ url, init, submittedBody, runDir });
      const status = sequence[Math.min(sequenceIndex++, sequence.length - 1)];
      if (status === "success" && overrides.deliver !== false) {
        const job = JSON.parse(await fsp.readFile(path.join(runDir, "artifacts/subtitle-removal/job.json")));
        assert.equal((await fetch(job.transport.uploadUrl, { method: "PUT", body: overrides.output ?? "valid-output-video" })).status, 200);
      }
      return response({ status, progress: status === "queued" ? 12 : 45, description: `${apiKey} ${accessToken} https://secret.invalid/cap` });
    }
    if (url.pathname === "/v2/user/billings") {
      if (overrides.billing) return overrides.billing({ url, init });
      return response({ total_pages: 1, items: [{ task_id: "other-task", billing_type: "consume", credits: -999, metering: "999" },
        { task_id: "cloud-task-1", billing_type: "consume", credits: -28, metering: "28" }] });
    }
    throw new Error("unexpected endpoint");
  };
  const probe = overrides.probe || (async (file) => {
    const bytes = await fsp.readFile(file, "utf8");
    if (bytes.startsWith("<html") || !bytes) throw new Error("invalid media");
    return { ...media, ...(file === inputPath ? {} : overrides.outputMedia) };
  });
  const service = createWuhenService({ transportManager: manager, transport, probe, now: () => clock, sleep: async (ms, signal) => {
    clock += ms; if (overrides.sleep) await overrides.sleep(ms, signal);
  }, receiptWaitMs: 0, ...overrides.dependencies });
  const args = { runDir, inputPath, apiKey, options, onStage: (stage, job) => stages.push({ stage, job }) };
  const statePath = path.join(runDir, "artifacts/subtitle-removal/job.json");
  t.after(async () => {
    if (!overrides.blockBilling && calls.some(({ url }) => url.pathname === "/v2/user/billings")) await waitForBilling(statePath);
    await manager.close(); await fsp.rm(root, { recursive: true, force: true });
  });
  return { service, manager, transport, calls, stages, args, root, runDir, inputPath, statePath: path.join(runDir, "artifacts/subtitle-removal/job.json"), accessToken,
    setClock(value) { clock = value; }, getClock() { return clock; } };
}

test("default API transport uses the same process fetch as naming without independent DNS checks", async (t) => {
  const originalFetch = globalThis.fetch;
  const f = await fixture(t, { dependencies: { transport: undefined } });
  globalThis.fetch = (value, init) => {
    const url = new URL(value);
    if (url.hostname !== "api.wuhenai.com") return originalFetch(value, init);
    assert.equal(init.dispatcher, undefined);
    return f.transport(value, init);
  };
  try {
    const result = await f.service.removeVideoSubtitles(f.args);
    assert.equal(result.job.taskId, "cloud-task-1");
    await waitForBilling(f.statePath);
    assert.ok(f.calls.some(call => call.url.pathname === "/v2/user/access_token"));
    assert.equal(f.calls.filter(call => call.url.pathname === "/v2/video_removal").length, 1);
  } finally { globalThis.fetch = originalFetch; }
});

test("default region maps actual pixels and explicit regions block reverse/outside/oversize/noninteger frames", () => {
  assert.deepEqual(validateWuhenOptions({}).rectNormalized, defaultRect);
  assert.deepEqual(validateWuhenOptions({ method: "all_area" }), { model: "video_removal_std", method: "all_area" });
  for (const [width, height, expected] of [
    [576, 1024, { x1: 28, y1: 614, x2: 548, y2: 871 }],
    [720, 1280, { x1: 36, y1: 768, x2: 684, y2: 1088 }],
    [1080, 1920, { x1: 54, y1: 1152, x2: 1026, y2: 1632 }],
  ]) {
    assert.deepEqual(validateWuhenOptions({}, { width, height }).rect, expected);
  }
  assert.throws(() => validateWuhenOptions({}, { width: 2160, height: 3840 }), { code: "OPTIONS_INVALID" });
  assert.deepEqual(validateWuhenOptions(options, media).rect, { x1: 36, y1: 793, x2: 684, y2: 908 });
  for (const invalid of [{ ...options, model: "other" }, { rect: { x1: 2, y1: 2, x2: 1, y2: 3 } },
    { rect: { x1: 0, y1: 0, x2: 721, y2: 10 } }, { rect: { x1: 0, y1: 0, x2: 720, y2: 1000 } },
    { rect: { x1: 0.1, y1: 0, x2: 10, y2: 10 } }, { rectNormalized: { x1: 0, y1: 0, x2: 1.1, y2: 1 } },
    { ...options, rect: { x1: 1, y1: 1, x2: 2, y2: 2 } }, { method: "all_area", rect: { x1: 1, y1: 1, x2: 2, y2: 2 } }]) {
    assert.throws(() => validateWuhenOptions(invalid, media), { code: "OPTIONS_INVALID" });
  }
});

test("V2 nonce/time/Bearer/JSON, task persistence, queue semantics, billing and completed reuse", async (t) => {
  const f = await fixture(t, { submit: async ({ init, runDir }) => {
    const saved = JSON.parse(await fsp.readFile(path.join(runDir, "artifacts/subtitle-removal/job.json")));
    assert.equal(saved.stage, "submitting"); assert.ok(saved.submissionStartedAt); assert.equal(saved.taskId, undefined);
    assert.equal(init.headers["Content-Type"], "application/json");
    const submitted = JSON.parse(init.body); assert.equal(typeof submitted.upload_headers, "object"); assert.deepEqual(submitted.rect, { x1: 36, y1: 793, x2: 684, y2: 908 });
    return response({ task_id: "cloud-task-1" });
  } });
  const result = await f.service.removeVideoSubtitles(f.args);
  assert.equal(result.job.stage, "completed");
  const bill = await waitForBilling(f.statePath); assert.equal(bill.taskId, "cloud-task-1"); assert.equal(bill.credits, -28); assert.equal(bill.metering, 28);
  assert.equal(await fsp.readFile(f.inputPath, "utf8"), "original-video"); assert.equal(await fsp.readFile(result.outputPath, "utf8"), "valid-output-video");
  const queued = f.stages.find((event) => event.job.status === "queued"); assert.equal(queued.job.queueAhead, 12); assert.equal(queued.job.progress, undefined);
  assert.equal(f.stages.find((event) => event.stage === "subtitle_processing").job.progress, 45);
  const nonces = f.calls.map(({ url }) => url.searchParams.get("nonce")); assert.equal(new Set(nonces).size, nonces.length);
  assert.ok(f.calls.every(({ url }) => /^\d{10}$/.test(url.searchParams.get("t"))));
  assert.ok(f.calls.filter(({ url }) => url.pathname !== "/v2/user/access_token").every(({ init }) => init.headers.Authorization === `Bearer ${f.accessToken}`));
  assert.equal(f.calls.filter(({ url }) => url.pathname === "/v2/user/access_token").length, 1);
  const privateJob = await fsp.readFile(f.statePath, "utf8"); assert.ok(!privateJob.includes(f.args.apiKey)); assert.ok(!privateJob.includes(f.accessToken));
  const publicJson = JSON.stringify(f.stages); for (const secret of [f.args.apiKey, f.accessToken, "/input/", "/output/", "secret.invalid"]) assert.ok(!publicJson.includes(secret));
  const count = f.calls.length; const again = await f.service.removeVideoSubtitles({ ...f.args, apiKey: "", options: { method: "all_area" } });
  assert.equal(again.outputPath, result.outputPath); assert.equal(f.calls.length, count);
  const state = JSON.parse(privateJob);
  assert.equal((await fetch(state.transport.uploadUrl, { method: "PUT", body: "valid-output-video" })).status, 200);
  assert.equal((await fetch(state.transport.uploadUrl, { method: "PUT", body: "new-output" })).status, 409);
});

test("unknown paid submission outcomes persist intent and never automatically POST again", async (t) => {
  for (const submit of [async () => { throw new Error("lost response secret-api-key"); }, async () => response({}, 0, 200), async () => response({}, 500, 502)]) {
    const f = await fixture(t, { submit });
    await assert.rejects(f.service.removeVideoSubtitles(f.args), { code: "SUBMISSION_UNCERTAIN" });
    await assert.rejects(f.service.removeVideoSubtitles(f.args), { code: "SUBMISSION_UNCERTAIN" });
    assert.equal(f.calls.filter(({ url }) => url.pathname === "/v2/video_removal").length, 1);
    assert.equal(JSON.parse(await fsp.readFile(f.statePath)).stage, "submission_uncertain");
  }
});

test("task identity survives conflicting outer code and resumes original ID/model without resubmission", async (t) => {
  const f = await fixture(t, { submit: () => response({ task_id: "cloud-task-1" }, 99, 502) });
  await assert.rejects(f.service.removeVideoSubtitles(f.args), (error) => error.code === "SUBMISSION_UNCERTAIN" && error.job.taskId === "cloud-task-1");
  assert.equal(JSON.parse(await fsp.readFile(f.statePath)).taskId, "cloud-task-1");
  const result = await f.service.removeVideoSubtitles({ ...f.args, options: { model: "video_removal_pro", method: "all_area" } });
  assert.equal(result.job.model, "video_removal_std"); assert.equal(result.job.method, "sel_area");
  assert.deepEqual(result.job.rect, { x1: 36, y1: 793, x2: 684, y2: 908 });
  assert.equal(f.calls.filter(({ url }) => url.pathname === "/v2/video_removal").length, 1);
  assert.ok(f.calls.filter(({ url }) => url.pathname === "/v2/status").every(({ url }) => url.searchParams.get("task_id") === "cloud-task-1"));
});

test("temporary Windows rename locks retry before the submitted task ID is lost", async (t) => {
  let failures = 0; const backoffs = [];
  const f = await fixture(t, { dependencies: { stateRetrySleep: async (ms) => { backoffs.push(ms); }, rename: async (source, target) => {
    const state = JSON.parse(await fsp.readFile(source));
    if (target.endsWith("job.json") && state.stage === "submitted" && failures < 2) {
      failures += 1; throw Object.assign(new Error("file busy"), { code: failures === 1 ? "EPERM" : "EBUSY" });
    }
    await fsp.rename(source, target);
  } } });
  assert.equal((await f.service.removeVideoSubtitles(f.args)).job.stage, "completed");
  assert.deepEqual(backoffs, [25, 50]); assert.equal(JSON.parse(await fsp.readFile(f.statePath)).taskId, "cloud-task-1");
  assert.equal(f.calls.filter(({ url }) => url.pathname === "/v2/video_removal").length, 1);
});

test("persistent private save failure exposes a safe outer recovery identity and restores without POST", async (t) => {
  const f = await fixture(t, { dependencies: { stateRetrySleep: async () => {}, rename: async (source, target) => {
    const state = JSON.parse(await fsp.readFile(source));
    if (target.endsWith("job.json") && state.taskId) throw Object.assign(new Error("file busy private secret"), { code: "EBUSY" });
    await fsp.rename(source, target);
  } } });
  const backupPath = path.join(f.runDir, "outer-subtitle.json");
  let fallback;
  await assert.rejects(f.service.removeVideoSubtitles({ ...f.args, onStage: async (stage, summary) => {
    if (summary.taskId) { fallback = summary; await fsp.writeFile(backupPath, JSON.stringify(summary)); }
  } }), (error) => {
    assert.equal(error.code, "STATE_WRITE_FAILED"); assert.equal(error.job.taskId, "cloud-task-1");
    assert.equal(error.job.id, fallback.id); return true;
  });
  const privateState = JSON.parse(await fsp.readFile(f.statePath)); assert.equal(privateState.taskId, undefined); assert.ok(privateState.submissionStartedAt);
  const backup = JSON.parse(await fsp.readFile(backupPath));
  for (const secret of [f.args.apiKey, f.accessToken, "/input/", "/output/"]) assert.ok(!JSON.stringify(backup).includes(secret));
  const resumed = createWuhenService({ transportManager: f.manager, transport: f.transport, probe: async () => media, sleep: async () => {} });
  assert.equal((await resumed.removeVideoSubtitles({ ...f.args, recoveryJob: backup })).job.stage, "completed");
  assert.equal(f.calls.filter(({ url }) => url.pathname === "/v2/video_removal").length, 1);
  assert.equal(JSON.parse(await fsp.readFile(f.statePath)).taskId, "cloud-task-1");
});

test("paused/failed preserve task ID, query interruption does not cancel or resubmit", async (t) => {
  for (const status of ["paused", "failed"]) {
    const f = await fixture(t, { sequence: [status] });
    const code = status === "paused" ? "REMOTE_PAUSED" : "REMOTE_FAILED";
    await assert.rejects(f.service.removeVideoSubtitles(f.args), { code });
    await assert.rejects(f.service.removeVideoSubtitles(f.args), { code });
    assert.equal(JSON.parse(await fsp.readFile(f.statePath)).taskId, "cloud-task-1");
    assert.equal(f.calls.filter(({ url }) => url.pathname === "/v2/video_removal").length, 1);
  }
  const f = await fixture(t, { query: async () => { throw new Error("secret network details"); } });
  await assert.rejects(f.service.removeVideoSubtitles(f.args), { code: "QUERY_INTERRUPTED" });
  await assert.rejects(f.service.removeVideoSubtitles(f.args), { code: "QUERY_INTERRUPTED" });
  assert.equal(f.calls.filter(({ url }) => url.pathname === "/v2/video_removal").length, 1); assert.ok(!f.calls.some(({ url }) => url.pathname.includes("cancel")));
});

test("success without output and lost tunnel never become completed or cause a paid retry", async (t) => {
  const f = await fixture(t, { sequence: ["success"], deliver: false });
  await assert.rejects(f.service.removeVideoSubtitles(f.args), { code: "OUTPUT_MISSING" });
  f.manager.setPublicBaseUrl("http://127.0.0.1:54321");
  await assert.rejects(f.service.removeVideoSubtitles(f.args), { code: "TRANSPORT_LOST" });
  assert.equal(f.calls.filter(({ url }) => url.pathname === "/v2/video_removal").length, 1);
  assert.equal(f.calls.filter(({ url }) => url.pathname === "/v2/status").length, 1);
});

test("missing/replaced transport recovery files cannot mutate already submitted capability URLs", async (t) => {
  for (const mode of ["missing", "replaced"]) {
    const f = await fixture(t, { sequence: ["success"], deliver: false });
    await assert.rejects(f.service.removeVideoSubtitles(f.args), { code: "OUTPUT_MISSING" });
    const original = JSON.parse(await fsp.readFile(f.statePath)), transportPath = path.join(path.dirname(f.statePath), "transport.json");
    if (mode === "missing") await fsp.rm(transportPath);
    else {
      const state = JSON.parse(await fsp.readFile(transportPath)); state.id = "replacement-handle";
      await fsp.writeFile(transportPath, JSON.stringify(state));
      // A restarted manager will restore the replacement rather than use the previously registered handle.
      const replacement = await createWuhenTransport({ runsDir: f.root, allowLocalPublicBase: true, transportFetch: fetch });
      t.after(() => replacement.close()); replacement.setPublicBaseUrl(`http://127.0.0.1:${replacement.port}`);
      f.service = createWuhenService({ transportManager: replacement, probe: async () => media, transport: async () => { throw new Error("unexpected API"); } });
    }
    await assert.rejects(f.service.removeVideoSubtitles(f.args), { code: "TRANSPORT_LOST" });
    const saved = JSON.parse(await fsp.readFile(f.statePath)); assert.deepEqual(saved.transport, original.transport);
    assert.equal(f.calls.filter(({ url }) => url.pathname === "/v2/video_removal").length, 1);
  }
});

test("pre-submission connectivity failure can prepare a fresh tunnel without a paid retry", async (t) => {
  let reachable = false, localBase;
  const f = await fixture(t, { sequence: ["success"], managerDependencies: { transportFetch: async (value, init) => {
    if (!reachable) throw new Error("mock tunnel offline");
    const url = new URL(value); return fetch(localBase + url.pathname, init);
  } } });
  localBase = `http://127.0.0.1:${f.manager.port}`;
  await assert.rejects(f.service.removeVideoSubtitles(f.args), { code: "TRANSPORT_UNREACHABLE" });
  assert.equal(f.calls.length, 0);
  const transportPath = path.join(path.dirname(f.statePath), "transport.json"), original = JSON.parse(await fsp.readFile(transportPath));
  f.manager.setPublicBaseUrl("https://fresh-test.trycloudflare.com"); reachable = true;
  // Mock the supplier's PUT via the local receiver while the API submission carries the new public base.
  const resumed = createWuhenService({ transportManager: f.manager, probe: async () => media, receiptWaitMs: 0, transport: async (value) => {
    const url = new URL(value); f.calls.push({ url });
    if (url.pathname.endsWith("access_token")) return response({ access_token: "mock-token", expired: Math.floor(Date.now() / 1000) + 1000 });
    if (url.pathname.endsWith("/me")) return response({ balance: 1000 });
    if (url.pathname.endsWith("video_removal")) return response({ task_id: "cloud-task-1" });
    if (url.pathname.endsWith("/status")) {
      const saved = JSON.parse(await fsp.readFile(f.statePath));
      await fetch(localBase + saved.transport.outputRoute, { method: "PUT", body: "mock-video" }); return response({ status: "success" });
    }
    return response({ total_pages: 0, items: [] });
  } });
  assert.equal((await resumed.removeVideoSubtitles(f.args)).job.stage, "completed");
  const refreshed = JSON.parse(await fsp.readFile(transportPath));
  assert.notEqual(refreshed.id, original.id); assert.equal(refreshed.publicBaseUrl, "https://fresh-test.trycloudflare.com");
  assert.equal((await fetch(localBase + original.inputRoute)).status, 404);
  assert.equal(f.calls.filter(({ url }) => url.pathname === "/v2/video_removal").length, 1);
});

test("billing paginates by OpenAPI page_index and matches the original task ID", async (t) => {
  const seen = [];
  const f = await fixture(t, { billing: ({ url }) => {
    const index = url.searchParams.get("page_index"); seen.push(index);
    return response({ total_pages: 2, items: index === "0" ? [{ task_id: "other", billing_type: "consume", credits: -99, metering: "99" }]
      : [{ task_id: "cloud-task-1", billing_type: "consume", credits: -28, metering: "28" }] });
  } });
  assert.equal((await f.service.removeVideoSubtitles(f.args)).job.stage, "completed");
  assert.equal((await waitForBilling(f.statePath)).credits, -28); assert.deepEqual(seen, ["0", "1"]);
});

test("invalid/HTML/missing audio/wrong size/duration results fail validation; billing failure is supplementary", async (t) => {
  for (const config of [{ output: "<html>upstream error</html>" }, { outputMedia: { hasAudio: false } }, { outputMedia: { width: 721 } },
    { outputMedia: { durationSec: 100 } }, { outputMedia: { hasVideo: false } }]) {
    const f = await fixture(t, { ...config, sequence: ["success"] });
    await assert.rejects(f.service.removeVideoSubtitles(f.args), { code: "VALIDATION_FAILED" });
    assert.equal(JSON.parse(await fsp.readFile(f.statePath)).stage, "validation_failed"); assert.equal(await fsp.readFile(f.inputPath, "utf8"), "original-video");
  }
  const f = await fixture(t, { billing: () => response({}, 9, 500) });
  const result = await f.service.removeVideoSubtitles(f.args);
  assert.equal(result.job.stage, "completed"); assert.equal((await waitForBilling(f.statePath)).warning, "BILLING_UNAVAILABLE");
});

test("a billing request that never resolves cannot delay completion or existing-output reuse", async (t) => {
  const f = await fixture(t, { sequence: ["success"], blockBilling: true, billing: () => new Promise(() => {}) });
  const deadline = (promise) => Promise.race([promise, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error("completion blocked by billing")), 1000); timer.unref(); })]);
  const result = await deadline(f.service.removeVideoSubtitles(f.args)); assert.equal(result.job.stage, "completed");
  const saved = await fsp.readFile(f.statePath, "utf8");
  assert.equal((await deadline(f.service.removeVideoSubtitles({ ...f.args, apiKey: "" }))).outputPath, result.outputPath);
  assert.equal(JSON.parse(saved).stage, "completed"); assert.equal(JSON.parse(await fsp.readFile(f.statePath)).stage, "completed");
});

test("insufficient balance and invalid region block paid POST; long videos have no invented supplier cap", async (t) => {
  const f = await fixture(t, { balance: 27 }); await assert.rejects(f.service.removeVideoSubtitles(f.args), { code: "INSUFFICIENT_BALANCE" });
  assert.equal(f.calls.filter(({ url }) => url.pathname === "/v2/video_removal").length, 0);
  const invalid = await fixture(t); await assert.rejects(invalid.service.removeVideoSubtitles({ ...invalid.args, options: { rect: { x1: 0, y1: 0, x2: 720, y2: 1134 } } }), { code: "OPTIONS_INVALID" });
  assert.equal(invalid.calls.length, 0);
  const long = await fixture(t, { probe: async () => ({ ...media, durationSec: 601 }), balance: 2000 });
  assert.equal((await long.service.removeVideoSubtitles(long.args)).job.estimatedCredits, 601);
});

test("refresh uses actual token expiration and a new nonce", async (t) => {
  const f = await fixture(t, { query: () => { throw new Error("query off"); } });
  await assert.rejects(f.service.removeVideoSubtitles(f.args), { code: "QUERY_INTERRUPTED" });
  f.setClock(f.getClock() + 8 * 86400_000);
  await assert.rejects(f.service.removeVideoSubtitles(f.args), { code: "QUERY_INTERRUPTED" });
  const auth = f.calls.filter(({ url }) => url.pathname === "/v2/user/access_token"); assert.equal(auth.length, 2);
  assert.notEqual(auth[0].url.searchParams.get("nonce"), auth[1].url.searchParams.get("nonce"));
});

test("legacy provider job and changed input are rejected before API usage", async (t) => {
  const f = await fixture(t); const dir = path.dirname(f.statePath); await fsp.mkdir(dir, { recursive: true });
  for (const provider of [undefined, "zhiling"]) {
    await fsp.writeFile(f.statePath, JSON.stringify({ provider, inputPath: f.inputPath, inputMedia: media }));
    await assert.rejects(f.service.removeVideoSubtitles(f.args), { code: "INPUT_CHANGED" }); assert.equal(f.calls.length, 0);
  }
});

test("local stop and a second executor preserve a single cloud task", async (t) => {
  const controller = new AbortController();
  const stopped = await fixture(t, { sequence: ["processing"], sleep: async () => { controller.abort(); } });
  await assert.rejects(stopped.service.removeVideoSubtitles({ ...stopped.args, signal: controller.signal }), { code: "WAITING_PAUSED" });
  assert.equal(JSON.parse(await fsp.readFile(stopped.statePath)).taskId, "cloud-task-1");
  assert.ok(!stopped.calls.some(({ url }) => url.pathname.includes("cancel")));
  let unblock, started;
  const entered = new Promise((resolve) => { started = resolve; });
  const block = new Promise((resolve) => { unblock = resolve; });
  const racing = await fixture(t, { submit: async () => { started(); await block; return response({ task_id: "cloud-task-1" }); } });
  const first = racing.service.removeVideoSubtitles(racing.args); await entered;
  await assert.rejects(racing.service.removeVideoSubtitles(racing.args), { code: "JOB_BUSY" });
  unblock(); assert.equal((await first).job.stage, "completed");
  assert.equal(racing.calls.filter(({ url }) => url.pathname === "/v2/video_removal").length, 1);
});

test("real ffprobe validates a local ffmpeg sample through Mock provider and dedicated HTTP receiver", async (t) => {
  try { await exec(ffmpegPath, ["-version"], { windowsHide: true }); await exec(ffprobePath, ["-version"], { windowsHide: true }); }
  catch { t.skip("ffmpeg/ffprobe unavailable; protocol Mock tests above do not claim real media validation"); return; }
  const f = await fixture(t, { dependencies: { probe: undefined } });
  await exec(ffmpegPath, ["-y", "-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=160x120:r=10", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100", "-t", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", f.inputPath], { windowsHide: true });
  const bytes = await fsp.readFile(f.inputPath);
  const calls = [];
  const service = createWuhenService({ transportManager: f.manager, receiptWaitMs: 0, transport: async (value, init) => {
    const url = new URL(value); calls.push(url.pathname);
    if (url.pathname.endsWith("access_token")) return response({ access_token: "mock-token", expired: Math.floor(Date.now() / 1000) + 1000 });
    if (url.pathname.endsWith("/me")) return response({ balance: 1000 });
    if (url.pathname.endsWith("video_removal")) return response({ task_id: "real-media-mock" });
    if (url.pathname.endsWith("/status")) {
      const saved = JSON.parse(await fsp.readFile(f.statePath));
      await fetch(saved.transport.uploadUrl, { method: "PUT", body: bytes }); return response({ status: "success" });
    }
    return response({ total_pages: 0, items: [] });
  } });
  const result = await service.removeVideoSubtitles({ ...f.args, options: { rect: { x1: 0, y1: 80, x2: 160, y2: 110 } } });
  assert.equal(result.outputMedia.width, 160); assert.equal(result.outputMedia.height, 120); assert.equal(result.outputMedia.hasAudio, true);
  assert.equal(result.job.stage, "completed"); assert.deepEqual(await fsp.readFile(result.outputPath), bytes); assert.deepEqual(await fsp.readFile(f.inputPath), bytes);
  assert.equal(calls.filter((endpoint) => endpoint.endsWith("video_removal")).length, 1);
  await waitForBilling(f.statePath);
});
