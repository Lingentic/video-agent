import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { ffprobePath } from "./runtime-paths.mjs";

const execFileAsync = promisify(execFile);
const API = "https://api.wuhenai.com/v2/";
const activeJobs = new Set();
const DEFAULT_SUBTITLE_RECT = Object.freeze({ x1: 0.05, y1: 0.60, x2: 0.95, y2: 0.85 });
function failure(code, stage, message) { return Object.assign(new Error(message), { code, stage }); }
const badOptions = () => failure("OPTIONS_INVALID", "preparing", "无痕模型、方式或字幕区域无效；区域须为有效原始像素框且面积不超过 480000。");

export function validateWuhenOptions(options = {}, media = null) {
  if (!options || typeof options !== "object" || Array.isArray(options)) throw badOptions();
  const model = options.model ?? "video_removal_std", method = options.method ?? "sel_area";
  if (!["video_removal_std", "video_removal_pro"].includes(model) || !["sel_area", "all_area"].includes(method)) throw badOptions();
  if (method === "all_area") {
    if (options.rect != null || options.rectNormalized != null) throw badOptions();
    return { model, method };
  }
  if (options.rect == null && options.rectNormalized == null) options = { ...options, rectNormalized: DEFAULT_SUBTITLE_RECT };
  if ((options.rect == null) === (options.rectNormalized == null)) throw badOptions();
  const normalized = options.rectNormalized != null;
  const supplied = normalized ? options.rectNormalized : options.rect;
  if (!supplied || typeof supplied !== "object" || Array.isArray(supplied)) throw badOptions();
  const rect = Object.fromEntries(["x1", "y1", "x2", "y2"].map((key) => [key, supplied[key]]));
  if (!Object.values(rect).every((value) => Number.isFinite(value) && value >= 0 && (normalized ? value <= 1 : Number.isSafeInteger(value)))
    || rect.x2 <= rect.x1 || rect.y2 <= rect.y1) throw badOptions();
  if (normalized && !media) return { model, method, rectNormalized: rect };
  if (normalized) {
    for (const key of Object.keys(rect)) {
      const value = rect[key] * (key.startsWith("x") ? media.width : media.height);
      rect[key] = key.endsWith("1") ? Math.floor(value) : Math.ceil(value);
    }
  }
  if (!Object.values(rect).every(Number.isSafeInteger) || rect.x2 <= rect.x1 || rect.y2 <= rect.y1
    || (rect.x2 - rect.x1) * (rect.y2 - rect.y1) > 480000 || (media && (rect.x2 > media.width || rect.y2 > media.height))) throw badOptions();
  return { model, method, rect };
}

export function publicWuhenJob(job) {
  const keys = ["id", "provider", "apiVersion", "stage", "taskId", "status", "model", "method", "rect", "progress", "queueAhead",
    "estimatedCredits", "balanceBefore", "createdAt", "updatedAt", "submissionStartedAt", "submittedAt", "lastQueryAt", "remoteCompletedAt", "completedAt",
    "durationDeltaSec", "durationToleranceSec", "billing", "billingWarning"];
  const result = Object.fromEntries(keys.filter((key) => job[key] !== undefined).map((key) => [key, job[key]]));
  if (job.error) result.error = { code: job.error.code, stage: job.error.stage, message: job.error.message };
  return result;
}

async function atomicSave(file, job, { rename = fsp.rename, retrySleep = (ms) => delay(ms) } = {}) {
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await fsp.open(temp, "wx", 0o600);
    try { await handle.writeFile(`${JSON.stringify(job, null, 2)}\n`); await handle.sync(); } finally { await handle.close(); }
    for (let attempt = 0; ; attempt += 1) {
      try { await rename(temp, file); break; }
      catch (error) {
        if (!["EPERM", "EBUSY"].includes(error.code) || attempt >= 4) throw error;
        await retrySleep(25 * 2 ** attempt);
      }
    }
  } finally { await fsp.rm(temp, { force: true }); }
}

