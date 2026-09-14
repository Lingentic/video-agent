const workspace = document.querySelector("#workspace");
const navigation = document.querySelector("#navigation");
const serviceStatus = document.querySelector("#serviceStatus");
const toast = document.querySelector("#toast");
const mediaViewer = document.querySelector("#mediaViewer");
const mediaViewerTitle = document.querySelector("#mediaViewerTitle");
const mediaViewerBody = document.querySelector("#mediaViewerBody");
const uiPreviewMode = new URLSearchParams(window.location.search).get("preview") || "";
const videoClient = window.videoClient || {
  getServices: async () => [],
  openWorkspace: async () => notify("浏览器预览模式下不启动本地服务"),
  openLogs: async () => notify("浏览器预览模式下没有运行目录"),
  getKlingConfig: async () => ({ configured: false }),
  listKlingAssets: async () => ({ baseUrl: "", assets: [] }),
  createKlingRun: async () => { throw new Error("浏览器预览模式下不能运行产品替换"); },
  getKlingRun: async () => { throw new Error("浏览器预览模式下不能查询产品替换任务"); },
  startKlingVideo: async () => { throw new Error("浏览器预览模式下不能启动视频生成"); },
  resumeKlingRun: async () => { throw new Error("浏览器预览模式下不能恢复产品替换任务"); },
  getShotConfig: async () => ({ apiKeyConfigured: false, uploadLimitMb: 500 }),
  listShotAssets: async () => ({ baseUrl: "", assets: [] }),
  createShotRun: async () => { throw new Error("浏览器预览模式下不能运行素材分割"); },
  createShotBatch: async () => { throw new Error("浏览器预览模式下不能运行批量素材分割"); },
  getShotRun: async () => { throw new Error("浏览器预览模式下不能查询素材分割任务"); },
  resumeShotNaming: async () => { throw new Error("浏览器预览模式下不能恢复命名任务"); },
  getLatestShotRun: async () => { throw new Error("浏览器预览模式下没有运行记录"); },
  getShotBatch: async () => { throw new Error("浏览器预览模式下不能查询批量任务"); },
  resumeShotBatch: async () => { throw new Error("浏览器预览模式下不能恢复批量任务"); },
  retryShotBatchItem: async () => { throw new Error("浏览器预览模式下不能重试批量任务"); },
  onServicesUpdated: () => () => {}
};
const tools = [
  { id: "split", icon: "分", name: "素材分割", note: "素材清洗、分割与归档" },
  { id: "remake", icon: "替", name: "产品替换", note: "按参考视频生成同款" },
  { id: "audio", icon: "声", name: "音频处理", note: "声音克隆与去气口", available: false },
  { id: "compose", icon: "合", name: "视频合成", note: "多类型素材智能成片", available: false },
  { id: "library", icon: "库", name: "素材库", note: "统一管理创作素材" }
];
const state = {
  active: "split",
  remake: { products: [], reference: null, duration: 5, ratio: "9:16", resolution: "768P", videoMode: "multi_keyframes", audio: "silent", voiceScript: "", progress: 0, routeIndex: 0, stage: "", runId: null, serviceBaseUrl: "", editedImage: null, editedKeyframes: [], keyframeTimes: [], selectedRetryIndexes: [], imageReady: false, result: null, error: null, config: null, running: false },
  split: { source: null, sources: [], mode: "ffmpeg_only", keepAudio: true, progress: 0, routeIndex: 0, stage: "", runId: null, serviceBaseUrl: "", result: null, error: null, config: null, running: false, batch: null },
  audio: { source: null, script: "", progress: 0, result: null },
  compose: { script: "", ratio: "9:16", resolution: "1080P", progress: 0, result: null },
  library: [],
  libraryFilter: "all"
};
const timers = new Map();
let shotAssetsLoading = false;
let klingAssetsLoading = false;
let latestBatchChecked = false;
let previewOpener = null;
const esc = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
const mediaUrl = (file) => file ? URL.createObjectURL(file) : "";

function notify(message) { toast.textContent = message; toast.classList.add("show"); clearTimeout(notify.timer); notify.timer = setTimeout(() => toast.classList.remove("show"), 1800); }
function openMediaViewer(card) {
  const { previewUrl: url, previewKind: kind = "video", previewName: name = "未命名素材" } = card.dataset;
  if (!url) return;
  previewOpener = card;
  mediaViewerTitle.textContent = name;
  mediaViewerBody.innerHTML = kind === "image"
    ? `<img src="${esc(url)}" alt="${esc(name)}">`
    : kind === "audio"
      ? `<div class="media-viewer__audio"><i>声</i><strong>${esc(name)}</strong><audio src="${esc(url)}" controls autoplay></audio></div>`
      : `<video src="${esc(url)}" controls autoplay></video>`;
  if (!mediaViewer.open) mediaViewer.showModal();
  mediaViewerBody.querySelector("video, audio")?.play().catch(() => {});
}
function clearMediaViewer() {
  mediaViewerBody.querySelectorAll("video, audio").forEach((media) => media.pause());
  mediaViewerBody.innerHTML = "";
}
function closeMediaViewer() {
  if (mediaViewer.open) mediaViewer.close();
}
function sortLibraryNewestFirst() {
  state.library.sort((a, b) => (Date.parse(b.completedAt || "") || 0) - (Date.parse(a.completedAt || "") || 0));
}
function renderNavigation() { navigation.innerHTML = tools.map((tool) => { const unavailable = tool.available === false; return `<button class="${state.active === tool.id ? "active" : ""}${unavailable ? " is-unavailable" : ""}" data-tool="${tool.id}" data-tool-name="${tool.name}" ${unavailable ? 'data-unavailable="true" aria-disabled="true" title="暂未开放"' : ""} type="button"><i>${tool.icon}</i><span><strong>${tool.name}${unavailable ? "<em>暂未开放</em>" : ""}</strong><small>${tool.note}</small></span></button>`; }).join(""); }
function page(title, subtitle, controls, output, className = "") { return `<section class="tool-page ${className}"><div class="tool-layout"><aside class="control-panel">${controls}</aside><section class="output-panel">${output}</section></div></section>`; }
function step(number, title, note, body) { return `<section class="step"><header><b>${number}</b><span><strong>${title}</strong>${note ? `<small>${note}</small>` : ""}</span></header>${body}</section>`; }
function uploadBox(id, title, note, accept, multiple = false) { return `<label class="upload-box" for="${id}"><i>＋</i><strong>${title}</strong><small>${note}</small><em>选择文件</em><input id="${id}" type="file" accept="${accept}" ${multiple ? "multiple" : ""} hidden></label>`; }
function mediaPreview(item, kind = "video") { if (!item) return ""; const media = kind === "image" ? `<img src="${esc(item.url)}" alt="${esc(item.name)}">` : kind === "audio" ? `<audio src="${esc(item.url)}" controls></audio>` : `<video src="${esc(item.url)}" controls></video>`; return `<article class="media-preview">${media}<span><strong>${esc(item.name)}</strong><small>${esc(item.meta || "本地素材")}</small></span></article>`; }
function options(group, values, selected, disabled = []) { return `<div class="segmented">${values.map((value) => `<button type="button" data-option="${group}" data-value="${value}" class="${selected === value ? "active" : ""}" ${disabled.includes(value) ? "disabled" : ""}>${value}</button>`).join("")}</div>`; }
function routeIndexFor(item, stages) {
  if (Number.isInteger(item?.routeIndex)) return Math.max(0, Math.min(stages.length - 1, item.routeIndex));
  return Math.max(0, Math.min(stages.length - 1, Math.floor((Number(item?.progress) || 0) / (100 / stages.length))));
}
function processRoute(stages, activeIndex) {
  return `<div class="process-route" style="--stage-count:${stages.length}" aria-label="处理流程">${stages.map((label, index) => `<div class="process-route__step ${index < activeIndex ? "is-complete" : index === activeIndex ? "is-active" : ""}" data-process-step="${index}"><span class="process-route__marker">${index < activeIndex ? "✓" : index + 1}</span><small>${esc(label)}</small></div>`).join("")}</div>`;
}
function progressOutput(progress, stages, currentStage = "", className = "", item = null) { const index = routeIndexFor(item || { progress }, stages); const stage = currentStage || stages[index]; return `<div class="processing ${className}"><div class="progress-ring"><strong>处理中</strong></div><h2>${esc(currentStage ? "正在处理素材" : stage)}</h2><p>请保持客户端运行，完成后结果会显示在这里。</p>${processRoute(stages, index)}</div>`; }

const splitStages = {
  ffmpeg_only: [
    { keys: ["uploading"], label: "上传视频" },
    { keys: ["ffmpeg_processing"], label: "检测镜头边界" },
    { keys: ["ffmpeg_completed"], label: "导出视频片段" },
    { keys: ["completed"], label: "整理运行产物" }
  ],
  ffmpeg_gemini_naming: [
    { keys: ["uploading"], label: "上传视频" },
    { keys: ["ffmpeg_processing"], label: "检测并导出片段" },
    { keys: ["ffmpeg_completed", "shots_completed", "naming_prepare", "naming_processing"], label: "准备片段命名" },
    { keys: ["analysis_video_processing"], label: "准备分析视频" },
    { keys: ["analysis_video_completed", "provider_processing", "provider_completed", "provider_retry", "quota_wait", "gemini_analysis_retry"], label: "分析片段内容" },
    { keys: ["naming_export"], label: "生成命名片段" },
    { keys: ["completed"], label: "整理命名结果" }
  ]
};

