import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const main = await readFile(new URL("../main.mjs", import.meta.url), "utf8");
const preload = await readFile(new URL("../preload.cjs", import.meta.url), "utf8");
const renderer = await readFile(new URL("../renderer/app.js", import.meta.url), "utf8");
function fragment(source, start, end) {
  const index = source.indexOf(start);
  assert.notEqual(index, -1);
  const last = source.indexOf(end, index);
  assert.notEqual(last, -1);
  return source.slice(index, last);
}
function requestHarness(fetch) {
  const events = [], handles = new Map();
  const deps = { fetch, diagnostics: { record: async (...args) => events.push(args) }, ipcMain: { handle: (channel, handler) => handles.set(channel, handler) } };
  const api = Function("deps", `const {fetch,diagnostics,ipcMain}=deps;${fragment(main, "function diagnosticError(", "function findFreePort(")}return {diagnosticJsonRequest,handleClientIpc};`)(deps);
  return { ...api, events, handles };
}

test("request logging retains status and task identity, never the request body or credentials", async () => {
  const body = { run: { id: "run-test", stage: "video", status: "processing", videoTaskId: "cloud-test", voiceScript: "private-dialogue" } };
  const api = requestHarness(async () => new Response(JSON.stringify(body), { headers: { "x-request-id": "request-test" } }));
  const result = await api.diagnosticJsonRequest("remake", "api/runs/run-test", "http://localhost", { method: "POST", headers: { Authorization: "secret-header" }, body: "private-payload" }, "failed");
  assert.deepEqual(result, body);
  assert.equal(api.events[0][1].cloudTaskId, "cloud-test");
  assert.equal(api.events[0][1].requestId, "request-test");
  assert.doesNotMatch(JSON.stringify(api.events), /secret-header|private-payload|private-dialogue/);
});

test("network failures and HTTP errors are logged without resubmission or changing rejection identity", async () => {
  const failure = new Error("connection reset", { cause: { code: "ECONNRESET" } });
  let calls = 0;
  const api = requestHarness(async () => { calls++; throw failure; });
  await assert.rejects(api.diagnosticJsonRequest("shot", "api/config", "http://localhost", {}, "failed"), error => error === failure);
  assert.equal(calls, 1);
  assert.equal(api.events[0][1].error.cause.code, "ECONNRESET");
  const http = requestHarness(async () => new Response(JSON.stringify({ error: "provider unavailable" }), { status: 503 }));
  await assert.rejects(http.diagnosticJsonRequest("shot", "api/runs", "http://localhost", {}, "failed"), /provider unavailable/);
  assert.equal(http.events[0][1].httpStatus, 503);
  assert.equal(http.events[1][0], "request.failed");
});

test("HTTP success with a failed task or failed folder item saves a separate error event", async () => {
  const batch = { batchId: "batch-test", status: "partial" };
  const payload = { batch, items: [{ videoId: "video_001", status: "failed", stage: "naming", error: "quota exhausted", sourceFilename: "private.mp4", prompt: "private prompt" }] };
  const api = requestHarness(async () => new Response(JSON.stringify(payload)));
  assert.deepEqual(await api.diagnosticJsonRequest("shot", "api/batches/batch-test", "http://localhost", {}, "failed"), payload);
  const event = api.events.find(([name]) => name === "task.failed");
  assert.equal(event[1].runId, "batch-test");
  assert.equal(event[1].failedItems[0].videoId, "video_001");
  assert.equal(event[2], "error");
  assert.doesNotMatch(JSON.stringify(event), /private.mp4|private prompt/);
  const runApi = requestHarness(async () => new Response(JSON.stringify({ run: { id: "run-test", status: "FAILED", stage: "video", message: "timeout" } })));
  await runApi.diagnosticJsonRequest("remake", "api/runs/run-test", "http://localhost", {}, "failed");
  assert.equal(runApi.events.find(([name]) => name === "task.failed")[1].error, "timeout");
});

test("operation hooks preserve IPC arguments and results but do not log them", async () => {
  const api = requestHarness();
  const payload = { voiceScript: "private-dialogue", sourcePath: "private-file", apiKey: "private-key" };
  const result = { runId: "run-test", output: "private-result" };
  api.handleClientIpc("kling-create-run", async (_event, args) => { assert.equal(args, payload); return result; });
  assert.equal(await api.handles.get("kling-create-run")({}, payload), result);
  assert.deepEqual(api.events.map(([name]) => name), ["operation.started", "operation.completed"]);
  assert.equal(api.events[1][1].runId, "run-test");
  assert.doesNotMatch(JSON.stringify(api.events), /private-dialogue|private-file|private-key|private-result/);
  const failure = new Error("operation failed");
  api.handleClientIpc("voice-create", async () => { throw failure; });
  await assert.rejects(api.handles.get("voice-create")({}), error => error === failure);
  assert.equal(api.events.at(-1)[0], "operation.failed");
});

