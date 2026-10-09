import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../../../electron/renderer/app.js", import.meta.url), "utf8");
function fragment(start, end) { return source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start))); }
const assetsCode = fragment("async function loadKlingAssets()", "function showServices(");
const completionCode = fragment("async function completeRemakeResult(", "async function revoiceCurrentResult(");
const revoiceCode = fragment("async function revoiceCurrentResult(", "async function runRemake(");
const functions = fragment("function newRemakeState(", "class RemakeStoppedError");
function fixture(client = {}) {
  const state = { active: "library", library: [], remake: { reference: { name: "ref.mp4" }, voiceEnabled: false, duration: 5 } };
  const deps = { state, videoClient: client, URL, sortLibraryNewestFirst() {}, render() {}, assertCurrentRemake() {}, isCurrentRemake: item => item === state.remake, notify() {}, updateRemakeStage() {} };
  return { state, ...Function("deps", `const {${Object.keys(deps)}} = deps; let klingAssetsLoading = false, klingAssetsRevision = 0; ${functions}\n${assetsCode}\n${completionCode}\n${revoiceCode}; return {replaceKlingLibraryAssets, loadKlingAssets, completeRemakeResult, revoiceCurrentResult, newRemakeState};`)(deps) };
}
function assets(kind = "image", count = 4) {
  return { baseUrl: "http://local/", assets: Array.from({ length: count }, (_, i) => ({ runId: "run", sourceId: "run", kind, name: `result-${i}.${kind === "image" ? "png" : "mp4"}`, relativeUrl: `${kind}-${i}`, sourceFilename: "ref.mp4", completedAt: "2026-10-08T08:00:00Z" })) };
}
test("library uses image cards, replaces same-task images with only final video and preserves unrelated uploads", () => {
  const h = fixture();
  const local = { name: "own.png", origin: "本地上传", kind: "image" }, shot = { remoteKey: "split:key", workflow: "ffmpeg_only", kind: "video" };
  h.state.library.push(local, shot);
  h.replaceKlingLibraryAssets(assets());
  assert.equal(h.state.library.filter(a => a.runId === "run").length, 4);
  assert.ok(h.state.library.filter(a => a.runId === "run").every(a => a.kind === "image" && a.url.startsWith("http://local/image")));
  h.replaceKlingLibraryAssets(assets("video", 1));
  assert.deepEqual(h.state.library.filter(a => a.runId === "run").map(a => a.kind), ["video"]);
  h.replaceKlingLibraryAssets(assets("video", 1));
  assert.equal(h.state.library.length, 3);
  assert.ok(h.state.library.includes(local) && h.state.library.includes(shot));
});
test("failed list leaves saved assets intact; a successful refresh removes missing keyframes", async () => {
  const h = fixture({ listKlingAssets: async () => { throw Error("offline"); } });
  h.replaceKlingLibraryAssets(assets());
  await h.loadKlingAssets();
  assert.equal(h.state.library.length, 4);
  h.replaceKlingLibraryAssets(assets("image", 2));
  assert.equal(h.state.library.length, 2);
});
test("video completion removes image fallback and stale in-flight listing cannot bring it back", async () => {
  let resolve;
  const h = fixture({ listKlingAssets: () => new Promise(yes => { resolve = yes; }) });
  h.replaceKlingLibraryAssets(assets());
  const loading = h.loadKlingAssets();
  await h.completeRemakeResult({ id: "run", baseUrl: "http://local/", output: { id: "final", url: "final.mp4" }, videoProvider: "aimanplay", audioMode: "silent" });
  resolve(assets());
  await loading;
  assert.deepEqual(h.state.library.map(a => a.kind), ["video"]);
  assert.equal(h.state.library[0].url, "http://local/final.mp4");
});
test("subject is optional, forwarded without replacing inputs, and cleared for a fresh product task", () => {
  const h = fixture();
  assert.equal(h.newRemakeState().productSubject, "");
  assert.equal(h.newRemakeState({ productSubject: "外盒" }).productSubject, "");
  assert.match(source, /createKlingRun\(item\.reference\.file,.*item\.selectedVoiceId, item\.productSubject\)/);
  assert.match(source, /id="remakeProductSubject" maxlength="200"/);
  const handler = fragment('  if (event.target.id === "remakeProductSubject")', '  if (event.target.id === "voiceNameInput")');
  const apply = Function("state", "event", handler);
  apply(h.state, { target: { id: "remakeProductSubject", value: "只替换外盒" } });
  assert.equal(h.state.remake.productSubject, "只替换外盒");
  h.state.remake.runId = "run";
  apply(h.state, { target: { id: "remakeProductSubject", value: "不应覆盖" } });
  assert.equal(h.state.remake.productSubject, "只替换外盒");
  assert.match(source, /folder\.mediaKind === "image" \? "张图片"/);
});
test("revoicing after a library refresh replaces the video despite different persisted keys", async () => {
  let resolve;
  const h = fixture({ revoiceVideo: async () => ({ url: "file:///new.mp4", name: "新配音.mp4" }), listKlingAssets: () => new Promise(yes => { resolve = yes; }) });
  h.replaceKlingLibraryAssets(assets("video", 1));
  Object.assign(h.state.remake, { runId: "run", selectedVoiceId: "voice", voiceScript: "台词", result: { runId: "run", workflow: "remake", remoteKey: "run:output-id", url: "http://local/old.mp4" } });
  const loading = h.loadKlingAssets();
  await h.revoiceCurrentResult();
  resolve(assets("video", 1));
  await loading;
  assert.equal(h.state.library.length, 1);
  assert.equal(h.state.library[0].url, "file:///new.mp4");
  assert.equal(h.state.library[0].kind, "video");
});
