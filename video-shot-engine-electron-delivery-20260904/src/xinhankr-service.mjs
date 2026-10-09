import fsp from "node:fs/promises";
import { calculateCostYuan } from "./pricing.mjs";

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const stripFence = (text) => String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
const MODES = [
  { id: "json-response-schema", responseMimeType: true, schema: true },
  { id: "json-mime-only", responseMimeType: true, schema: false },
  { id: "prompt-json-only", responseMimeType: false, schema: false },
];

function usageFromBody(body) {
  const raw = body?.usageMetadata || {};
  const usage = {
    total_tokens: Number(raw.totalTokenCount || 0),
    total_input_tokens: Number(raw.promptTokenCount || 0),
    total_output_tokens: Number(raw.candidatesTokenCount || 0),
    total_thought_tokens: Number(raw.thoughtsTokenCount || 0),
    raw,
  };
  usage.estimated_cost_yuan = calculateCostYuan(usage);
  return usage;
}

function sumUsage(usages) {
  const total = usages.reduce((sum, usage) => {
    sum.total_tokens += Number(usage?.total_tokens || 0);
    sum.total_input_tokens += Number(usage?.total_input_tokens || 0);
    sum.total_output_tokens += Number(usage?.total_output_tokens || 0);
    sum.total_thought_tokens += Number(usage?.total_thought_tokens || 0);
    return sum;
  }, { total_tokens: 0, total_input_tokens: 0, total_output_tokens: 0, total_thought_tokens: 0 });
  total.estimated_cost_yuan = calculateCostYuan(total);
  return total;
}

function requestTimeoutMs(durationSec) {
  if (Number(durationSec) > 180) return 600_000;
  if (Number(durationSec) > 90) return 450_000;
  return 300_000;
}

function attachDiagnostics(error, requestAttempts, providerResponses, usages) {
  error.requestAttempts = requestAttempts;
  error.providerResponses = providerResponses;
  error.usage = sumUsage(usages);
  error.unknownCostAttempts = requestAttempts.filter((attempt) => attempt.costStatus === "unknown").length;
  return error;
}