test("preload offers only a path-free export request and a one-way error reporting channel", () => {
  const calls = []; let bridge;
  vm.runInNewContext(preload, { require: () => ({ contextBridge: { exposeInMainWorld: (_name, value) => { bridge = value; } }, ipcRenderer: { invoke: (...args) => calls.push(args), send: (...args) => calls.push(args) }, webUtils: {} }) });
  bridge.exportDiagnostics("untrusted-destination");
  bridge.reportDiagnostic({ message: "renderer failed" });
  assert.deepEqual(calls[0], ["export-diagnostics"]);
  assert.equal(calls[1][0], "diagnostics-event");
});

function exportHarness(selection) {
  const events = [], handles = new Map(), revealed = [];
  const deps = {
    path, app: { getPath: () => "desktop" }, mainWindow: {},
    dialog: { showSaveDialog: async () => selection },
    diagnostics: { record: async (...args) => events.push(args), exportBundle: async (target, options) => { events.push(["bundle", options]); return { path: target, fileCount: 3, taskCount: 1, warnings: [] }; } },
    shell: { showItemInFolder: target => revealed.push(target) },
    services: new Map([["shot", { key: "shot", status: "ready", port: 1234 }]]),
    serializeService: service => service, loadDiagnosticSecrets: async () => events.push(["secrets.loaded"]),
    handleClientIpc: (channel, handler) => handles.set(channel, handler)
  };
  Function("deps", `const {${Object.keys(deps).join(",")}}=deps;let diagnosticExportPending=false;${fragment(main, 'handleClientIpc("export-diagnostics",', 'ipcMain.on("diagnostics-event",')}`)(deps);
  return { ...deps, events, revealed, handler: handles.get("export-diagnostics") };
}

test("cancelled export creates no bundle, and export completion reveals the user's selected file", async () => {
  const cancelled = exportHarness({ canceled: true });
  assert.deepEqual(await cancelled.handler(), { canceled: true });
  assert.equal(cancelled.events.length, 0);
  const api = exportHarness({ canceled: false, filePath: "selected.zip" });
  assert.deepEqual(await api.handler(), { canceled: false, path: "selected.zip", fileCount: 3, taskCount: 1, warningCount: 0 });
  assert.deepEqual(api.revealed, ["selected.zip"]);
  assert.equal(api.events[0][0], "secrets.loaded");
  assert.equal(api.events[2][0], "bundle");
});

test("an export failure releases the pending guard so the user can retry", async () => {
  const api = exportHarness({ canceled: false, filePath: "selected.zip" });
  api.diagnostics.exportBundle = async () => { throw new Error("disk is read-only"); };
  await assert.rejects(api.handler(), /read-only/);
  api.diagnostics.exportBundle = async target => ({ path: target, fileCount: 2, taskCount: 0 });
  assert.equal((await api.handler()).canceled, false);
});

test("renderer export button suppresses duplicate clicks and resets on cancel or failure", async () => {
  let listener; const notices = [], errors = [];
  const button = { disabled: false, textContent: "导出诊断日志", addEventListener: (_event, fn) => { listener = fn; } };
  const videoClient = { exportDiagnostics: async () => ({ canceled: true }), reportDiagnostic: value => errors.push(value) };
  vm.runInNewContext(fragment(renderer, 'document.querySelector("#exportDiagnostics")', 'window.addEventListener("error",'), { document: { querySelector: () => button }, videoClient, notify: message => notices.push(message), cleanRemoteError: error => error.message });
  await listener({ currentTarget: button });
  assert.equal(button.disabled, false); assert.equal(notices.length, 0);
  button.disabled = true; let calls = 0;
  videoClient.exportDiagnostics = async () => { calls++; throw new Error("disk full"); };
  await listener({ currentTarget: button }); assert.equal(calls, 0);
  button.disabled = false; await listener({ currentTarget: button });
  assert.equal(button.disabled, false); assert.equal(button.textContent, "导出诊断日志");
  assert.match(notices[0], /可写入/); assert.equal(errors[0].message, "disk full");
});
