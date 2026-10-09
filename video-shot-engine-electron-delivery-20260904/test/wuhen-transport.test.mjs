import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { createWuhenTransport, validateWuhenPublicBaseUrl } from "../src/wuhen-transport.mjs";

async function fixture(t, options = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "wuhen-transport-")), runDir = path.join(root, "run");
  await fsp.mkdir(runDir); const inputPath = path.join(runDir, "input.mp4");
  await fsp.writeFile(inputPath, "0123456789");
  const manager = await createWuhenTransport({ runsDir: root, allowLocalPublicBase: true, transportFetch: fetch, ...options });
  const base = `http://127.0.0.1:${manager.port}`; manager.setPublicBaseUrl(base);
  t.after(async () => { await manager.close(); await fsp.rm(root, { recursive: true, force: true }); });
  const handle = await manager.prepare({ runDir, inputPath, jobId: "test-job" });
  return { manager, root, runDir, inputPath, handle, base };
}

test("production base rejects private URLs, credentials, paths and lookalike domains", () => {
  assert.equal(validateWuhenPublicBaseUrl("https://new-host.trycloudflare.com/"), "https://new-host.trycloudflare.com");
  for (const url of ["http://x.trycloudflare.com", "https://trycloudflare.com", "https://x.trycloudflare.com.evil.com", "https://x.trycloudflare.com/a",
    "https://user:secret@x.trycloudflare.com", "https://x.trycloudflare.com/?cap=secret", "http://127.0.0.1:3215", "https://a.b.trycloudflare.com"]) {
    assert.throws(() => validateWuhenPublicBaseUrl(url), { code: "TRANSPORT_URL_INVALID" });
  }
});

test("default tunnel checks use the process fetch without a separate DNS-pinned dispatcher", async (t) => {
  const originalFetch = globalThis.fetch, calls = [];
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "wuhen-fetch-"));
  const runDir = path.join(root, "run"), inputPath = path.join(runDir, "input.mp4");
  await fsp.mkdir(runDir); await fsp.writeFile(inputPath, "0123456789");
  const manager = await createWuhenTransport({ runsDir: root });
  t.after(async () => { await manager.close(); await fsp.rm(root, { recursive: true, force: true }); });
  globalThis.fetch = async (value, init) => {
    const url = new URL(value); calls.push({ url, init });
    assert.equal(url.hostname, "fake-ip-compatible.trycloudflare.com");
    assert.equal(init.dispatcher, undefined);
    if (url.pathname === "/api/health") return new Response(JSON.stringify({ ok: true }));
    if (url.pathname.startsWith("/input/")) return new Response("0123456789", { status: 206, headers: { "content-range": "bytes 0-9/10" } });
    if (url.pathname.startsWith("/probe/")) return new Response("ok");
    throw new Error("unexpected request");
  };
  try {
    manager.setPublicBaseUrl("https://fake-ip-compatible.trycloudflare.com");
    await manager.prepare({ runDir, inputPath, jobId: "global-fetch" });
    assert.equal(calls.length, 3);
    assert.deepEqual(calls.map(call => call.init.method), ["GET", "GET", "PUT"]);
  } finally { globalThis.fetch = originalFetch; }
});

test("only health and exact capabilities; Range/HEAD/suffix, probe does not create output", async (t) => {
  const { manager, handle, base } = await fixture(t);
  assert.deepEqual(await fetch(`${base}/api/health`).then((r) => r.json()), { ok: true });
  for (const route of ["/", "/api/runs", "/api/config", "/input", "/output", `${handle.inputRoute}?query=1`, handle.inputRoute.replace("/input/", "/%69nput/")]) {
    assert.equal((await fetch(base + route)).status, 404);
  }
  const range = await fetch(handle.inputUrl, { headers: { Range: "bytes=2-5" } });
  assert.equal(range.status, 206); assert.equal(range.headers.get("content-range"), "bytes 2-5/10"); assert.equal(await range.text(), "2345");
  assert.equal(await fetch(handle.inputUrl, { headers: { Range: "bytes=-3" } }).then((r) => r.text()), "789");
  const head = await fetch(handle.inputUrl, { method: "HEAD" }); assert.equal(head.headers.get("content-length"), "10"); assert.equal(await head.text(), "");
  assert.equal((await fetch(handle.inputUrl, { headers: { Range: "bytes=40-50" } })).status, 416);
  assert.equal((await fetch(handle.inputUrl, { headers: { Range: "bytes=0-2,5-6" } })).status, 416);
  assert.equal((await fetch(handle.uploadUrl)).status, 405);
  assert.equal((await fetch(handle.probeUrl, { method: "PUT", body: "ok" })).status, 200);
  assert.equal((await manager.inspect(handle)).received, false);
});

