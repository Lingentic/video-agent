import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../../../electron/renderer/app.js", import.meta.url), "utf8");
const css = await readFile(new URL("../../../electron/renderer/remake.css", import.meta.url), "utf8");
function fragment(start, end) {
  const first = source.indexOf(start);
  assert.notEqual(first, -1, `missing source fragment: ${start}`);
  const last = source.indexOf(end, first);
  assert.notEqual(last, -1, `missing source boundary: ${end}`);
  return source.slice(first, last);
}

test("subject hint renders as an accessible, hidden tooltip and preserves the textarea layout", () => {
  const markupSource = fragment("  const productReferences = `", "\n  const controls = ");
  const expression = markupSource.slice(markupSource.indexOf("= ") + 2).replace(/;\s*$/, "");
  const renderSubject = Function("item", "referenceVideoMode", "productLimit", "productAccept", "uploadBox", "esc", `return (${expression});`);
  const markup = renderSubject({ products: [], running: false, runId: null, productSubject: "" }, false, 3, "image/*", () => "upload fixture", (value) => String(value));
  assert.match(markup, /placeholder="例如：红色包装盒的为主体 旁边的散装不是主体"/);
  assert.match(markup, /<button class="product-subject-help"[^>]*type="button"[^>]*aria-describedby="productSubjectHint"/);
  assert.match(markup, /id="productSubjectHint"[^>]*popover="manual" role="tooltip"/);
  assert.match(markup, /参考图里有多个物品时，说明要替换的是哪一个；不填则自动识别。/);
  assert.doesNotMatch(markup, /<small id="productSubjectHint"/);
  assert.match(markup, /id="remakeProductSubject" maxlength="200" rows="2"/);
  assert.match(css, /\.product-subject-tooltip\s*\{[^}]*position:\s*fixed/);
});

test("video processing stop action stays inside the progress route and keeps existing stop behavior", () => {
  const progressFns = fragment("function routeIndexFor(", "\n\nconst splitStages");
  const { progressOutput } = Function("esc", `${progressFns}; return { progressOutput };`)((value) => String(value));
  const stop = '<div class="remake-stop-actions remake-stop-actions--processing"><button class="remake-stop-trigger" data-action="remake-stop-open" type="button">中止任务</button></div>';
  const markup = progressOutput(72, ["抽取", "替换", "生成", "整理"], "根据关键帧生成视频", "task-processing", { routeIndex: 2 }, stop);
  assert.match(markup, /class="processing task-processing"[\s\S]*class="process-route"[\s\S]*remake-stop-actions--processing[\s\S]*<\/div>$/);
  assert.match(source, /if \(stopStage && !\(item\.running && stopStage === "video"\)\)/);
  assert.match(source, /data-action="remake-stop-open" type="button" \$\{item\.stopping \? "disabled" : ""\}/);
  assert.match(source, /if \(action === "remake-stop-open"\)/);
  assert.match(source, /stopStage === "image" \? "保留图片并结束"/);
  assert.match(css, /\.remake-stop-actions--processing \{[^}]*justify-content:\s*center/);
  assert.match(css, /\.remake-stop-actions--processing \.remake-stop-trigger \{[^}]*color:\s*#b84741/);
});

test("product uploads stay out of the library while generated assets retain runs and suppress keyframes after video completion", () => {
  const addFileFn = fragment("function addFile(", "\nfunction runSimulation");
  const state = { library: [] };
  const addFile = Function("state", "mediaUrl", "sortLibraryNewestFirst", `${addFileFn}; return addFile;`)(state, (file) => `local:${file.name}`, () => {});
  const uploaded = addFile({ name: "reference.png" }, "image", "产品替换");
  assert.equal(uploaded.url, "local:reference.png");
  assert.deepEqual(state.library, []);
  addFile({ name: "split.mp4" }, "video", "素材拆分");
  assert.equal(state.library.length, 1);

  const derivedFn = fragment("function derivedLibraryRuns()", "\nfunction renderLibrary()");
  const derived = Function("state", `${derivedFn}; return derivedLibraryRuns;`)({ library: [
    { name: "old-upload.png", origin: "产品替换", kind: "image", completedAt: "2026-10-08T00:00:00Z" },
    { name: "frame.png", origin: "产品替换", workflow: "remake", runId: "run-1", sourceId: "run-1", kind: "image", completedAt: "2026-10-08T00:00:00Z" },
    { name: "final.mp4", origin: "产品替换", workflow: "remake", runId: "run-1", sourceId: "run-1", kind: "video", completedAt: "2026-10-08T00:00:00Z" },
    { name: "split.mp4", workflow: "ffmpeg_gemini_naming", kind: "video", usageType: "商品展示", sourceId: "split-1", completedAt: "2026-10-08T00:00:00Z" }
  ], libraryRuns: [] });
  const runs = derived();
  const remake = runs.find((run) => run.kind === "remake");
  const split = runs.find((run) => run.kind === "split_named");
  assert.deepEqual(remake.items.map((item) => item.kind), ["video"]);
  assert.equal(remake.runId, "run-1");
  assert.equal(runs.some((run) => run.items.some((item) => item.name === "old-upload.png")), false);
  assert.equal(split.categories[0].name, "商品展示");
  assert.match(source, /entries\.map\(libraryTaskCard\)/);
  assert.match(source, /data-library-run="\$\{esc\(run\.id\)\}"/);
  assert.match(source, /if \(event\.target\.closest\("\[data-library-export\]"\)\) return;/);
  assert.match(source, /const count = matchingRuns\.length/);
});

test("split task grouping and product result navigation remain compatible", () => {
  assert.match(source, /const named = !remake && \(item\.workflow === "ffmpeg_gemini_naming" \|\| Boolean\(item\.usageType\)\)/);
  assert.match(source, /kind: remake \? "remake" : named \? "split_named" : "split_plain"/);
  assert.match(source, /state\.libraryView = \{ runId: state\.remake\.result\?\.sourceId \|\| state\.remake\.result\?\.runId \|\| state\.remake\.runId, categoryId: null \}/);
  assert.match(source, /items\.map\(libraryAssetCard\)/);
  assert.doesNotMatch(source, /function libraryRemakeAssetCard\(/);
});
