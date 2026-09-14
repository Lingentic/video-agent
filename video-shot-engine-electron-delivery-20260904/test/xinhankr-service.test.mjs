import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createXinhankrService } from "../src/xinhankr-service.mjs";

const errorResponse = (status = 400) => new Response(JSON.stringify({ error: { message: "Request contains an invalid argument." } }), { status, headers: { "content-type": "application/json" } });
const successResponse = (text = '{"shots":[]}', tokens = { promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12 }) => new Response(JSON.stringify({ candidates: [{ finishReason: "STOP", content: { parts: [{ text }] } }], usageMetadata: tokens }), { status: 200, headers: { "content-type": "application/json" } });

async function withVideo(run) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "xinhankr-service-test-"));
  const file = path.join(dir, "video.mp4");
  await fsp.writeFile(file, "video");
  const originalFetch = globalThis.fetch;
  try { return await run(file); }
  finally { globalThis.fetch = originalFetch; await fsp.rm(dir, { recursive: true, force: true }); }
}

test("retries the same schema level once and always disables thinking", async () => withVideo(async (file) => {
  const requests = [];
  globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return requests.length === 1 ? errorResponse() : successResponse();
  };
  const service = createXinhankrService({ apiKey: "test", model: "test", retryDelaysMs: [0, 0, 0] });
  const result = await service.analyze(file, { prompt: "test", schema: { type: "object" } });
  assert.equal(requests.length, 2);
  assert.ok(requests[0].generationConfig.responseJsonSchema);
  assert.ok(requests[1].generationConfig.responseJsonSchema);
  assert.equal(requests[0].generationConfig.thinkingConfig.thinkingBudget, 0);
  assert.equal(requests[1].generationConfig.thinkingConfig.thinkingBudget, 0);
  assert.equal(result.requestAttempts[1].level, 1);
  assert.equal(result.requestAttempts[1].repeat, 2);
}));

test("uses prompt-only mode only after two failures in each earlier level", async () => withVideo(async (file) => {
  const requests = [];
  globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return requests.length < 5 ? errorResponse() : successResponse();
  };
  const service = createXinhankrService({ apiKey: "test", model: "test", retryDelaysMs: [0, 0, 0] });
  const result = await service.analyze(file, { prompt: "test", schema: { type: "object" } });
  assert.equal(requests.length, 5);
  assert.equal(requests[2].generationConfig.responseJsonSchema, undefined);
  assert.equal(requests[2].generationConfig.responseMimeType, "application/json");
  assert.equal(requests[4].generationConfig.responseJsonSchema, undefined);
  assert.equal(requests[4].generationConfig.responseMimeType, undefined);
  assert.equal(requests[4].generationConfig.thinkingConfig.thinkingBudget, 0);
  assert.equal(result.acceptedMode, "prompt-json-only");
  assert.equal(result.acceptedRepeat, 1);
}));

test("retries invalid content with feedback and accumulates both billed responses", async () => withVideo(async (file) => {
  const requests = [];
  globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return requests.length === 1 ? successResponse('{"bad":true}') : successResponse('{"shots":[]}');
  };
  const service = createXinhankrService({ apiKey: "test", model: "test", retryDelaysMs: [0, 0, 0] });
  const result = await service.analyze(file, { prompt: "test", schema: { type: "object" } }, { validateParsed: (value) => { if (!Array.isArray(value.shots)) throw new Error("缺少 shots 数组"); } });
  assert.equal(requests.length, 2);
  assert.match(requests[1].contents[0].parts[1].text, /缺少 shots 数组/);
  assert.equal(result.usage.total_tokens, 24);
  assert.equal(result.usage.estimated_cost_yuan, 0.00006);
  assert.equal(result.requestAttempts[0].validation, "failed");
  assert.equal(result.requestAttempts[1].accepted, true);
}));

test("marks a transport timeout cost unknown and retries the same level", async () => withVideo(async (file) => {
  const requests = [];
  globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(init.body));
    if (requests.length === 1) { const error = new Error("timeout"); error.name = "TimeoutError"; throw error; }
    return successResponse();
  };
  const service = createXinhankrService({ apiKey: "test", model: "test", retryDelaysMs: [0, 0, 0] });
  const result = await service.analyze(file, { prompt: "test", schema: { type: "object" } });
  assert.equal(requests.length, 2);
  assert.equal(result.unknownCostAttempts, 1);
  assert.equal(result.requestAttempts[0].costStatus, "unknown");
  assert.equal(result.requestAttempts[1].repeat, 2);
}));
