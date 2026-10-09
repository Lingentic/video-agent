import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../../../electron/main.mjs", import.meta.url), "utf8");

test("stop IPC sends only the run ID and local stop stage", async () => {
  const preload = await readFile(new URL("../../../electron/preload.cjs", import.meta.url), "utf8");
  let api;
  const calls = [];
  vm.runInNewContext(preload, { require: () => ({
    contextBridge: { exposeInMainWorld: (_, value) => { api = value; } },
    ipcRenderer: { invoke: (...args) => calls.push(args) }, webUtils: {}
  }) });
  api.stopKlingRun("saved-run", "video");
  assert.deepEqual(calls[0], ["kling-stop-run", "saved-run", "video"]);
  const snippet = source.slice(source.indexOf("async function stopKlingRun("), source.indexOf("async function retryKlingImage("));
  const stop = Function("klingRequest", `${snippet}; return stopKlingRun;`)(async (...args) => { calls.push(args); return {userStopped:{stage:"video"}}; });
  await stop("saved-run", "video");
  assert.equal(calls[1][0], "api/runs/saved-run/stop");
  assert.deepEqual(JSON.parse(calls[1][1].body), {stage:"video"});
  await assert.rejects(stop("saved-run", "upload"), /未找到可中止/);
  assert.equal(calls.length, 2);
});

test("ended image runs and stopped video waits are not automatically restored", async () => {
  const snippet = source.slice(source.indexOf("async function getLatestRecoverableKlingRun("), source.indexOf("async function readEnvValue("));
  const runs = [
    {id:"stopped-image",stage:"image",imageProvider:"wawapi",status:"SUCCEEDED",userStopped:{stage:"image"}},
    {id:"stopped-video",stage:"video",status:"PROCESSING",videoTaskId:"paid-task",editedKeyframes:[{}],userStopped:{stage:"video"}},
    {id:"blocked-variant",stage:"video",status:"FAILED",editedKeyframes:[{}],userStopped:{stage:"video",inheritedFromRunId:"stopped-video"}},
    {id:"interrupted",stage:"video",status:"PROCESSING",videoTaskId:"other-paid-task",editedKeyframes:[{}]}
  ];
  const latest = Function("klingRequest", `${snippet}; return getLatestRecoverableKlingRun;`)(async () => ({runs,baseUrl:"http://localhost/"}));
  assert.equal((await latest()).run.id, "interrupted");
  runs.pop();
  assert.equal((await latest()).run, null);
});