async function acquireLock(dir) {
  const file = path.join(dir, "job.lock"), token = randomUUID();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await fsp.open(file, "wx", 0o600);
      try { await handle.writeFile(JSON.stringify({ pid: process.pid, token })); } finally { await handle.close(); }
      return async () => {
        const current = await fsp.readFile(file, "utf8").then(JSON.parse).catch(() => null);
        if (current?.token === token) await fsp.rm(file, { force: true });
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw failure("STATE_WRITE_FAILED", "preparing", "无法保存无痕任务执行锁。");
      const previous = await fsp.readFile(file, "utf8").then(JSON.parse).catch(() => null);
      if (!Number.isInteger(previous?.pid) || previous.pid <= 0) break;
      let alive = true;
      try { process.kill(previous.pid, 0); } catch (error) { alive = error.code !== "ESRCH"; }
      if (alive) break;
      const current = await fsp.readFile(file, "utf8").then(JSON.parse).catch(() => null);
      if (current?.token !== previous.token) break;
      await fsp.rm(file, { force: true });
    }
  }
  throw failure("JOB_BUSY", "preparing", "此无痕任务已有执行者。");
}

async function defaultProbe(file, signal) {
  const { stdout } = await execFileAsync(ffprobePath, ["-v", "error", "-show_format", "-show_streams", "-of", "json", file],
    { signal, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  const raw = JSON.parse(stdout), video = raw.streams?.find((stream) => stream.codec_type === "video");
  const audio = raw.streams?.find((stream) => stream.codec_type === "audio");
  const [n, d] = String(video?.avg_frame_rate || "0/1").split("/").map(Number);
  return { durationSec: Number(raw.format?.duration), width: Number(video?.width), height: Number(video?.height), hasVideo: Boolean(video), hasAudio: Boolean(audio),
    videoCodec: video?.codec_name || null, audioCodec: audio?.codec_name || null, formatName: raw.format?.format_name || "", fps: Number.isFinite(n / d) ? n / d : null };
}
function validMedia(media) {
  return media?.hasVideo === true && Number.isFinite(media.durationSec) && media.durationSec > 0
    && Number.isSafeInteger(media.width) && media.width > 0 && Number.isSafeInteger(media.height) && media.height > 0;
}

/** Uses the same process fetch/proxy configuration as splitting and naming. */
export function createWuhenService(dependencies = {}) {
  const { transportManager } = dependencies;
  const transport = dependencies.transport || ((url, init) => fetch(url, init));
  const probe = dependencies.probe || defaultProbe;
  const now = dependencies.now || Date.now;
  const sleep = dependencies.sleep || ((ms, signal) => delay(ms, undefined, { signal }));
  const nonce = dependencies.nonce || randomUUID;
  const writeState = (file, value) => atomicSave(file, value, { rename: dependencies.rename, retrySleep: dependencies.stateRetrySleep });
  const pollMs = dependencies.pollMs ?? 15_000, observationMs = dependencies.observationMs ?? 30 * 60_000;
  const receiptWaitMs = dependencies.receiptWaitMs ?? 60_000;
  const tokens = new Map();

  async function execute({ runDir, inputPath, apiKey, options = {}, signal, onStage, recoveryJob }, dir) {
    const releaseLock = await acquireLock(dir);
    const statePath = path.join(dir, "job.json"), outputPath = path.join(dir, "output.mp4");
    let job;
    const stamp = () => new Date(now()).toISOString();
    const save = async () => {
      job.updatedAt = stamp();
      try { await writeState(statePath, job); }
      catch { throw failure("STATE_WRITE_FAILED", job.stage, "无痕任务状态暂时无法落盘；已保留可取得的任务 ID，请恢复原任务。"); }
    };
    const stage = async (value) => {
      job.stage = value; delete job.error; await save();
      await onStage?.(`subtitle_${value}`, publicWuhenJob(job));
    };
    const abort = () => { if (signal?.aborted) throw failure("WAITING_PAUSED", job?.stage || "preparing", "已停止本机等待；已提交的无痕任务仍可能继续处理。"); };
    const request = async (endpoint, { method = "GET", body, params = {}, token, timeoutMs = 60_000 } = {}) => {
      abort();
      const url = new URL(endpoint, API);
      url.search = new URLSearchParams({ ...params, nonce: nonce(), t: String(Math.floor(now() / 1000)) }).toString();
      let response;
      try {
        response = await transport(url.href, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
          ...(body ? { body: JSON.stringify(body) } : {}), redirect: "manual",
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs) });
        let parsed;
        try { parsed = await response.json(); } catch { throw failure("PROTOCOL_ERROR", job.stage, "无痕响应不是有效 JSON。"); }
        return { ok: response.ok, httpStatus: response.status, body: parsed };
      } catch (error) {
        abort();
        if (error.code === "PROTOCOL_ERROR") throw error;
        throw failure("NETWORK_FAILED", job.stage, "无痕网络请求失败或超时；已保留原任务状态。");
      } finally { await response?.release?.(); }
    };
    const token = async () => {
      if (typeof apiKey !== "string" || !apiKey.trim()) throw failure("KEY_REQUIRED", job.stage, "请配置无痕 API Key 后继续。");
      const cacheId = createHash("sha256").update(apiKey).digest("hex"), existing = tokens.get(cacheId);
      if (existing && existing.expired > now() / 1000 + 30) return existing.accessToken;
      const response = await request("user/access_token", { params: { api_key: apiKey } });
      const data = response.body?.data;
      if (!response.ok || response.body?.code !== 0 || typeof data?.access_token !== "string" || !data.access_token.trim()
        || /[\r\n]/.test(data.access_token) || !Number.isFinite(Number(data.expired)) || Number(data.expired) <= now() / 1000) {
        throw failure("AUTH_FAILED", job.stage, "无法取得有效的无痕访问令牌。");
      }
      tokens.set(cacheId, { accessToken: data.access_token, expired: Number(data.expired) });
      return data.access_token;
    };
    const authed = async (endpoint, init = {}) => request(endpoint, { ...init, token: await token() });
    const inspectOutput = async (file) => {
      abort();
      let media, stat;
      try { stat = await fsp.stat(file); media = await probe(file, signal); }
      catch { abort(); throw failure("VALIDATION_FAILED", "validating", "无痕成品无法解析为有效视频。"); }
      const input = job.inputMedia, tolerance = Math.max(0.75, input.durationSec * 0.01);
      if (!stat.isFile() || !stat.size || !validMedia(media) || !/(?:^|,)(?:mov|mp4)(?:,|$)/.test(media.formatName || "")
        || media.width !== input.width || media.height !== input.height || (input.hasAudio && !media.hasAudio)
        || Math.abs(media.durationSec - input.durationSec) > tolerance) {
        throw failure("VALIDATION_FAILED", "validating", "无痕成品的容器、尺寸、时长或音轨校验未通过。");
      }
      job.outputMedia = media; job.durationDeltaSec = media.durationSec - input.durationSec; job.durationToleranceSec = tolerance;
      return media;
    };
    const finish = async (file) => {
      await stage("validating");
      const outputMedia = await inspectOutput(file);
      abort();
      if (file !== outputPath) {
        // Keep the receiver object for later identical PUT retries; output is a separate workflow resource.
        const temp = `${outputPath}.${randomUUID()}.tmp`;
        try { await fsp.copyFile(file, temp); await fsp.rename(temp, outputPath); }
        finally { await fsp.rm(temp, { force: true }); }
      }
      job.completedAt ||= stamp(); job.outputPath = outputPath;
      await stage("completed");
      return { outputPath, job: publicWuhenJob(job), inputMedia: job.inputMedia, outputMedia };
    };
    const collectBilling = async () => {
      const evidence = { taskId: job.taskId, checkedAt: stamp() };
      try {
        for (let page = 0; page < 3; page += 1) {
          const response = await authed("user/billings", { timeoutMs: 5000, params: { page_index: String(page), time_start: String(Math.floor(Date.parse(job.submissionStartedAt) / 1000) - 60) } });
          if (!response.ok || response.body?.code !== 0 || !Array.isArray(response.body?.data?.items)) throw new Error("billing");
          const item = response.body.data.items.find((entry) => entry.task_id === job.taskId && entry.billing_type === "consume");
          if (item) {
            const credits = Number(item.credits), metering = Number(item.metering);
            if (!Number.isFinite(credits) || !Number.isFinite(metering)) throw new Error("billing");
            Object.assign(evidence, { credits, metering }); break;
          }
          if (page + 1 >= Number(response.body.data.total_pages || 0)) break;
        }
        if (evidence.credits === undefined) evidence.warning = "BILLING_NOT_FOUND";
      } catch { evidence.warning = "BILLING_UNAVAILABLE"; }
      // An independent private artifact avoids racing completion/resume saves and never delays downstream work.
      await writeState(path.join(dir, "billing.json"), evidence).catch(() => {});
    };

    try {
      try { job = JSON.parse(await fsp.readFile(statePath, "utf8")); }
      catch (error) { if (error.code !== "ENOENT") throw failure("STATE_INVALID", "preparing", "无痕任务状态文件无法读取，请保留原文件核查。"); }
      if (job && (job.provider !== "wuhen" || !validMedia(job.inputMedia) || job.inputPath !== path.resolve(inputPath))) {
        throw failure("INPUT_CHANGED", "preparing", "保存的无痕任务与当前素材不一致，不能自动恢复。");
      }
      if (job && recoveryJob?.taskId) {
        const identity = recoveryJob.taskId;
        if (recoveryJob.provider !== "wuhen" || recoveryJob.id !== job.id || !job.submissionStartedAt || typeof identity !== "string"
          || !identity.trim() || identity.length > 256 || /[\u0000-\u001f\u007f]/.test(identity) || /https?:\/\//i.test(identity)
          || (apiKey && identity.includes(apiKey)) || (job.taskId && job.taskId !== identity.trim())) {
          throw failure("STATE_INVALID", "preparing", "外层任务身份与私有提交记录不一致，不能自动恢复。");
        }
        if (!job.taskId) { job.taskId = identity.trim(); job.submittedAt = recoveryJob.submittedAt || stamp(); job.status = "created"; await save(); }
      }
      if (job?.stage === "completed") return await finish(outputPath);
      if (!job) job = { id: randomUUID(), provider: "wuhen", apiVersion: "v2", stage: "preparing", inputPath: path.resolve(inputPath), createdAt: stamp() };
      abort();
      let inputStat, inputMedia;
      try { inputStat = await fsp.stat(inputPath); inputMedia = await probe(inputPath, signal); }
      catch { abort(); throw failure("INPUT_INVALID", "preparing", "输入视频不可读取或无法解析。"); }
      if (!inputStat.isFile() || !inputStat.size || !validMedia(inputMedia)) throw failure("INPUT_INVALID", "preparing", "输入须为非空且可解析的视频文件。");
      if (job.inputBytes !== undefined && (job.inputBytes !== inputStat.size || job.inputMtimeMs !== inputStat.mtimeMs)) {
        throw failure("INPUT_CHANGED", "preparing", "原视频已变更，不能复用此无痕任务。");
      }
      // Restore the saved model/region. Caller option changes cannot mutate an existing paid task.
      Object.assign(job, { inputBytes: inputStat.size, inputMtimeMs: inputStat.mtimeMs, inputMedia });
      const selected = validateWuhenOptions(job.model ? { model: job.model, method: job.method, ...(job.rect ? { rect: job.rect } : {}) } : options, inputMedia);
      Object.assign(job, selected); await save();
      if (!job.taskId && job.submissionStartedAt) throw failure("SUBMISSION_UNCERTAIN", "submission_uncertain", "原提交结果不确定且没有任务 ID；请核查云端，不能自动再次收费提交。");
      if (job.status === "failed") throw failure("REMOTE_FAILED", "remote_failed", "无痕原任务已失败，不能自动重新收费提交。");
      if (job.status === "paused") throw failure("REMOTE_PAUSED", "remote_paused", "无痕原任务已暂停，不能自动重新创建任务。");
      // Recover an atomically renamed, validated file even after a crash before completed was saved.
      if (job.remoteCompletedAt && await fsp.stat(outputPath).then((stat) => stat.isFile()).catch(() => false)) return await finish(outputPath);
      if (!transportManager) throw failure("TRANSPORT_NOT_READY", "preparing", "专用无痕传输接收器尚未启动。");
      if (job.taskId && (!job.transport || !await fsp.stat(path.join(dir, "transport.json")).then((stat) => stat.isFile()).catch(() => false))) {
        throw failure("TRANSPORT_LOST", "receiving", "原任务的传输恢复文件已丢失；保留 taskId，不能用新地址替换已提交的回传地址。");
      }
      const handle = await transportManager.prepare({ runDir, inputPath, jobId: job.id, replaceUnsubmitted: !job.taskId && !job.submissionStartedAt });
      if (job.taskId && ["id", "inputUrl", "uploadUrl", "probeUrl", "receivedPath", "expiresAt", "publicBaseUrl"].some((key) => job.transport[key] !== handle[key])) {
        throw failure("TRANSPORT_LOST", "receiving", "恢复文件与原任务已提交的传输地址不一致；已阻止替换原地址。");
      }
      job.transport = handle; await save();

      if (!job.taskId) {
        await stage("preparing");
        await transportManager.verify?.(handle, { signal });
        const account = await authed("user/me");
        const balance = Number(account.body?.data?.balance);
        if (!account.ok || account.body?.code !== 0 || !Number.isFinite(balance) || balance < 0) throw failure("BALANCE_FAILED", "preparing", "无法读取无痕可用积分余额。");
        job.balanceBefore = balance;
        if (job.method === "sel_area") {
          job.estimatedCredits = Math.ceil(inputMedia.durationSec) * (job.model === "video_removal_pro" ? 2 : 1);
          if (balance < job.estimatedCredits) throw failure("INSUFFICIENT_BALANCE", "preparing", "无痕可用积分低于本次区域去字幕估算，请核查余额。");
        }
        const accessToken = await token();
        job.submissionStartedAt = stamp(); await stage("submitting");
        let response;
        try {
          response = await request("video_removal", { method: "POST", token: accessToken,
            body: { video_url: handle.inputUrl, upload_url: handle.uploadUrl, upload_headers: handle.uploadHeaders, ...selected } });
          const taskId = response.body?.data?.task_id;
          if (typeof taskId === "string" && taskId.trim() && taskId.length <= 256 && !/[\u0000-\u001f\u007f]/.test(taskId)
            && !/https?:\/\//i.test(taskId) && !taskId.includes(apiKey) && !taskId.includes(accessToken)) {
            job.taskId = taskId.trim(); job.submittedAt = stamp(); job.status = "created";
            job.stage = "submitted"; delete job.error;
            // Notify the outer durable task record as soon as identity is known. Private persistence is still mandatory.
            try { await onStage?.("subtitle_submitted", publicWuhenJob(job)); }
            finally { await save(); }
          }
          if (!response.ok || response.body?.code !== 0 || !job.taskId) {
            throw failure(!job.taskId && [401, 403].includes(response.httpStatus) ? "SUBMISSION_REJECTED" : "SUBMISSION_UNCERTAIN", "submitting",
              "无痕提交响应无法确认结果；已保存提交记录和可取得的任务 ID，不能自动重提。");
          }
        } catch (error) {
          if (["SUBMISSION_REJECTED", "SUBMISSION_UNCERTAIN", "STATE_WRITE_FAILED"].includes(error.code)) throw error;
          throw failure("SUBMISSION_UNCERTAIN", "submitting", "无痕提交结果不确定；已保存记录，不能自动再次收费提交。");
        }
      }

      const deadline = now() + observationMs;
      while (!job.remoteCompletedAt) {
        abort();
        if (now() >= deadline) throw failure("QUERY_INTERRUPTED", job.stage, "本机观察窗口已结束；保留原 taskId，可继续查询原任务。");
        let response;
        try { response = await authed("status", { params: { task_id: job.taskId } }); }
        catch (error) { if (error.code === "WAITING_PAUSED" || error.code === "KEY_REQUIRED" || error.code === "AUTH_FAILED") throw error; throw failure("QUERY_INTERRUPTED", job.stage, "无痕状态查询中断；已保留原 taskId。"); }
        const remote = response.body?.data;
        if (!response.ok || response.body?.code !== 0 || !["created", "queued", "processing", "success", "failed", "paused"].includes(remote?.status)) {
          throw failure("QUERY_INTERRUPTED", job.stage, "无痕状态响应无效；已保留原 taskId，不能重新提交。");
        }
        job.status = remote.status; job.lastQueryAt = stamp(); delete job.progress; delete job.queueAhead;
        if (remote.status === "queued") {
          const queue = Number(remote.progress);
          if (!Number.isSafeInteger(queue) || queue < 0) throw failure("QUERY_INTERRUPTED", job.stage, "无痕排队数量无效；已保留原任务。");
          job.queueAhead = queue; await stage("queued");
        } else if (remote.status === "processing") {
          const progress = Number(remote.progress);
          if (!Number.isInteger(progress) || progress < 0 || progress > 100) throw failure("QUERY_INTERRUPTED", job.stage, "无痕处理进度无效；已保留原任务。");
          job.progress = progress; await stage("processing");
        } else if (remote.status === "success") {
          job.remoteCompletedAt = stamp(); await stage("receiving"); break;
        } else if (remote.status === "failed") {
          await save(); throw failure("REMOTE_FAILED", "remote_failed", "无痕已返回原任务处理失败；保留任务 ID，请在供应商后台核查原因。");
        } else if (remote.status === "paused") {
          await save(); throw failure("REMOTE_PAUSED", "remote_paused", "无痕原任务已暂停；不会自动重新创建收费任务。");
        } else await stage("queued");
        const reception = await transportManager.inspect(handle);
        if (!reception.received && (reception.expired || !reception.publicBaseMatches)) {
          throw failure(reception.expired ? "TRANSPORT_EXPIRED" : "TRANSPORT_LOST", job.stage,
            "原任务回传通道已失效；已保留 taskId，新通道不能替换云端保存的地址。");
        }
        try { await sleep(pollMs, signal); } catch { abort(); throw failure("QUERY_INTERRUPTED", job.stage, "本机等待中断，已保留原任务。"); }
      }
      await stage("receiving");
      const receiveDeadline = now() + receiptWaitMs;
      let reception;
      for (;;) {
        abort(); reception = await transportManager.inspect(handle);
        if (reception.received) break;
        if (reception.expired || !reception.publicBaseMatches) throw failure(reception.expired ? "TRANSPORT_EXPIRED" : "TRANSPORT_LOST", "receiving",
          "云端任务已完成，但原回传通道失效且本地未收到成品；保留 taskId，请核查原任务回传。");
        if (now() >= receiveDeadline) throw failure("OUTPUT_MISSING", "receiving", "无痕返回 success，但本地尚无完整成品；保留 taskId，恢复时仅读取原接收对象。");
        try { await sleep(Math.min(1000, Math.max(1, receiveDeadline - now())), signal); } catch { abort(); throw failure("QUERY_INTERRUPTED", "receiving", "等待回传中断，已保留原任务。"); }
      }
      const result = await finish(reception.receivedPath);
      void collectBilling().catch(() => {}); return result;
    } catch (error) {
      const safe = ["OPTIONS_INVALID", "STATE_INVALID", "INPUT_CHANGED", "INPUT_INVALID", "JOB_BUSY", "STATE_WRITE_FAILED", "WAITING_PAUSED", "KEY_REQUIRED", "AUTH_FAILED", "BALANCE_FAILED", "INSUFFICIENT_BALANCE",
        "SUBMISSION_UNCERTAIN", "SUBMISSION_REJECTED", "QUERY_INTERRUPTED", "REMOTE_FAILED", "REMOTE_PAUSED", "OUTPUT_MISSING", "VALIDATION_FAILED", "TRANSPORT_NOT_READY", "TRANSPORT_EXPIRED", "TRANSPORT_LOST", "TRANSPORT_UNREACHABLE", "TRANSPORT_STATE_INVALID", "TRANSPORT_PATH_INVALID"];
      const reported = safe.includes(error.code) ? error : failure("WUHEN_FAILED", job?.stage || "preparing", "无痕任务未完成；已保留任务状态，请核查本地接收与网络条件。");
      if (job) {
        if (reported.code === "SUBMISSION_UNCERTAIN" && !job.taskId) job.stage = "submission_uncertain";
        else if (reported.code === "SUBMISSION_REJECTED") job.stage = "submission_rejected";
        else if (reported.code === "REMOTE_FAILED") job.stage = "remote_failed";
        else if (reported.code === "REMOTE_PAUSED") job.stage = "remote_paused";
        else if (reported.code === "VALIDATION_FAILED") job.stage = "validation_failed";
        job.error = { code: reported.code, stage: reported.stage, message: reported.message };
        await save().catch(() => {});
        reported.job = publicWuhenJob(job);
      }
      throw reported;
    } finally { await releaseLock(); }
  }
  return { async removeVideoSubtitles(args) {
    const dir = path.resolve(args.runDir, "artifacts", "subtitle-removal");
    if (activeJobs.has(dir)) throw failure("JOB_BUSY", "preparing", "此无痕任务已有执行者。");
    activeJobs.add(dir);
    try { await fsp.mkdir(dir, { recursive: true }); return await execute(args, dir); }
    finally { activeJobs.delete(dir); }
  } };
}
