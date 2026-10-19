import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import os from "node:os";

const source = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
const execFileAsync = promisify(execFile);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function extract(name) {
  const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(start >= 0, `missing ${name}`);
  return source.slice(start, source.indexOf("\n}", start) + 2);
}

function makeWav({ sampleRate = 16000, seconds = 0.4, channels = 1 } = {}) {
  const bitsPerSample = 16;
  const frameCount = Math.floor(sampleRate * seconds);
  const dataSize = frameCount * channels * bitsPerSample / 8;
  const wav = Buffer.alloc(44 + dataSize);
  wav.write("RIFF", 0); wav.writeUInt32LE(36 + dataSize, 4); wav.write("WAVE", 8);
  wav.write("fmt ", 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(channels, 22); wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * channels * bitsPerSample / 8, 28);
  wav.writeUInt16LE(channels * bitsPerSample / 8, 32); wav.writeUInt16LE(bitsPerSample, 34);
  wav.write("data", 36); wav.writeUInt32LE(dataSize, 40);
  for (let index = 0; index < frameCount; index += 1) {
    const sample = Math.round(Math.sin(2 * Math.PI * 330 * index / sampleRate) * 4000);
    for (let channel = 0; channel < channels; channel += 1) wav.writeInt16LE(sample, 44 + (index * channels + channel) * 2);
  }
  return wav;
}

function makePrepare(overrides = {}) {
  const deps = {
    createHash, readFile, randomUUID: (() => { let id = 0; return () => `prepared-${++id}`; })(),
    join, mkdir, unlink: async (file) => (await import("node:fs/promises")).unlink(file),
    execFileAsync: async (...args) => execFileAsync(...args),
    FFMPEG_PATH: process.env.FFMPEG_PATH || "ffmpeg", RUNS_DIR: ".", persistRun: async () => {},
    HttpError: class extends Error { constructor(status, message) { super(message); this.status = status; } },
    ...overrides,
  };
  return Function("deps", `const {createHash, readFile, randomUUID, join, mkdir, unlink, execFileAsync, FFMPEG_PATH, RUNS_DIR, persistRun, HttpError} = deps;
    ${extract("prepareAimanplayAudio")}
    return prepareAimanplayAudio;`)(deps);
}