function updateSplitStage(stage) {
  const item = state.split;
  const stages = splitStages[item.mode];
  const index = Math.max(0, stages.findIndex((entry) => entry.keys.includes(stage)));
  const current = stages[index];
  item.progress = Math.round(((index + 1) / stages.length) * 100);
  item.routeIndex = item.mode === "ffmpeg_only" ? index : index === 0 ? 0 : index === 1 ? 1 : index <= 4 ? 2 : 3;
  item.stage = current.label;
}

function formatTime(seconds) {
  const value = Math.max(0, Number(seconds) || 0);
  const minutes = Math.floor(value / 60);
  const rest = value - minutes * 60;
  return `${String(minutes).padStart(2, "0")}:${rest.toFixed(1).padStart(4, "0")}`;
}

function shotMediaUrl(baseUrl, runId, relativePath) {
  const pathName = String(relativePath || "").split("/").map(encodeURIComponent).join("/");
  return `${baseUrl}runs/${encodeURIComponent(runId)}/${pathName}`;
}

function splitResultFrom(response) {
  const run = response.run || response;
  const named = response.renameManifest || [];
  const shots = named.length ? named : run.shots || response.shots || [];
  return {
    mediaTools: run.mediaTools || response.mediaTools || null,
    keepAudio: run.keepAudio ?? response.keepAudio ?? state.split.keepAudio,
    clips: shots.map((shot, index) => ({
      id: shot.shotId || `shot_${index + 1}`,
      remoteKey: `${run.runId || response.runId || state.split.runId}:${shot.namedPath || shot.filePath || index}`,
      name: shot.namedFilename || `${shot.shotId || `片段_${index + 1}`}.mp4`,
      startSec: shot.startSec,
      endSec: shot.endSec,
      url: shotMediaUrl(response.baseUrl || state.split.serviceBaseUrl, run.runId || response.runId || state.split.runId, shot.namedPath || shot.filePath)
    }))
  };
}

function addSplitResultsToLibrary(result) {
  const completedAt = new Date().toISOString();
  const additions = [];
  for (const clip of result.clips) {
    if (state.library.some((item) => item.remoteKey === clip.remoteKey)) continue;
    additions.push({ name: clip.name, url: clip.url, kind: "video", origin: "素材分割", remoteKey: clip.remoteKey, completedAt });
  }
  state.library.unshift(...additions);
  sortLibraryNewestFirst();
}

