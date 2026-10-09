import http from "node:http";
import fsp from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { pipeline } from "node:stream/promises";

function failure(code, message) { return Object.assign(new Error(message), { code, stage: "preparing" }); }
function within(root, file) {
  const relative = path.relative(root, file);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}
async function atomicSave(file, value) {
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await fsp.open(temp, "wx", 0o600);
    try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync(); } finally { await handle.close(); }
    await fsp.rename(temp, file);
  } finally { await fsp.rm(temp, { force: true }); }
}
async function digestFile(file) {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(file)) { hash.update(chunk); bytes += chunk.length; }
  return { bytes, sha256: hash.digest("hex") };
}

// Explicit injection permits local tests; production accepts only standard HTTPS Quick Tunnel origins.
export function validateWuhenPublicBaseUrl(value, { allowLocalPublicBase = false } = {}) {
  let url;
  try { url = new URL(value); } catch { throw failure("TRANSPORT_URL_INVALID", "临时通道地址无效。"); }
  const local = allowLocalPublicBase && url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname);
  if (!local && (url.protocol !== "https:" || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.trycloudflare\.com$/i.test(url.hostname)
    || (url.port && url.port !== "443"))) throw failure("TRANSPORT_URL_INVALID", "临时通道必须使用 HTTPS trycloudflare.com 地址。");
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") throw failure("TRANSPORT_URL_INVALID", "临时通道必须是无凭据、无路径参数的基址。");
  return url.origin;
}