test("Aimanplay voice audio is normalized once, cached by source hash, and rebuilt when the prepared bytes are damaged", async () => {
  const root = await mkdtemp(join(os.tmpdir(), "aimanplay-audio-cache-"));
  try {
    const sourceDir = join(root, "run-a");
    await mkdir(sourceDir, { recursive: true });
    const originalPath = join(sourceDir, "reference.wav");
    const original = makeWav({ channels: 2 });
    await writeFile(originalPath, original);
    const calls = [];
    const prepare = makePrepare({
      RUNS_DIR: root,
      FFMPEG_PATH: process.env.FFMPEG_PATH || "ffmpeg",
      execFileAsync: async (command, args, options) => {
        calls.push(command);
        return execFileAsync(command, args, options);
      },
    });
    const run = { id: "run-a", voiceAudio: { id: "voice-a", path: originalPath, name: "reference.wav", mime: "audio/wav", size: original.length } };
    const prepared = await prepare(run);
    assert.equal(prepared.sourceId, "voice-a");
    assert.equal(prepared.sourceSha256, sha256(original));
    assert.equal(prepared.sha256, sha256(await readFile(prepared.path)));
    assert.equal(prepared.formatVersion, "mp3-24k-mono-v1");
    assert.equal(prepared.mime, "audio/mpeg");
    assert.equal(calls.length, 2, "one FFmpeg conversion plus one FFprobe validation");

    assert.equal(await prepare(run), prepared);
    assert.equal(calls.length, 2, "a matching intact cache avoids another conversion");
    assert.equal(sha256(await readFile(originalPath)), sha256(original), "the source audio is never overwritten");

    await writeFile(prepared.path, "damaged cache");
    const rebuilt = await prepare(run);
    assert.notEqual(rebuilt.id, prepared.id);
    assert.equal(rebuilt.sha256, sha256(await readFile(rebuilt.path)));
    assert.equal(calls.length, 4, "a damaged cache is regenerated and probed");
    assert.equal(sha256(await readFile(originalPath)), sha256(original));

    const changedSource = makeWav({ sampleRate: 22050, seconds: 0.55, channels: 2 });
    await writeFile(originalPath, changedSource);
    const rebuiltForChangedSource = await prepare(run);
    assert.notEqual(rebuiltForChangedSource.id, rebuilt.id, "changed source content invalidates the previous cache");
    assert.equal(rebuiltForChangedSource.sourceSha256, sha256(changedSource));
    assert.notEqual(rebuiltForChangedSource.sourceSha256, rebuilt.sourceSha256);
    assert.deepEqual(await readFile(originalPath), changedSource, "source replacement remains intact after rebuilding");
    assert.equal(calls.length, 6, "changed source is converted and probed again");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unreadable source audio returns 422 and preserves its original bytes", async () => {
  const root = await mkdtemp(join(os.tmpdir(), "aimanplay-audio-failure-"));
  try {
    const sourcePath = join(root, "invalid.wav");
    const original = Buffer.from("not a decodable WAV");
    await writeFile(sourcePath, original);
    const prepare = makePrepare({
      RUNS_DIR: root,
      execFileAsync: async () => { throw Error("ffmpeg failed with private path"); },
    });
    await assert.rejects(prepare({ id: "bad-audio", voiceAudio: { id: "voice-bad", path: sourcePath } }), error => error.status === 422);
    assert.deepEqual(await readFile(sourcePath), original, "failed conversion does not alter the source audio");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("audio URL validation retries new uploads at most twice and checks complete unauthenticated GET bytes", async () => {
  const audio = Buffer.from("valid normalized mp3 bytes");
  const reads = [];
  const writes = [];
  const events = [];
  const fetch = async (url, options = {}) => {
    reads.push({ url, options });
    assert.equal(options.headers?.Authorization, undefined, "public verification GET has no auth header");
    if (url.endsWith("old.mp3")) return new Response("missing", { status: 404 });
    if (url.endsWith("first.mp3")) return new Response("<html>expired</html>", { headers: { "Content-Type": "text/html" } });
    if (url.endsWith("second.mp3")) return new Response(audio);
    if (url.endsWith("truncated.mp3")) return new Response(audio);
    return new Response("missing", { status: 404 });
  };
  const deps = {
    createHash, fetch, AIMANPLAY_API_BASE: "http://127.0.0.1:12345", process,
    aimanplayJson: async () => ({ success: true, enabled: true, token: "only-for-upload" }),
    aimanplayUpload: async (_item, sts) => { writes.push(sts); return writes.length === 1 ? "https://oss.test/first.mp3" : "https://oss.test/second.mp3"; },
    persistRun: async () => events.push("persist"), logRun: async (_run, name) => events.push(name),
    HttpError: class extends Error { constructor(status, message) { super(message); this.status = status; } },
  };
  const run = { id: "run-a", aimanplayUploads: { "audio-a": "https://oss.test/old.mp3" } };
  const item = { id: "audio-a", size: audio.length, sha256: sha256(audio) };
  const ensure = Function("deps", `const {createHash, fetch, AIMANPLAY_API_BASE, process, aimanplayJson, aimanplayUpload, persistRun, logRun, HttpError} = deps;
    ${extract("aimanplayAudioReadable")}
    ${extract("ensureAimanplayAudioUrl")}
    return ensureAimanplayAudioUrl;`)(deps);

  const readable = Function("deps", `const {createHash, fetch, AIMANPLAY_API_BASE, process} = deps;
    ${extract("aimanplayAudioReadable")}
    return aimanplayAudioReadable;`)(deps);
  assert.equal(await readable("https://oss.test/truncated.mp3", { size: audio.length + 1, sha256: sha256(audio) }), false,
    "a response that ends before the expected complete file size is rejected");

  const readCountBeforeEnsure = reads.length;
  const url = await ensure(run, item);
  assert.equal(url, "https://oss.test/second.mp3");
  assert.equal(writes.length, 2, "404 cache is invalidated and an unreadable first replacement is retried once");
  assert.equal(run.aimanplayUploads["audio-a"], url);
  assert.equal(reads.length - readCountBeforeEnsure, 3, "checks the stale URL, then verifies both uploads");

  const exhaustedDeps = {
    ...deps,
    fetch: async () => new Response("<html>bad</html>", { headers: { "Content-Type": "text/html" } }),
    aimanplayUpload: async () => "https://oss.test/bad.mp3",
  };
  const exhaustedRun = { id: "run-b", aimanplayUploads: {} };
  const exhausted = Function("deps", `const {createHash, fetch, AIMANPLAY_API_BASE, process, aimanplayJson, aimanplayUpload, persistRun, logRun, HttpError} = deps;
    ${extract("aimanplayAudioReadable")}
    ${extract("ensureAimanplayAudioUrl")}
    return ensureAimanplayAudioUrl;`)(exhaustedDeps);
  await assert.rejects(exhausted(exhaustedRun, item), error => error.status === 502);
});