test("PUT is atomic and idempotent, rejects conflict/empty/oversize; original is intact", async (t) => {
  const { manager, handle, inputPath } = await fixture(t, { maxOutputBytes: 20 });
  const put = (body) => fetch(handle.uploadUrl, { method: "PUT", headers: handle.uploadHeaders, body });
  assert.equal((await put("")).status, 400);
  assert.equal((await put("x".repeat(21))).status, 413);
  assert.equal((await put("video-data")).status, 200);
  const receipt = await manager.inspect(handle); assert.equal(receipt.received, true); assert.equal(receipt.receipt.bytes, 10);
  assert.equal((await put("video-data")).status, 200);
  assert.equal((await put("different")).status, 409);
  assert.equal(await fsp.readFile(handle.receivedPath, "utf8"), "video-data");
  assert.equal(await fsp.readFile(inputPath, "utf8"), "0123456789");
  assert.equal(await fsp.stat(`${handle.receivedPath}.part`).then(() => true).catch(() => false), false);
});

test("interrupted upload can retry and concurrent PUT cannot race", async (t) => {
  const { manager, handle } = await fixture(t);
  const pending = http.request(handle.uploadUrl, { method: "PUT", headers: { "Content-Length": 100 } });
  pending.on("error", () => {}); pending.write("first-fragment");
  for (let i = 0; i < 100 && !(await manager.inspect(handle)).receiving; i += 1) await new Promise((r) => setTimeout(r, 5));
  assert.equal((await fetch(handle.uploadUrl, { method: "PUT", body: "conflict" })).status, 409);
  pending.destroy();
  for (let i = 0; i < 100 && (await manager.inspect(handle)).receiving; i += 1) await new Promise((r) => setTimeout(r, 5));
  assert.equal((await manager.inspect(handle)).receiving, false);
  assert.equal((await fetch(handle.uploadUrl, { method: "PUT", body: "replacement" })).status, 200);
  assert.equal(await fsp.readFile(handle.receivedPath, "utf8"), "replacement");
});

test("restore keeps submitted URLs, lost host is explicit and local receipt survives restart", async (t) => {
  const { root, runDir, inputPath, handle, manager, base } = await fixture(t);
  await fetch(handle.uploadUrl, { method: "PUT", body: "result" });
  const restoredManager = await createWuhenTransport({ runsDir: root, allowLocalPublicBase: true, transportFetch: fetch });
  t.after(() => restoredManager.close());
  restoredManager.setPublicBaseUrl(`http://127.0.0.1:${restoredManager.port}`);
  const restored = await restoredManager.prepare({ runDir, inputPath, jobId: "test-job" });
  assert.equal(restored.inputUrl, handle.inputUrl); assert.equal(restored.publicBaseUrl, base);
  assert.equal((await restoredManager.inspect(restored)).received, true);
  assert.equal((await restoredManager.inspect(restored)).publicBaseMatches, false);
  await assert.rejects(restoredManager.verify(restored), { code: "TRANSPORT_LOST" });
  manager.setPublicBaseUrl("http://127.0.0.1:54321"); assert.equal((await manager.inspect(handle)).publicBaseMatches, false);
});

test("expired routes fail closed and files cannot escape runs root", async (t) => {
  let timestamp = Date.now();
  const { manager, handle, root, inputPath } = await fixture(t, { now: () => timestamp });
  timestamp += 27 * 3600_000;
  assert.equal((await fetch(handle.inputUrl)).status, 410); assert.equal((await fetch(handle.uploadUrl, { method: "PUT", body: "x" })).status, 410);
  const outside = await fsp.mkdtemp(path.join(os.tmpdir(), "wuhen-outside-")); t.after(() => fsp.rm(outside, { recursive: true, force: true }));
  await assert.rejects(manager.prepare({ runDir: outside, inputPath, jobId: "outside" }), { code: "TRANSPORT_PATH_INVALID" });
  await assert.rejects(manager.prepare({ runDir: root, inputPath, jobId: "root" }), { code: "TRANSPORT_PATH_INVALID" });
  assert.throws(() => manager.setPublicBaseUrl("https://evil.invalid"), { code: "TRANSPORT_URL_INVALID" });
});