export function createXinhankrService({ apiKey, model, baseUrl = "https://token.xinhankr.com", retryDelaysMs = [5000, 8000, 12000], sleep = defaultSleep }) {
  const waitForRetry = async (ms, signal) => {
    if (!signal) return sleep(ms);
    signal.throwIfAborted();
    let onAbort;
    try {
      await Promise.race([sleep(ms), new Promise((_, reject) => {
        onAbort = () => reject(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
      })]);
      signal.throwIfAborted();
    } finally { signal.removeEventListener("abort", onAbort); }
  };
  return {
    async uploadVideo(filePath, displayName, mimeType) {
      const stat = await fsp.stat(filePath);
      return { name: `local:${displayName}`, uri: filePath, mimeType, state: "ACTIVE", uploadMethod: "google-native-inlineData-compressed-proxy", fileBytes: stat.size, base64EstimatedBytes: Math.ceil(stat.size * 4 / 3) };
    },
    async waitForFile(name, onState) {
      const file = { name, state: "ACTIVE" };
      await onState?.(file);
      return file;
    },
    async analyze(filePath, profile, { validateParsed, onAttempt, signal } = {}) {
      signal?.throwIfAborted();
      const data = (await fsp.readFile(filePath)).toString("base64");
      const requestAttempts = [];
      const providerResponses = [];
      const usages = [];
      const timeoutMs = requestTimeoutMs(profile.durationSec);
      let lastError;
      let correction = "";
      let requestNumber = 0;

      for (let levelIndex = 0; levelIndex < MODES.length; levelIndex += 1) {
        const mode = MODES[levelIndex];
        for (let repeat = 1; repeat <= 2; repeat += 1) {
          signal?.throwIfAborted();
          requestNumber += 1;
          const startedAt = new Date().toISOString();
          const generationConfig = { temperature: 0, maxOutputTokens: mode.responseMimeType ? 12000 : 8000, thinkingConfig: { thinkingBudget: 0 } };
          if (mode.responseMimeType) generationConfig.responseMimeType = "application/json";
          if (mode.schema) generationConfig.responseJsonSchema = profile.schema;
          const prompt = correction ? `${profile.prompt}\n\n上一次输出未通过程序校验：${correction}\n请重新生成完整结果，并修正上述问题。` : profile.prompt;
          const attemptRecord = { requestNumber, level: levelIndex + 1, repeat, schemaMode: mode.id, startedAt, thinkingBudget: 0, timeoutMs };
          let response;

          try {
            response = await fetch(`${baseUrl.replace(/\/$/, "")}/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
              method: "POST",
              headers: { "X-Goog-Api-Key": apiKey, "Content-Type": "application/json" },
              body: JSON.stringify({ contents: [{ role: "user", parts: [{ inlineData: { mimeType: "video/mp4", data } }, { text: prompt }] }], generationConfig }),
              signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
            });
          } catch (cause) {
            const waitMs = repeat === 1 ? Number(retryDelaysMs[levelIndex] || 0) : 0;
            Object.assign(attemptRecord, { finishedAt: new Date().toISOString(), status: null, outcome: "transport_error", costStatus: "unknown", waitMs, transportError: { name: cause?.name || "Error", message: cause?.message || String(cause) } });
            requestAttempts.push(attemptRecord);
            lastError = attachDiagnostics(cause, requestAttempts, providerResponses, usages);
            await onAttempt?.({ requestAttempts, providerResponses, usage: lastError.usage, latest: attemptRecord });
            if (signal?.aborted) throw lastError;
            if (repeat === 1) { await waitForRetry(waitMs, signal); continue; }
            break;
          }

          const body = await response.json().catch(() => ({}));
          const usage = response.ok ? usageFromBody(body) : null;
          if (usage) usages.push(usage);
          const waitMs = repeat === 1 ? Number(retryDelaysMs[levelIndex] || 0) : 0;
          Object.assign(attemptRecord, { finishedAt: new Date().toISOString(), status: response.status, costStatus: response.ok ? "known" : "no_usage_returned", ...(usage ? { usage } : {}) });

          if (!response.ok) {
            const error = new Error(body?.error?.message || `xinhankr HTTP ${response.status}`);
            error.status = response.status;
            error.providerResponse = body;
            const retryable = response.status === 400 || response.status >= 500;
            Object.assign(attemptRecord, { outcome: "http_error", waitMs: retryable && repeat === 1 ? waitMs : 0 });
            requestAttempts.push(attemptRecord);
            lastError = attachDiagnostics(error, requestAttempts, providerResponses, usages);
            await onAttempt?.({ requestAttempts, providerResponses, usage: lastError.usage, latest: attemptRecord });
            if ([401, 402, 403, 404, 429].includes(response.status) || !retryable) throw lastError;
            if (repeat === 1) { await waitForRetry(waitMs, signal); continue; }
            break;
          }

          const text = body?.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("") || "";
          const finishReason = body?.candidates?.[0]?.finishReason || "unknown";
          providerResponses.push({ requestNumber, level: levelIndex + 1, repeat, schemaMode: mode.id, response: body });
          let parsed;
          let validationError;
          try {
            if (!text) throw new Error(`xinhankr 没有返回正文，finishReason=${finishReason}`);
            parsed = JSON.parse(stripFence(text));
            await validateParsed?.(parsed);
          } catch (cause) {
            validationError = cause;
          }

          if (validationError) {
            correction = validationError.message;
            Object.assign(attemptRecord, { outcome: "validation_failed", validation: "failed", validationError: validationError.message, finishReason, waitMs });
            requestAttempts.push(attemptRecord);
            lastError = new Error(`Gemini 输出未通过校验：${validationError.message}`);
            lastError.providerResponse = body;
            lastError = attachDiagnostics(lastError, requestAttempts, providerResponses, usages);
            await onAttempt?.({ requestAttempts, providerResponses, usage: lastError.usage, latest: attemptRecord });
            if (repeat === 1) { await waitForRetry(waitMs, signal); continue; }
            break;
          }

          Object.assign(attemptRecord, { outcome: "accepted", validation: "passed", finishReason, waitMs: 0, accepted: true });
          requestAttempts.push(attemptRecord);
          const usageTotal = sumUsage(usages);
          await onAttempt?.({ requestAttempts, providerResponses, usage: usageTotal, latest: attemptRecord });
          return { interaction: body, parsed, usage: usageTotal, acceptedUsage: usage, requestAttempts, providerResponses, acceptedMode: mode.id, acceptedLevel: levelIndex + 1, acceptedRepeat: repeat, unknownCostAttempts: requestAttempts.filter((attempt) => attempt.costStatus === "unknown").length };
        }
      }

      throw attachDiagnostics(lastError || new Error("xinhankr 所有请求层级均失败"), requestAttempts, providerResponses, usages);
    },
  };
}
