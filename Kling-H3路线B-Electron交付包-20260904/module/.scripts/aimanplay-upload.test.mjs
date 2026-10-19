import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { extname, join } from "node:path";
import os from "node:os";

const source = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
const execFileAsync = promisify(execFile);
function extract(name) {
  const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(start >= 0);
  return source.slice(start, source.indexOf("\n}", start) + 2);
}
function uploadFunctions(overrides = {}) {
  const deps = { extname, readFile, execFileAsync, createHmac, randomUUID, fetch: () => { throw Error("Unexpected network request"); }, AIMANPLAY_API_BASE: "https://unused.invalid", FFMPEG_PATH: process.env.FFMPEG_PATH || "ffmpeg", AIMANPLAY_IMAGE_MAX_BYTES: 10_000_000,
    HttpError: class extends Error { constructor(status, message) { super(message); this.status = status; } }, ...overrides };
  return Function("deps", `const { extname, readFile, execFileAsync, createHmac, randomUUID, fetch, AIMANPLAY_API_BASE, FFMPEG_PATH, AIMANPLAY_IMAGE_MAX_BYTES, HttpError } = deps;
    ${extract("aimanplayMime")}
    ${extract("prepareAimanplayImageUpload")}
    ${extract("aimanplayUpload")}
    return Object.assign(prepareAimanplayImageUpload, { upload: aimanplayUpload });`)(deps);
}

test("small images remain byte-identical and oversized images retry quality until strictly below the limit", async () => {
  const qualities = [];
  const prepare = uploadFunctions({ execFileAsync: async (_cmd, args) => {
    qualities.push(Number(args[args.indexOf("-q:v") + 1]));
    return { stdout: Buffer.alloc(qualities.length === 1 ? 100 : 99) };
  } });
  const original = Buffer.from("small png");
  const small = await prepare({ path: "original.png" }, original, 100);
  assert.equal(small.bytes, original);
  assert.equal(small.mime, "image/png");
  assert.deepEqual(qualities, []);
  const compressed = await prepare({ path: "original.png" }, Buffer.alloc(100), 100);
  assert.deepEqual(qualities, [2, 6]);
  assert.equal(compressed.bytes.length, 99);
  assert.equal(compressed.mime, "image/jpeg");
  assert.equal(compressed.extension, ".jpg");
});

test("compression failure never returns an oversized upload or raw command error", async () => {
  const prepare = uploadFunctions({ execFileAsync: async () => ({ stdout: Buffer.alloc(100) }) });
  await assert.rejects(prepare({ path: "original.png" }, Buffer.alloc(101), 100), error => error.status === 413);
  const broken = uploadFunctions({ execFileAsync: async () => { throw Error("Command failed: private path"); } });
  await assert.rejects(broken({ path: "original.png" }, Buffer.alloc(101), 100), error => error.status === 422 && !error.message.includes("private path"));
});

test("upload checks real bytes, caps channel limits at decimal 10MB, and sends matching JPEG type and suffix", async () => {
  const fn = extract("aimanplayUpload");
  assert.match(fn, /Math\.min\(AIMANPLAY_IMAGE_MAX_BYTES, configuredLimit\)/);
  assert.match(fn, /bytes = await readFile\(item\.path\)/);
  assert.match(fn, /prepareAimanplayImageUpload\(item, bytes, limit\)/);
  assert.match(fn, /body: bytes/);
  assert.match(fn, /\$\{extension\}/);
  assert.doesNotMatch(fn, /Number\(item\.size\)/);
  const requests = [];
  const prepare = uploadFunctions({ readFile: async () => Buffer.alloc(10_000_000),
    execFileAsync: async () => ({ stdout: Buffer.alloc(80) }),
    fetch: async (url, request) => { requests.push({ url, request }); return { ok: true }; }
  });
  const sts = { host: "https://upload.invalid", dir: "uploads", bucket: "test", accessKeyId: "test-id", accessKeySecret: "test-secret", securityToken: "test-token", maxImageBytes: 100_000_000 };
  const item = { path: "original.png", size: 1 }; // Deliberately incorrect metadata must not bypass the byte check.
  await prepare.upload(item, sts);
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /\.jpg$/);
  assert.equal(requests[0].request.headers["Content-Type"], "image/jpeg");
  assert.equal(requests[0].request.body.length, 80);
  await assert.rejects(prepare.upload(item, { ...sts, maxImageBytes: 70 }), error => error.status === 413);
  assert.equal(requests.length, 1, "nothing uploads if compression cannot meet the channel's smaller limit");
});

test("real oversized PNG compresses below 10MB and stays decodable without changing the original", async () => {
  const root = await mkdtemp(join(os.tmpdir(), "aimanplay-upload-"));
  try {
    const raw = join(root, "noise.rgb");
    const input = join(root, "original.png");
    await writeFile(raw, randomBytes(2000 * 2000 * 3));
    await execFileAsync(process.env.FFMPEG_PATH || "ffmpeg", ["-v", "error", "-f", "rawvideo", "-pixel_format", "rgb24", "-video_size", "2000x2000", "-i", raw, "-frames:v", "1", input], { windowsHide: true });
    const bytes = await readFile(input);
    assert.ok(bytes.length >= 10_000_000, `fixture must exceed 10MB: ${bytes.length}`);
    const hash = value => createHash("sha256").update(value).digest("hex");
    const result = await uploadFunctions()({ path: input }, bytes, 10_000_000);
    assert.ok(result.bytes.length > 0 && result.bytes.length < 10_000_000);
    assert.equal(result.bytes.readUInt16BE(0), 0xffd8);
    assert.equal(hash(await readFile(input)), hash(bytes));
    const output = join(root, "upload.jpg");
    await writeFile(output, result.bytes);
    await execFileAsync(process.env.FFMPEG_PATH || "ffmpeg", ["-v", "error", "-i", output, "-f", "null", "-"], { windowsHide: true });
  } finally { await rm(root, { recursive: true, force: true }); }
});