/** A dedicated receiver: no task APIs, listing, result GET, or application server forwarding. */
export async function createWuhenTransport({ runsDir, host = "127.0.0.1", port = 0, maxOutputBytes = 4 * 1024 ** 3,
  lifetimeMs = 26 * 3600_000, now = Date.now, transportFetch = (url, init) => fetch(url, init), allowLocalPublicBase = false } = {}) {
  if (host !== "127.0.0.1") throw failure("TRANSPORT_HOST_INVALID", "专用接收器仅允许监听本机回环地址。");
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1 || !Number.isFinite(lifetimeMs) || lifetimeMs < 26 * 3600_000) {
    throw failure("TRANSPORT_CONFIG_INVALID", "接收容量或有效期配置无效。");
  }
  await fsp.mkdir(path.resolve(runsDir), { recursive: true });
  const root = await fsp.realpath(path.resolve(runsDir));
  const routes = new Map(), records = new Map(), preparing = new Map();
  let publicBaseUrl = null;

  async function inspect(handle) {
    const record = records.get(handle.id);
    if (!record || record.handle !== handle) throw failure("TRANSPORT_HANDLE_INVALID", "传输句柄未恢复到当前接收器。");
    let receipt = await fsp.readFile(record.receiptPath, "utf8").then(JSON.parse).catch(() => null);
    const stat = await fsp.stat(handle.receivedPath).catch(() => null);
    if (stat?.isFile() && stat.size > 0 && !receipt) {
      receipt = { ...(await digestFile(handle.receivedPath)), receivedAt: stat.mtime.toISOString() };
      await atomicSave(record.receiptPath, receipt);
    }
    return { received: Boolean(stat?.isFile() && stat.size > 0 && receipt?.bytes === stat.size), receiving: record.receiving,
      receivedPath: handle.receivedPath, receipt, expired: now() >= Date.parse(handle.expiresAt),
      publicBaseMatches: publicBaseUrl === handle.publicBaseUrl };
  }

  const server = http.createServer(async (req, res) => {
    const end = (status, body = "") => { if (!res.headersSent) res.writeHead(status, { "Cache-Control": "no-store" }); res.end(body); };
    try {
      // Compare the raw request target: encoded paths, query variations and traversal never alias capabilities.
      if (req.url === "/api/health" && req.method === "GET") { res.setHeader("Content-Type", "application/json"); end(200, JSON.stringify({ ok: true })); return; }
      const route = routes.get(req.url);
      if (!route) { end(404); return; }
      const { record, kind } = route, handle = record.handle;
      if (now() >= Date.parse(handle.expiresAt)) { end(410); return; }
      if (kind === "input" && ["GET", "HEAD"].includes(req.method)) {
        const stat = await fsp.stat(handle.inputPath);
        if (!stat.isFile() || stat.size !== handle.inputBytes || stat.mtimeMs !== handle.inputMtimeMs) { end(409); return; }
        let start = 0, stop = stat.size - 1, status = 200;
        if (req.headers.range) {
          const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
          if (!match || (!match[1] && !match[2])) { res.setHeader("Content-Range", `bytes */${stat.size}`); end(416); return; }
          if (!match[1]) { const suffix = Number(match[2]); start = Math.max(0, stat.size - suffix); if (!suffix) start = stat.size; }
          else { start = Number(match[1]); if (match[2]) stop = Math.min(Number(match[2]), stop); }
          if (!Number.isSafeInteger(start) || !Number.isSafeInteger(stop) || start < 0 || start > stop || start >= stat.size) { res.setHeader("Content-Range", `bytes */${stat.size}`); end(416); return; }
          status = 206; res.setHeader("Content-Range", `bytes ${start}-${stop}/${stat.size}`);
        }
        res.writeHead(status, { "Content-Type": "video/mp4", "Content-Length": stop - start + 1, "Accept-Ranges": "bytes", "Cache-Control": "no-store" });
        if (req.method === "HEAD") res.end(); else await pipeline(createReadStream(handle.inputPath, { start, end: stop }), res);
        return;
      }
      if (kind === "probe" && req.method === "PUT") {
        let bytes = 0;
        for await (const chunk of req.iterator({ destroyOnReturn: false })) {
          bytes += chunk.length;
          if (bytes > 4096) { end(413); req.resume(); return; }
        }
        end(200, "OK"); return;
      }
      if (kind !== "output" || req.method !== "PUT") { end(405); return; }
      if (record.receiving) { end(409); req.resume(); return; }
      if (Number(req.headers["content-length"]) > maxOutputBytes) { end(413); req.resume(); return; }
      record.receiving = true;
      const partPath = `${handle.receivedPath}.part`;
      let file, uploadStatus = 500, uploadBody = "";
      try {
        // Only our fixed partial file is replaced; an interrupted PUT can start again.
        await fsp.rm(partPath, { force: true });
        file = await fsp.open(partPath, "wx", 0o600);
        const hash = createHash("sha256"); let bytes = 0;
        for await (const chunk of req.iterator({ destroyOnReturn: false })) {
          bytes += chunk.length;
          if (bytes > maxOutputBytes) { uploadStatus = 413; req.resume(); return; }
          hash.update(chunk); await file.writeFile(chunk);
        }
        if (!bytes) { uploadStatus = 400; return; }
        await file.sync(); await file.close(); file = null;
        const received = { bytes, sha256: hash.digest("hex"), receivedAt: new Date(now()).toISOString() };
        const existing = await inspect(handle);
        if (existing.received) {
          uploadStatus = existing.receipt.sha256 === received.sha256 && existing.receipt.bytes === bytes ? 200 : 409;
          uploadBody = "OK"; return;
        }
        await fsp.rename(partPath, handle.receivedPath);
        await atomicSave(record.receiptPath, received);
        uploadStatus = 200; uploadBody = "OK";
      } finally {
        try { await file?.close(); await fsp.rm(partPath, { force: true }); }
        finally {
          // Release the write lock before acknowledging: an immediate legitimate retry must not see a stale busy flag.
          record.receiving = false; if (!res.destroyed) end(uploadStatus, uploadBody);
        }
      }
    } catch { if (!res.destroyed) end(500); }
  });
  server.requestTimeout = 30 * 60_000;
  server.headersTimeout = 60_000;
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, host, resolve); });

  async function verify(handle, { signal } = {}) {
    const status = await inspect(handle);
    if (status.expired) throw failure("TRANSPORT_EXPIRED", "原任务临时传输地址已过期，不能自动重新提交。");
    if (!status.publicBaseMatches) throw failure("TRANSPORT_LOST", "原任务的临时通道已丢失；新地址无法替换云端已保存的回传地址。");
    const request = async (url, init, check) => {
      let response;
      try {
        response = await transportFetch(url, { ...init, redirect: "manual", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000) });
        if (!await check(response)) throw failure("TRANSPORT_UNREACHABLE", "临时通道的文件读取或独立回传探针检查失败。");
      } catch (error) { if (error.code?.startsWith("TRANSPORT_")) throw error; throw failure("TRANSPORT_UNREACHABLE", "临时通道连通性检查失败。"); }
      finally { await response?.body?.cancel().catch(() => {}); await response?.release?.(); }
    };
    await request(`${handle.publicBaseUrl}/api/health`, { method: "GET" }, async (r) => r.ok && (await r.json()).ok === true);
    const count = Math.min(1024, handle.inputBytes);
    await request(handle.inputUrl, { method: "GET", headers: { Range: `bytes=0-${count - 1}` } }, async (r) => r.status === 206
      && r.headers.get("content-range") === `bytes 0-${count - 1}/${handle.inputBytes}` && (await r.arrayBuffer()).byteLength === count);
    await request(handle.probeUrl, { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: "wuhen-probe" }, async (r) => r.status === 200);
  }

  async function prepareOnce({ runDir, inputPath, jobId, replaceUnsubmitted = false }) {
    const run = await fsp.realpath(path.resolve(runDir));
    const input = await fsp.realpath(path.resolve(inputPath));
    if (!within(root, run) || !within(root, input) || run === root) throw failure("TRANSPORT_PATH_INVALID", "传输文件必须属于指定任务目录范围。");
    const dir = path.join(run, "artifacts", "subtitle-removal");
    await fsp.mkdir(dir, { recursive: true });
    if (!within(run, await fsp.realpath(dir))) throw failure("TRANSPORT_PATH_INVALID", "传输目录不能通过链接跳出任务目录。");
    const statePath = path.join(dir, "transport.json"), receivedPath = path.join(dir, "received.mp4");
    const inputStat = await fsp.stat(input);
    if (!inputStat.isFile() || !inputStat.size) throw failure("INPUT_INVALID", "输入视频必须是非空文件。");
    let handle;
    try { handle = JSON.parse(await fsp.readFile(statePath, "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw failure("TRANSPORT_STATE_INVALID", "原任务传输状态无法读取，请保留状态文件。"); }
    let restored = Boolean(handle);
    if (handle) {
      const routePattern = /^\/(input|output|probe)\/[a-f0-9]{48}(?:\.mp4)?$/;
      if (handle.jobId !== jobId || handle.inputPath !== input || handle.receivedPath !== receivedPath
        || handle.inputBytes !== inputStat.size || handle.inputMtimeMs !== inputStat.mtimeMs || !Number.isFinite(Date.parse(handle.expiresAt))
        || ![handle.inputRoute, handle.outputRoute, handle.probeRoute].every((route) => routePattern.test(route))
        || !handle.inputRoute.startsWith("/input/") || !handle.outputRoute.startsWith("/output/") || !handle.probeRoute.startsWith("/probe/")) {
        throw failure("TRANSPORT_STATE_INVALID", "原任务传输信息与当前素材不一致，不能自动替换。");
      }
      const base = validateWuhenPublicBaseUrl(handle.publicBaseUrl, { allowLocalPublicBase });
      if (handle.inputUrl !== base + handle.inputRoute || handle.uploadUrl !== base + handle.outputRoute || handle.probeUrl !== base + handle.probeRoute) {
        throw failure("TRANSPORT_STATE_INVALID", "原任务能力地址不匹配，不能自动替换。");
      }
      if (replaceUnsubmitted && (handle.publicBaseUrl !== publicBaseUrl || now() >= Date.parse(handle.expiresAt))) {
        const submission = await fsp.readFile(path.join(dir, "job.json"), "utf8").then(JSON.parse).catch((error) => {
          if (error.code === "ENOENT") return null;
          throw failure("TRANSPORT_STATE_INVALID", "无法核查原任务提交状态，已阻止替换地址。");
        });
        if (submission?.taskId || submission?.submissionStartedAt) throw failure("TRANSPORT_LOST", "原任务已有提交意图，不能用新地址替换原传输对象。");
        if (!publicBaseUrl) throw failure("TRANSPORT_NOT_READY", "请先启动并连接专用临时通道。");
        const record = records.get(handle.id);
        if (record?.receiving) throw failure("TRANSPORT_STATE_INVALID", "原对象正在接收数据，不能替换传输地址。");
        if (await fsp.stat(receivedPath).then((stat) => stat.size > 0).catch(() => false)) throw failure("TRANSPORT_STATE_INVALID", "原对象已有回传内容，不能替换传输地址。");
        for (const route of [handle.inputRoute, handle.outputRoute, handle.probeRoute]) routes.delete(route);
        records.delete(handle.id); handle = null; restored = false;
      }
    }
    if (!handle) {
      const submission = await fsp.readFile(path.join(dir, "job.json"), "utf8").then(JSON.parse).catch((error) => {
        if (error.code === "ENOENT") return null;
        throw failure("TRANSPORT_STATE_INVALID", "无法核查原任务提交状态，已阻止创建新地址。");
      });
      if (submission?.taskId || submission?.submissionStartedAt) throw failure("TRANSPORT_LOST", "原任务已有提交意图且传输信息丢失，不能创建替代地址。");
      if (!publicBaseUrl) throw failure("TRANSPORT_NOT_READY", "请先启动并连接专用临时通道。");
      handle = { id: randomUUID(), jobId, inputPath: input, inputBytes: inputStat.size, inputMtimeMs: inputStat.mtimeMs, receivedPath,
        publicBaseUrl, expiresAt: new Date(now() + lifetimeMs).toISOString(), uploadHeaders: { "Content-Type": "application/octet-stream" },
        inputRoute: `/input/${randomBytes(24).toString("hex")}.mp4`, outputRoute: `/output/${randomBytes(24).toString("hex")}.mp4`, probeRoute: `/probe/${randomBytes(24).toString("hex")}` };
      handle.inputUrl = publicBaseUrl + handle.inputRoute; handle.uploadUrl = publicBaseUrl + handle.outputRoute; handle.probeUrl = publicBaseUrl + handle.probeRoute;
      await atomicSave(statePath, handle);
    }
    // Returning the registered object ensures inspect cannot accept a forged path-bearing handle.
    const prior = records.get(handle.id);
    if (prior) return prior.handle;
    handle = Object.freeze({ ...handle, uploadHeaders: Object.freeze({ "Content-Type": "application/octet-stream" }) });
    const record = { handle, receiving: false, receiptPath: path.join(dir, "receipt.json") };
    records.set(handle.id, record);
    for (const [kind, route] of [["input", handle.inputRoute], ["output", handle.outputRoute], ["probe", handle.probeRoute]]) {
      if (routes.has(route)) throw failure("TRANSPORT_STATE_INVALID", "任务能力路径发生冲突。");
      routes.set(route, { record, kind });
    }
    if (!restored) await verify(handle);
    return handle;
  }
  return { port: server.address().port,
    setPublicBaseUrl(value) { publicBaseUrl = value == null ? null : validateWuhenPublicBaseUrl(value, { allowLocalPublicBase }); },
    async prepare(args) {
      const key = path.resolve(args.runDir);
      if (preparing.has(key)) return preparing.get(key);
      const promise = prepareOnce(args); preparing.set(key, promise);
      try { return await promise; } finally { preparing.delete(key); }
    }, inspect, verify,
    async close() {
      const closed = new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      server.closeAllConnections(); await closed;
    },
  };
}