function formatFileSize(bytes) {
  const value = Math.max(0, Number(bytes) || 0);
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)} GB`;
  if (value >= 1024 ** 2) return `${Math.round(value / 1024 ** 2)} MB`;
  return `${Math.max(1, Math.round(value / 1024))} KB`;
}

function batchStageText(stage, status) {
  if (status === "completed") return "已完成";
  if (status === "failed") return "处理失败";
  const labels = {
    queued: "等待处理",
    ffmpeg_processing: "正在检测镜头",
    ffmpeg_completed: "正在准备命名",
    naming_processing: "正在分析命名",
    analysis_video_processing: "正在准备分析视频",
    analysis_video_completed: "正在分析片段",
    provider_processing: "正在分析片段",
    provider_retry: "正在重试分析",
    quota_wait: "等待服务配额",
    naming_export: "正在整理命名片段"
  };
  return labels[stage] || "处理中";
}

function batchFromResponse(response) {
  const sourceBatch = response.batch || {};
  const previous = state.split.batch;
  let queuedPosition = 0;
  const items = (response.items || sourceBatch.items || []).map((entry, index) => {
    const rawStatus = String(entry.status || "queued").toLowerCase();
    const status = rawStatus === "completed" || rawStatus === "failed" || rawStatus === "queued" ? rawStatus : "processing";
    if (status === "queued") queuedPosition += 1;
    const old = previous?.items?.find((item) => item.id === entry.videoId);
    const manifest = Array.isArray(entry.renameManifest) && entry.renameManifest.length ? entry.renameManifest : entry.shots || [];
    const clips = manifest.map((clip, clipIndex) => {
      const relativePath = String(clip.namedPath || clip.filePath || "").replaceAll("\\", "/");
      return {
        id: clip.shotId || `shot_${clipIndex + 1}`,
        remoteKey: `${sourceBatch.batchId}:items/${entry.videoId}/${relativePath || clipIndex}`,
        name: clip.namedFilename || `${clip.shotId || `片段_${clipIndex + 1}`}.mp4`,
        startSec: clip.startSec,
        endSec: clip.endSec,
        url: relativePath ? shotMediaUrl(response.baseUrl || state.split.serviceBaseUrl, sourceBatch.batchId, `items/${entry.videoId}/${relativePath}`) : ""
      };
    });
    return {
      id: entry.videoId || `video_${index + 1}`,
      name: entry.sourceFilename || old?.name || `视频 ${index + 1}`,
      size: old?.size || "",
      status,
      rawStatus,
      stage: entry.stage || rawStatus,
      detail: status === "failed" ? entry.errorRecord?.message || entry.error || "处理失败" : batchStageText(entry.stage, status),
      clipCount: clips.length || Number(entry.namedShotCount || entry.shots?.length || 0),
      clips,
      queuePosition: status === "queued" ? queuedPosition : null,
      completedAt: entry.completedAt || entry.updatedAt || sourceBatch.finishedAt || null,
      keepAudio: entry.keepAudio ?? sourceBatch.keepAudio ?? state.split.keepAudio
    };
  });
  return {
    id: sourceBatch.batchId || previous?.id || null,
    status: String(sourceBatch.status || previous?.status || "queued").toLowerCase(),
    active: Boolean(sourceBatch.active),
    filter: previous?.filter || "all",
    selectedVideoId: previous?.selectedVideoId || null,
    mode: sourceBatch.workflow || previous?.mode || state.split.mode,
    keepAudio: sourceBatch.keepAudio ?? previous?.keepAudio ?? state.split.keepAudio,
    items,
    preview: false
  };
}

function addBatchResultsToLibrary(batch) {
  const additions = [];
  for (const entry of batch?.items || []) {
    if (entry.status !== "completed") continue;
    for (const clip of entry.clips || []) {
      if (!clip.url || state.library.some((item) => item.remoteKey === clip.remoteKey)) continue;
      additions.push({ name: clip.name, url: clip.url, kind: "video", origin: `素材分割 · ${entry.name}`, remoteKey: clip.remoteKey, completedAt: entry.completedAt || new Date().toISOString() });
    }
  }
  state.library.unshift(...additions);
  sortLibraryNewestFirst();
}

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function pollSplitRun() {
  const item = state.split;
  while (item.running && item.runId) {
    const response = await videoClient.getShotRun(item.runId);
    item.serviceBaseUrl = response.baseUrl || item.serviceBaseUrl;
    const run = response.run || {};
    if (run.status === "failed") {
      const error = new Error(run.namingError || response.namingError?.message || "素材处理失败");
      error.stage = run.stage || "素材处理";
      throw error;
    }
    updateSplitStage(run.stage || run.status);
    if (state.active === "split") render({ preserveControls: true });
    if (run.status === "completed") return response;
    await wait(2000);
  }
  throw new Error("素材处理已中断");
}

async function pollSplitBatch() {
  const item = state.split;
  while (item.running && item.runId) {
    const response = await videoClient.getShotBatch(item.runId);
    item.serviceBaseUrl = response.baseUrl || item.serviceBaseUrl;
    item.batch = batchFromResponse(response);
    if (state.active === "split" && !item.batch.selectedVideoId) renderBatchStatus();
    if (!item.batch.active && ["completed", "partial", "failed"].includes(item.batch.status)) return item.batch;
    await wait(2000);
  }
  throw new Error("批量素材处理已中断");
}

function renderBatchStatus() {
  const controls = workspace.querySelector(".control-panel");
  const controlsScroll = controls?.querySelector(".panel-scroll")?.scrollTop || 0;
  const outputScroll = workspace.querySelector(".output-panel")?.scrollTop || 0;
  renderBatchSplit(state.split);
  const freshControls = workspace.querySelector(".control-panel");
  if (controls && freshControls) {
    freshControls.replaceWith(controls);
    const panelScroll = controls.querySelector(".panel-scroll");
    if (panelScroll) panelScroll.scrollTop = controlsScroll;
  }
  const output = workspace.querySelector(".output-panel");
  if (output) output.scrollTop = outputScroll;
}

async function runSplitBatch({ resume = false, retryVideoId = null } = {}) {
  const item = state.split;
  if (item.running || (!resume && !retryVideoId && item.sources.length < 2) || ((resume || retryVideoId) && !item.runId)) return;
  item.running = true;
  item.error = null;
  try {
    if (retryVideoId) await videoClient.retryShotBatchItem(item.runId, retryVideoId);
    else if (resume) await videoClient.resumeShotBatch(item.runId);
    else {
      item.batch = {
        id: null,
        status: "uploading",
        active: true,
        filter: "all",
        selectedVideoId: null,
        mode: item.mode,
        keepAudio: item.keepAudio,
        preview: false,
        items: item.sources.map((source, index) => ({ id: `upload_${index}`, name: source.name, size: source.size, status: "queued", detail: "等待上传", clipCount: 0, clips: [], queuePosition: index + 1 }))
      };
      render();
      const response = await videoClient.createShotBatch(item.sources.map((source) => source.file), item.mode, item.keepAudio);
      item.runId = response.batchId;
      item.serviceBaseUrl = response.baseUrl;
    }
    const batch = await pollSplitBatch();
    addBatchResultsToLibrary(batch);
    const completed = batch.items.filter((entry) => entry.status === "completed").length;
    const failed = batch.items.filter((entry) => entry.status === "failed").length;
    notify(failed ? `批次完成：${completed} 个成功，${failed} 个失败` : `批量素材处理完成，共 ${completed} 个视频`);
  } catch (error) {
    item.error = { stage: "批量素材处理", rawStage: "batch", message: error.message };
  } finally {
    item.running = false;
    if (item.batch) item.batch.active = false;
    if (state.active === "split") render();
  }
}

async function runSplit({ resumeNaming = false } = {}) {
  const item = state.split;
  if (!resumeNaming && item.sources.length > 1) return runSplitBatch();
  if (item.running || !item.source) return;
  item.running = true;
  item.result = null;
  item.error = null;
  try {
    let response;
    if (resumeNaming && item.runId) {
      updateSplitStage("naming_prepare");
      render();
      await videoClient.resumeShotNaming(item.runId);
      response = await pollSplitRun();
    } else {
      item.runId = null;
      updateSplitStage("uploading");
      render();
      updateSplitStage("ffmpeg_processing");
      render({ preserveControls: true });
      response = await videoClient.createShotRun(item.source.file, item.mode, item.keepAudio);
      item.runId = response.runId;
      item.serviceBaseUrl = response.baseUrl;
      if (item.mode === "ffmpeg_gemini_naming") response = await pollSplitRun();
    }
    updateSplitStage("completed");
    const result = splitResultFrom(response);
    addSplitResultsToLibrary(result);
    item.result = result;
    notify(`素材处理完成，共 ${result.clips.length} 个片段`);
  } catch (error) {
    const rawStage = error.stage || item.stage || "素材处理";
    item.error = { stage: rawStage, rawStage, message: error.message };
  } finally {
    item.running = false;
    item.progress = 0;
    if (state.active === "split") render();
  }
}

function updateRemakeStage(stage) {
  const item = state.remake;
  const values = { upload: 12, image: 45, video: 78, completed: 100 };
  const labels = { upload: "上传素材并抽取关键帧", image: "逐张生成商品替换关键帧", video: "根据确认关键帧生成视频", completed: "整理最终成片" };
  const routeIndexes = { upload: 0, image: 1, video: 2, completed: 3 };
  item.progress = values[stage] || item.progress || 5;
  if (Number.isInteger(routeIndexes[stage])) item.routeIndex = routeIndexes[stage];
  item.stage = labels[stage] || stage || "准备任务";
}

async function pollKlingRun() {
  const item = state.remake;
  while (item.running && item.runId) {
    let response = await videoClient.getKlingRun(item.runId);
    item.serviceBaseUrl = response.baseUrl || item.serviceBaseUrl;
    const status = String(response.status || "").toUpperCase();
    if (status === "FAILED") {
      const error = new Error(response.message || "产品替换失败");
      error.stage = response.stage || "video";
      error.keyframeIndex = response.imageTasks?.find((task) => String(task.status || "").toUpperCase() === "FAILED")?.index;
      error.confirmedFailed = true;
      throw error;
    }
    updateRemakeStage(response.stage || "upload");
    if (response.stage === "image" && status === "SUCCEEDED" && (response.editedKeyframes?.length || response.editedImage)) return response;
    if (state.active === "remake") render({ preserveControls: true });
    if (response.stage === "video" && status === "SUCCEEDED" && response.output?.url) return response;
    await wait(2000);
  }
  throw new Error("产品替换任务已中断");
}

async function runRemake({ retryVideo = false } = {}) {
  const item = state.remake;
  const referenceVideoMode = item.videoMode === "reference_video";
  if (item.running || !item.reference || !item.products.length || (!referenceVideoMode && (!item.voiceScript.trim() || item.voiceScript.length > item.duration * 6))) return;
  item.running = true;
  item.result = null;
  item.error = null;
  try {
    let response;
    if (retryVideo && item.runId) {
      updateRemakeStage("video");
      render();
      response = await videoClient.startKlingVideo(item.runId, item.voiceScript, item.videoMode, item.duration, item.keyframeTimes, true);
      item.runId = response.id || item.runId;
      item.serviceBaseUrl = response.baseUrl || item.serviceBaseUrl;
    } else {
      item.runId = null;
      updateRemakeStage("upload");
      render();
      response = await videoClient.createKlingRun(item.reference.file, item.products[0].file, item.voiceScript, item.audio, item.videoMode, item.duration);
      item.runId = response.id;
      item.serviceBaseUrl = response.baseUrl;
    }
    response = await pollKlingRun();
    if (response.stage === "image") {
      item.editedImage = response.editedImage;
      item.editedKeyframes = response.editedKeyframes || (response.editedImage ? [response.editedImage] : []);
      item.keyframeTimes = response.keyframeTimes || [];
      item.selectedRetryIndexes = [];
      item.imageReady = true;
      item.running = false;
      item.progress = 0;
      item.stage = "替换关键帧已生成";
      if (state.active === "remake") render();
      notify("替换关键帧已生成，请逐张确认或重试");
      return;
    }
    updateRemakeStage("completed");
    const url = new URL(response.output.url, response.baseUrl || item.serviceBaseUrl).toString();
    const remoteKey = `${response.id}:${response.output.id}`;
    item.result = { name: response.output.name || "商品替换成片.mp4", url, remoteKey, runId: response.id, completedAt: response.updatedAt || new Date().toISOString() };
    if (!state.library.some((asset) => asset.remoteKey === remoteKey)) state.library.unshift({ ...item.result, kind: "video", origin: "产品替换" });
    sortLibraryNewestFirst();
    notify("产品替换已完成");
  } catch (error) {
    const rawStage = error.stage || item.stage || "产品替换";
    item.error = { stage: rawStage, rawStage, message: error.message, keyframeIndex: error.keyframeIndex };
  } finally {
    item.running = false;
    item.progress = 0;
    if (state.active === "remake") render();
  }
}

async function recoverRemake() {
  const item = state.remake;
  if (!item.runId || item.running) return;
  item.running = true;
  item.error = null;
  updateRemakeStage(item.stage || "video");
  render();
  try {
    let response = await videoClient.resumeKlingRun(item.runId);
    item.serviceBaseUrl = response.baseUrl || item.serviceBaseUrl;
    if (String(response.status || "").toUpperCase() === "FAILED") {
      const error = new Error(response.message || "原任务已确认失败");
      error.stage = response.stage || "video";
      error.keyframeIndex = response.imageTasks?.find((task) => String(task.status || "").toUpperCase() === "FAILED")?.index;
      error.confirmedFailed = true;
      throw error;
    }
    if (String(response.status || "").toUpperCase() !== "SUCCEEDED") response = await pollKlingRun();
    if (response.stage === "image") {
      item.editedImage = response.editedImage;
      item.editedKeyframes = response.editedKeyframes || (response.editedImage ? [response.editedImage] : []);
      item.keyframeTimes = response.keyframeTimes || [];
      item.imageReady = true;
      notify("已恢复原任务的关键帧结果，未重新提交");
      return;
    }
    const url = new URL(response.output.url, response.baseUrl || item.serviceBaseUrl).toString();
    const remoteKey = `${response.id}:${response.output.id}`;
    item.result = { name: response.output.name || "商品替换成片.mp4", url, remoteKey, runId: response.id, completedAt: response.updatedAt || new Date().toISOString() };
    if (!state.library.some((asset) => asset.remoteKey === remoteKey)) state.library.unshift({ ...item.result, kind: "video", origin: "产品替换" });
    sortLibraryNewestFirst();
    notify("已恢复原任务结果，未重新提交");
  } catch (error) {
    const rawStage = error.stage || item.stage || "产品替换";
    item.error = { stage: rawStage, rawStage, message: error.message, keyframeIndex: error.keyframeIndex, confirmedFailed: Boolean(error.confirmedFailed) };
  } finally {
    item.running = false;
    item.progress = 0;
    if (state.active === "remake") render();
  }
}

async function confirmRemakeImage() {
  const item = state.remake;
  if (!item.runId || !item.imageReady || !item.editedKeyframes.length || item.running || item.voiceScript.length > item.duration * 6) return;
  item.running = true;
  item.imageReady = false;
  item.error = null;
  updateRemakeStage("video");
  render();
  try {
    await videoClient.startKlingVideo(item.runId, item.voiceScript, item.videoMode, item.duration, item.keyframeTimes);
    const response = await pollKlingRun();
    updateRemakeStage("completed");
    const url = new URL(response.output.url, response.baseUrl || item.serviceBaseUrl).toString();
    const remoteKey = `${response.id}:${response.output.id}`;
    item.result = { name: response.output.name || "商品替换成片.mp4", url, remoteKey, runId: response.id, completedAt: response.updatedAt || new Date().toISOString() };
    if (!state.library.some((asset) => asset.remoteKey === remoteKey)) state.library.unshift({ ...item.result, kind: "video", origin: "产品替换" });
    sortLibraryNewestFirst();
    notify("产品替换已完成");
  } catch (error) {
    item.error = { stage: error.stage || "video", rawStage: error.stage || "video", message: error.message };
  } finally { item.running = false; item.progress = 0; if (state.active === "remake") render(); }
}

async function retryRemakeImages(indexes = [0]) {
  const item = state.remake;
  const selectedIndexes = [...new Set((Array.isArray(indexes) ? indexes : [indexes]).filter(Number.isInteger))].sort((a, b) => a - b);
  if (!item.runId || item.running || !selectedIndexes.length) return;
  item.running = true;
  item.imageReady = false;
  item.error = null;
  updateRemakeStage("image");
  render();
  try {
    await videoClient.retryKlingImage(item.runId, item.videoMode === "multi_keyframes" ? selectedIndexes : undefined);
    const response = await pollKlingRun();
    item.editedImage = response.editedImage;
    item.editedKeyframes = response.editedKeyframes || (response.editedImage ? [response.editedImage] : []);
    item.keyframeTimes = response.keyframeTimes || item.keyframeTimes;
    item.selectedRetryIndexes = [];
    item.imageReady = true;
    notify(selectedIndexes.length === 1 ? `第 ${selectedIndexes[0] + 1} 张替换关键帧已重新生成` : `${selectedIndexes.length} 张替换关键帧已重新生成`);
  } catch (error) { item.error = { stage: "image", rawStage: "image", message: error.message }; }
  finally { item.running = false; item.progress = 0; if (state.active === "remake") render(); }
}

function renderRemake() {
  const item = state.remake;
  const referenceVideoMode = item.videoMode === "reference_video";
  const videoResolution = referenceVideoMode ? "720P" : "768P";
  const videoRatio = referenceVideoMode ? "跟随原视频" : "9:16";
  const referenceVideoReady = item.config?.referenceVideoConfigured !== false;
  const lockedVideoModes = item.running ? ["关键帧生成", "参考视频生成"] : [];
  const videoModeOptions = options("remakeVideoMode", ["关键帧生成", "参考视频生成"], referenceVideoMode ? "参考视频生成" : "关键帧生成", lockedVideoModes);
  const durationLabel = `${item.duration} 秒`;
  const durationValues = referenceVideoMode ? ["5 秒", "10 秒", "15 秒"] : ["5 秒", "8 秒", "10 秒", "15 秒"];
  const durationOptions = options("remakeDuration", durationValues, durationLabel, item.running ? durationValues : []);
  const voiceLimit = item.duration * 6;
  const voiceWithinLimit = item.voiceScript.length <= voiceLimit;
  const soundOptions = options("audio", ["无声音", "有声音"], item.audio === "voice" ? "有声音" : "无声音");
  const voiceInput = referenceVideoMode ? "" : `<div class="voice-script ${voiceWithinLimit ? "" : "is-over-limit"}"><label for="remakeVoiceScript"><strong>台词</strong><small><b>${item.voiceScript.length}</b> / ${voiceLimit} 字</small></label><textarea id="remakeVoiceScript" maxlength="${voiceLimit}" placeholder="输入约 ${item.duration} 秒的台词，建议不超过 ${voiceLimit} 字">${esc(item.voiceScript)}</textarea></div>`;
  const ready = referenceVideoMode ? item.config?.klingConfigured === true : item.config?.configured === true;
  const controls = `<header class="panel-heading"><h2>替换视频中的商品</h2>${referenceVideoMode ? "" : "<p>自动抽取并替换多张关键帧，确认后再生成视频。</p>"}</header><div class="panel-scroll">${step(1, "产品图", "单张产品图", item.products.length ? `<div class="image-grid single"><img src="${esc(item.products[0].url)}" alt="${esc(item.products[0].name)}"></div><label class="inline-action" for="productInput">重新选择</label><input id="productInput" type="file" accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp" hidden>` : uploadBox("productInput", "上传产品图", "JPG / PNG / WEBP · 单张图片", "image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp"))}${step(2, "参考视频", referenceVideoMode ? "输入视频需为 3–10 秒" : `建议与 ${item.duration} 秒输出时长一致`, item.reference ? `${mediaPreview(item.reference)}<label class="inline-action" for="referenceInput">替换视频</label><input id="referenceInput" type="file" accept="video/mp4,video/quicktime,.mp4,.mov" hidden>` : uploadBox("referenceInput", "上传参考视频", referenceVideoMode ? "MP4 / MOV · 3–10 秒" : `MP4 / MOV · 建议 ${item.duration} 秒`, "video/mp4,video/quicktime,.mp4,.mov"))}${step(3, "生成方式", referenceVideoMode ? referenceVideoReady ? "Kling 直接参考原视频的动作与镜头" : "首次生成时将自动连接临时公网通道" : "抽取 4–6 张关键帧并逐张替换", videoModeOptions)}${step(4, "输出规格", "", `<div class="duration-choice"><small>视频时长</small>${durationOptions}</div><div class="fixed-specs fixed-specs--two"><span><small>视频比例</small><strong>${videoRatio}</strong></span><span><small>分辨率</small><strong>${videoResolution}</strong></span></div>`)}${step(5, "声音", "", `${soundOptions}${voiceInput}`)}</div><footer class="submit"><button class="primary" data-action="remake-generate" ${!ready || item.running || item.imageReady || !item.products.length || !item.reference || (!referenceVideoMode && (!item.voiceScript.trim() || !voiceWithinLimit)) ? "disabled" : ""}>${item.running ? "正在生成…" : referenceVideoMode ? "直接生成替换视频 →" : "生成替换关键帧 →"}</button><small>${!ready ? `${referenceVideoMode ? "Kling" : "商品替换"}服务未配置` : !referenceVideoMode && !voiceWithinLimit ? `当前台词超过 ${item.duration} 秒建议上限，请缩短至 ${voiceLimit} 字以内` : item.products.length && item.reference ? `${referenceVideoMode ? referenceVideoReady ? "Kling 3.0 Omni 参考原视频和商品图" : "生成前会先连接 Cloudflare 临时通道" : "确认全部替换关键帧后再生成视频"} · ${item.duration} 秒 · ${videoRatio} · ${videoResolution} · ${referenceVideoMode ? item.audio === "voice" ? "保留原视频音轨" : "输出无声" : item.audio === "voice" ? "保留声音" : "生成口型后移除声音"}` : "请先上传产品图与参考视频"}</small></footer>`;
  let output = referenceVideoMode
    ? `<header class="output-heading"><h2>参考视频 + 商品图 = 替换成片</h2></header><div class="equation"><span>参考视频</span><b>＋</b><span>商品图片</span><b>→</b><span class="accent">替换成片</span></div><div class="empty"><i>替</i><h3>准备产品图、参考视频和台词</h3><p>此模式直接生成成片，不经过关键帧确认。</p></div>`
    : `<header class="output-heading"><h2>多张替换关键帧生成成片</h2></header><div class="equation"><span>4–6 张关键帧</span><b>＋</b><span>商品图片</span><b>→</b><span class="accent">替换成片</span></div><div class="empty"><i>替</i><h3>准备产品图、参考视频和台词</h3><p>关键帧全部生成后会等待确认，再进入视频生成阶段。</p></div>`;
  if (item.error) {
    const safeRetry = item.runId ? `<button class="primary" data-action="retry-remake" type="button">↻　检查并恢复原任务</button>` : "";
    const paidRetry = item.runId && item.error.confirmedFailed ? `<button class="secondary" data-action="retry-remake-paid" type="button">重新生成失败阶段（会再次计费）</button>` : "";
    const safetyNote = item.runId ? "检查操作只查询原任务，不会重新提交，也不会新增计费。" : "未取得可恢复的任务编号；已停止自动重试，避免产生重复计费。";
    output = `<header class="output-heading"><h2>产品替换</h2></header><div class="failure-state"><i>!</i><small>生成失败 · ${esc(item.error.stage || "生成替换视频")}</small><h2>未能生成替换视频</h2><p>${esc(item.error.message || "服务处理失败。")}</p><p>${safetyNote}</p><div class="confirm-actions">${safeRetry}${paidRetry}</div></div>`;
  }
  if (item.running) output = progressOutput(item.progress, referenceVideoMode ? ["上传素材", "读取参考内容", "生成替换视频", "整理最终成片"] : ["抽取关键帧", "逐张替换商品", "生成替换视频", "整理最终成片"], item.stage, "task-processing", item);
  if (item.imageReady && item.editedKeyframes.length) {
    const selectedRetryIndexes = item.selectedRetryIndexes || [];
    output = `<header class="output-heading"><h2>请逐张确认商品替换是否正确</h2></header><div class="keyframe-review-grid">${item.editedKeyframes.map((frame, index) => { const selected = selectedRetryIndexes.includes(index); return `<article class="${selected ? "is-selected" : ""}"><img src="${esc(new URL(frame.url, item.serviceBaseUrl).toString())}" alt="替换关键帧 ${index + 1}"><span><strong>关键帧 ${index + 1}</strong><small>约 ${Number(item.keyframeTimes[index] || 0).toFixed(1)} 秒</small></span><button class="keyframe-select" data-action="toggle-remake-image" data-keyframe-index="${index}" type="button" aria-pressed="${selected}"><i aria-hidden="true">${selected ? "✓" : ""}</i>${selected ? "已选择" : "选择重做"}</button></article>`; }).join("")}</div><div class="confirm-actions"><button class="icon-button" data-action="retry-selected-remake-images" type="button" ${selectedRetryIndexes.length ? "" : "disabled"}>重新生成所选${selectedRetryIndexes.length ? `（${selectedRetryIndexes.length}）` : ""}</button><button class="primary" data-action="confirm-remake-image" type="button" ${voiceWithinLimit ? "" : "disabled"}>确认并生成 ${item.duration} 秒视频</button></div>`;
  }
  if (item.result) output = `<header class="output-heading"><h2>产品替换已完成</h2></header><div class="result-video remake-final-video"><video src="${esc(item.result.url)}" controls></video></div>`;
  workspace.innerHTML = page("产品替换", "按参考视频生成同款", controls, output);
}

function renderBatchSplit(item) {
  const batch = item.batch;
  const completed = batch.items.filter((entry) => entry.status === "completed").length;
  const processing = batch.items.filter((entry) => entry.status === "processing").length;
  const queued = batch.items.filter((entry) => entry.status === "queued").length;
  const failed = batch.items.filter((entry) => entry.status === "failed").length;
  const pending = Math.max(0, batch.items.length - completed);
  const canResume = !item.running && !batch.active && pending > 0 && batch.id;
  const totalSize = batch.preview ? "1.8 GB" : formatFileSize(item.sources.reduce((sum, source) => sum + Number(source.file?.size || 0), 0));
  const primaryFooterAction = batch.status === "completed" && !pending ? `<button class="primary" data-action="batch-new" type="button">开始新的批次</button>` : canResume ? `<button class="primary" data-action="batch-resume" type="button">继续处理 ${pending} 个未完成视频</button>` : `<button class="primary" type="button" disabled>${batch.status === "uploading" ? "正在上传视频…" : `正在处理 ${batch.items.length} 个视频…`}</button>`;
  const footerAction = failed && !item.running && !batch.active ? `<div class="batch-submit-actions">${primaryFooterAction}<button class="batch-new-button" data-action="batch-new" type="button">开始新批次</button></div>` : primaryFooterAction;
  const controls = `<header class="panel-heading"><h2>把多条视频整理成素材</h2><p>统一设置后，按顺序完成拆分与命名。</p></header><div class="panel-scroll">${step(1, "视频队列", `已选择 ${batch.items.length} 个视频`, `<div class="batch-upload-summary"><i>${batch.items.length}</i><span><strong>${batch.items.length} 个视频已加入队列</strong><small>${totalSize} · 处理期间不可修改</small></span></div><div class="batch-source-list">${batch.items.map((entry, index) => `<span><i>${String(index + 1).padStart(2, "0")}</i><strong>${esc(entry.name)}</strong><small>${esc(entry.size || "")}</small></span>`).join("")}</div>`)}${step(2, "处理方式", "应用到全部视频", options("splitMode", ["分割", "分割并命名"], batch.mode === "ffmpeg_only" ? "分割" : "分割并命名", ["分割", "分割并命名"]))}${step(3, "声音", "应用到全部视频", options("splitAudio", ["保留原声", "去除声音"], batch.keepAudio ? "保留原声" : "去除声音", ["保留原声", "去除声音"]))}</div><footer class="submit">${footerAction}<small>串行处理 · 单个失败不会中断后续视频</small></footer>`;

  if (batch.selectedVideoId) {
    const selected = batch.items.find((entry) => entry.id === batch.selectedVideoId);
    const previewVideo = "../../video-mix-standalone/assets/video-remake/spring-water-reference-5s.mp4";
    const clipNames = ["人物手持商品正面展示的稳定镜头", "产品包装细节与人物自然动作", "侧面角度展示商品使用过程", "人物转身后继续手持商品", "桌面环境中的产品近景片段", "自然光线下的商品互动镜头", "人物面向镜头完成口播动作", "结尾画面与商品稳定定格"];
    const clips = batch.preview ? clipNames.slice(0, selected.clipCount).map((name, index) => ({ name, url: previewVideo, startSec: index * 3, endSec: index * 3 + 3 })) : selected.clips || [];
    const output = `<header class="output-heading batch-detail-heading"><button class="icon-button" data-action="batch-back" type="button">← 返回批次结果</button><h2>${esc(selected.name)}</h2></header><div class="batch-detail-summary"><strong>${selected.clipCount} 个片段</strong><span>${selected.keepAudio ?? batch.keepAudio ? "保留原声" : "已去除声音"}</span><span>${batch.mode === "ffmpeg_only" ? "分割" : "分割并命名"}</span></div><div class="clip-grid batch-detail-clips">${clips.map((clip) => `<article class="previewable" tabindex="0" data-preview-url="${esc(clip.url)}" data-preview-kind="video" data-preview-name="${esc(clip.name)}"><div class="clip-card__preview"><video src="${esc(clip.url)}" muted playsinline preload="metadata" tabindex="-1"></video></div><div class="clip-card__info"><strong title="${esc(clip.name)}">${esc(clip.name)}</strong><small>${formatTime(clip.startSec)} - ${formatTime(clip.endSec)}</small></div></article>`).join("")}</div>`;
    workspace.innerHTML = page("素材分割", batch.preview ? "批量素材处理预览" : "批量素材处理", controls, output, "batch-preview-page");
    return;
  }

  const filters = [
    { id: "all", label: "全部", count: batch.items.length },
    { id: "processing", label: "处理中", count: processing },
    { id: "completed", label: "已完成", count: completed },
    { id: "failed", label: "失败", count: failed }
  ];
  const visibleItems = batch.filter === "all" ? batch.items : batch.items.filter((entry) => entry.status === batch.filter);
  const statusText = { completed: "已完成", processing: "处理中", queued: "等待处理", failed: "处理失败" };
  const statusIcon = { completed: "✓", processing: "●", queued: "○", failed: "!" };
  const active = item.running || batch.active ? batch.items.find((entry) => entry.status === "processing") : null;
  const stageIndex = active ? /naming_prepare|ffmpeg_completed/.test(active.stage) ? 1 : /ffmpeg_processing/.test(active.stage) ? 0 : /naming|analysis|provider|quota/.test(active.stage) ? 2 : 3 : 3;
  const activeProgress = batch.mode === "ffmpeg_only" ? `<div class="batch-indeterminate-progress" role="progressbar" aria-label="正在分割视频"><i></i></div>` : processRoute(["检测镜头", "导出片段", "分析命名", "整理结果"], stageIndex);
  const activePanel = active ? `<section class="batch-active"><header><span><i></i><small>当前处理</small><strong>${esc(active.name)}</strong></span><b>${esc(active.detail || "处理中")}</b></header>${activeProgress}</section>` : `<section class="batch-active is-idle"><header><span><i></i><small>${pending ? "等待继续" : "批次状态"}</small><strong>${pending ? `${pending} 个视频尚未完成` : "全部视频处理完成"}</strong></span></header></section>`;
  const output = `<header class="output-heading"><h2>批量素材处理</h2></header><div class="batch-overview"><div class="batch-stats"><span><strong>${completed} / ${batch.items.length}</strong><small>已完成</small></span><span><strong>${processing}</strong><small>处理中</small></span><span><strong>${queued}</strong><small>等待</small></span><span class="${failed ? "has-failure" : ""}"><strong>${failed}</strong><small>失败</small></span></div>${activePanel}<nav class="batch-filters">${filters.map((filter) => `<button type="button" data-batch-filter="${filter.id}" class="${batch.filter === filter.id ? "active" : ""}">${filter.label}<small>${filter.count}</small></button>`).join("")}</nav><div class="batch-result-list">${visibleItems.map((entry) => `<article class="batch-result-row is-${entry.status}"><i>${statusIcon[entry.status]}</i><span><strong>${esc(entry.name)}</strong><small>${statusText[entry.status]}${entry.detail ? ` · ${esc(entry.detail)}` : ""}</small></span><b>${entry.status === "completed" ? `${entry.clipCount} 个片段` : entry.status === "queued" ? `队列第 ${entry.queuePosition} 位` : ""}</b>${entry.status === "completed" ? `<button class="icon-button" data-action="batch-view-result" data-video-id="${entry.id}" type="button">查看结果</button>` : entry.status === "failed" ? `<button class="icon-button" data-action="${batch.preview ? "batch-retry-demo" : "batch-retry-item"}" data-video-id="${entry.id}" type="button">重试</button>` : "<em></em>"}</article>`).join("")}</div></div>`;
  workspace.innerHTML = page("素材分割", batch.preview ? "批量素材处理预览" : "批量素材处理", controls, output, "batch-preview-page");
}

function renderSplit() {
  const item = state.split;
  if (item.batch) return renderBatchSplit(item);
  const namingAvailable = item.config?.apiKeyConfigured === true;
  const flow = item.mode === "ffmpeg_only"
    ? ["上传视频", "检测镜头边界", "导出视频片段", "整理运行产物"]
    : ["上传视频", "检测并导出片段", "分析片段并命名", "生成命名清单"];
  const lockedOptions = item.running ? ["分割", "分割并命名"] : namingAvailable ? [] : ["分割并命名"];
  const lockedAudio = item.running ? ["保留原声", "去除声音"] : [];
  const sourceCount = item.sources.length;
  const sourceContent = sourceCount > 1
    ? `<div class="batch-upload-summary"><i>${sourceCount}</i><span><strong>${sourceCount} 个视频已选择</strong><small>${formatFileSize(item.sources.reduce((sum, source) => sum + source.file.size, 0))} · 最多 25 个</small></span></div><div class="batch-source-list is-editable">${item.sources.map((source, index) => `<span><i>${String(index + 1).padStart(2, "0")}</i><strong>${esc(source.name)}</strong><small>${esc(source.size)}</small><button type="button" data-action="split-remove-source" data-source-index="${index}" aria-label="移除 ${esc(source.name)}">×</button></span>`).join("")}</div><label class="inline-action" for="splitInput">重新选择</label><input id="splitInput" type="file" accept="video/*" multiple hidden>`
    : item.source ? `${mediaPreview(item.source)}<label class="inline-action" for="splitInput">重新选择</label><input id="splitInput" type="file" accept="video/*" multiple hidden>`
      : uploadBox("splitInput", "上传一个或多个长视频", `MP4 / MOV / WEBM · 单个不超过 ${item.config?.uploadLimitMb || 500}MB`, "video/*", true);
  const controls = `<header class="panel-heading"><h2>把长视频整理成可用素材</h2><p>上传视频，按镜头切分命名。</p></header><div class="panel-scroll">${step(1, "上传视频", sourceCount ? `已选择 ${sourceCount} 个本地视频` : "支持单个或批量处理", sourceContent)}${step(2, "处理方式", "", options("splitMode", ["分割", "分割并命名"], item.mode === "ffmpeg_only" ? "分割" : "分割并命名", lockedOptions))}${step(3, "声音", "", options("splitAudio", ["保留原声", "去除声音"], item.keepAudio ? "保留原声" : "去除声音", lockedAudio))}</div><footer class="submit"><button class="primary" data-action="split-generate" ${!sourceCount || item.running ? "disabled" : ""}>${item.running ? "正在处理…" : sourceCount > 1 ? `开始处理 ${sourceCount} 个视频 →` : "开始素材处理 →"}</button><small>${!namingAvailable ? `分割可用 · 命名服务未配置 · ${item.keepAudio ? "保留原声" : "去除声音"}` : sourceCount ? `完成后将显示切分片段 · ${item.keepAudio ? "保留原声" : "去除声音"}` : "请先上传视频"}</small></footer>`;
  let output = `<header class="output-heading"><h2>${sourceCount > 1 ? "多条视频，统一整理成素材" : "一条长视频，整理成多个片段"}</h2></header><div class="empty"><i>分</i><h3>${sourceCount ? `${sourceCount} 个视频已就绪，可以开始处理` : "上传视频开始处理"}</h3><p>处理后的片段、名称和 FFmpeg 运行信息会在这里显示。</p></div>`;
  if (item.error) output = `<header class="output-heading"><h2>素材分割</h2></header><div class="failure-state"><i>!</i><small>处理失败 · ${esc(item.error.stage || "素材处理")}</small><h2>未能完成素材分割</h2><p>${esc(item.error.message || "处理进程意外终止，可以使用原有内容直接重试。")}</p><button class="primary" data-action="retry-split" type="button">↻　重试本次任务</button></div>`;
  if (item.running) output = progressOutput(item.progress, flow, item.stage, "task-processing", item);
  if (item.result) {
    const source = item.result.mediaTools?.ffmpeg?.source;
    const sourceLabel = source === "client_directory" ? "客户端目录" : source === "system_path" ? "系统目录" : source === "configured_path" ? "配置目录" : "未知目录";
    output = `<header class="output-heading"><h2>素材处理完成</h2></header><div class="clip-grid">${item.result.clips.map((clip) => `<article class="previewable" tabindex="0" data-preview-url="${esc(clip.url)}" data-preview-kind="video" data-preview-name="${esc(clip.name)}"><div class="clip-card__preview"><video src="${esc(clip.url)}" muted playsinline preload="metadata" tabindex="-1"></video></div><div class="clip-card__info"><strong title="${esc(clip.name)}">${esc(clip.name)}</strong><small>${formatTime(clip.startSec)} - ${formatTime(clip.endSec)}</small></div></article>`).join("")}</div>`;
  }
  workspace.innerHTML = page("素材分割", "素材清洗、分割与归档", controls, output);
}

function renderAudio() {
  const item = state.audio;
  const controls = `<header class="panel-heading"><h2>生成一段自然克隆配音</h2><p>选择清晰人声并输入文案，模拟声音克隆和连贯性处理。</p></header><div class="panel-scroll">${step(1, "选择克隆音色", "建议 5-30 秒无背景音乐的人声", item.source ? `${mediaPreview(item.source, "audio")}<label class="inline-action" for="audioInput">更换样本</label><input id="audioInput" type="file" accept="audio/*" hidden>` : uploadBox("audioInput", "上传音色样本", "MP3 / WAV / M4A", "audio/*"))}${step(2, "准备配音文案", "当前保留模拟生成", `<textarea id="audioScript" maxlength="1000" placeholder="输入需要合成的配音文案">${esc(item.script)}</textarea><small class="counter">${item.script.length} / 1000</small>`)}${step(3, "自动处理流程", "声音克隆、去气口、连贯优化", `<div class="stage-list"><span>克隆音色</span><span>清理气口与空白</span><span>生成连贯音频</span><span>保存到素材库</span></div>`)}</div><footer class="submit"><button class="primary" data-action="audio-generate" ${!item.source || !item.script.trim() ? "disabled" : ""}>${item.progress ? "正在处理…" : "开始生成音频 →"}</button><small>此功能目前为原型模拟</small></footer>`;
  let output = `<header class="output-heading"><span><small>生成结果</small><h2>从一段声音，生成自然配音</h2><p>真实声音克隆后端暂未接入。</p></span></header><div class="empty"><i>声</i><h3>选择音色并输入文案</h3><p>模拟完成后会生成示例音频并加入当前素材库。</p></div>`;
  if (item.progress) output = progressOutput(item.progress, ["克隆音色", "清理气口", "优化连贯性", "保存素材"], "", "", item);
  if (item.result) output = `<header class="output-heading"><span><small>生成结果</small><h2>克隆配音已生成</h2><p>当前播放示例音频。</p></span></header><div class="audio-result"><i>声</i><span><strong>${esc(item.result.name)}</strong><small>模拟产物 · 已去气口</small></span><audio src="../../video-mix-standalone/assets/video-audio/cloned-voice-clean.m4a" controls></audio></div>`;
  workspace.innerHTML = page("音频处理", "声音克隆与去气口", controls, output);
}

function renderCompose() {
  const item = state.compose;
  const controls = `<header class="panel-heading"><h2>把素材组合成完整视频</h2><p>输入视频文案，按段落组织主画面、口播和辅助素材。</p></header><div class="panel-scroll">${step(1, "确认视频文案", "文案定义段落和素材匹配条件", `<textarea id="composeScript" maxlength="1000" placeholder="输入完整视频文案，每个句段可用换行分隔">${esc(item.script)}</textarea><small class="counter">${item.script.length} / 1000</small>`)}${step(2, "选择素材", "后续从本地素材库读取", `<button class="library-placeholder" data-tool="library" type="button">库　从素材库选择</button>`)}${step(3, "输出规格", "统一画幅和清晰度", `<label>视频比例${options("composeRatio", ["9:16", "1:1", "16:9"], item.ratio)}</label><label>分辨率${options("composeResolution", ["720P", "1080P"], item.resolution)}</label>`)}</div><footer class="submit"><button class="primary" data-action="compose-generate" ${!item.script.trim() ? "disabled" : ""}>${item.progress ? "正在合成…" : "开始生成视频 →"}</button><small>此功能目前为原型模拟</small></footer>`;
  let output = `<header class="output-heading"><span><small>合成时间线</small><h2>文案、画面与声音统一编排</h2><p>真实合成与混音服务暂未接入。</p></span></header><div class="timeline"><span><b>文案</b><i></i><i></i><i></i></span><span><b>主画面</b><i></i><i></i><i></i></span><span><b>口播</b><i class="wide"></i></span><span><b>背景音乐</b><i class="wide faint"></i></span></div>`;
  if (item.progress) output = progressOutput(item.progress, ["拆分文案", "匹配素材", "合成轨道", "检查并导出"], "", "", item);
  if (item.result) output = `<header class="output-heading"><span><small>合成结果</small><h2>视频已生成</h2><p>当前为模拟结果，未执行真实 FFmpeg 合成。</p></span></header><div class="result-video"><video src="../../video-mix-standalone/assets/video-remake/spring-water-result-5s.mp4" controls></video></div>`;
  workspace.innerHTML = page("视频合成", "多类型素材智能成片", controls, output);
}

function renderLibrary() {
  const filters = [{ id: "all", label: "全部" }, { id: "video", label: "视频" }, { id: "image", label: "图片" }, { id: "audio", label: "音频" }];
  const visible = state.libraryFilter === "all" ? state.library : state.library.filter((item) => item.kind === state.libraryFilter);
  const cards = visible.length ? visible.map((item) => `<article class="asset-card previewable" tabindex="0" data-preview-url="${esc(item.url)}" data-preview-kind="${esc(item.kind)}" data-preview-name="${esc(item.name)}"><div class="asset-card__preview">${item.kind === "image" ? `<img src="${esc(item.url)}" alt="">` : item.kind === "audio" ? `<i>声</i>` : `<video src="${esc(item.url)}" preload="metadata"></video>`}</div><div class="asset-card__info"><strong title="${esc(item.name)}">${esc(item.name)}</strong><small>${esc(item.origin)}</small></div></article>`).join("") : `<div class="library-empty"><i>库</i><h2>${state.library.length ? "没有这一类型的素材" : "素材库暂时为空"}</h2><p>${state.library.length ? "切换其他分类查看素材。" : "当前可上传临时素材。后续将改为读取用户选择的本地目录。"}</p></div>`;
  const tabs = filters.map((filter) => {
    const count = filter.id === "all" ? state.library.length : state.library.filter((item) => item.kind === filter.id).length;
    return `<button type="button" data-library-filter="${filter.id}" class="${state.libraryFilter === filter.id ? "active" : ""}">${filter.label} <small>${count}</small></button>`;
  }).join("");
  workspace.innerHTML = `<section class="library-page"><header><span><small>共享基础能力</small><h1>素材库</h1><p>统一查看产品替换、素材分割、音频处理和视频合成使用的素材。</p></span><label class="primary upload-button" for="libraryInput">＋ 上传临时素材<input id="libraryInput" type="file" accept="video/*,audio/*,image/*" multiple hidden></label></header><nav class="library-tabs">${tabs}</nav><div class="asset-grid">${cards}</div></section>`;
}

function markOverflowingNames() {
  workspace.querySelectorAll(".asset-card, .clip-grid article").forEach((card) => {
    const info = card.querySelector(".asset-card__info, .clip-card__info");
    const name = info?.querySelector("strong");
    if (!info || !name) return;

    card.classList.remove("is-name-overflowing");
    info.style.removeProperty("--expanded-info-height");
    if (name.scrollWidth <= name.clientWidth + 1) return;

    card.classList.add("is-measuring-name");
    const expandedHeight = Math.ceil(info.scrollHeight);
    card.classList.remove("is-measuring-name");
    const availableHeight = Math.max(58, card.clientHeight - 12);
    info.style.setProperty("--expanded-info-height", `${Math.min(expandedHeight, availableHeight)}px`);
    card.classList.add("is-name-overflowing");
  });
}

function updateProcessingDisplay() {
  const item = state[state.active];
  const processing = workspace.querySelector(".processing");
  if (!item?.running || !processing) return false;
  const routeSteps = [...processing.querySelectorAll("[data-process-step]")];
  const activeIndex = routeIndexFor(item, routeSteps);
  routeSteps.forEach((step, index) => {
    step.classList.toggle("is-complete", index < activeIndex);
    step.classList.toggle("is-active", index === activeIndex);
    const marker = step.querySelector(".process-route__marker");
    const markerText = index < activeIndex ? "✓" : String(index + 1);
    if (marker && marker.textContent !== markerText) marker.textContent = markerText;
  });
  return true;
}

function render({ preserveScroll = true, preserveControls = false } = {}) {
  if (preserveControls) {
    updateProcessingDisplay();
    return;
  }
  const scrollPosition = preserveScroll ? {
    workspace: workspace.scrollTop,
    controls: workspace.querySelector(".panel-scroll")?.scrollTop || 0,
    output: workspace.querySelector(".output-panel")?.scrollTop || 0
  } : null;

  renderNavigation();
  ({ remake: renderRemake, split: renderSplit, audio: renderAudio, compose: renderCompose, library: renderLibrary })[state.active]();

  if (scrollPosition) {
    workspace.scrollTop = scrollPosition.workspace;
    const controls = workspace.querySelector(".panel-scroll");
    const output = workspace.querySelector(".output-panel");
    if (controls) controls.scrollTop = scrollPosition.controls;
    if (output) output.scrollTop = scrollPosition.output;
  }
  markOverflowingNames();
}
function addFile(file, kind, origin) { const item = { name: file.name, url: mediaUrl(file), kind, origin, file, completedAt: new Date().toISOString() }; state.library.unshift(item); sortLibraryNewestFirst(); return item; }
function runSimulation(key, done) { if (timers.has(key)) return; const item = state[key]; item.running = true; item.progress = 6; item.result = null; item.error = null; render(); const timer = setInterval(() => { item.progress = Math.min(100, item.progress + 9); if (item.progress < 100) return updateProcessingDisplay(); clearInterval(timer); timers.delete(key); item.running = false; item.progress = 0; item.result = done(); render(); notify("模拟处理完成"); }, 180); timers.set(key, timer); }

document.addEventListener("click", (event) => {
  if (event.target.closest("[data-preview-close]")) { closeMediaViewer(); return; }
  const libraryFilter = event.target.closest("[data-library-filter]")?.dataset.libraryFilter;
  if (libraryFilter) { state.libraryFilter = libraryFilter; render(); return; }
  const batchFilter = event.target.closest("[data-batch-filter]")?.dataset.batchFilter;
  if (batchFilter && state.split.batch) { state.split.batch.filter = batchFilter; render(); return; }
  const toolButton = event.target.closest("[data-tool]");
  if (toolButton?.dataset.unavailable === "true") { notify(`${toolButton.dataset.toolName}暂未开放，敬请期待`); return; }
  const tool = toolButton?.dataset.tool;
  if (tool) {
    state.active = tool;
    render({ preserveScroll: false });
    if (tool === "library") { void loadShotAssets(); void loadKlingAssets(); }
    return;
  }
  const option = event.target.closest("[data-option]");
  if (option) {
    const map = { audio: ["remake", "audio"], remakeVideoMode: ["remake", "videoMode"], remakeDuration: ["remake", "duration"], splitMode: ["split", "mode"], splitAudio: ["split", "keepAudio"], composeRatio: ["compose", "ratio"], composeResolution: ["compose", "resolution"] };
    const [section, field] = map[option.dataset.option];
    const values = { "无声音": "silent", "有声音": "voice", "关键帧生成": "multi_keyframes", "参考视频生成": "reference_video", "5 秒": 5, "8 秒": 8, "10 秒": 10, "15 秒": 15, "分割": "ffmpeg_only", "分割并命名": "ffmpeg_gemini_naming", "保留原声": true, "去除声音": false };
    const value = values[option.dataset.value] ?? option.dataset.value;
    if (option.dataset.option === "remakeVideoMode" && state.remake.videoMode !== value) {
      Object.assign(state.remake, { runId: null, editedImage: null, editedKeyframes: [], keyframeTimes: [], selectedRetryIndexes: [], imageReady: false, result: null, error: null, progress: 0, stage: "" });
      if (value === "reference_video" && ![5, 10, 15].includes(state.remake.duration)) state.remake.duration = 5;
    }
    if (option.dataset.option === "remakeDuration" && state.remake.duration !== value) {
      Object.assign(state.remake, { result: null, error: null, progress: 0, stage: "" });
    }
    state[section][field] = value;
    render();
    return;
  }
  const action = event.target.closest("[data-action]")?.dataset.action;
  if (action === "open-kling" || action === "open-shot") {
    videoClient.openWorkspace(action === "open-kling" ? "kling" : "shot").catch((error) => notify(error.message));
    return;
  }
  if (action === "retry-remake") { void recoverRemake(); return; }
  if (action === "retry-remake-paid") {
    if (!window.confirm("这会重新提交失败阶段并可能再次计费，是否继续？")) return;
    if (state.remake.error?.rawStage === "image" && state.remake.runId) void retryRemakeImages([Number.isInteger(state.remake.error.keyframeIndex) ? state.remake.error.keyframeIndex : 0]);
    else void runRemake({ retryVideo: state.remake.error?.rawStage === "video" });
    return;
  }
  if (action === "confirm-remake-image") { void confirmRemakeImage(); return; }
  if (action === "batch-view-result" && state.split.batch) { state.split.batch.selectedVideoId = event.target.closest("[data-action]")?.dataset.videoId || null; render(); return; }
  if (action === "batch-back" && state.split.batch) { state.split.batch.selectedVideoId = null; render(); return; }
  if (action === "batch-retry-demo") { notify("预览模式：只会重试当前失败视频"); return; }
  if (action === "batch-retry-item") { void runSplitBatch({ retryVideoId: event.target.closest("[data-action]")?.dataset.videoId }); return; }
  if (action === "batch-resume") { void runSplitBatch({ resume: true }); return; }
  if (action === "batch-new") { Object.assign(state.split, { source: null, sources: [], runId: null, result: null, error: null, batch: null, progress: 0, stage: "" }); render(); return; }
  if (action === "split-remove-source") {
    const index = Number(event.target.closest("[data-action]")?.dataset.sourceIndex);
    state.split.sources.splice(index, 1);
    state.split.source = state.split.sources[0] || null;
    render();
    return;
  }
  if (action === "toggle-remake-image") {
    const index = Number(event.target.closest("[data-action]")?.dataset.keyframeIndex);
    const selected = new Set(state.remake.selectedRetryIndexes || []);
    if (selected.has(index)) selected.delete(index); else selected.add(index);
    state.remake.selectedRetryIndexes = [...selected].sort((a, b) => a - b);
    render();
    return;
  }
  if (action === "retry-selected-remake-images") { void retryRemakeImages(state.remake.selectedRetryIndexes); return; }
  if (action === "retry-split") { void runSplit({ resumeNaming: Boolean(state.split.runId && /naming|provider|quota|analysis/i.test(state.split.error?.rawStage || "")) }); return; }
  if (action === "remake-generate") void runRemake();
  if (action === "split-generate") void runSplit();
  if (action === "audio-generate") runSimulation("audio", () => ({ name: "克隆配音_示例.m4a" }));
  if (action === "compose-generate") runSimulation("compose", () => ({ name: "智能合成视频.mp4" }));
});
document.addEventListener("dblclick", (event) => {
  const card = event.target.closest(".previewable[data-preview-url]");
  if (!card) return;
  event.preventDefault();
  event.stopPropagation();
  card.querySelector("video, audio")?.pause();
  openMediaViewer(card);
}, true);
document.addEventListener("keydown", (event) => {
  const card = event.target.closest?.(".previewable[data-preview-url]");
  if (event.key !== "Enter" || !card || event.target !== card) return;
  event.preventDefault();
  openMediaViewer(card);
});
mediaViewer.addEventListener("click", (event) => {
  if (event.target !== mediaViewer) return;
  const rect = mediaViewer.getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeMediaViewer();
});
mediaViewer.addEventListener("close", () => {
  clearMediaViewer();
  previewOpener?.focus();
  previewOpener = null;
});
document.addEventListener("input", (event) => {
  if (event.target.id === "remakeVoiceScript") {
    state.remake.voiceScript = event.target.value;
    const voiceLimit = state.remake.duration * 6;
    const voiceWithinLimit = event.target.value.length <= voiceLimit;
    event.target.closest(".voice-script")?.classList.toggle("is-over-limit", !voiceWithinLimit);
    const count = document.querySelector(".voice-script label b");
    if (count) count.textContent = event.target.value.length;
    const button = document.querySelector('[data-action="remake-generate"]');
    if (button) button.disabled = state.remake.config?.configured !== true || state.remake.running || !state.remake.products.length || !state.remake.reference || !event.target.value.trim() || !voiceWithinLimit;
    return;
  }
  if (event.target.id === "audioScript") state.audio.script = event.target.value;
  if (event.target.id === "composeScript") state.compose.script = event.target.value;
  const button = document.querySelector(`[data-action="${event.target.id === "audioScript" ? "audio" : "compose"}-generate"]`);
  if (button) button.disabled = !event.target.value.trim();
  const counter = event.target.nextElementSibling;
  if (counter?.classList.contains("counter")) counter.textContent = `${event.target.value.length} / 1000`;
});
document.addEventListener("change", (event) => {
  const files = [...(event.target.files || [])];
  if (!files.length) return;
  if (event.target.id === "productInput" || event.target.id === "referenceInput") {
    if (event.target.id === "productInput") state.remake.products = [addFile(files[0], "image", "产品替换")];
    else state.remake.reference = addFile(files[0], "video", "产品替换");
    Object.assign(state.remake, { runId: null, editedImage: null, editedKeyframes: [], keyframeTimes: [], imageReady: false, result: null, error: null, progress: 0, stage: "" });
  }
  if (event.target.id === "splitInput") {
    const selected = files.slice(0, 25).map((file) => ({ name: file.name, url: mediaUrl(file), kind: "video", origin: "素材分割输入", file, size: formatFileSize(file.size) }));
    Object.assign(state.split, { sources: selected, source: selected[0] || null, runId: null, result: null, error: null, batch: null, progress: 0, stage: "" });
    if (files.length > 25) notify("一次最多处理 25 个视频，已保留前 25 个");
  }
  if (event.target.id === "audioInput") state.audio.source = addFile(files[0], "audio", "音频处理");
  if (event.target.id === "libraryInput") files.forEach((file) => addFile(file, file.type.startsWith("image/") ? "image" : file.type.startsWith("audio/") ? "audio" : "video", "本地上传"));
  render();
});
let resizeFrame;
window.addEventListener("resize", () => {
  cancelAnimationFrame(resizeFrame);
  resizeFrame = requestAnimationFrame(markOverflowingNames);
});
document.querySelector("#openLogs").addEventListener("click", async () => { try { await videoClient.openLogs(); } catch (error) { notify(`运行目录打开失败：${error.message}`); } });
async function loadShotConfig() {
  try {
    state.split.config = await videoClient.getShotConfig();
    if (!state.split.config.apiKeyConfigured) state.split.mode = "ffmpeg_only";
    if (state.active === "split") render();
  } catch {}
}
async function loadShotAssets() {
  if (shotAssetsLoading) return;
  shotAssetsLoading = true;
  try {
    const response = await videoClient.listShotAssets();
    if (response.scanErrors?.length) console.warn("素材拆分记录存在无法读取的目录", response.scanErrors);
    for (const asset of response.assets || []) {
      const url = shotMediaUrl(response.baseUrl, asset.runId, asset.relativePath);
      const remoteKey = `${asset.runId}:${asset.relativePath}`;
      if (state.library.some((item) => item.remoteKey === remoteKey)) continue;
      state.library.push({ name: asset.name, url, kind: "video", origin: asset.sourceFilename ? `素材分割 · ${asset.sourceFilename}` : "素材分割", remoteKey, startSec: asset.startSec, endSec: asset.endSec, completedAt: asset.completedAt });
    }
    sortLibraryNewestFirst();
    if (state.active === "library") render();
  } catch (error) {
    if (state.active === "library") notify(`素材库读取失败：${error.message}`);
  } finally { shotAssetsLoading = false; }
}
async function loadLatestInterruptedBatch() {
  if (latestBatchChecked || state.split.batch || state.split.sources.length) return;
  latestBatchChecked = true;
  try {
    const latest = await videoClient.getLatestShotRun();
    if (!String(latest.runId || "").startsWith("batch_")) return;
    const response = await videoClient.getShotBatch(latest.runId);
    const status = String(response.batch?.status || "").toLowerCase();
    if (!["queued", "processing", "partial", "failed"].includes(status) || response.batch?.active) return;
    state.split.runId = latest.runId;
    state.split.serviceBaseUrl = response.baseUrl || "";
    state.split.mode = response.batch?.workflow === "ffmpeg_gemini_naming" ? "ffmpeg_gemini_naming" : "ffmpeg_only";
    state.split.keepAudio = response.batch?.keepAudio !== false;
    state.split.batch = batchFromResponse(response);
    addBatchResultsToLibrary(state.split.batch);
    if (state.active === "split") render();
    notify("发现未完成的批量任务，可以继续处理");
  } catch {}
}
async function loadKlingConfig() {
  try {
    state.remake.config = await videoClient.getKlingConfig();
    if (state.active === "remake") render();
  } catch {}
}
async function loadKlingAssets() {
  if (klingAssetsLoading) return;
  klingAssetsLoading = true;
  try {
    const response = await videoClient.listKlingAssets();
    for (const asset of response.assets || []) {
      const remoteKey = `${asset.runId}:${asset.relativeUrl}`;
      if (state.library.some((item) => item.remoteKey === remoteKey)) continue;
      state.library.push({ name: asset.name, url: new URL(asset.relativeUrl, response.baseUrl).toString(), kind: "video", origin: "产品替换", remoteKey, completedAt: asset.completedAt });
    }
    sortLibraryNewestFirst();
    if (state.active === "library") render();
  } catch {} finally { klingAssetsLoading = false; }
}
function showServices(services) { const ready = services.filter((service) => service.status === "ready").length; serviceStatus.textContent = ready === 2 ? "两个本地服务已就绪" : `${ready}/${services.length || 2} 个服务就绪`; serviceStatus.className = ready === 2 ? "ready" : services.some((service) => service.status === "error") ? "error" : ""; if (services.some((service) => service.key === "shot" && service.status === "ready")) { if (!state.split.config) void loadShotConfig(); void loadShotAssets(); void loadLatestInterruptedBatch(); } if (services.some((service) => service.key === "kling" && service.status === "ready")) { if (!state.remake.config) void loadKlingConfig(); void loadKlingAssets(); } }
if (uiPreviewMode === "batch-split") {
  state.active = "split";
  state.split.batch = {
    id: "batch_preview",
    status: "processing",
    active: true,
    preview: true,
    mode: "ffmpeg_gemini_naming",
    keepAudio: true,
    filter: "all",
    selectedVideoId: null,
    items: [
      { id: "video_001", name: "夏季新品人物展示01.mp4", size: "186 MB", status: "completed", clipCount: 8, detail: "32 秒" },
      { id: "video_002", name: "户外场景商品口播02.mp4", size: "241 MB", status: "completed", clipCount: 6, detail: "27 秒" },
      { id: "video_003", name: "室内桌面产品演示03.mp4", size: "208 MB", status: "completed", clipCount: 7, detail: "30 秒" },
      { id: "video_004", name: "人物手持商品多角度展示04.mp4", size: "256 MB", status: "processing", detail: "正在分析第 5 / 9 个片段" },
      { id: "video_005", name: "自然光环境产品展示05.mp4", size: "198 MB", status: "queued", queuePosition: 1 },
      { id: "video_006", name: "通勤场景人物互动06.mp4", size: "224 MB", status: "queued", queuePosition: 2 },
      { id: "video_007", name: "产品细节与包装展示07.mp4", size: "173 MB", status: "failed", detail: "命名服务响应超时" },
      { id: "video_008", name: "结尾补充商品展示08.mp4", size: "154 MB", status: "queued", queuePosition: 3 }
    ]
  };
  serviceStatus.textContent = "批量界面预览 · 未启动真实服务";
  serviceStatus.className = "";
  render();
} else if (uiPreviewMode === "processing") {
  state.active = "remake";
  Object.assign(state.remake, {
    running: true,
    progress: 78,
    routeIndex: 2,
    stage: "根据参考视频生成替换视频",
    videoMode: "reference_video",
    voiceScript: "界面预览",
    config: { configured: true, klingConfigured: true, referenceVideoConfigured: true }
  });
  Object.assign(state.split, {
    running: true,
    progress: 50,
    routeIndex: 2,
    stage: "分析片段并命名",
    mode: "ffmpeg_gemini_naming",
    config: { apiKeyConfigured: true, uploadLimitMb: 500 }
  });
  serviceStatus.textContent = "界面预览 · 未启动本地服务";
  serviceStatus.className = "";
  render();
} else {
  videoClient.onServicesUpdated(showServices);
  showServices(await videoClient.getServices());
  render();
}
