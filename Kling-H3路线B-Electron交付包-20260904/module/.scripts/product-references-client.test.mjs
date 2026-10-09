import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";

const mainSource = await readFile(new URL("../../../electron/main.mjs", import.meta.url), "utf8");
const createSource = mainSource.slice(mainSource.indexOf("async function createKlingRun("), mainSource.indexOf("async function startKlingVideo("));

function setup() {
  const uploads = [], requests = [];
  const deps = {
    path, app: { getPath: () => "C:/mock-temp" }, mkdir: async () => {}, rm: async () => {},
    normalizeKlingDuration: Number, resolveVoice: async () => { throw new Error("unexpected voice lookup"); },
    videoDurationSeconds: async () => 12, keyframeCount: () => 4,
    execFileAsync: async () => ({}), runtimeFfmpegPath: "mock-ffmpeg",
    KLING_IMAGE_PROMPT: "single-product", KLING_MULTI_PRODUCT_IMAGE_PROMPT: "multiple-products",
    klingVideoPrompt: () => "mock-video-prompt", klingOmniDurations: new Set([5,10,15]), KLING_OMNI_PROMPT_MAX_BYTES: 3072,
    uploadKlingMedia: async (...args) => { uploads.push(args); return { id: `upload-${uploads.length}` }; },
    klingRequest: async (route, options) => {
      if (route === "api/config") return { configured: true, imageConfigured: true, klingConfigured: true };
      if (route === "api/run-id") return { runId: "test-run" };
      const body = JSON.parse(options.body); requests.push(body); return body;
    }
  };
  const create = Function("deps", `const { ${Object.keys(deps).join(",")} } = deps; ${createSource}; return createKlingRun;`)(deps);
  return { create, uploads, requests };
}

test("IPC forwards all three product files in order", async () => {
  const source = await readFile(new URL("../../../electron/preload.cjs", import.meta.url), "utf8");
  let client, payload;
  vm.runInNewContext(source, { require: () => ({
    contextBridge: { exposeInMainWorld: (_, api) => { client = api; } },
    ipcRenderer: { invoke: (_, body) => { payload = body; } },
    webUtils: { getPathForFile: file => file.path }
  }) });
  await client.createKlingRun({path:"video.mp4"}, [1,2,3].map(i => ({path:`product-${i}.jpg`})), "", "silent", "multi_keyframes", 5, null);
  assert.deepEqual(Array.from(payload.productPaths), ["product-1.jpg", "product-2.jpg", "product-3.jpg"]);
  await client.createKlingRun({path:"video.mp4"}, {path:"one.jpg"}, "", "silent", "multi_keyframes", 5, null);
  assert.deepEqual(Array.from(payload.productPaths), ["one.jpg"]);
  await client.createKlingRun({path:"video.mp4"}, {path:"one.jpg"}, "", "silent", "multi_keyframes", 5, null, "手中的水杯");
  assert.equal(payload.productSubject, "手中的水杯");
});

test("main stages three products then binds all IDs in the paid-run request", async () => {
  const { create, uploads } = setup();
  const body = await create({videoPath:"video.mp4", productPaths:["a.jpg","b.jpg","c.jpg"], audioMode:"silent", duration:5, videoMode:"multi_keyframes"});
  const products = uploads.filter(args => args[3] === "inputs/product-image");
  assert.deepEqual(products.map(args => args[1]), ["a.jpg","b.jpg","c.jpg"]);
  assert.ok(products.every(args => args[5] === false));
  assert.equal(body.productImageIds.length, 3);
  assert.equal(body.keyframeIds.length, 4);
  assert.equal(body.imagePrompt, "multiple-products");
  assert.equal(body.productImageId, undefined);
  assert.equal(body.productSubject, "");
});

test("single-file history stays compatible and excessive references fail before uploads", async () => {
  const { create, uploads, requests } = setup();
  const body = await create({videoPath:"video.mp4", productPath:"a.jpg", audioMode:"silent", duration:5});
  assert.equal(body.productImageIds.length, 1);
  assert.equal(body.imagePrompt, "single-product");
  const count = uploads.length, requestCount = requests.length;
  await assert.rejects(create({videoPath:"video.mp4", productPaths:["a","b","c","d"]}), /最多上传 3 张/);
  await assert.rejects(create({videoPath:"video.mp4", productPaths:["a","b"], videoMode:"reference_video"}), /仅支持 1 张/);
  assert.equal(uploads.length, count);
  assert.equal(requests.length, requestCount);
});

test("subject appends to the complete single/multiple base prompt and whitespace keeps exact legacy prompts", async () => {
  for (const productPaths of [["a.jpg"], ["a.jpg", "b.jpg", "c.jpg"]]) {
    const { create } = setup();
    const base = productPaths.length === 1 ? "single-product" : "multiple-products";
    for (const productSubject of [undefined, "", "  \n "]) {
      const body = await create({videoPath:"video.mp4", productPaths, audioMode:"silent", duration:5, productSubject});
      assert.equal(body.imagePrompt, base);
      assert.equal(body.productSubject, "");
    }
    const body = await create({videoPath:"video.mp4", productPaths, audioMode:"silent", duration:5, productSubject:"  手中的水杯  "});
    assert.equal(body.productSubject, "手中的水杯");
    assert.ok(body.imagePrompt.startsWith(`${base}\n\n`));
    assert.match(body.imagePrompt, /商品参考图中用于替换的主体为：手中的水杯/);
    assert.match(body.imagePrompt, /商品参考图里的其他物品和背景不作为替换内容/);
  }
});

test("subject length is limited before any staging or request", async () => {
  const { create, uploads, requests } = setup();
  await assert.rejects(create({videoPath:"video.mp4", productPaths:["a.jpg"], audioMode:"silent", productSubject:"杯".repeat(201)}), /不能超过 200 字/);
  assert.equal(uploads.length, 0);
  assert.equal(requests.length, 0);
});
