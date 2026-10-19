import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const main = await readFile(new URL("../main.mjs", import.meta.url), "utf8");
function extract(name) {
  const start = main.indexOf(`async function ${name}(`);
  assert.ok(start >= 0);
  return main.slice(start, main.indexOf("\n}", start) + 2);
}

test("missing built-in voice samples are restored before resolving the selected voice", async () => {
  let restored = false;
  const resolve = Function("deps", `const {readVoiceRegistry, existsSync, ensureBuiltinVoices} = deps; ${extract("resolveVoice")} return resolveVoice;`)({
    readVoiceRegistry: async () => [{ id: "builtin", builtin: true, samplePath: restored ? "restored.mp3" : "missing.mp3" }],
    existsSync: file => file === "restored.mp3",
    ensureBuiltinVoices: async () => { restored = true; }
  });
  assert.equal((await resolve("builtin")).samplePath, "restored.mp3");
  assert.equal(restored, true);
});

test("voice uploads over 20MB are rejected before inspecting or enrolling a paid voice", async () => {
  const create = Function("deps", `const {stat, videoDurationSeconds} = deps; ${extract("createVoice")} return createVoice;`)({
    stat: async () => ({ size: 20_000_001 }),
    videoDurationSeconds: async () => { assert.fail("oversized input must be rejected first"); }
  });
  await assert.rejects(create({ sourcePath: "oversized.wav" }), /20MB.*8–15秒/);
});

test("broken product references are identified before creating a run or submitting an image edit", async () => {
  const create = Function("deps", `const {execFileAsync, runtimeFfmpegPath} = deps; ${extract("createKlingRun")} return createKlingRun;`)({
    runtimeFfmpegPath: "ffmpeg", execFileAsync: async () => { throw Error("Invalid picture"); }
  });
  await assert.rejects(create({ videoPath: "source.mp4", productPaths: ["broken.png"] }), /第 1 张商品参考图无法打开/);
});
