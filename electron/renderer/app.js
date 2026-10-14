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
  exportDiagnostics: async () => { throw new Error("浏览器预览模式下不能导出客户端诊断日志"); },
  reportDiagnostic: () => {},
  getKlingConfig: async () => ({ configured: false }),
  listKlingAssets: async () => ({ baseUrl: "", assets: [] }),
  getLatestRecoverableKlingRun: async () => ({ run: null, baseUrl: "" }),
  inspectReferenceAudio: async () => ({ hasAudio: false, duration: null }),
  createKlingRun: async () => { throw new Error("浏览器预览模式下不能运行产品替换"); },
  getKlingRun: async () => { throw new Error("浏览器预览模式下不能查询产品替换任务"); },
  startKlingVideo: async () => { throw new Error("浏览器预览模式下不能启动视频生成"); },
  stopKlingRun: async () => { throw new Error("浏览器预览模式下不能中止产品替换任务"); },
  resumeKlingRun: async () => { throw new Error("浏览器预览模式下不能恢复产品替换任务"); },
  listVoices: async () => [],
  createVoice: async () => { throw new Error("浏览器预览模式下不能创建声音"); },
  deleteVoice: async () => { throw new Error("浏览器预览模式下不能删除声音"); },
  revoiceVideo: async () => { throw new Error("浏览器预览模式下不能重新配音"); },
  getShotConfig: async () => ({ apiKeyConfigured: false, uploadLimitMb: 500 }),
  configureSubtitles: async () => { throw new Error("浏览器预览模式不能保存服务密钥"); },
  listShotAssets: async () => ({ baseUrl: "", assets: [] }),
  exportLibraryTask: async () => { throw new Error("浏览器预览模式下不能导出本地任务"); },
  pickShotFolders: async () => ({ folders: [], entries: [] }),
  createShotRun: async () => { throw new Error("浏览器预览模式下不能运行素材分割"); },
  createShotBatch: async () => { throw new Error("浏览器预览模式下不能运行批量素材分割"); },
  getShotRun: async () => { throw new Error("浏览器预览模式下不能查询素材分割任务"); },
  resumeShotNaming: async () => { throw new Error("浏览器预览模式下不能恢复命名任务"); },
  getLatestShotRun: async () => { throw new Error("浏览器预览模式下没有运行记录"); },
  getShotBatch: async () => { throw new Error("浏览器预览模式下不能查询批量任务"); },
  cancelShotBatch: async () => { throw new Error("浏览器预览模式下不能取消批量任务"); },
  resumeShotBatch: async () => { throw new Error("浏览器预览模式下不能恢复批量任务"); },
  retryShotBatchItem: async () => { throw new Error("浏览器预览模式下不能重试批量任务"); },
  onServicesUpdated: () => () => {}
};
const tools = [
  { id: "split", icon: `<svg viewBox="0 0 24 24"><path d="m8.5 8.5 10 10M8.5 15.5 18.5 5.5"/><circle cx="6" cy="7" r="2.5"/><circle cx="6" cy="17" r="2.5"/></svg>`, name: "素材分割", note: "素材清洗、分割与归档" },
  { id: "remake", icon: `<svg viewBox="0 0 24 24"><path d="M5 8h13m0 0-3-3m3 3-3 3M19 16H6m0 0 3 3m-3-3 3-3"/></svg>`, name: "产品替换", note: "多关键帧商品替换" },
  { id: "compose", icon: `<svg viewBox="0 0 24 24"><rect x="3.5" y="5" width="17" height="14" rx="2"/><path d="m10 9 5 3-5 3z"/></svg>`, name: "视频合成", note: "多类型素材智能成片", available: false },
  { id: "library", icon: `<svg viewBox="0 0 24 24"><path d="M3 6.5h6l2 2h10v10H3z"/></svg>`, name: "素材库", note: "统一管理创作素材" }
];
const state = {
  active: "split",
  remake: newRemakeState(),
  split: { source: null, sources: [], mode: "ffmpeg_only", keepAudio: true, removeSubtitles: false, progress: 0, routeIndex: 0, stage: "", runId: null, serviceBaseUrl: "", result: null, error: null, config: null, running: false, batch: null, batchOperation: null, batchCancelConfirm: false, batchCanceling: false },
  audio: { source: null, script: "", progress: 0, result: null },
  compose: { script: "", ratio: "9:16", resolution: "1080P", progress: 0, result: null },
  library: [],
  libraryFilter: "all",
  libraryRunFilter: "all",
  libraryRuns: [],
  libraryView: { runId: null, categoryId: null }
};
const timers = new Map();
let shotAssetsLoading = false;
let klingAssetsLoading = false;
let klingAssetsRevision = 0;
const assetServiceInstances = new Map();
let latestServices = [];
let libraryExportBusy = false;
const defaultSubtitleOptions = () => ({ model: "video_removal_std", method: "sel_area" });
let latestBatchChecked = false;
let latestRemakeChecked = false;
let previewOpener = null;
let voicePreviewAudio = null;
const esc = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
const mediaUrl = (file) => file ? URL.createObjectURL(file) : "";
const cleanRemoteError = (error) => String(error?.message || error || "未知错误").replace(/^Error invoking remote method '[^']+':\s*Error:\s*/i, "").trim();
function friendlyRemakeError(error, stage = "video") {
  const message = cleanRemoteError(error);
  if (stage === "image" && /是否生成暂时无法确认/.test(message)) return "连接中断，部分图片是否生成暂时无法确认。已完成图片已保留；重新生成可能重复计费，请先核对记录。";
  if (/余额不足|HTTP\s*402|\b402\b/i.test(message)) return "当前服务余额不足，请充值后再试。";
  if (/429|限频|频率|请求过多/i.test(message)) return "当前使用人数较多，请稍后再试。";
  if (/风控|版权|内容.*拦截|审核/i.test(message)) return "素材或台词未通过服务检查，请调整后再试。";
  if (/fetch failed|无法连接|ECONN|ENOTFOUND|TLS|网络通道|请求超时|启动超时|timeout/i.test(message)) return "网络连接暂时不稳定，服务未能响应，请稍后再试。";
  if (stage === "image") return "部分关键帧未能生成，请稍后重试对应图片。";
  if (stage === "voice") return "配音暂时未能生成，视频结果已经保留。";
  return "视频暂时未能生成，当前进度已经保留。";
}
function friendlyVoiceCreateError(error) {
  const message = cleanRemoteError(error);
  if (/8[–-]15|8 秒|15 秒|时长/i.test(message)) return "参考音频需要在 8–15 秒之间，请重新选择。";
  if (/音轨|音频|格式|读取|codec|Invalid data/i.test(message)) return "这段音频无法使用，请换一段 MP3、WAV 或 M4A 音频。";
  if (/fetch failed|网络|timeout|超时|ECONN|ENOTFOUND|TLS/i.test(message)) return "网络暂时不稳定，请稍后再试。";
  return "音色暂时未能创建，请稍后再试。";
}

function notify(message) { toast.textContent = message; toast.classList.add("show"); clearTimeout(notify.timer); notify.timer = setTimeout(() => toast.classList.remove("show"), 1800); }
function syncVoicePlaybackUi() {
  document.querySelectorAll('[data-action="voice-preview-play"]').forEach((button) => {
    const playing = button.dataset.voiceId === state.remake.voicePlayingId;
    button.textContent = playing ? "Ⅱ" : "▶";
    button.setAttribute("aria-pressed", String(playing));
    button.closest("article, div")?.querySelector(".voice-fingerprint")?.classList.toggle("is-playing", playing);
  });
}

function syncVoiceLibrarySelectionUi() {
  workspace.querySelectorAll(".voice-library-grid > article").forEach((card) => {
    const button = card.querySelector('[data-action="voice-select"]');
    const selected = button?.dataset.voiceId === state.remake.selectedVoiceId;
    card.classList.toggle("is-selected", selected);
    button?.setAttribute("aria-pressed", String(selected));
    button?.setAttribute("aria-label", `${selected ? "已选择" : "选择"}${card.querySelector("strong")?.textContent || "音色"}`);
    const mark = button?.querySelector("i");
    if (mark) mark.textContent = selected ? "✓" : "";
  });
}
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
function renderNavigation() { navigation.innerHTML = tools.map((tool) => { const unavailable = tool.available === false; return `<button class="${state.active === tool.id ? "active" : ""}${unavailable ? " is-unavailable" : ""}" data-tool="${tool.id}" data-tool-name="${tool.name}" ${unavailable ? 'data-unavailable="true" aria-disabled="true" title="暂未开放"' : ""} type="button"><i aria-hidden="true">${tool.icon}</i><span><strong>${tool.name}${unavailable ? "<em>暂未开放</em>" : ""}</strong><small>${tool.note}</small></span></button>`; }).join(""); }
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
function progressOutput(progress, stages, currentStage = "", className = "", item = null, tail = "") { const index = routeIndexFor(item || { progress }, stages); const stage = currentStage || stages[index]; return `<div class="processing ${className}"><div class="progress-ring"><strong>处理中</strong></div><h2>${esc(currentStage ? "正在处理素材" : stage)}</h2><p>请保持客户端运行，完成后结果会显示在这里。</p>${processRoute(stages, index)}${tail}</div>`; }

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
    runId: run.runId || response.runId || state.split.runId,
    workflow: named.length ? "ffmpeg_gemini_naming" : run.workflow || state.split.mode,
    sourceFilename: run.sourceFilename || state.split.source?.name || "素材",
    mediaTools: run.mediaTools || response.mediaTools || null,
    keepAudio: run.keepAudio ?? response.keepAudio ?? state.split.keepAudio,
    clips: shots.map((shot, index) => ({
      id: shot.shotId || `shot_${index + 1}`,
      remoteKey: `${run.runId || response.runId || state.split.runId}:${shot.namedPath || shot.filePath || index}`,
      name: shot.namedFilename || `${shot.shotId || `片段_${index + 1}`}.mp4`,
      usageType: shot.usageType || null,
      contentTitle: shot.contentTitle || null,
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
    additions.push({ name: clip.name, url: clip.url, kind: "video", origin: "素材分割", remoteKey: clip.remoteKey, runId: result.runId, sourceId: result.runId, sourceFilename: result.sourceFilename, sourceFolderName: String(result.sourceFilename || "素材").replace(/\.[^.]+$/, ""), workflow: result.workflow, usageType: clip.usageType, contentTitle: clip.contentTitle, completedAt });
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
    subtitle_preparing: "检查去字幕素材",
    subtitle_uploading: "上传去字幕素材",
    subtitle_submitting: "提交去字幕任务",
    subtitle_queued: "等待云端去字幕",
    subtitle_processing: "云端正在去字幕",
    subtitle_receiving: "接收去字幕成品",
    subtitle_downloading: "下载去字幕结果",
    subtitle_validating: "检查去字幕结果",
    subtitle_completed: "去字幕已完成，准备拆分",
    subtitle_waiting_paused: "已停止等待，可继续查询原任务",
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
function subtitleStageDescription(entry) {
  const job = entry.subtitle;
  if (job?.status === "queued" && Number.isFinite(Number(job.queueAhead))) return `云端排队，前方 ${Math.max(0, Number(job.queueAhead))} 个任务`;
  if (job?.status === "processing" && Number.isFinite(Number(job.progress))) return `云端正在去字幕 ${Math.max(0, Math.min(100, Number(job.progress)))}%`;
  return batchStageText(entry.stage, entry.status);
}

function batchFromResponse(response) {
  const sourceBatch = response.batch || {};
  const previous = state.split.batch;
  let queuedPosition = 0;
  const items = (response.items || sourceBatch.items || []).map((entry, index) => {
    const rawStatus = String(entry.status || "queued").toLowerCase();
    const status = ["completed", "failed", "queued", "cancelled", "paused"].includes(rawStatus) ? rawStatus : "processing";
    if (status === "queued") queuedPosition += 1;
    const old = previous?.items?.find((item) => item.id === entry.videoId);
    const manifest = Array.isArray(entry.renameManifest) && entry.renameManifest.length ? entry.renameManifest : entry.shots || [];
    const clips = manifest.map((clip, clipIndex) => {
      const relativePath = String(clip.namedPath || clip.filePath || "").replaceAll("\\", "/");
      return {
        id: clip.shotId || `shot_${clipIndex + 1}`,
        remoteKey: `${sourceBatch.batchId}:items/${entry.videoId}/${relativePath || clipIndex}`,
        name: clip.namedFilename || `${clip.shotId || `片段_${clipIndex + 1}`}.mp4`,
        usageType: clip.usageType || null,
        contentTitle: clip.contentTitle || null,
        startSec: clip.startSec,
        endSec: clip.endSec,
        url: relativePath ? shotMediaUrl(response.baseUrl || state.split.serviceBaseUrl, sourceBatch.batchId, `items/${entry.videoId}/${relativePath}`) : ""
      };
    });
    return {
      id: entry.videoId || `video_${index + 1}`,
      name: entry.sourceFilename || old?.name || `视频 ${index + 1}`,
      sourceFilename: entry.sourceFilename || old?.name || `视频 ${index + 1}`,
      size: old?.size || "",
      status,
      rawStatus,
      stage: entry.stage || rawStatus,
      detail: status === "failed" ? entry.errorRecord?.message || entry.error || "处理失败" : status === "paused" ? "已停止本地等待，可继续查询原任务" : subtitleStageDescription(entry),
      clipCount: clips.length || Number(entry.namedShotCount || entry.shots?.length || 0),
      clips,
      queuePosition: status === "queued" ? queuedPosition : null,
      completedAt: entry.completedAt || entry.updatedAt || sourceBatch.finishedAt || null,
      keepAudio: entry.keepAudio ?? sourceBatch.keepAudio ?? state.split.keepAudio,
      removeSubtitles: entry.removeSubtitles ?? sourceBatch.removeSubtitles ?? false,
      sourceFolderId: entry.sourceFolderId || old?.sourceFolderId || null,
      sourceFolderName: entry.sourceFolderName || old?.sourceFolderName || null,
      sourceRelativePath: entry.sourceRelativePath || old?.sourceRelativePath || entry.sourceFilename || old?.name || `视频 ${index + 1}`
    };
  });
  const folderMode = Boolean(sourceBatch.folderMode || items.some((entry) => entry.sourceFolderId));
  const folderMap = new Map();
  if (folderMode) {
    for (const entry of items) {
      const folderId = entry.sourceFolderId || `folder_${entry.id}`;
      const folderName = entry.sourceFolderName || "未分组";
      if (!folderMap.has(folderId)) folderMap.set(folderId, { id: folderId, name: folderName, videos: [] });
      folderMap.get(folderId).videos.push(entry);
    }
  }
  const folders = [...folderMap.values()].map((folder) => {
    const statuses = folder.videos.map((video) => video.status);
    const status = statuses.every((value) => value === "completed") ? "completed"
      : statuses.some((value) => value === "processing") ? "processing"
        : statuses.some((value) => value === "paused") ? "paused"
          : statuses.some((value) => value === "failed" || value === "cancelled") ? "partial" : "queued";
    return { ...folder, status };
  });
  const processingFolder = folders.find((folder) => folder.status === "processing");
  return {
    id: sourceBatch.batchId || previous?.id || null,
    status: String(sourceBatch.status || previous?.status || "queued").toLowerCase(),
    active: Boolean(sourceBatch.active),
    filter: previous?.filter || "all",
    selectedVideoId: previous?.selectedVideoId || null,
    mode: sourceBatch.workflow || previous?.mode || state.split.mode,
    keepAudio: sourceBatch.keepAudio ?? previous?.keepAudio ?? state.split.keepAudio,
    removeSubtitles: sourceBatch.removeSubtitles ?? previous?.removeSubtitles ?? state.split.removeSubtitles,
    subtitleOptions: sourceBatch.subtitleOptions || previous?.subtitleOptions || state.split.subtitleOptions || defaultSubtitleOptions(),
    items,
    folderMode,
    folders,
    selectedFolderId: previous?.selectedFolderId && folders.some((folder) => folder.id === previous.selectedFolderId)
      ? previous.selectedFolderId
      : processingFolder?.id || folders[0]?.id || null,
    folderQuery: previous?.folderQuery || "",
    preview: false
  };
}

function addBatchResultsToLibrary(batch) {
  const additions = [];
  for (const entry of batch?.items || []) {
    if (entry.status !== "completed") continue;
    for (const clip of entry.clips || []) {
      if (!clip.url || state.library.some((item) => item.remoteKey === clip.remoteKey)) continue;
      additions.push({ name: clip.name, url: clip.url, kind: "video", origin: `素材分割 · ${entry.sourceFolderName || entry.name}`, remoteKey: clip.remoteKey, runId: batch.id, sourceId: entry.sourceFolderId || `${batch.id}:${entry.id}`, sourceFolderId: entry.sourceFolderId || null, sourceFilename: entry.sourceFilename || entry.name, sourceFolderName: entry.sourceFolderName || String(entry.sourceFilename || entry.name).replace(/\.[^.]+$/, ""), workflow: batch.mode, usageType: clip.usageType, contentTitle: clip.contentTitle, completedAt: entry.completedAt || new Date().toISOString() });
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

async function pollSplitBatch(operation) {
  const item = state.split;
  while (item.running && item.runId && item.batchOperation === operation) {
    const response = await videoClient.getShotBatch(item.runId);
    if (item.batchOperation !== operation) break;
    item.serviceBaseUrl = response.baseUrl || item.serviceBaseUrl;
    item.batch = batchFromResponse(response);
    if (state.active === "split" && !item.batch.selectedVideoId) renderBatchStatus();
    if (!item.batch.active && ["completed", "partial", "failed", "paused", "cancelled"].includes(item.batch.status)) return item.batch;
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
  if (!resume && !retryVideoId && !item.running) item.removeSubtitles = false;
  const folderMode = item.sources.some((source) => source.folderId);
  if (item.running || (!resume && !retryVideoId && (!item.sources.length || (!folderMode && !item.removeSubtitles && item.sources.length < 2))) || ((resume || retryVideoId) && !item.runId)) return;
  if (!resume && !retryVideoId && item.removeSubtitles && !item.config?.subtitleConfigured) { notify("去字幕服务暂不可用，请联系维护者"); return; }
  item.running = true;
  const operation = Symbol("split-batch");
  item.batchOperation = operation;
  item.error = null;
  try {
    if (retryVideoId) await videoClient.retryShotBatchItem(item.runId, retryVideoId);
    else if (resume) await videoClient.resumeShotBatch(item.runId);
    else {
      const uploadItems = item.sources.map((source, index) => ({ id: `upload_${index}`, name: source.name, size: source.size, status: "queued", detail: "等待上传", clipCount: 0, clips: [], queuePosition: index + 1, sourceFolderId: source.folderId || null, sourceFolderName: source.folderName || null, sourceRelativePath: source.relativePath || source.name }));
      const uploadFolderMap = new Map();
      for (const entry of uploadItems) {
        if (!entry.sourceFolderId) continue;
        if (!uploadFolderMap.has(entry.sourceFolderId)) uploadFolderMap.set(entry.sourceFolderId, { id: entry.sourceFolderId, name: entry.sourceFolderName, status: "queued", videos: [] });
        uploadFolderMap.get(entry.sourceFolderId).videos.push(entry);
      }
      item.batch = {
        id: null,
        status: "uploading",
        active: true,
        filter: "all",
        selectedVideoId: null,
        mode: item.mode,
        keepAudio: item.keepAudio,
        removeSubtitles: item.removeSubtitles,
        subtitleOptions: item.subtitleOptions || defaultSubtitleOptions(),
        folderMode,
        folders: [...uploadFolderMap.values()],
        selectedFolderId: uploadFolderMap.keys().next().value || null,
        folderQuery: "",
        preview: false,
        items: uploadItems
      };
      render();
      const response = await videoClient.createShotBatch(item.sources, item.mode, item.keepAudio, item.removeSubtitles, item.subtitleOptions || defaultSubtitleOptions());
      item.runId = response.batchId;
      item.serviceBaseUrl = response.baseUrl;
    }
    if (item.batchOperation !== operation) return;
    const batch = await pollSplitBatch(operation);
    if (item.batchOperation !== operation) return;
    addBatchResultsToLibrary(batch);
    const completed = batch.items.filter((entry) => entry.status === "completed").length;
    const failed = batch.items.filter((entry) => entry.status === "failed").length;
    notify(batch.status === "paused" ? "已停止本地等待，可继续查询原任务" : failed ? `批次完成：${completed} 个成功，${failed} 个失败` : `批量素材处理完成，共 ${completed} 个视频`);
  } catch (error) {
    if (item.batchOperation === operation) item.error = { stage: "批量素材处理", rawStage: "batch", message: error.message };
  } finally {
    if (item.batchOperation === operation) {
      item.batchOperation = null;
      item.running = false;
      if (item.batch) item.batch.active = false;
      if (state.active === "split") render();
    }
  }
}

async function runSplit({ resumeNaming = false } = {}) {
  const item = state.split;
  if (!resumeNaming && !item.running) item.removeSubtitles = false;
  if (!resumeNaming && (item.removeSubtitles || item.sources.length > 1 || item.sources.some((source) => source.folderId))) return runSplitBatch();
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
      response = await videoClient.createShotRun(item.source.file, item.mode, item.keepAudio, item.removeSubtitles, item.subtitleOptions || defaultSubtitleOptions());
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

function newRemakeState(previous = {}) {
  const item = { products: [], reference: null, duration: 5, ratio: "9:16", resolution: "768P", videoMode: "multi_keyframes", audio: "voice", voiceEnabled: true, voiceScript: "", voiceDetected: null, voices: [], selectedVoiceId: null, voicePanel: null, voiceSource: null, voiceDraftName: "", voiceCreateError: "", voicePlayingId: null, revoicePending: false, voiceBusy: false, revoiceError: null, videoRetryConfirm: false, progress: 0, routeIndex: 0, stage: "", runId: null, serviceBaseUrl: "", editedImage: null, editedKeyframes: [], keyframeTimes: [], selectedRetryIndexes: [], imageReady: false, result: null, error: null, config: null, running: false, videoTaskSubmitted: false, stopConfirm: null, stopping: false, stopRequest: null, userStopped: false };
  for (const key of ["config", "configError", "voices", "selectedVoiceId", "duration", "ratio", "resolution", "videoMode", "audio", "voiceEnabled", "voiceScript"]) {
    if (Object.hasOwn(previous, key)) item[key] = previous[key];
  }
  item.productSubject = "";
  return item;
}

class RemakeStoppedError extends Error {}
function isCurrentRemake(item) { return state.remake === item && !item.userStopped; }
function assertCurrentRemake(item) { if (!isCurrentRemake(item)) throw new RemakeStoppedError("任务已结束"); }
async function waitForRemakeStop(item) {
  if (item.stopRequest) { try { await item.stopRequest; } catch {} }
  assertCurrentRemake(item);
}
function remakeStopStage(item) {
  if (typeof videoClient.stopKlingRun !== "function") return null;
  if (!item.runId || item.result || item.error) return null;
  if (!item.running && item.imageReady && item.editedKeyframes.length && item.editedKeyframes.every(Boolean) && !item.videoTaskSubmitted) return "image";
  if (item.running && item.routeIndex === 2 && item.videoTaskSubmitted) return "video";
  return null;
}
function openRemakeStop() {
  const item = state.remake;
  const stage = remakeStopStage(item);
  if (!stage || item.stopping) return;
  item.stopConfirm = { runId: item.runId, stage };
  render();
  workspace.querySelector('[data-action="remake-stop-dismiss"]')?.focus();
}
function dismissRemakeStop() {
  if (state.remake.stopping) return;
  state.remake.stopConfirm = null;
  render();
  workspace.querySelector('[data-action="remake-stop-open"]')?.focus();
}
async function stopRemake() {
  const item = state.remake;
  const confirmation = item.stopConfirm;
  if (item.stopping || !confirmation) return;
  if (confirmation.runId !== item.runId || confirmation.stage !== remakeStopStage(item)) { dismissRemakeStop(); return; }
  item.stopping = true;
  render();
  // Include the reset in the promise that pollers await, so no old response can
  // commit between the stop acknowledgement and replacing the current item.
  item.stopRequest = (async () => {
    await videoClient.stopKlingRun(confirmation.runId, confirmation.stage);
    assertCurrentRemake(item);
    item.userStopped = true;
    item.running = false;
    voicePreviewAudio?.pause();
    voicePreviewAudio = null;
    state.remake = newRemakeState(item);
  })();
  try {
    await item.stopRequest;
    if (state.active === "remake") render();
    notify(confirmation.stage === "image" ? "图片已保存，已返回上传设置" : "已停止客户端等待，任务记录已保留");
  } catch (error) {
    if (!isCurrentRemake(item)) return;
    item.stopping = false;
    item.stopConfirm = null;
    if (state.active === "remake") render();
    notify(`中止失败：${cleanRemoteError(error)}`);
  } finally { item.stopRequest = null; }
}
function renderRemakeStopDialog(item) {
  if (!item.stopConfirm) return "";
  const image = item.stopConfirm.stage === "image";
  return `<div class="batch-cancel-overlay remake-stop-overlay"><section class="batch-cancel-dialog" role="alertdialog" aria-modal="true" aria-labelledby="remakeStopTitle"><h2 id="remakeStopTitle">${image ? "保留图片并结束？" : "中止当前任务？"}</h2><p>${image ? "生成的关键帧图片已保存，结束后仍会保留。不进入视频生成，不会扣除视频生成费用。" : "视频任务已提交，费用已扣除。中止只停止客户端等待，不会自动退款；云端任务可能继续运行，任务记录会保留。"}</p><div><button data-action="remake-stop-dismiss" type="button" ${item.stopping ? "disabled" : ""}>${image ? "继续确认" : "继续等待"}</button><button class="is-danger" data-action="remake-stop-confirm" type="button" ${item.stopping ? "disabled" : ""}>${item.stopping ? "正在结束…" : image ? "保留图片并结束" : "停止等待并返回上传"}</button></div></section></div>`;
}

function updateRemakeStage(stage, item = state.remake) {
  assertCurrentRemake(item);
  const values = { upload: 12, image: 45, video: 72, voice: 88, completed: 100 };
  const labels = { upload: "上传素材并抽取关键帧", image: "逐张生成商品替换关键帧", video: "根据确认关键帧生成视频", voice: "生成克隆配音并校准时长", completed: "整理最终成片" };
  const routeIndexes = { upload: 0, image: 1, video: 2, voice: 3, completed: 3 };
  item.progress = values[stage] || item.progress || 5;
  if (Number.isInteger(routeIndexes[stage])) item.routeIndex = routeIndexes[stage];
  item.stage = labels[stage] || stage || "准备任务";
}

async function pollKlingRun(item = state.remake) {
  while (item.running && item.runId) {
    assertCurrentRemake(item);
    let response;
    try { response = await videoClient.getKlingRun(item.runId); }
    catch (error) { await waitForRemakeStop(item); error.stage = item.routeIndex === 1 ? "image" : "video"; throw error; }
    await waitForRemakeStop(item);
    const stopWasAvailable = Boolean(remakeStopStage(item));
    item.videoTaskSubmitted = item.videoTaskSubmitted || Boolean(response.videoTaskId);
    item.serviceBaseUrl = response.baseUrl || item.serviceBaseUrl;
    if (response.stage === "image") {
      item.imageCompleted = (response.imageTasks || []).filter(task => task.status === "SUCCEEDED").length;
      item.imageTotal = response.imageTasks?.length || response.keyframes?.length || 4;
      const progressLabel = document.querySelector("[data-image-retry-progress]");
      if (progressLabel) progressLabel.textContent = `已完成 ${item.imageCompleted}/${item.imageTotal} 张，正在继续处理剩余图片。`;
    }
    const status = String(response.status || "").toUpperCase();
    if (status === "FAILED") {
      const error = new Error(response.message || "产品替换失败");
      error.stage = response.stage || "video";
      error.keyframeIndex = response.imageTasks?.find((task) => ["FAILED", "UNCERTAIN", "ARCHIVE_FAILED", "QUEUED"].includes(String(task.status || "").toUpperCase()))?.index;
      error.confirmedFailed = true;
      throw error;
    }
    updateRemakeStage(response.stage || "upload", item);
    if (response.stage === "image" && status === "SUCCEEDED" && (response.editedKeyframes?.length || response.editedImage)) return response;
    if (state.active === "remake") render({ preserveControls: stopWasAvailable === Boolean(remakeStopStage(item)) });
    if (response.stage === "video" && status === "SUCCEEDED" && response.output?.url) return response;
    await wait(2000);
    assertCurrentRemake(item);
  }
  assertCurrentRemake(item);
  throw new Error("产品替换任务已中断");
}

async function completeRemakeResult(response, item = state.remake) {
  assertCurrentRemake(item);
  item.stopConfirm = null;
  const originalUrl = new URL(response.output.url, response.baseUrl || item.serviceBaseUrl).toString();
  const remoteKey = `${response.id}:${response.output.id}`;
  let result = { name: response.output.name || "商品替换成片.mp4", url: originalUrl, remoteKey, runId: response.id, sourceId: response.id, sourceFilename: item.reference?.name || "商品替换", sourceFolderName: String(item.reference?.name || "商品替换").replace(/\.[^.]+$/, ""), workflow: "remake", duration: item.duration, voiceName: response.videoProvider === "aimanplay" ? response.audioMode === "silent" ? "无声音" : response.voiceName || "参考声音" : "原视频声音", completedAt: response.updatedAt || new Date().toISOString() };
  item.revoiceError = null;
  if (item.voiceEnabled && item.selectedVoiceId && response.videoProvider !== "aimanplay") {
    updateRemakeStage("voice", item);
    item.stage = "生成克隆配音并校准时长";
    if (state.active === "remake") render();
    try {
      result = { ...result, ...(await videoClient.revoiceVideo(originalUrl, response.id, item.selectedVoiceId, item.voiceScript)), remoteKey };
      assertCurrentRemake(item);
    } catch (error) {
      if (!isCurrentRemake(item)) throw new RemakeStoppedError("任务已结束");
      item.revoiceError = error.message;
      result.voiceName = "原视频声音（克隆配音失败）";
    }
  }
  item.result = result;
  updateRemakeStage("completed", item);
  klingAssetsRevision += 1;
  state.library = state.library.filter(asset => !(asset.runId === response.id && (asset.workflow === "remake" || asset.origin === "产品替换")));
  const libraryAsset = { ...result, kind: "video", origin: "产品替换" };
  state.library.unshift(libraryAsset);
  sortLibraryNewestFirst();
}

async function revoiceCurrentResult() {
  const item = state.remake;
  if (!item.result || !item.selectedVoiceId || !item.voiceScript.trim() || item.running || item.stopping) return;
  item.running = true;
  item.revoiceError = null;
  item.stage = "生成克隆配音并校准时长";
  updateRemakeStage("voice");
  render();
  try {
    const updated = await videoClient.revoiceVideo(item.result.url, item.runId || item.result.runId, item.selectedVoiceId, item.voiceScript);
    assertCurrentRemake(item);
    item.result = { ...item.result, ...updated };
    klingAssetsRevision += 1;
    const runId = item.result.runId || item.runId;
    state.library = state.library.filter(asset => !(asset.runId === runId && (asset.workflow === "remake" || asset.origin === "产品替换")));
    state.library.unshift({ ...item.result, kind: "video", origin: "产品替换" });
    sortLibraryNewestFirst();
    notify("新声音已生成并替换到成片中");
  } catch (error) {
    if (!isCurrentRemake(item)) return;
    item.revoiceError = error.message;
    notify(`重新配音失败：${error.message}`);
  } finally {
    if (!isCurrentRemake(item)) return;
    item.running = false;
    item.progress = 0;
    if (state.active === "remake") render();
  }
}

async function runRemake({ retryVideo = false } = {}) {
  const item = state.remake;
  const referenceVideoMode = item.videoMode === "reference_video";
  const outputAudioEnabled = referenceVideoMode ? item.audio === "voice" : item.voiceEnabled;
  const selectedVoice = item.voices.find((voice) => voice.id === item.selectedVoiceId);
  const voiceSettingsValid = !item.voiceEnabled || (Boolean(item.voiceScript.trim()) && item.voiceScript.length <= item.duration * 6 && Boolean(selectedVoice) && selectedVoice.demo !== true);
  if (item.running || item.stopping || !item.reference || !item.products.length || (!referenceVideoMode && !voiceSettingsValid)) return;
  item.running = true;
  item.videoTaskSubmitted = false;
  item.stopConfirm = null;
  item.result = null;
  item.error = null;
  try {
    let response;
    if (retryVideo && item.runId) {
      updateRemakeStage("video");
      render();
      response = await videoClient.startKlingVideo(item.runId, outputAudioEnabled && !referenceVideoMode ? item.voiceScript : "", item.videoMode, item.duration, item.keyframeTimes, true, outputAudioEnabled, item.useSavedVoice ? null : item.selectedVoiceId);
      assertCurrentRemake(item);
      item.runId = response.id || item.runId;
      item.serviceBaseUrl = response.baseUrl || item.serviceBaseUrl;
    } else {
      item.runId = null;
      item.useSavedVoice = false;
      updateRemakeStage("upload");
      render();
      response = await videoClient.createKlingRun(item.reference.file, item.products.map(product => product.file), item.voiceEnabled && !referenceVideoMode ? item.voiceScript : "", outputAudioEnabled ? "voice" : "silent", item.videoMode, item.duration, item.selectedVoiceId, item.productSubject);
      assertCurrentRemake(item);
      item.runId = response.id;
      item.serviceBaseUrl = response.baseUrl;
    }
    item.videoTaskSubmitted = Boolean(response.videoTaskId);
    if (response.stage === "video") updateRemakeStage("video", item);
    if (state.active === "remake") render();
    response = await pollKlingRun(item);
    assertCurrentRemake(item);
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
    await completeRemakeResult(response, item);
    assertCurrentRemake(item);
    notify("产品替换已完成");
  } catch (error) {
    if (!isCurrentRemake(item)) return;
    const technicalMessage = cleanRemoteError(error);
    const rawStage = error.stage || item.stage || "产品替换";
    const tunnelFailure = technicalMessage.includes("网络通道暂时未连接成功");
    item.error = { stage: tunnelFailure ? "准备网络连接" : rawStage, rawStage, message: friendlyRemakeError(technicalMessage, rawStage), technicalMessage, keyframeIndex: error.keyframeIndex, confirmedFailed: Boolean(error.confirmedFailed), tunnelFailure };
  } finally {
    if (!isCurrentRemake(item)) return;
    item.stopConfirm = null;
    item.running = false;
    item.progress = 0;
    if (state.active === "remake") render();
  }
}

async function recoverRemake() {
  const item = state.remake;
  if (!item.runId || item.running || item.stopping) return;
  item.running = true;
  item.stopConfirm = null;
  item.error = null;
  updateRemakeStage(item.stage || "video");
  render();
  try {
    let response = await videoClient.resumeKlingRun(item.runId);
    assertCurrentRemake(item);
    item.videoTaskSubmitted = Boolean(response.videoTaskId);
    updateRemakeStage(response.stage || "video", item);
    if (state.active === "remake") render();
    item.serviceBaseUrl = response.baseUrl || item.serviceBaseUrl;
    if (String(response.status || "").toUpperCase() === "FAILED") {
      const error = new Error(response.message || "原任务已确认失败");
      error.stage = response.stage || "video";
      error.keyframeIndex = response.imageTasks?.find((task) => ["FAILED", "UNCERTAIN", "ARCHIVE_FAILED", "QUEUED"].includes(String(task.status || "").toUpperCase()))?.index;
      error.confirmedFailed = true;
      throw error;
    }
    if (String(response.status || "").toUpperCase() !== "SUCCEEDED") response = await pollKlingRun(item);
    assertCurrentRemake(item);
    if (response.stage === "image") {
      item.editedImage = response.editedImage;
      item.editedKeyframes = response.editedKeyframes || (response.editedImage ? [response.editedImage] : []);
      item.keyframeTimes = response.keyframeTimes || [];
      item.imageReady = true;
      notify("已恢复原任务的关键帧结果，未重新提交");
      return;
    }
    await completeRemakeResult(response, item);
    assertCurrentRemake(item);
    notify("已恢复原任务结果，未重新提交");
  } catch (error) {
    if (!isCurrentRemake(item)) return;
    const rawStage = error.stage || item.stage || "产品替换";
    let savedRun = null;
    try { savedRun = await videoClient.getKlingRun(item.runId); } catch {}
    if (!isCurrentRemake(item)) return;
    const videoRetryAvailable = (rawStage === "video" || savedRun?.stage === "video") && !savedRun?.videoTaskId && item.editedKeyframes.length > 0;
    item.error = {
      stage: rawStage,
      rawStage,
      message: friendlyRemakeError(error, rawStage),
      technicalMessage: cleanRemoteError(error),
      keyframeIndex: error.keyframeIndex,
      confirmedFailed: Boolean(error.confirmedFailed),
      videoRetryAvailable,
      submissionUncertain: ["submitting", "uncertain"].includes(savedRun?.videoSubmission?.status),
      preservedKeyframeCount: videoRetryAvailable ? item.editedKeyframes.length : 0
    };
  } finally {
    if (!isCurrentRemake(item)) return;
    item.stopConfirm = null;
    item.running = false;
    item.progress = 0;
    if (state.active === "remake") render();
  }
}

async function confirmRemakeImage() {
  const item = state.remake;
  const selectedVoice = item.voices.find((voice) => voice.id === item.selectedVoiceId);
  const voiceSettingsValid = !item.voiceEnabled || (Boolean(item.voiceScript.trim()) && item.voiceScript.length <= item.duration * 6 && (item.useSavedVoice || (Boolean(selectedVoice) && selectedVoice.demo !== true)));
  if (!item.runId || !item.imageReady || !item.editedKeyframes.length || item.running || item.stopping || !voiceSettingsValid) return;
  item.running = true;
  item.videoTaskSubmitted = false;
  item.stopConfirm = null;
  item.imageReady = false;
  item.error = null;
  updateRemakeStage("video");
  render();
  try {
    const submitted = await videoClient.startKlingVideo(item.runId, item.voiceEnabled ? item.voiceScript : "", item.videoMode, item.duration, item.keyframeTimes, false, item.voiceEnabled, item.useSavedVoice ? null : item.selectedVoiceId);
    assertCurrentRemake(item);
    item.videoTaskSubmitted = Boolean(submitted.videoTaskId);
    if (state.active === "remake") render();
    const response = await pollKlingRun(item);
    assertCurrentRemake(item);
    updateRemakeStage("completed");
    await completeRemakeResult(response, item);
    assertCurrentRemake(item);
    notify("产品替换已完成");
  } catch (error) {
    if (!isCurrentRemake(item)) return;
    let savedRun = null;
    try { savedRun = await videoClient.getKlingRun(item.runId); } catch {}
    if (!isCurrentRemake(item)) return;
    const technicalMessage = cleanRemoteError(error);
    const videoRetryAvailable = !savedRun?.videoTaskId && item.editedKeyframes.length > 0;
    item.error = { stage: "video", rawStage: "video", message: friendlyRemakeError(technicalMessage, "video"), technicalMessage, videoRetryAvailable, submissionUncertain: ["submitting", "uncertain"].includes(savedRun?.videoSubmission?.status), preservedKeyframeCount: item.editedKeyframes.length };
  } finally { if (isCurrentRemake(item)) { item.stopConfirm = null; item.running = false; item.progress = 0; if (state.active === "remake") render(); } }
}

async function retrySavedRemakeVideo() {
  const item = state.remake;
  if (!item.runId || item.running || item.stopping || !item.editedKeyframes.length) return;
  item.videoRetryConfirm = false;
  item.running = true;
  item.videoTaskSubmitted = false;
  item.stopConfirm = null;
  item.error = null;
  updateRemakeStage("video");
  render();
  try {
    let response = await videoClient.startKlingVideo(item.runId, item.voiceEnabled ? item.voiceScript : "", item.videoMode, item.duration, item.keyframeTimes, true, item.voiceEnabled, item.useSavedVoice ? null : item.selectedVoiceId);
    assertCurrentRemake(item);
    item.videoTaskSubmitted = Boolean(response.videoTaskId);
    item.runId = response.id || item.runId;
    item.serviceBaseUrl = response.baseUrl || item.serviceBaseUrl;
    if (state.active === "remake") render();
    response = await pollKlingRun(item);
    assertCurrentRemake(item);
    updateRemakeStage("completed");
    await completeRemakeResult(response, item);
    assertCurrentRemake(item);
    notify("视频生成已完成，四张关键帧没有重复计费");
  } catch (error) {
    if (!isCurrentRemake(item)) return;
    let savedRun = null;
    try { savedRun = await videoClient.getKlingRun(item.runId); } catch {}
    if (!isCurrentRemake(item)) return;
    const technicalMessage = cleanRemoteError(error);
    item.error = {
      stage: "video",
      rawStage: "video",
      message: friendlyRemakeError(technicalMessage, "video"),
      technicalMessage,
      videoRetryAvailable: !savedRun?.videoTaskId && item.editedKeyframes.length > 0,
      submissionUncertain: ["submitting", "uncertain"].includes(savedRun?.videoSubmission?.status),
      preservedKeyframeCount: item.editedKeyframes.length,
      confirmedFailed: Boolean(savedRun?.videoTaskId && String(savedRun.status || "").toUpperCase() === "FAILED")
    };
  } finally {
    if (!isCurrentRemake(item)) return;
    item.stopConfirm = null;
    item.running = false;
    item.progress = 0;
    if (state.active === "remake") render();
  }
}

async function retryRemakeImages(indexes = [0], continueOnly = false) {
  const item = state.remake;
  const selectedIndexes = [...new Set((Array.isArray(indexes) ? indexes : [indexes]).filter(Number.isInteger))].sort((a, b) => a - b);
  if (!item.runId || item.running || item.stopping || !selectedIndexes.length) return;
  item.running = true;
  item.videoTaskSubmitted = false;
  item.stopConfirm = null;
  item.imageRetrying = true;
  item.imageReady = false;
  item.error = null;
  updateRemakeStage("image");
  render();
  try {
    await videoClient.retryKlingImage(item.runId, item.videoMode === "multi_keyframes" ? selectedIndexes : undefined, continueOnly);
    assertCurrentRemake(item);
    const response = await pollKlingRun(item);
    assertCurrentRemake(item);
    item.editedImage = response.editedImage;
    item.editedKeyframes = response.editedKeyframes || (response.editedImage ? [response.editedImage] : []);
    item.keyframeTimes = response.keyframeTimes || item.keyframeTimes;
    item.selectedRetryIndexes = [];
    item.imageReady = true;
    notify("替换关键帧已就绪，请确认后生成视频");
  } catch (error) { if (isCurrentRemake(item)) item.error = { stage: "image", rawStage: "image", message: friendlyRemakeError(error, "image"), technicalMessage: cleanRemoteError(error) }; }
  finally { if (isCurrentRemake(item)) { item.stopConfirm = null; item.running = false; item.imageRetrying = false; item.progress = 0; if (state.active === "remake") render(); } }
}

function imageRetryMarkup(item, processing = false) {
  const icon = processing
    ? '<svg class="network-progress-ring" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" opacity=".18"/><path d="M12 3a9 9 0 0 1 9 9"/></svg>'
    : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9a13 13 0 0 1 16 0M7 13a8 8 0 0 1 10 0M10 17a3 3 0 0 1 4 0M4 3l16 18"/></svg>';
  return `<header class="output-heading"><h2>生成替换关键帧</h2></header><div class="network-retry-preview" role="status"><i class="network-retry-symbol ${processing ? "is-processing" : ""}">${icon}</i><h2>${processing ? "正在继续生成" : /连接|网络|超时/.test(item.error?.technicalMessage || "") ? "网络连接不稳定" : "生成暂时中断"}</h2><p ${processing ? 'data-image-retry-progress' : ''}>${processing ? `已完成 ${item.imageCompleted || 0}/${item.imageTotal || 4} 张，正在继续处理剩余图片。` : "已完成的图片已保留，请重试。"}</p><button class="primary" data-action="retry-remake-images-direct" type="button" ${processing ? "disabled" : ""}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 10a8 8 0 1 0-1 7M20 4v6h-6"/></svg>${processing ? "正在重试…" : "重试"}</button><small>${processing ? "已完成的图片不会重新生成" : "中断的图片重新生成可能再次计费"}</small></div>`;
}

function voiceFingerprint(seed = 1) {
  const bars = Array.from({ length: 11 }, (_, index) => 7 + ((index * 13 + seed * 7) % 23));
  return `<span class="voice-fingerprint" aria-hidden="true">${bars.map((height) => `<i style="height:${height}px"></i>`).join("")}</span>`;
}

function voiceChangeIcon() {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h13"/><path d="m14 5 3 3-3 3"/><path d="M20 16H7"/><path d="m10 13-3 3 3 3"/></svg>`;
}

function remakeVoiceChoiceMarkup(item, voiceLocked = item.running) {
  const selectedVoice = item.voices.find((voice) => voice.id === item.selectedVoiceId) || null;
  return selectedVoice
    ? `<article class="selected-voice-card ${selectedVoice.demo ? "is-demo" : ""}"><button class="voice-play" data-action="voice-preview-play" data-voice-id="${esc(selectedVoice.id)}" type="button">${item.voicePlayingId === selectedVoice.id ? "Ⅱ" : "▶"}</button>${voiceFingerprint(3)}<span><strong>${esc(selectedVoice.name)}</strong></span><button class="voice-change" data-action="voice-open-picker" type="button" aria-label="更换音色" title="更换音色" ${voiceLocked ? "disabled" : ""}>${voiceChangeIcon()}</button></article>`
    : `<div class="voice-empty-choice"><button data-action="voice-open-create" type="button" ${voiceLocked ? "disabled" : ""}><i>＋</i><span><strong>创建新音色</strong><small>上传 8–15 秒参考音频</small></span></button><button data-action="voice-open-picker" type="button" ${(item.voices.length && !voiceLocked) ? "" : "disabled"}><i>⌁</i><span><strong>选择已有声音</strong><small>${item.voices.length ? `已有 ${item.voices.length} 个声音` : "暂无已保存声音"}</small></span></button></div>`;
}

function syncRemakeVoiceChoice() {
  const current = workspace.querySelector(".voice-control-stack > :first-child");
  if (!current) return;
  current.insertAdjacentHTML("beforebegin", remakeVoiceChoiceMarkup(state.remake));
  current.remove();
  syncRemakeSubmitUi();
}

function syncRemakeSubmitUi() {
  const item = state.remake;
  const voiceLimit = item.duration * 6;
  const selectedVoice = item.voices.find((voice) => voice.id === item.selectedVoiceId);
  const voiceValid = !item.voiceEnabled || (Boolean(selectedVoice) && selectedVoice.demo !== true && Boolean(item.voiceScript.trim()) && item.voiceScript.length <= voiceLimit);
  const ready = item.videoMode === "reference_video" ? item.config?.klingConfigured === true : item.config?.configured === true;
  const generateButton = workspace.querySelector('[data-action="remake-generate"]');
  if (generateButton) generateButton.disabled = !ready || item.running || item.imageReady || !item.products.length || !item.reference || (item.videoMode !== "reference_video" && !voiceValid);
  const confirmButton = workspace.querySelector('[data-action="confirm-remake-image"]');
  if (confirmButton) {
    confirmButton.disabled = !voiceValid;
    confirmButton.textContent = `确认并生成 ${item.duration} 秒视频`;
  }
  const note = workspace.querySelector(".control-panel .submit small");
  if (!note) return;
  if (!ready) note.textContent = item.configError || `${item.videoMode === "reference_video" ? "Kling" : "商品替换"}服务未配置`;
  else if (!item.products.length || !item.reference) note.textContent = "请先上传产品图与参考视频";
  else if (item.videoMode !== "reference_video" && item.voiceEnabled && (!selectedVoice || selectedVoice.demo)) note.textContent = selectedVoice?.demo ? "演示音色仅用于查看选择和删除逻辑" : "请选择或创建声音";
  else if (item.videoMode !== "reference_video" && item.voiceEnabled && item.voiceScript.length > voiceLimit) note.textContent = `当前台词超过 ${item.duration} 秒建议上限，请缩短至 ${voiceLimit} 字以内`;
  else {
    const voice = selectedVoice;
    note.textContent = `${item.videoMode === "reference_video" ? "直接生成替换视频" : "确认全部替换关键帧后再生成视频"} · ${item.duration} 秒 · ${item.videoMode === "reference_video" ? "跟随原视频 · 720P" : "9:16 · 768P"} · ${item.videoMode === "reference_video" ? item.audio === "voice" ? "保留原视频音轨" : "输出无声" : !item.voiceEnabled ? "不生成声音与口型" : `使用「${voice?.name || "已选声音"}」生成配音`}`;
  }
}

function applyRemakeDurationLocally(value, option) {
  const item = state.remake;
  if (item.duration === value) return;
  item.duration = value;
  option.parentElement?.querySelectorAll('[data-option="remakeDuration"]').forEach((button) => button.classList.toggle("active", button === option));
  const referenceStep = workspace.querySelector("#referenceInput")?.closest(".step");
  if (item.videoMode !== "reference_video") {
    const note = referenceStep?.querySelector("header small");
    if (note) note.textContent = `建议与 ${value} 秒输出时长一致`;
    const uploadNote = referenceStep?.querySelector(".upload-box small");
    if (uploadNote) uploadNote.textContent = `MP4 / MOV · 建议 ${value} 秒`;
  }
  const textarea = workspace.querySelector("#remakeVoiceScript");
  if (textarea) {
    const limit = value * 6;
    textarea.maxLength = limit;
    textarea.placeholder = `输入约 ${value} 秒的台词，建议不超过 ${limit} 字`;
    const counter = textarea.closest(".voice-script")?.querySelector("label small");
    if (counter) counter.innerHTML = `<b>${item.voiceScript.length}</b> / ${limit} 字`;
    textarea.closest(".voice-script")?.classList.toggle("is-over-limit", item.voiceScript.length > limit);
  }
  syncRemakeSubmitUi();
}

function replaceVoiceOverlay(panel) {
  state.remake.voicePanel = panel;
  workspace.querySelector(".voice-overlay")?.remove();
  if (panel) workspace.insertAdjacentHTML("beforeend", renderVoiceOverlay(state.remake));
}

function showVoiceDeleteConfirm(voice) {
  workspace.querySelector(".voice-delete-confirm-layer")?.remove();
  const trashIcon = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M9 7V4h6v3M8 10v7M12 10v7M16 10v7M7 7l1 13h8l1-13"/></svg>`;
  workspace.querySelector(".voice-overlay")?.insertAdjacentHTML("beforeend", `<div class="voice-delete-confirm-layer" data-action="voice-delete-cancel"><section class="voice-delete-confirm" role="alertdialog" aria-modal="true" aria-labelledby="voiceDeleteTitle"><i>${trashIcon}</i><h3 id="voiceDeleteTitle">删除这个音色？</h3><p>删除后将无法继续使用“${esc(voice.name)}”。</p><div><button data-action="voice-delete-cancel" type="button">取消</button><button class="is-danger" data-action="voice-delete-confirm" data-voice-id="${esc(voice.id)}" type="button">删除音色</button></div></section></div>`);
}

function voiceLibraryCardMarkup(item, voice, index, removeVoiceIcon) {
  const selected = voice.id === item.selectedVoiceId;
  const meta = voice.demo
    ? "演示音色"
    : voice.builtin
      ? `内置音色${voice.duration ? ` · ${Number(voice.duration).toFixed(1)} 秒样本` : ""}`
      : voice.hasGeneratedPreview ? "已生成试听音频" : voice.duration ? `${Number(voice.duration).toFixed(1)} 秒样本` : "已保存音色";
  const deleteControl = voice.builtin ? "" : `<button class="voice-library-delete" data-action="voice-delete" data-voice-id="${esc(voice.id)}" type="button" aria-label="删除${esc(voice.name)}">${removeVoiceIcon}</button>`;
  return `<article class="${selected ? "is-selected" : ""} ${voice.demo ? "is-demo" : ""} ${voice.builtin ? "is-builtin" : ""}"><button class="voice-library-play" data-action="voice-preview-play" data-voice-id="${esc(voice.id)}" type="button" aria-label="试听${esc(voice.name)}">${item.voicePlayingId === voice.id ? "Ⅱ" : "▶"}</button>${voiceFingerprint(index + 2)}<span><strong>${esc(voice.name)}</strong><small>${meta}</small></span><button class="voice-library-select" data-action="voice-select" data-voice-id="${esc(voice.id)}" type="button" aria-label="${selected ? "已选择" : "选择"}${esc(voice.name)}" aria-pressed="${selected}"><i aria-hidden="true">${selected ? "✓" : ""}</i></button><div class="voice-library-delete-slot">${deleteControl}</div></article>`;
}

function renderVoiceOverlay(item) {
  if (item.voicePanel === "picker") {
    const voices = item.voices || [];
    const createIcon = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v18M3 12h18"/><path d="M5 5h3M5 5v3M19 19h-3m3 0v-3"/></svg>`;
    const removeVoiceIcon = `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill-rule="evenodd" clip-rule="evenodd" d="M7.10002 5H3C2.44772 5 2 5.44772 2 6C2 6.55228 2.44772 7 3 7H4.06055L4.88474 20.1871C4.98356 21.7682 6.29471 23 7.8789 23H16.1211C17.7053 23 19.0164 21.7682 19.1153 20.1871L19.9395 7H21C21.5523 7 22 6.55228 22 6C22 5.44772 21.5523 5 21 5H19.0073C19.0018 4.99995 18.9963 4.99995 18.9908 5H16.9C16.4367 2.71776 14.419 1 12 1C9.58104 1 7.56329 2.71776 7.10002 5ZM9.17071 5H14.8293C14.4175 3.83481 13.3062 3 12 3C10.6938 3 9.58254 3.83481 9.17071 5ZM17.9355 7H6.06445L6.88085 20.0624C6.91379 20.5894 7.35084 21 7.8789 21H16.1211C16.6492 21 17.0862 20.5894 17.1192 20.0624L17.9355 7ZM14.279 10.0097C14.83 10.0483 15.2454 10.5261 15.2068 11.0771L14.7883 17.0624C14.7498 17.6134 14.2719 18.0288 13.721 17.9903C13.17 17.9517 12.7546 17.4739 12.7932 16.9229L13.2117 10.9376C13.2502 10.3866 13.7281 9.97122 14.279 10.0097ZM9.721 10.0098C10.2719 9.97125 10.7498 10.3866 10.7883 10.9376L11.2069 16.923C11.2454 17.4739 10.83 17.9518 10.2791 17.9903C9.72811 18.0288 9.25026 17.6134 9.21173 17.0625L8.79319 11.0771C8.75467 10.5262 9.17006 10.0483 9.721 10.0098Z"/></svg>`;
    return `<div class="voice-overlay" data-action="voice-close-panel"><section class="voice-dialog" role="dialog" aria-modal="true" aria-label="选择音色"><header><span><small>声音库</small><h2>选择一个音色</h2></span><button data-action="voice-close-panel" type="button" aria-label="关闭">×</button></header><div class="voice-library-grid">${voices.map((voice, index) => voiceLibraryCardMarkup(item, voice, index, removeVoiceIcon)).join("")}<button class="voice-create-tile" data-action="voice-open-create" type="button"><i>${createIcon}</i><strong>添加新音色</strong></button></div></section></div>`;
  }
  if (item.voicePanel === "create") {
    const source = item.voiceSource;
    const uploadIcon = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V4m0 0-4 4m4-4 4 4M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/></svg>`;
    return `<div class="voice-overlay" data-action="voice-close-panel"><section class="voice-dialog voice-create-dialog" role="dialog" aria-modal="true" aria-label="创建新音色"><header><span><small>声音库 / 新建</small><h2>创建新音色</h2></span><button data-action="voice-close-panel" type="button" aria-label="关闭">×</button></header><div class="voice-create-body"><p class="voice-create-hint">上传一段 <strong>8–15 秒</strong>的音频，最好只有目标人物说话，没有背景音乐或其他人的声音。</p><label class="voice-audio-upload" for="voiceSourceInput" tabindex="0"><i>${uploadIcon}</i><span><strong>${esc(source?.name || "选择参考音频")}</strong><small>${source?.checking ? "正在检查时长…" : source?.duration ? `${Number(source.duration).toFixed(1)} 秒 · 点击更换文件` : "支持 MP3、WAV、M4A"}</small></span></label><input id="voiceSourceInput" type="file" accept="audio/mpeg,audio/wav,audio/mp4,.mp3,.wav,.m4a" ${item.voiceBusy ? "disabled" : ""} hidden><label class="voice-name-field"><span>音色名称</span><input id="voiceNameInput" value="${esc(item.voiceDraftName || "")}" placeholder="例如：我的声音" maxlength="20" ${item.voiceBusy ? "disabled" : ""}></label><div class="voice-preview-note"><i>▶</i><span>固定试听台词：“你好，这里是我的声音。希望接下来的作品，能带给你不一样的惊喜。”</span></div>${item.voiceCreateError ? `<p class="voice-create-error" role="alert">${esc(item.voiceCreateError)}</p>` : ""}</div><div class="voice-create-actions"><button data-action="voice-back-picker" type="button" ${item.voiceBusy ? "disabled" : ""}>返回声音库</button><button class="primary" data-action="voice-create" type="button" ${item.voiceBusy || !source?.file || source.checking || !(source.duration >= 8 && source.duration <= 15) ? "disabled" : ""}>${item.voiceBusy ? "正在创建音色和试听…" : "创建并生成试听"}</button></div></section></div>`;
  }
  return "";
}

function renderRemake() {
  const item = state.remake;
  const referenceVideoMode = item.videoMode === "reference_video";
  const videoResolution = referenceVideoMode ? "720P" : "768P";
  const videoRatio = referenceVideoMode ? "跟随原视频" : "9:16";
  const referenceVideoReady = item.config?.referenceVideoConfigured !== false;
  const durationLabel = `${item.duration} 秒`;
  const durationValues = referenceVideoMode ? ["5 秒", "10 秒", "15 秒"] : ["5 秒", "8 秒", "10 秒", "15 秒"];
  const durationOptions = options("remakeDuration", durationValues, durationLabel, item.running || item.imageReady ? durationValues : []);
  const voiceLimit = item.duration * 6;
  const voiceWithinLimit = item.voiceScript.length <= voiceLimit;
  const voiceEnabled = item.voiceEnabled !== false;
  const voiceLocked = item.running;
  const soundOptions = options("audio", ["无声音", "有声音"], item.audio === "voice" ? "有声音" : "无声音");
  const selectedVoice = item.voices.find((voice) => voice.id === item.selectedVoiceId) || null;
  const voiceChoice = remakeVoiceChoiceMarkup(item, voiceLocked);
  const voiceInput = referenceVideoMode ? "" : `<div class="voice-control-stack">${voiceChoice}<div class="voice-script ${voiceWithinLimit ? "" : "is-over-limit"}"><label for="remakeVoiceScript"><strong>台词</strong><small><b>${item.voiceScript.length}</b> / ${voiceLimit} 字</small></label><textarea id="remakeVoiceScript" maxlength="${voiceLimit}" placeholder="输入约 ${item.duration} 秒的台词，建议不超过 ${voiceLimit} 字" ${voiceLocked ? "disabled" : ""}>${esc(item.voiceScript)}</textarea></div></div>`;
  const voiceSettingsValid = !voiceEnabled || (Boolean(item.voiceScript.trim()) && voiceWithinLimit && (item.useSavedVoice || (Boolean(selectedVoice) && selectedVoice.demo !== true)));
  const voiceStep = referenceVideoMode
    ? step(4, "声音", "", soundOptions)
    : `<section class="step voice-step ${voiceEnabled ? "is-enabled" : "is-disabled"}"><header><b>4</b><span><strong>声音与口型</strong></span><button class="voice-toggle ${voiceEnabled ? "is-on" : ""}" data-action="toggle-remake-voice" type="button" role="switch" aria-checked="${voiceEnabled}" aria-label="${voiceEnabled ? "关闭声音与口型" : "开启声音与口型"}" ${voiceLocked ? "disabled" : ""}><i aria-hidden="true"></i></button></header><div class="voice-step__reveal" aria-hidden="${!voiceEnabled}"><div class="voice-step__reveal-inner">${voiceInput}</div></div></section>`;
  const ready = referenceVideoMode ? item.config?.klingConfigured === true : item.config?.configured === true;
  const productLimit = referenceVideoMode ? 1 : 3;
  const productAccept = "image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp";
  const productReferences = `${item.products.length
    ? `<div class="image-grid product-reference-grid">${item.products.map((product, index) => `<figure><img src="${esc(product.url)}" alt="商品参考图 ${index + 1}：${esc(product.name)}"><figcaption>参考图 ${index + 1}</figcaption></figure>`).join("")}</div><label class="inline-action" for="productInput">重新选择参考图</label><input id="productInput" type="file" accept="${productAccept}" ${productLimit > 1 ? "multiple" : ""} hidden>`
    : uploadBox("productInput", "上传商品参考图", `JPG / PNG / WEBP · 最多 ${productLimit} 张`, productAccept, productLimit > 1)}${!referenceVideoMode ? '<p class="product-reference-hint">至少一张包含人类手部等可参照物体，便于判断商品尺寸。</p>' : ""}<div class="product-subject-field"><div class="product-subject-heading"><label for="remakeProductSubject">替换主体说明 <small>可选</small></label><button class="product-subject-help" data-subject-help type="button" aria-label="替换主体说明帮助" aria-describedby="productSubjectHint"><svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7.5"/><path d="M8 7.7a2.1 2.1 0 0 1 4.1.7c0 1.5-2.1 1.8-2.1 3.2M10 14.4v.1"/></svg></button><span id="productSubjectHint" class="product-subject-tooltip" popover="manual" role="tooltip">参考图里有多个物品时，说明要替换的是哪一个；不填则自动识别。</span></div><textarea id="remakeProductSubject" maxlength="200" rows="2" placeholder="例如：红色包装盒的为主体 旁边的散装不是主体" ${item.running || item.runId ? "disabled" : ""}>${esc(item.productSubject)}</textarea></div>`;
  const controls = `<header class="panel-heading"><h2>替换视频中的商品</h2>${referenceVideoMode ? "" : "<p>自动抽取并替换多张关键帧，确认后再生成视频。</p>"}</header><div class="panel-scroll">${step(1, "输出规格", "", `<div class="duration-choice"><small>视频时长</small>${durationOptions}</div><div class="fixed-specs fixed-specs--two"><span><small>视频比例</small><strong>${videoRatio}</strong></span><span><small>分辨率</small><strong>${videoResolution}</strong></span></div>`)}${step(2, "商品参考图", referenceVideoMode ? "1 张商品图" : "最多 3 张 · 同一商品", productReferences)}${step(3, "参考视频", referenceVideoMode ? "输入视频需为 3–10 秒" : `建议与 ${item.duration} 秒输出时长一致`, item.reference ? `${mediaPreview(item.reference)}<label class="inline-action" for="referenceInput">替换视频</label><input id="referenceInput" type="file" accept="video/mp4,video/quicktime,.mp4,.mov" hidden>` : uploadBox("referenceInput", "上传参考视频", referenceVideoMode ? "MP4 / MOV · 3–10 秒" : `MP4 / MOV · 建议 ${item.duration} 秒`, "video/mp4,video/quicktime,.mp4,.mov"))}${voiceStep}</div><footer class="submit"><button class="primary" data-action="remake-generate" ${!ready || item.running || item.imageReady || !item.products.length || !item.reference || (!referenceVideoMode && !voiceSettingsValid) ? "disabled" : ""}>${item.running ? "正在生成…" : referenceVideoMode ? "直接生成替换视频 →" : "生成替换关键帧 →"}</button><small>${!ready ? item.configError ? esc(item.configError) : referenceVideoMode ? "参考原视频服务未配置" : "视频生成服务待配置" : !referenceVideoMode && voiceEnabled && (!selectedVoice || selectedVoice.demo) ? selectedVoice?.demo ? "演示音色仅用于查看选择和删除逻辑" : "请选择或创建声音" : !referenceVideoMode && voiceEnabled && !voiceWithinLimit ? `当前台词超过 ${item.duration} 秒建议上限，请缩短至 ${voiceLimit} 字以内` : item.products.length && item.reference ? `${referenceVideoMode ? referenceVideoReady ? "Kling 3.0 Omni 参考原视频和商品图" : "生成前会先连接 Cloudflare 临时通道" : "确认全部替换关键帧后再生成视频"} · ${item.duration} 秒 · ${videoRatio} · ${videoResolution} · ${referenceVideoMode ? item.audio === "voice" ? "保留原视频音轨" : "输出无声" : !voiceEnabled ? "不生成声音与口型" : `使用「${esc(selectedVoice?.name || "") }」生成配音`}` : "请先上传产品图与参考视频"}</small></footer>`;
  let output = referenceVideoMode
    ? `<header class="output-heading"><h2>参考视频 + 商品图 = 替换成片</h2></header><div class="equation"><span>参考视频</span><b>＋</b><span>商品图片</span><b>→</b><span class="accent">替换成片</span></div><div class="empty"><i>替</i><h3>准备产品图、参考视频和台词</h3><p>此模式直接生成成片，不经过关键帧确认。</p></div>`
    : `<header class="output-heading"><h2>多张替换关键帧生成成片</h2></header><div class="equation"><span>4–6 张关键帧</span><b>＋</b><span>商品图片</span><b>→</b><span class="accent">替换成片</span></div><div class="empty"><i>替</i><h3>准备产品图、参考视频和台词</h3><p>关键帧全部生成后会等待确认，再进入视频生成阶段。</p></div>`;
  if (item.error) {
    const tunnelFailure = item.error.tunnelFailure === true;
    const videoRetryAvailable = item.error.videoRetryAvailable === true && item.editedKeyframes.length > 0;
    const stageLabel = { image: "生成替换关键帧", video: "生成替换视频", voice: "生成配音" }[item.error.rawStage] || item.error.stage || "完成任务";
    const safeRetry = item.runId && !videoRetryAvailable ? `<button class="primary" data-action="retry-remake" type="button">↻　继续当前任务</button>` : "";
    const paidRetry = item.runId && item.error.confirmedFailed ? `<button class="secondary" data-action="retry-remake-paid" type="button">重新尝试失败步骤</button>` : "";
    const safetyNote = tunnelFailure ? "任务尚未提交，不会产生费用。" : item.runId ? "当前进度已经保留，可以稍后继续。" : "任务尚未开始，请稍后再试。";
    if (videoRetryAvailable) {
      const submissionUncertain = item.error.submissionUncertain === true;
      const framesIcon = `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="7" width="12" height="12" rx="2"/><path d="M8 4h10a2 2 0 0 1 2 2v10"/></svg>`;
      const retryIcon = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 8a8 8 0 1 0 1 7"/><path d="M19 3v5h-5"/><path d="m10 9 6 3-6 3z"/></svg>`;
      const reviewIcon = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12s3.5-6 9-6 9 6 9 6-3.5 6-9 6-9-6-9-6Z"/><circle cx="12" cy="12" r="2.5"/></svg>`;
      const retryControls = item.videoRetryConfirm
        ? `<div class="video-retry-confirm"><span><strong>${submissionUncertain ? "仍要重新提交视频？" : "继续完成视频？"}</strong><small>${submissionUncertain ? "上次提交可能已被受理，重新提交可能重复计费。关键帧不会重新生成。" : "将直接使用已经生成的关键帧，不会重复生成图片。开始后可能产生一次视频生成费用。"}</small></span><div><button class="secondary" data-action="cancel-remake-video-retry" type="button">取消</button><button class="primary" data-action="confirm-remake-video-retry" type="button">${submissionUncertain ? "确认重新提交" : "继续生成"}</button></div></div>`
        : `<div class="video-recovery-actions"><button class="secondary" data-action="review-saved-keyframes" type="button"><i>${reviewIcon}</i><span><small>确认已有结果</small><strong>查看 ${item.editedKeyframes.length} 张关键帧</strong></span></button><button class="primary" data-action="prepare-remake-video-retry" type="button"><i>${retryIcon}</i><span><small>从当前进度继续</small><strong>继续生成视频</strong></span></button></div>`;
      output = `<header class="output-heading"><h2>产品替换</h2></header><div class="failure-state failure-state--recoverable"><div class="recovery-frame-icon"><i>${framesIcon}</i><b>${item.error.preservedKeyframeCount || item.editedKeyframes.length}</b></div><small>生成暂时中断</small><h2>关键帧已保留，可以继续完成视频</h2><p>${submissionUncertain ? "上次视频提交结果暂时无法确认，请先核对任务记录；再次提交可能重复计费。" : "视频服务暂时未能响应。已经完成的关键帧不会重复生成。"}</p>${retryControls}</div>`;
    } else {
      output = `<header class="output-heading"><h2>产品替换</h2></header><div class="failure-state"><i>!</i><small>${tunnelFailure ? "连接未完成" : `${esc(stageLabel)}未完成`}</small><h2>${tunnelFailure ? "网络暂时未连接成功" : "这一步暂时没有完成"}</h2><p>${esc(item.error.message || "服务暂时未能响应，请稍后再试。")}</p><p>${safetyNote}</p><div class="confirm-actions">${safeRetry}${paidRetry}</div></div>`;
    }
  }
  const stopStage = remakeStopStage(item);
  const processingStop = stopStage === "video" ? `<div class="remake-stop-actions remake-stop-actions--processing"><button class="remake-stop-trigger" data-action="remake-stop-open" type="button" ${item.stopping ? "disabled" : ""}>中止任务</button></div>` : "";
  if (item.running) output = progressOutput(item.progress, referenceVideoMode ? ["上传素材", "读取参考内容", "生成替换视频", "整理最终成片"] : ["抽取关键帧", "逐张替换商品", "生成替换视频", "整理最终成片"], item.stage, "task-processing", item, processingStop);
  if (item.error?.rawStage === "image" && item.runId) output = imageRetryMarkup(item);
  if (item.running && item.imageRetrying) output = imageRetryMarkup(item, true);
  if (item.imageReady && item.editedKeyframes.length) {
    const selectedRetryIndexes = item.selectedRetryIndexes || [];
    output = `<header class="output-heading"><h2>请逐张确认商品替换是否正确</h2></header><div class="keyframe-review-grid">${item.editedKeyframes.map((frame, index) => { const selected = selectedRetryIndexes.includes(index); return `<article class="${selected ? "is-selected" : ""}"><img src="${esc(new URL(frame.url, item.serviceBaseUrl).toString())}" alt="替换关键帧 ${index + 1}"><span><strong>关键帧 ${index + 1}</strong><small>约 ${Number(item.keyframeTimes[index] || 0).toFixed(1)} 秒</small></span><button class="keyframe-select" data-action="toggle-remake-image" data-keyframe-index="${index}" type="button" aria-pressed="${selected}"><i aria-hidden="true">${selected ? "✓" : ""}</i>${selected ? "已选择" : "选择重做"}</button></article>`; }).join("")}</div><div class="confirm-actions"><button class="icon-button" data-action="retry-selected-remake-images" type="button" ${selectedRetryIndexes.length ? "" : "disabled"}>重新生成所选${selectedRetryIndexes.length ? `（${selectedRetryIndexes.length}）` : ""}</button><button class="primary" data-action="confirm-remake-image" type="button" ${voiceSettingsValid ? "" : "disabled"}>确认并生成 ${item.duration} 秒视频</button></div>`;
  }
  if (stopStage && !(item.running && stopStage === "video")) output += `<div class="remake-stop-actions"><button class="remake-stop-trigger" data-action="remake-stop-open" type="button" ${item.stopping ? "disabled" : ""}>${stopStage === "image" ? "保留图片并结束" : "中止任务"}</button></div>`;
  if (item.result) {
    const clockIcon = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path d="M12 7v5l3 2"/></svg>`;
    const framesIcon = `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="6" width="11" height="12" rx="2"/><path d="M9 3h9a2 2 0 0 1 2 2v10"/></svg>`;
    const resolutionIcon = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5"/></svg>`;
    const voiceIcon = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 13v-2M8 17V7M12 20V4M16 16V8M20 14v-4"/></svg>`;
    const revoiceIcon = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 13v-2M8 17V7M12 19V5M16 15V9"/><path d="M18 5h3v3M21 5l-4 4"/></svg>`;
    const folderIcon = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7h7l2 2h9v10H3z"/></svg>`;
    const metric = (icon, label, value) => `<span><i>${icon}</i><b><small>${label}</small><strong>${esc(value)}</strong></b></span>`;
    const status = item.revoiceError ? `<em class="is-warning">配音待处理</em>` : `<em>✓ 已完成</em>`;
    output = `<header class="output-heading"><h2>产品替换已完成</h2></header><div class="voice-result-layout"><div class="voice-result-preview"><video src="${esc(item.result.url)}" controls></video></div><aside class="voice-result-side"><section class="voice-result-meta"><header><strong>输出信息</strong>${status}</header><div>${metric(clockIcon, "时长", `${Number(item.result.duration || item.duration).toFixed(0)} 秒`)}${metric(framesIcon, "帧率", "24 FPS")}${metric(resolutionIcon, "分辨率", videoResolution)}${metric(voiceIcon, "声音来源", item.result.voiceName || selectedVoice?.name || (voiceEnabled ? "克隆声音" : "无声音"))}</div>${item.revoiceError ? `<p class="voice-result-warning">克隆配音未完成：${esc(item.revoiceError)}</p>` : ""}</section><section class="voice-result-actions"><header><strong>更多操作</strong></header><div class="voice-result-action-grid"><button class="primary" data-action="voice-revoice" type="button"><i>${revoiceIcon}</i><strong>更换声音并重新配音</strong></button><button class="voice-result-secondary" data-action="voice-view-library" type="button"><i>${folderIcon}</i><strong>查看结果</strong></button></div></section></aside></div>`;
  }
  workspace.innerHTML = `${page("产品替换", "多关键帧商品替换", controls, output)}${renderVoiceOverlay(item)}${renderRemakeStopDialog(item)}`;
}

function subtitleStep(item, locked = false) {
  const enabled = locked && item.removeSubtitles === true;
  const configured = state.split.config?.subtitleConfigured === true;
  return step(3, "字幕", "拆分前处理整条视频", `${options("splitSubtitles", ["不去字幕", "去字幕"], enabled ? "去字幕" : "不去字幕", locked ? ["不去字幕", "去字幕"] : ["去字幕"])}${enabled ? `<div class="subtitle-service-note"><p>固定处理画面底部字幕，无需逐条框选。处理期间请保持客户端开启及网络连接；原片保留。</p>${!configured ? "<small>去字幕服务暂不可用，请联系维护者</small>" : ""}</div>` : ""}`);
}
function batchProcessingRoute(batch, active) {
  const index = active ? /naming_prepare|ffmpeg_completed/.test(active.stage) ? 1 : /ffmpeg_processing/.test(active.stage) ? 0 : /naming|analysis|provider|quota/.test(active.stage) ? 2 : 3 : 3;
  const subtitle = batch.removeSubtitles && active?.stage?.startsWith("subtitle_");
  const stages = batch.removeSubtitles ? ["云端去字幕", "检测镜头", "导出片段", "分析命名", "整理结果"] : ["检测镜头", "导出片段", "分析命名", "整理结果"];
  return processRoute(stages, batch.removeSubtitles ? subtitle ? 0 : index + 1 : index);
}
function renderFolderBatchSplit(item) {
  const batch = item.batch;
  const folders = batch.folders || [];
  const allVideos = folders.flatMap((folder) => folder.videos || []);
  const completedFolders = folders.filter((folder) => folder.status === "completed").length;
  const completedVideos = allVideos.filter((video) => video.status === "completed").length;
  const failedVideos = allVideos.filter((video) => video.status === "failed").length;
  const processingFolder = folders.find((folder) => folder.status === "processing");
  const selectedFolder = folders.find((folder) => folder.id === batch.selectedFolderId) || processingFolder || folders[0];
  const selectedIndex = Math.max(0, folders.findIndex((folder) => folder.id === selectedFolder?.id));
  const currentVideo = selectedFolder?.videos?.find((video) => video.status === "processing") || null;
  const folderStatusText = { completed: "已完成", processing: "处理中", queued: "等待处理", partial: "部分完成", paused: "等待继续" };
  const videoStatusText = { completed: "已完成", processing: "处理中", queued: "等待处理", failed: "处理失败", cancelled: "已取消", paused: "等待继续" };
  const statusIcon = { completed: "✓", processing: "●", queued: "○", failed: "!", cancelled: "–", paused: "Ⅱ" };
  const stageIndex = currentVideo ? /naming_prepare|ffmpeg_completed/.test(currentVideo.stage) ? 1 : /ffmpeg_processing/.test(currentVideo.stage) ? 0 : /naming|analysis|provider|quota/.test(currentVideo.stage) ? 2 : 3 : 3;
  const query = String(batch.folderQuery || "").trim().toLowerCase();
  const visibleFolders = query ? folders.filter((folder) => folder.name.toLowerCase().includes(query)) : folders;
  const activeFolderIndex = Math.max(0, folders.findIndex((folder) => folder.id === processingFolder?.id));
  const selectedIsActive = selectedFolder?.id === processingFolder?.id;
  const folderRail = `<aside class="folder-workbench-rail"><header><strong>${folders.length} 个商品文件夹</strong><b>${completedFolders} 已完成</b></header>${folders.length > 8 ? `<label class="folder-search"><i>⌕</i><input id="folderTaskSearch" value="${esc(batch.folderQuery || "")}" placeholder="查找文件夹" autocomplete="off"></label>` : ""}<div class="folder-rail-list">${visibleFolders.map((folder) => { const index = folders.indexOf(folder); const done = folder.videos.filter((video) => video.status === "completed").length; return `<button class="is-${folder.status} ${folder.id === selectedFolder?.id ? "active" : ""}" data-folder-task="${folder.id}" type="button"><i>${folder.status === "completed" ? "✓" : folder.status === "processing" ? "●" : String(index + 1).padStart(2, "0")}</i><span><strong>${esc(folder.name)}</strong><small>${done} / ${folder.videos.length} 个视频</small></span><em>${folderStatusText[folder.status]}</em></button>`; }).join("") || `<div class="folder-search-empty">没有匹配的文件夹</div>`}</div></aside>`;
  let focusPanel = "";
  if (selectedFolder?.status === "processing" && currentVideo) {
    focusPanel = `<section class="folder-focus-card"><header><h2>${esc(currentVideo.name)}</h2></header><p>${esc(currentVideo.detail || "处理中")}</p>${batchProcessingRoute(batch, currentVideo)}</section>`;
  }
  const videoList = `<div class="folder-video-list workbench-video-list">${(selectedFolder?.videos || []).map((video, index) => {
    const meta = video.status === "completed" ? `${video.clipCount} 个片段` : video.status === "queued" ? `第 ${index + 1} 个` : "";
    const action = video.status === "failed" ? `<button class="icon-button" data-action="${batch.preview ? "folder-retry-demo" : "batch-retry-item"}" data-video-id="${esc(video.id)}" type="button">重试</button>` : "";
    return `<article class="is-${video.status}"><i>${statusIcon[video.status]}</i><span><strong>${esc(video.name)}</strong><small>${videoStatusText[video.status]}${video.detail ? ` · ${esc(video.detail)}` : ""}</small></span>${meta ? `<b>${meta}</b>` : ""}${action}</article>`;
  }).join("")}</div>`;
  const returnToActive = !selectedIsActive && processingFolder ? `<button class="folder-return-active" data-action="folder-return-active" type="button" aria-label="返回当前正在处理的任务 ${esc(processingFolder.name)}"><i>↩</i><strong>返回当前任务</strong></button>` : "";
  const progressTrack = `<div class="folder-overall-track" aria-label="文件夹总体进度">${folders.map((folder) => `<i class="is-${folder.status}" title="${esc(folder.name)}"></i>`).join("")}</div>`;
  const selectedStatusLabel = selectedFolder?.status === "queued" ? "等待中" : folderStatusText[selectedFolder?.status] || "等待中";
  const detail = `<main class="folder-workbench-detail"><div class="folder-detail-content"><header class="folder-detail-header"><div class="folder-detail-title"><h1>${esc(selectedFolder?.name || "文件夹任务")}</h1><span class="is-${selectedFolder?.status || "queued"}">${selectedStatusLabel}</span></div></header>${focusPanel}<div class="folder-content-heading"><strong>视频按文件名顺序串行处理</strong></div>${videoList}</div>${returnToActive}</main>`;
  const optionSummary = `<div class="folder-workbench-options"><strong>${batch.mode === "ffmpeg_only" ? "分割" : "分割并命名"}</strong><strong>${batch.removeSubtitles ? "去字幕" : "不去字幕"}</strong><strong>${batch.keepAudio ? "保留原声" : "去除声音"}</strong></div>`;
  const canViewResults = selectedFolder?.status === "completed" && completedVideos > 0;
  const taskFinished = batch.status === "paused" || folders.length > 0 && !folders.some((folder) => folder.status === "processing" || folder.status === "queued");
  const newTaskAction = taskFinished ? `<button class="folder-new-task" data-action="batch-new" type="button" title="开启新任务"><i><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg></i><strong>开启新任务</strong></button>` : "";
  const cancelAction = batch.id && !["completed", "cancelled", "paused"].includes(batch.status) ? `<button class="batch-cancel-trigger" data-action="batch-cancel-open" type="button" ${item.batchCanceling ? "disabled" : ""}>${item.batchCanceling ? "正在停止…" : "中止当前任务"}</button>` : "";
  const resultAction = `<button class="folder-library-result" data-action="folder-result-demo" type="button" ${canViewResults ? 'title="查看结果"' : `disabled title="${selectedFolder?.status === "processing" ? "当前文件夹处理完成后可查看结果" : "当前文件夹尚未开始处理"}"`}><i><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6.5h6l2 2h10v10H3z"/></svg></i><strong>查看结果</strong></button>`;
  const headerActions = `<div class="folder-workbench-actions">${!item.running && !batch.active && !["completed","cancelled"].includes(batch.status) ? '<button class="batch-cancel-trigger" data-action="batch-resume" type="button">继续未完成任务</button>' : ""}${cancelAction}${newTaskAction}${resultAction}</div>`;
  workspace.innerHTML = `<section class="folder-workbench"><header class="folder-workbench-header"><h2>文件夹批量处理</h2>${optionSummary}${headerActions}${progressTrack}</header><div class="folder-workbench-body">${folderRail}${detail}</div></section>${batchCancelDialog(item)}`;
}

function batchCancelDialog(item) {
  if (!item.batchCancelConfirm) return "";
  return `<div class="batch-cancel-overlay"><section class="batch-cancel-dialog" role="alertdialog" aria-modal="true" aria-labelledby="batchCancelTitle"><h2 id="batchCancelTitle">中止当前任务？</h2><p>已完成的视频会保留在素材库。当前处理会尝试中断，未开始的视频不再处理；已提交的第三方请求可能仍会产生费用。</p><div><button data-action="batch-cancel-dismiss" type="button">继续处理</button><button class="is-danger" data-action="batch-cancel-confirm" type="button">停止并返回上传</button></div></section></div>`;
}

function renderBatchSplit(item) {
  const batch = item.batch;
  if (batch.folderMode) return renderFolderBatchSplit(item);
  const completed = batch.items.filter((entry) => entry.status === "completed").length;
  const processing = batch.items.filter((entry) => entry.status === "processing").length;
  const queued = batch.items.filter((entry) => entry.status === "queued").length;
  const failed = batch.items.filter((entry) => entry.status === "failed").length;
  const pending = Math.max(0, batch.items.length - completed);
  const canResume = !item.running && !item.batchCanceling && !batch.active && batch.status !== "cancelled" && pending > 0 && batch.id;
  const totalSize = batch.preview ? "1.8 GB" : formatFileSize(item.sources.reduce((sum, source) => sum + Number(source.file?.size || 0), 0));
  const primaryFooterAction = batch.status === "cancelled" || (batch.status === "completed" && !pending) ? `<button class="primary" data-action="batch-new" type="button">开始新的批次</button>` : canResume ? `<button class="primary" data-action="batch-resume" type="button">继续处理 ${pending} 个未完成视频</button>` : `<button class="primary" type="button" disabled>${item.batchCanceling ? "正在停止…" : batch.status === "uploading" ? "正在上传视频…" : `正在处理 ${batch.items.length} 个视频…`}</button>`;
  const footerAction = failed && batch.status !== "cancelled" && !item.running && !batch.active ? `<div class="batch-submit-actions">${primaryFooterAction}<button class="batch-new-button" data-action="batch-new" type="button">开始新批次</button></div>` : primaryFooterAction;
  const cancelAction = batch.id && !["completed", "cancelled", "paused"].includes(batch.status) ? `<button class="batch-cancel-trigger" data-action="batch-cancel-open" type="button" ${item.batchCanceling ? "disabled" : ""}>${item.batchCanceling ? "正在停止…" : "中止当前任务"}</button>` : "";
  const controls = `<header class="panel-heading"><h2>把多条视频整理成素材</h2><p>统一设置后，按顺序完成拆分与命名。</p></header><div class="panel-scroll">${step(1, "视频队列", `已选择 ${batch.items.length} 个视频`, `<div class="batch-upload-summary"><i>${batch.items.length}</i><span><strong>${batch.items.length} 个视频已加入队列</strong><small>${totalSize} · 处理期间不可修改</small></span></div><div class="batch-source-list">${batch.items.map((entry, index) => `<span><i>${String(index + 1).padStart(2, "0")}</i><strong>${esc(entry.name)}</strong><small>${esc(entry.size || "")}</small></span>`).join("")}</div>`)}${step(2, "处理方式", "应用到全部视频", options("splitMode", ["分割", "分割并命名"], batch.mode === "ffmpeg_only" ? "分割" : "分割并命名", ["分割", "分割并命名"]))}${subtitleStep(batch, true)}${step(4, "声音", "应用到全部视频", options("splitAudio", ["保留原声", "去除声音"], batch.keepAudio ? "保留原声" : "去除声音", ["保留原声", "去除声音"]))}</div><footer class="submit">${footerAction}${cancelAction}<small>串行处理 · 单个失败不会中断后续视频</small></footer>`;

  if (batch.selectedVideoId) {
    const selected = batch.items.find((entry) => entry.id === batch.selectedVideoId);
    const previewVideo = "../../video-mix-standalone/assets/video-remake/spring-water-reference-5s.mp4";
    const clipNames = ["人物手持商品正面展示的稳定镜头", "产品包装细节与人物自然动作", "侧面角度展示商品使用过程", "人物转身后继续手持商品", "桌面环境中的产品近景片段", "自然光线下的商品互动镜头", "人物面向镜头完成口播动作", "结尾画面与商品稳定定格"];
    const clips = batch.preview ? clipNames.slice(0, selected.clipCount).map((name, index) => ({ name, url: previewVideo, startSec: index * 3, endSec: index * 3 + 3 })) : selected.clips || [];
    const output = `<header class="output-heading batch-detail-heading"><button class="icon-button" data-action="batch-back" type="button">← 返回批次结果</button><h2>${esc(selected.name)}</h2></header><div class="batch-detail-summary"><strong>${selected.clipCount} 个片段</strong><span>${selected.keepAudio ?? batch.keepAudio ? "保留原声" : "已去除声音"}</span><span>${batch.mode === "ffmpeg_only" ? "分割" : "分割并命名"}</span></div><div class="clip-grid batch-detail-clips">${clips.map((clip) => `<article class="previewable" tabindex="0" data-preview-url="${esc(clip.url)}" data-preview-kind="video" data-preview-name="${esc(clip.name)}"><div class="clip-card__preview"><video src="${esc(clip.url)}" muted playsinline preload="metadata" tabindex="-1"></video></div><div class="clip-card__info"><strong title="${esc(clip.name)}">${esc(clip.name)}</strong><small>${formatTime(clip.startSec)} - ${formatTime(clip.endSec)}</small></div></article>`).join("")}</div>`;
    workspace.innerHTML = `${page("素材分割", batch.preview ? "批量素材处理预览" : "批量素材处理", controls, output, "batch-preview-page")}${batchCancelDialog(item)}`;
    return;
  }

  const filters = [
    { id: "all", label: "全部", count: batch.items.length },
    { id: "processing", label: "处理中", count: processing },
    { id: "completed", label: "已完成", count: completed },
    { id: "failed", label: "失败", count: failed }
  ];
  const visibleItems = batch.filter === "all" ? batch.items : batch.items.filter((entry) => entry.status === batch.filter);
  const statusText = { completed: "已完成", processing: "处理中", queued: "等待处理", failed: "处理失败", cancelled: "已取消", paused: "等待继续" };
  const statusIcon = { completed: "✓", processing: "●", queued: "○", failed: "!", cancelled: "–", paused: "Ⅱ" };
  const active = item.running || batch.active ? batch.items.find((entry) => entry.status === "processing") : null;
  const stageIndex = active ? /naming_prepare|ffmpeg_completed/.test(active.stage) ? 1 : /ffmpeg_processing/.test(active.stage) ? 0 : /naming|analysis|provider|quota/.test(active.stage) ? 2 : 3 : 3;
  const activeProgress = batch.mode === "ffmpeg_only" && !batch.removeSubtitles ? `<div class="batch-indeterminate-progress" role="progressbar" aria-label="正在分割视频"><i></i></div>` : batchProcessingRoute(batch, active);
  const activePanel = active ? `<section class="batch-active"><header><span><i></i><small>当前处理</small><strong>${esc(active.name)}</strong></span><b>${esc(active.detail || "处理中")}</b></header>${activeProgress}</section>` : `<section class="batch-active is-idle"><header><span><i></i><small>${batch.status === "cancelled" ? "任务已停止" : pending ? "等待继续" : "批次状态"}</small><strong>${batch.status === "cancelled" ? "已完成的视频保留在素材库" : pending ? `${pending} 个视频尚未完成` : "全部视频处理完成"}</strong></span></header></section>`;
  const output = `<header class="output-heading"><h2>批量素材处理</h2></header><div class="batch-overview"><div class="batch-stats"><span><strong>${completed} / ${batch.items.length}</strong><small>已完成</small></span><span><strong>${processing}</strong><small>处理中</small></span><span><strong>${queued}</strong><small>等待</small></span><span class="${failed ? "has-failure" : ""}"><strong>${failed}</strong><small>失败</small></span></div>${activePanel}<nav class="batch-filters">${filters.map((filter) => `<button type="button" data-batch-filter="${filter.id}" class="${batch.filter === filter.id ? "active" : ""}">${filter.label}<small>${filter.count}</small></button>`).join("")}</nav><div class="batch-result-list">${visibleItems.map((entry) => `<article class="batch-result-row is-${entry.status}"><i>${statusIcon[entry.status]}</i><span><strong>${esc(entry.name)}</strong><small>${statusText[entry.status]}${entry.detail ? ` · ${esc(entry.detail)}` : ""}</small></span><b>${entry.status === "completed" ? `${entry.clipCount} 个片段` : entry.status === "queued" ? `队列第 ${entry.queuePosition} 位` : ""}</b>${entry.status === "completed" ? `<button class="icon-button" data-action="batch-view-result" data-video-id="${entry.id}" type="button">查看结果</button>` : entry.status === "failed" ? `<button class="icon-button" data-action="${batch.preview ? "batch-retry-demo" : "batch-retry-item"}" data-video-id="${entry.id}" type="button">重试</button>` : "<em></em>"}</article>`).join("")}</div></div>`;
  workspace.innerHTML = `${page("素材分割", batch.preview ? "批量素材处理预览" : "批量素材处理", controls, output, "batch-preview-page")}${batchCancelDialog(item)}`;
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
  const selectedFolderMap = new Map();
  for (const source of item.sources) {
    if (!source.folderId) continue;
    if (!selectedFolderMap.has(source.folderId)) selectedFolderMap.set(source.folderId, { id: source.folderId, name: source.folderName, sources: [] });
    selectedFolderMap.get(source.folderId).sources.push(source);
  }
  const selectedFolders = [...selectedFolderMap.values()];
  const selectedBytes = item.sources.reduce((sum, source) => sum + Number(source.file?.size || source.sizeBytes || 0), 0);
  const folderCards = selectedFolders.map((folder) => `<article class="split-folder-card"><i><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7h7l2 2h9v10H3z"/></svg></i><span><strong>${esc(folder.name)}</strong><small>${folder.sources.length} 个视频 · ${formatFileSize(folder.sources.reduce((sum, source) => sum + Number(source.sizeBytes || 0), 0))}</small></span></article>`).join("");
  const sourceContent = selectedFolders.length
    ? `<div class="batch-upload-summary"><i>${selectedFolders.length}</i><span><strong>${selectedFolders.length} 个文件夹已选择</strong><small>${sourceCount} 个视频 · ${formatFileSize(selectedBytes)}</small></span></div><div class="split-folder-grid">${folderCards}</div><div class="split-source-actions"><button data-action="split-pick-folders" type="button">重新选择文件夹</button><label for="splitInput">改为选择视频</label></div><input id="splitInput" type="file" accept="video/*" multiple hidden>`
    : sourceCount > 1
      ? `<div class="batch-upload-summary"><i>${sourceCount}</i><span><strong>${sourceCount} 个视频已选择</strong><small>${formatFileSize(selectedBytes)} · 最多 25 个</small></span></div><div class="batch-source-list is-editable">${item.sources.map((source, index) => `<span><i>${String(index + 1).padStart(2, "0")}</i><strong>${esc(source.name)}</strong><small>${esc(source.size)}</small><button type="button" data-action="split-remove-source" data-source-index="${index}" aria-label="移除 ${esc(source.name)}">×</button></span>`).join("")}</div><div class="split-source-actions"><label for="splitInput">重新选择视频</label><button data-action="split-pick-folders" type="button">改为选择文件夹</button></div><input id="splitInput" type="file" accept="video/*" multiple hidden>`
      : item.source ? `${mediaPreview(item.source)}<div class="split-source-actions"><label for="splitInput">重新选择视频</label><button data-action="split-pick-folders" type="button">改为选择文件夹</button></div><input id="splitInput" type="file" accept="video/*" multiple hidden>`
        : `<div class="split-source-choice">${uploadBox("splitInput", "选择视频", `单个或多个 · 每个不超过 ${item.config?.uploadLimitMb || 500}MB`, "video/*", true)}<button class="upload-box" data-action="split-pick-folders" type="button"><i><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7h7l2 2h9v10H3z"/></svg></i><strong>选择文件夹</strong><small>按商品文件夹批量处理</small><em>选择文件夹</em></button></div>`;
  const controls = `<header class="panel-heading"><h2>把长视频整理成可用素材</h2><p>选择视频或商品文件夹，按顺序完成拆分与命名。</p></header><div class="panel-scroll">${step(1, selectedFolders.length ? "商品文件夹" : "上传视频", sourceCount ? selectedFolders.length ? `已选择 ${selectedFolders.length} 个文件夹、${sourceCount} 个视频` : `已选择 ${sourceCount} 个本地视频` : "支持视频或文件夹批量处理", sourceContent)}${step(2, "处理方式", "", options("splitMode", ["分割", "分割并命名"], item.mode === "ffmpeg_only" ? "分割" : "分割并命名", lockedOptions))}${subtitleStep(item, item.running)}${step(4, "声音", "", options("splitAudio", ["保留原声", "去除声音"], item.keepAudio ? "保留原声" : "去除声音", lockedAudio))}</div><footer class="submit"><button class="primary" data-action="split-generate" ${!sourceCount || item.running ? "disabled" : ""}>${item.running ? "正在处理…" : selectedFolders.length ? `开始处理 ${selectedFolders.length} 个文件夹 →` : sourceCount > 1 ? `开始处理 ${sourceCount} 个视频 →` : "开始素材处理 →"}</button><small>${!namingAvailable ? `分割可用 · 命名服务未配置 · ${item.keepAudio ? "保留原声" : "去除声音"}` : sourceCount ? `完成后将按${selectedFolders.length ? "文件夹" : "视频"}整理结果 · ${item.keepAudio ? "保留原声" : "去除声音"}` : "请先选择视频或文件夹"}</small></footer>`;
  let output = `<header class="output-heading"><h2>${sourceCount > 1 ? "多条视频，统一整理成素材" : "一条长视频，整理成多个片段"}</h2></header><div class="empty"><i>分</i><h3>${sourceCount ? `${sourceCount} 个视频已就绪，可以开始处理` : "上传视频开始处理"}</h3><p>处理后的片段、名称和 FFmpeg 运行信息会在这里显示。</p></div>`;
  if (item.error) output = `<header class="output-heading"><h2>素材分割</h2></header><div class="failure-state"><i>!</i><small>处理失败 · ${esc(item.error.stage || "素材处理")}</small><h2>未能完成素材分割</h2><p>${esc(item.error.message || "处理进程意外终止，可以使用原有内容直接重试。")}</p><button class="primary" data-action="retry-split" type="button">↻　重试本次任务</button></div>`;
  if (item.running) output = progressOutput(item.progress, flow, item.stage, "task-processing", item);
  if (item.result) {
    const source = item.result.mediaTools?.ffmpeg?.source;
    const sourceLabel = source === "client_directory" ? "客户端目录" : source === "system_path" ? "系统目录" : source === "configured_path" ? "配置目录" : "未知目录";
    output = `<header class="output-heading"><h2>素材处理完成</h2></header><div class="clip-grid">${item.result.clips.map((clip) => `<article class="previewable" tabindex="0" data-preview-url="${esc(clip.url)}" data-preview-kind="video" data-preview-name="${esc(clip.name)}"><div class="clip-card__preview"><video src="${esc(clip.url)}" muted playsinline preload="metadata" tabindex="-1"></video></div><div class="clip-card__info"><strong title="${esc(clip.name)}">${esc(clip.name)}</strong><small>${formatTime(clip.startSec)} - ${formatTime(clip.endSec)}</small></div></article>`).join("")}</div>`;
  }
  workspace.innerHTML = `${page("素材分割", "素材清洗、分割与归档", controls, output)}`;
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

function libraryAssetDisplayName(item) {
  const extension = /\.[^.]+$/.exec(String(item.name || ""))?.[0] || (item.kind === "video" ? ".mp4" : "");
  if (item.contentTitle) return `${String(item.contentTitle).trim()}${extension}`;
  const withoutSequence = String(item.name || "未命名素材").replace(/^\d{1,4}[_\-\s]+/, "");
  if (!item.usageType) return withoutSequence;
  return withoutSequence.replace(new RegExp(`[_\-\s]+${String(item.usageType).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=\.[^.]+$)`, "i"), "");
}

function libraryAssetCard(item) {
  const displayName = libraryAssetDisplayName(item);
  return `<article class="asset-card previewable" tabindex="0" data-preview-url="${esc(item.url)}" data-preview-kind="${esc(item.kind)}" data-preview-name="${esc(displayName)}"><div class="asset-card__preview">${item.kind === "image" ? `<img src="${esc(item.url)}" alt="">` : item.kind === "audio" ? `<i>声</i>` : `<video src="${esc(item.url)}" preload="metadata"></video>`}</div><div class="asset-card__info"><strong title="${esc(displayName)}">${esc(displayName)}</strong></div></article>`;
}

function libraryFolderCard(folder, attribute) {
  const modes = {
    split_named: { label: "分割并命名", icon: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z"/></svg>` },
    split_plain: { label: "仅分割", icon: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8.5 8.5 10 10M8.5 15.5 18.5 5.5"/><circle cx="6" cy="7" r="2.5"/><circle cx="6" cy="17" r="2.5"/></svg>` },
    remake: { label: "商品替换", icon: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 8h13m0 0-3-3m3 3-3 3M19 16H6m0 0 3 3m-3-3 3-3"/></svg>` }
  };
  const mode = modes[folder.kind];
  const count = Number(folder.itemCount ?? folder.items?.length ?? 0);
  const time = folder.completedAt ? new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(folder.completedAt)) : "";
  const timeMeta = time ? `<span><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/></svg>${time}</span>` : "";
  const countMeta = `<span><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="5" width="16" height="14" rx="2"/><path d="m10 9 5 3-5 3z"/></svg>${count} ${folder.mediaKind === "image" ? "张图片" : folder.mediaKind === "mixed" ? "个素材" : "个视频"}</span>`;
  const meta = `${timeMeta}${countMeta}`;
  const badge = mode ? `<em class="library-mode-badge">${mode.icon}<span>${mode.label}</span></em>` : "";
  return `<button class="library-folder-card is-${esc(folder.kind || "category")}" ${attribute} type="button"><span class="library-folder-card__preview"><i aria-hidden="true"><b></b></i>${badge}</span><span class="library-folder-card__info"><strong>${esc(folder.name)}</strong><small>${meta}</small></span></button>`;
}

function libraryTaskCard(run) {
  const itemCount = run.categories ? run.categories.reduce((sum, category) => sum + category.items.length, 0) : run.items.length;
  const mediaKind = run.items?.length && run.items.every(item => item.kind === "image") ? "image" : run.items?.some(item => item.kind !== "video") ? "mixed" : "video";
  const card = libraryFolderCard({ ...run, itemCount, mediaKind }, `data-library-run="${esc(run.id)}"`);
  const exportButton = run.runId ? `<button class="library-export-button" data-library-export="${esc(run.id)}" type="button" ${libraryExportBusy ? "disabled" : ""} title="导出到本地" aria-label="导出${esc(run.name)}"><span>${libraryExportBusy ? "导出中…" : "导出"}</span></button>` : "";
  return `<div class="library-task-card">${card}${exportButton}</div>`;
}

function libraryDateKey(value) {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(value || 0));
}

function libraryDateLabel(key) {
  const [year, month, day] = key.split("-").map(Number);
  const today = libraryDateKey(new Date());
  const label = `${month}月${day}日`;
  return key === today ? `今天 · ${label}` : `${year === new Date().getFullYear() ? "" : `${year}年`}${label}`;
}

function derivedLibraryRuns() {
  if (state.libraryRuns.length) return state.libraryRuns;
  const groups = new Map();
  for (const item of state.library) {
    const sourceId = item.sourceId || item.runId || String(item.remoteKey || "").split(":")[0] || `local-${item.name}-${item.completedAt || "upload"}`;
    const remake = item.workflow === "remake" || item.origin === "产品替换";
    if (remake && !item.runId) continue;
    const groupId = item.runId && !remake ? `${item.runId}:${sourceId}` : sourceId;
    const named = !remake && (item.workflow === "ffmpeg_gemini_naming" || Boolean(item.usageType));
    if (!groups.has(groupId)) {
      const sourceName = item.sourceFolderName || String(item.sourceFilename || item.name || "素材").replace(/\.[^.]+$/, "");
      groups.set(groupId, { id: groupId, runId: item.runId || null, sourceId, sourceFolderId: item.sourceFolderId || null, name: sourceName, kind: remake ? "remake" : named ? "split_named" : "split_plain", completedAt: item.completedAt, items: [], categories: named ? [] : null, categoryMap: named ? new Map() : null });
    }
    const group = groups.get(groupId);
    if (named) {
      const categoryName = item.usageType || "其他素材";
      if (!group.categoryMap.has(categoryName)) {
        const category = { id: `${groupId}:${categoryName}`, name: categoryName, items: [] };
        group.categoryMap.set(categoryName, category);
        group.categories.push(category);
      }
      group.categoryMap.get(categoryName).items.push(item);
    } else {
      group.items.push(item);
    }
  }
  return [...groups.values()].map((group) => {
    if (group.kind === "remake") {
      const videos = group.items.filter((item) => item.kind === "video");
      group.items = videos.length ? videos : group.items.filter((item) => item.kind === "image");
    }
    delete group.categoryMap;
    return group;
  }).sort((a, b) => (Date.parse(b.completedAt || "") || 0) - (Date.parse(a.completedAt || "") || 0));
}

function renderLibrary() {
  const runs = derivedLibraryRuns();
  const currentRun = runs.find((run) => run.id === state.libraryView.runId) || null;
  const currentCategory = currentRun?.categories?.find((category) => category.id === state.libraryView.categoryId) || null;
  let tabs = "";
  let breadcrumb = `<strong>素材库</strong>`;
  let cards = "";

  if (!currentRun) {
    const filters = [
      { id: "all", label: "全部" },
      { id: "split", label: "素材拆分" },
      { id: "remake", label: "商品替换" }
    ];
    const visibleRuns = runs.filter((run) => state.libraryRunFilter === "all" || (state.libraryRunFilter === "split" ? run.kind.startsWith("split") : run.kind === "remake"));
    tabs = `<nav class="library-tabs">${filters.map((filter) => { const matchingRuns = filter.id === "all" ? runs : runs.filter((run) => filter.id === "split" ? run.kind.startsWith("split") : run.kind === "remake"); const count = matchingRuns.length; return `<button type="button" data-library-run-filter="${filter.id}" class="${state.libraryRunFilter === filter.id ? "active" : ""}">${filter.label} <small>${count}</small></button>`; }).join("")}</nav>`;
    const dateGroups = new Map();
    for (const run of visibleRuns) {
      const key = libraryDateKey(run.completedAt);
      if (!dateGroups.has(key)) dateGroups.set(key, []);
      dateGroups.get(key).push(run);
    }
    cards = visibleRuns.length ? [...dateGroups.entries()].map(([key, entries]) => `<section class="library-date-group"><header><strong>${libraryDateLabel(key)}</strong><i></i></header><div class="asset-grid">${entries.map(libraryTaskCard).join("")}</div></section>`).join("") : `<div class="library-empty"><i>库</i><h2>素材库暂时为空</h2><p>完成素材拆分或商品替换后，结果会显示在这里。</p></div>`;
  } else if (currentRun.kind === "split_named" && !currentCategory) {
    breadcrumb = `<button data-library-home type="button">素材库</button><i>›</i><strong>${esc(currentRun.name)}</strong>`;
    cards = currentRun.categories.map((category) => libraryFolderCard({ ...category, kind: "category", category: true, itemCount: category.items.length }, `data-library-category="${esc(category.id)}"`)).join("");
  } else {
    const items = currentCategory?.items || currentRun.items || [];
    breadcrumb = `<button data-library-home type="button">素材库</button><i>›</i>${currentCategory ? `<button data-library-run="${esc(currentRun.id)}" type="button">${esc(currentRun.name)}</button><i>›</i><strong>${esc(currentCategory.name)}</strong>` : `<strong>${esc(currentRun.name)}</strong>`}`;
    cards = items.length ? items.map(libraryAssetCard).join("") : `<div class="library-empty"><i>库</i><h2>文件夹中暂无素材</h2></div>`;
  }

  const backButton = currentRun ? `<button class="library-back-button" data-library-back type="button" aria-label="返回上一级" title="返回上一级"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11.5 5.5 5 12l6.5 6.5M5 12h14"/></svg></button>` : "";
  const contentClass = currentRun ? "asset-grid library-content-grid" : "library-date-list";
  workspace.innerHTML = `<section class="library-page"><header><span><h1>素材库</h1><p>按日期和来源文件夹查看本地结果。</p></span><label class="primary upload-button" for="libraryInput">＋ 上传临时素材<input id="libraryInput" type="file" accept="video/*,audio/*,image/*" multiple hidden></label></header><div class="library-pathbar">${backButton}<div class="library-breadcrumb">${breadcrumb}</div></div>${tabs}<div class="${contentClass}">${cards}</div></section>`;
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
function addFile(file, kind, origin) { const item = { name: file.name, url: mediaUrl(file), kind, origin, file, completedAt: new Date().toISOString() }; if (origin !== "产品替换") { state.library.unshift(item); sortLibraryNewestFirst(); } return item; }
function runSimulation(key, done) { if (timers.has(key)) return; const item = state[key]; item.running = true; item.progress = 6; item.result = null; item.error = null; render(); const timer = setInterval(() => { item.progress = Math.min(100, item.progress + 9); if (item.progress < 100) return updateProcessingDisplay(); clearInterval(timer); timers.delete(key); item.running = false; item.progress = 0; item.result = done(); render(); notify("模拟处理完成"); }, 180); timers.set(key, timer); }

function showProductSubjectTooltip(button) {
  const tooltip = button?.parentElement?.querySelector(".product-subject-tooltip");
  if (!tooltip || tooltip.matches(":popover-open")) return;
  tooltip.showPopover();
  const buttonRect = button.getBoundingClientRect();
  const tooltipRect = tooltip.getBoundingClientRect();
  const left = Math.max(12, Math.min(buttonRect.left, window.innerWidth - tooltipRect.width - 12));
  const below = buttonRect.bottom + 8;
  const top = below + tooltipRect.height <= window.innerHeight - 12 ? below : Math.max(12, buttonRect.top - tooltipRect.height - 8);
  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${top}px`;
}
function hideProductSubjectTooltip(button) {
  const tooltip = button?.parentElement?.querySelector(".product-subject-tooltip");
  if (tooltip?.matches(":popover-open")) tooltip.hidePopover();
}

document.addEventListener("pointerover", (event) => {
  const button = event.target.closest?.("[data-subject-help]");
  if (button && !button.contains(event.relatedTarget)) showProductSubjectTooltip(button);
});
document.addEventListener("pointerout", (event) => {
  const heading = event.target.closest?.(".product-subject-heading");
  if (!heading || heading.contains(event.relatedTarget)) return;
  const button = heading.querySelector("[data-subject-help]");
  if (document.activeElement !== button) hideProductSubjectTooltip(button);
});
document.addEventListener("focusin", (event) => {
  const button = event.target.closest?.("[data-subject-help]");
  if (button) showProductSubjectTooltip(button);
});
document.addEventListener("focusout", (event) => {
  const button = event.target.closest?.("[data-subject-help]");
  if (button) hideProductSubjectTooltip(button);
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") hideProductSubjectTooltip(document.activeElement?.closest?.("[data-subject-help]"));
});

document.addEventListener("click", async (event) => {
  if (event.target.closest("[data-preview-close]")) { closeMediaViewer(); return; }
  const libraryExport = event.target.closest("[data-library-export]");
  if (libraryExport) {
    const run = derivedLibraryRuns().find((entry) => entry.id === libraryExport.dataset.libraryExport);
    if (!run?.runId || libraryExportBusy) return;
    libraryExportBusy = true;
    workspace.querySelectorAll("[data-library-export]").forEach((button) => { button.disabled = true; });
    libraryExport.querySelector("span").textContent = "导出中…";
    try {
      const result = await videoClient.exportLibraryTask({ kind: run.kind === "remake" ? "remake" : "split", runId: run.runId, sourceId: run.sourceId, name: run.name });
      if (!result.canceled) notify(`已导出 ${result.count} 个文件到 ${result.destination}`);
    } catch (error) { notify(`导出失败：${error.message}`); }
    finally {
      libraryExportBusy = false;
      workspace.querySelectorAll("[data-library-export]").forEach((button) => { button.disabled = false; button.querySelector("span").textContent = "导出"; });
    }
    return;
  }
  const libraryFilter = event.target.closest("[data-library-filter]")?.dataset.libraryFilter;
  if (libraryFilter) { state.libraryFilter = libraryFilter; render(); return; }
  const libraryRunFilter = event.target.closest("[data-library-run-filter]")?.dataset.libraryRunFilter;
  if (libraryRunFilter) { state.libraryRunFilter = libraryRunFilter; render(); return; }
  if (event.target.closest("[data-library-back]")) {
    state.libraryView = state.libraryView.categoryId ? { runId: state.libraryView.runId, categoryId: null } : { runId: null, categoryId: null };
    render({ preserveScroll: false });
    return;
  }
  const libraryRun = event.target.closest("[data-library-run]")?.dataset.libraryRun;
  if (libraryRun) { state.libraryView = { runId: libraryRun, categoryId: null }; render({ preserveScroll: false }); return; }
  const libraryCategory = event.target.closest("[data-library-category]")?.dataset.libraryCategory;
  if (libraryCategory) { state.libraryView.categoryId = libraryCategory; render({ preserveScroll: false }); return; }
  if (event.target.closest("[data-library-home]")) { state.libraryView = { runId: null, categoryId: null }; render({ preserveScroll: false }); return; }
  const folderTask = event.target.closest("[data-folder-task]")?.dataset.folderTask;
  if (folderTask && state.split.batch?.folderMode) { state.split.batch.selectedFolderId = folderTask; render(); return; }
  const batchFilter = event.target.closest("[data-batch-filter]")?.dataset.batchFilter;
  if (batchFilter && state.split.batch) { state.split.batch.filter = batchFilter; render(); return; }
  const toolButton = event.target.closest("[data-tool]");
  if (toolButton?.dataset.unavailable === "true") { notify(`${toolButton.dataset.toolName}暂未开放，敬请期待`); return; }
  const tool = toolButton?.dataset.tool;
  if (tool) {
    state.active = tool;
    if (tool === "remake" && state.remake.configError) void loadKlingConfig();
    render({ preserveScroll: false });
    if (tool === "library") { void loadShotAssets(); void loadKlingAssets(); }
    return;
  }
  const option = event.target.closest("[data-option]");
  if (option) {
    if (option.disabled) return;
    if (option.dataset.option === "remakeDuration") {
      const value = Number.parseInt(option.dataset.value, 10);
      if (!Number.isFinite(value) || state.remake.duration === value) return;
      const resetsOutput = Boolean(state.remake.result || state.remake.error);
      Object.assign(state.remake, { result: null, error: null, progress: 0, stage: "" });
      if (resetsOutput) { state.remake.duration = value; render(); }
      else applyRemakeDurationLocally(value, option);
      return;
    }
    if (option.dataset.option === "audio") {
      state.remake.audio = option.dataset.value === "有声音" ? "voice" : "silent";
      option.parentElement?.querySelectorAll('[data-option="audio"]').forEach((button) => button.classList.toggle("active", button === option));
      syncRemakeSubmitUi();
      return;
    }
    const map = { audio: ["remake", "audio"], remakeDuration: ["remake", "duration"], splitMode: ["split", "mode"], splitAudio: ["split", "keepAudio"], splitSubtitles: ["split", "removeSubtitles"], composeRatio: ["compose", "ratio"], composeResolution: ["compose", "resolution"] };
    const [section, field] = map[option.dataset.option];
    const values = { "无声音": "silent", "有声音": "voice", "自动提取": "video", "上传样本": "upload", "5 秒": 5, "8 秒": 8, "10 秒": 10, "15 秒": 15, "分割": "ffmpeg_only", "分割并命名": "ffmpeg_gemini_naming", "保留原声": true, "去除声音": false, "去字幕": true, "不去字幕": false };
    const value = values[option.dataset.value] ?? option.dataset.value;
    state[section][field] = value;
    render();
    return;
  }
  const action = event.target.closest("[data-action]")?.dataset.action;
  if (action === "voice-open-picker") { state.remake.revoicePending = false; replaceVoiceOverlay("picker"); return; }
  if (action === "voice-open-create") {
    state.remake.revoicePending = false;
    state.remake.voiceCreateError = "";
    replaceVoiceOverlay("create");
    return;
  }
  if (action === "voice-back-picker") {
    if (!state.remake.voiceBusy) replaceVoiceOverlay("picker");
    return;
  }
  if (action === "voice-close-panel") {
    if (state.remake.voiceBusy) return;
    const target = event.target.closest("[data-action='voice-close-panel']");
    if (target?.classList.contains("voice-overlay") && event.target !== target) return;
    state.remake.revoicePending = false;
    replaceVoiceOverlay(null);
    return;
  }
  if (action === "voice-preview-play") {
    const voiceId = event.target.closest("[data-action]")?.dataset.voiceId;
    const voice = state.remake.voices.find((entry) => entry.id === voiceId);
    voicePreviewAudio?.pause();
    if (state.remake.voicePlayingId === voiceId) {
      state.remake.voicePlayingId = null;
      voicePreviewAudio = null;
      syncVoicePlaybackUi();
      return;
    }
    if (!voice?.sampleUrl) { notify("这个声音没有可试听的本地样本"); return; }
    voicePreviewAudio = new Audio(voice.sampleUrl);
    state.remake.voicePlayingId = voiceId;
    syncVoicePlaybackUi();
    voicePreviewAudio.addEventListener("ended", () => {
      if (state.remake.voicePlayingId !== voiceId) return;
      state.remake.voicePlayingId = null;
      voicePreviewAudio = null;
      syncVoicePlaybackUi();
    }, { once: true });
    voicePreviewAudio.play().catch((error) => {
      state.remake.voicePlayingId = null;
      voicePreviewAudio = null;
      syncVoicePlaybackUi();
      notify(`试听失败：${error.message}`);
    });
    return;
  }
  if (action === "voice-select") {
    state.remake.selectedVoiceId = event.target.closest("[data-action]")?.dataset.voiceId || null;
    state.remake.useSavedVoice = false;
    const selectedVoice = state.remake.voices.find((voice) => voice.id === state.remake.selectedVoiceId);
    const shouldRevoice = state.remake.revoicePending;
    if (shouldRevoice) {
      state.remake.revoicePending = false;
      replaceVoiceOverlay(null);
      if (selectedVoice?.demo) { syncRemakeVoiceChoice(); notify("演示音色不会提交真实重新配音"); }
      else void revoiceCurrentResult();
    } else {
      syncVoiceLibrarySelectionUi();
      syncRemakeVoiceChoice();
      notify(`已选择 ${selectedVoice?.name || "音色"}，可继续试听`);
    }
    return;
  }
  if (action === "voice-create") {
    const source = state.remake.voiceSource;
    if (state.remake.voiceBusy || !source?.file || source.checking) return;
    if (!(source.duration >= 8 && source.duration <= 15)) { state.remake.voiceCreateError = "参考音频时长需在 8–15 秒之间"; replaceVoiceOverlay("create"); return; }
    const name = document.querySelector("#voiceNameInput")?.value.trim() || "新音色";
    state.remake.voiceDraftName = name;
    state.remake.voiceCreateError = "";
    state.remake.voiceBusy = true;
    const createButton = event.target.closest("[data-action='voice-create']");
    const nameInput = workspace.querySelector("#voiceNameInput");
    if (createButton) { createButton.disabled = true; createButton.textContent = "正在创建…"; }
    if (nameInput) nameInput.disabled = true;
    try {
      const voice = await videoClient.createVoice(source.file, name);
      state.remake.voices.unshift(voice);
      state.remake.selectedVoiceId = voice.id;
      state.remake.useSavedVoice = false;
      state.remake.voiceSource = null;
      state.remake.voiceDraftName = "";
      replaceVoiceOverlay("picker");
      syncRemakeVoiceChoice();
      notify("新音色已创建，点击播放可试听效果");
    } catch (error) {
      console.error("创建音色失败", error);
      state.remake.voiceCreateError = friendlyVoiceCreateError(error);
    } finally {
      state.remake.voiceBusy = false;
      if (state.remake.voicePanel === "create") replaceVoiceOverlay("create");
    }
    return;
  }
  if (action === "voice-delete") {
    const voiceId = event.target.closest("[data-action]")?.dataset.voiceId;
    const voice = state.remake.voices.find((entry) => entry.id === voiceId);
    if (!voice) return;
    showVoiceDeleteConfirm(voice);
    return;
  }
  if (action === "voice-delete-cancel") {
    const layer = event.target.closest("[data-action='voice-delete-cancel']");
    if (layer?.classList.contains("voice-delete-confirm-layer") && event.target !== layer) return;
    workspace.querySelector(".voice-delete-confirm-layer")?.remove();
    return;
  }
  if (action === "voice-delete-confirm") {
    const confirmButton = event.target.closest("[data-action='voice-delete-confirm']");
    const voiceId = confirmButton?.dataset.voiceId;
    const voice = state.remake.voices.find((entry) => entry.id === voiceId);
    if (!voice) return;
    confirmButton.disabled = true;
    confirmButton.textContent = "正在删除…";
    try {
      await videoClient.deleteVoice(voiceId);
      state.remake.voices = state.remake.voices.filter((entry) => entry.id !== voiceId);
      if (state.remake.selectedVoiceId === voiceId) state.remake.selectedVoiceId = null;
      replaceVoiceOverlay("picker");
      syncRemakeVoiceChoice();
      notify("音色已删除");
    } catch {
      confirmButton.disabled = false;
      confirmButton.textContent = "删除音色";
      notify("删除失败，请稍后重试");
    }
    return;
  }
  if (action === "voice-revoice") { state.remake.revoicePending = true; replaceVoiceOverlay("picker"); return; }
  if (action === "voice-view-library") {
    state.active = "library";
    state.libraryRunFilter = "remake";
    state.libraryView = { runId: state.remake.result?.sourceId || state.remake.result?.runId || state.remake.runId, categoryId: null };
    render({ preserveScroll: false });
    return;
  }
  if (action === "open-kling" || action === "open-shot") {
    videoClient.openWorkspace(action === "open-kling" ? "kling" : "shot").catch((error) => notify(error.message));
    return;
  }
  if (action === "toggle-remake-voice") {
    if (state.remake.running) return;
    const enabled = !state.remake.voiceEnabled;
    state.remake.voiceEnabled = enabled;
    state.remake.audio = enabled ? "voice" : "silent";
    const toggle = event.target.closest("[data-action='toggle-remake-voice']");
    const voiceStep = toggle.closest(".voice-step");
    const reveal = voiceStep.querySelector(".voice-step__reveal");
    voiceStep.classList.toggle("is-enabled", enabled);
    voiceStep.classList.toggle("is-disabled", !enabled);
    toggle.classList.toggle("is-on", enabled);
    toggle.setAttribute("aria-checked", String(enabled));
    toggle.setAttribute("aria-label", enabled ? "关闭声音与口型" : "开启声音与口型");
    reveal.setAttribute("aria-hidden", String(!enabled));
    const voiceLimit = state.remake.duration * 6;
    const selectedVoice = state.remake.voices.find((voice) => voice.id === state.remake.selectedVoiceId);
    const voiceSettingsValid = !enabled || (Boolean(state.remake.voiceScript.trim()) && state.remake.voiceScript.length <= voiceLimit && (state.remake.useSavedVoice || (Boolean(selectedVoice) && selectedVoice.demo !== true)));
    const generateButton = document.querySelector('[data-action="remake-generate"]');
    if (generateButton) generateButton.disabled = state.remake.config?.configured !== true || state.remake.running || state.remake.imageReady || !state.remake.products.length || !state.remake.reference || !voiceSettingsValid;
    const confirmButton = document.querySelector('[data-action="confirm-remake-image"]');
    if (confirmButton) confirmButton.disabled = !voiceSettingsValid;
    const submitNote = document.querySelector(".submit small");
    if (submitNote && state.remake.products.length && state.remake.reference && state.remake.config?.configured === true) submitNote.textContent = `确认全部替换关键帧后再生成视频 · ${state.remake.duration} 秒 · 9:16 · 768P · ${enabled ? "使用已选声音生成口型与配音" : "不生成声音与口型"}`;
    return;
  }
  if (action === "retry-remake") { void recoverRemake(); return; }
  if (action === "remake-stop-open") { openRemakeStop(); return; }
  if (action === "remake-stop-dismiss") { dismissRemakeStop(); return; }
  if (action === "remake-stop-confirm") { void stopRemake(); return; }
  if (action === "review-saved-keyframes") {
    state.remake.videoRetryConfirm = false;
    state.remake.error = null;
    state.remake.imageReady = true;
    state.remake.stage = "替换关键帧已生成";
    render();
    return;
  }
  if (action === "prepare-remake-video-retry") { state.remake.videoRetryConfirm = true; render(); return; }
  if (action === "cancel-remake-video-retry") { state.remake.videoRetryConfirm = false; render(); return; }
  if (action === "confirm-remake-video-retry") { void retrySavedRemakeVideo(); return; }
  if (action === "retry-remake-images-direct") {
    void retryRemakeImages([Number.isInteger(state.remake.error?.keyframeIndex) ? state.remake.error.keyframeIndex : 0], true);
    return;
  }
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
  if (action === "folder-retry-demo") { notify("预览模式：只重试这个失败视频，不重复处理其他视频"); return; }
  if (action === "folder-result-demo") {
    const selectedFolder = state.split.batch?.folders?.find((folder) => folder.id === state.split.batch.selectedFolderId);
    const targetRun = derivedLibraryRuns().find((run) => run.sourceFolderId === selectedFolder?.id || run.name === selectedFolder?.name);
    if (!targetRun) { notify("当前批次暂时没有可查看的结果"); return; }
    state.active = "library";
    state.libraryView = { runId: targetRun.id, categoryId: null };
    render({ preserveScroll: false });
    return;
  }
  if (action === "folder-return-active" && state.split.batch?.folderMode) {
    const activeFolder = state.split.batch.folders.find((folder) => folder.status === "processing");
    if (activeFolder) state.split.batch.selectedFolderId = activeFolder.id;
    render();
    return;
  }
  if (action === "batch-retry-item") { void runSplitBatch({ retryVideoId: event.target.closest("[data-action]")?.dataset.videoId }); return; }
  if (action === "batch-resume") { void runSplitBatch({ resume: true }); return; }
  if (action === "batch-cancel-open" && state.split.batch?.id && !state.split.batchCanceling) { state.split.batchCancelConfirm = true; render(); return; }
  if (action === "batch-cancel-dismiss") { state.split.batchCancelConfirm = false; render(); return; }
  if (action === "batch-cancel-confirm" && state.split.batch?.id && !state.split.batchCanceling) {
    const batchId = state.split.batch.id;
    if (state.split.batch.preview) {
      Object.assign(state.split, { source: null, sources: [], runId: null, result: null, error: null, batch: null, batchOperation: null, batchCanceling: false, batchCancelConfirm: false, running: false, progress: 0, stage: "" });
      render();
      notify("预览模式：已返回上传界面");
      return;
    }
    state.split.batchCancelConfirm = false;
    state.split.batchCanceling = true;
    render();
    try {
      const stopped = await videoClient.cancelShotBatch(batchId);
      let stoppedBatch = null;
      try {
        const response = await videoClient.getShotBatch(batchId);
        stoppedBatch = batchFromResponse(response);
        addBatchResultsToLibrary(stoppedBatch);
      } catch { void loadShotAssets(); }
      if (stopped.status === "paused") {
        Object.assign(state.split, { batch: stoppedBatch || { ...state.split.batch, status: "paused", active: false }, batchOperation: null, batchCanceling: false, batchCancelConfirm: false, running: false });
        render(); notify("已停止本地等待。云端任务可能继续，可稍后查询原任务；关闭客户端会使临时回传通道失效。"); return;
      }
      Object.assign(state.split, { source: null, sources: [], runId: null, result: null, error: null, batch: null, batchOperation: null, batchCanceling: false, batchCancelConfirm: false, running: false, progress: 0, stage: "" });
      render();
      notify(stopped.status === "completed" ? "任务已完成，结果保留在素材库" : "任务已停止，已完成的视频保留在素材库");
    } catch (error) {
      state.split.batchCanceling = false;
      render();
      notify(`停止任务失败：${error.message}`);
    }
    return;
  }
  if (action === "batch-new") { Object.assign(state.split, { source: null, sources: [], runId: null, result: null, error: null, batch: null, batchOperation: null, batchCancelConfirm: false, batchCanceling: false, running: false, progress: 0, stage: "" }); render(); return; }
  if (action === "split-pick-folders") {
    try {
      const selection = await videoClient.pickShotFolders();
      if (!selection?.entries?.length) return;
      const sources = selection.entries.map((entry) => ({ ...entry, kind: "video", origin: "素材分割输入", size: formatFileSize(entry.sizeBytes || 0) }));
      Object.assign(state.split, { sources, source: sources[0] || null, runId: null, result: null, error: null, batch: null, progress: 0, stage: "" });
      render();
    } catch (error) { notify(error.message); }
    return;
  }
  if (action === "split-remove-source") {
    const index = Number(event.target.closest("[data-action]")?.dataset.sourceIndex);
    state.split.sources.splice(index, 1);
    state.split.source = state.split.sources[0] || null;
    render();
    return;
  }
  if (action === "toggle-remake-image") {
    const button = event.target.closest("[data-action='toggle-remake-image']");
    const index = Number(button?.dataset.keyframeIndex);
    const selected = new Set(state.remake.selectedRetryIndexes || []);
    if (selected.has(index)) selected.delete(index); else selected.add(index);
    state.remake.selectedRetryIndexes = [...selected].sort((a, b) => a - b);
    const isSelected = selected.has(index);
    button?.closest("article")?.classList.toggle("is-selected", isSelected);
    if (button) {
      button.setAttribute("aria-pressed", String(isSelected));
      button.innerHTML = `<i aria-hidden="true">${isSelected ? "✓" : ""}</i>${isSelected ? "已选择" : "选择重做"}`;
    }
    const retryButton = workspace.querySelector('[data-action="retry-selected-remake-images"]');
    if (retryButton) {
      retryButton.disabled = selected.size === 0;
      retryButton.textContent = `重新生成所选${selected.size ? `（${selected.size}）` : ""}`;
    }
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
  if (event.target.closest("[data-library-export]")) return;
  const card = event.target.closest(".previewable[data-preview-url]");
  if (!card) return;
  event.preventDefault();
  event.stopPropagation();
  card.querySelector("video, audio")?.pause();
  openMediaViewer(card);
}, true);
document.addEventListener("keydown", (event) => {
  const stopDialog = workspace.querySelector(".remake-stop-overlay");
  if (stopDialog) {
    if (event.key === "Escape") { event.preventDefault(); dismissRemakeStop(); return; }
    if (event.key === "Tab") {
      const buttons = [...stopDialog.querySelectorAll("button:not(:disabled)")];
      if (!buttons.length) { event.preventDefault(); return; }
      const first = buttons[0], last = buttons.at(-1);
      if (event.shiftKey && (document.activeElement === first || !stopDialog.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !stopDialog.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    }
  }
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
document.addEventListener("keydown", (event) => {
  if (event.target.matches(".voice-audio-upload") && (event.key === "Enter" || event.key === " ")) {
    event.preventDefault();
    document.querySelector("#voiceSourceInput")?.click();
  }
});
document.addEventListener("input", (event) => {
  if (event.target.id === "remakeProductSubject") {
    if (!state.remake.running && !state.remake.runId) state.remake.productSubject = event.target.value.slice(0, 200);
    return;
  }
  if (event.target.id === "voiceNameInput") { state.remake.voiceDraftName = event.target.value; return; }
  if (event.target.id === "folderTaskSearch" && state.split.batch?.folderMode) {
    state.split.batch.folderQuery = event.target.value;
    const query = event.target.value.trim().toLowerCase();
    document.querySelectorAll(".folder-rail-list [data-folder-task]").forEach((button) => {
      button.hidden = Boolean(query) && !button.textContent.toLowerCase().includes(query);
    });
    return;
  }
  if (event.target.id === "remakeVoiceScript") {
    state.remake.voiceScript = event.target.value;
    const voiceLimit = state.remake.duration * 6;
    const voiceWithinLimit = event.target.value.length <= voiceLimit;
    event.target.closest(".voice-script")?.classList.toggle("is-over-limit", !voiceWithinLimit);
    const count = document.querySelector(".voice-script label b");
    if (count) count.textContent = event.target.value.length;
    const button = document.querySelector('[data-action="remake-generate"]');
    const selectedVoice = state.remake.voices.find((voice) => voice.id === state.remake.selectedVoiceId);
    if (button) button.disabled = state.remake.config?.configured !== true || state.remake.running || !state.remake.products.length || !state.remake.reference || !event.target.value.trim() || !voiceWithinLimit || !selectedVoice || selectedVoice.demo === true;
    const confirmButton = document.querySelector('[data-action="confirm-remake-image"]');
    if (confirmButton) confirmButton.disabled = state.remake.voiceEnabled && (!event.target.value.trim() || !voiceWithinLimit || !selectedVoice || selectedVoice.demo === true);
    return;
  }
  if (event.target.id === "audioScript") state.audio.script = event.target.value;
  if (event.target.id === "composeScript") state.compose.script = event.target.value;
  const button = document.querySelector(`[data-action="${event.target.id === "audioScript" ? "audio" : "compose"}-generate"]`);
  if (button) button.disabled = !event.target.value.trim();
  const counter = event.target.nextElementSibling;
  if (counter?.classList.contains("counter")) counter.textContent = `${event.target.value.length} / 1000`;
});
document.addEventListener("change", async (event) => {
  const files = [...(event.target.files || [])];
  if (!files.length) return;
  if (event.target.id === "voiceSourceInput") {
    const source = { file: files[0], name: files[0].name, checking: true, duration: null };
    state.remake.voiceSource = source;
    state.remake.voiceCreateError = "";
    replaceVoiceOverlay("create");
    try {
      const info = await videoClient.inspectReferenceAudio(files[0]);
      if (state.remake.voiceSource !== source) return;
      if (!info.hasAudio || !Number.isFinite(Number(info.duration))) throw new Error("无法读取这段音频，请选择 MP3、WAV 或 M4A 文件");
      source.duration = Number(info.duration);
      if (source.duration < 8 || source.duration > 15) state.remake.voiceCreateError = "参考音频时长需在 8–15 秒之间";
    } catch (error) {
      if (state.remake.voiceSource !== source) return;
      state.remake.voiceCreateError = friendlyVoiceCreateError(error);
    } finally {
      source.checking = false;
      if (state.remake.voiceSource === source && state.remake.voicePanel === "create") replaceVoiceOverlay("create");
    }
    return;
  }
  if (event.target.id === "productInput" || event.target.id === "referenceInput") {
    if (state.remake.running || state.remake.stopping) { event.target.value = ""; return; }
    if (event.target.id === "productInput") {
      const limit = state.remake.videoMode === "reference_video" ? 1 : 3;
      if (files.length > limit) { event.target.value = ""; notify(`最多上传 ${limit} 张商品参考图，请重新选择`); return; }
      state.remake.products = files.map(file => addFile(file, "image", "产品替换"));
    }
    else {
      const reference = addFile(files[0], "video", "产品替换");
      state.remake.reference = reference;
      state.remake.voiceDetected = { checking: true, hasAudio: false, detail: "正在检测参考视频声音" };
      Object.assign(state.remake, { runId: null, editedImage: null, editedKeyframes: [], keyframeTimes: [], imageReady: false, result: null, error: null, progress: 0, stage: "" });
      render();
      try {
        const info = await videoClient.inspectReferenceAudio(files[0]);
        if (state.remake.reference !== reference) return;
        state.remake.voiceDetected = { checking: false, hasAudio: info.hasAudio === true, duration: info.duration, detail: info.hasAudio ? `检测到可用音轨${info.duration ? ` · ${Number(info.duration).toFixed(1)} 秒` : ""}` : "未检测到音轨" };
      } catch (error) {
        if (state.remake.reference !== reference) return;
        state.remake.voiceDetected = { checking: false, hasAudio: false, detail: error.message };
      }
      render();
      return;
    }
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
document.querySelector("#exportDiagnostics")?.addEventListener("click", async (event) => {
  const button = event.currentTarget;
  if (button.disabled) return;
  button.disabled = true;
  button.textContent = "正在导出…";
  try {
    const result = await videoClient.exportDiagnostics();
    if (!result.canceled) notify(result.warningCount ? "诊断日志已导出，部分旧记录无法读取；请将压缩包发给维护者" : "诊断日志已导出，请将压缩包发给维护者");
  } catch (error) {
    notify("诊断日志导出失败，请换一个可写入的位置再试");
    try { videoClient.reportDiagnostic?.({ module: "diagnostics", message: cleanRemoteError(error), stack: error?.stack }); } catch {}
  } finally {
    button.disabled = false;
    button.textContent = "导出诊断日志";
  }
});
window.addEventListener("error", (event) => {
  try { videoClient.reportDiagnostic?.({ module: state.active, message: event.message, stack: event.error?.stack }); } catch {}
});
window.addEventListener("unhandledrejection", (event) => {
  try { videoClient.reportDiagnostic?.({ module: state.active, message: cleanRemoteError(event.reason), stack: event.reason?.stack }); } catch {}
});
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
      state.library.push({ name: asset.name, url, kind: "video", origin: asset.sourceFilename ? `素材分割 · ${asset.sourceFilename}` : "素材分割", remoteKey, runId: asset.runId, sourceId: asset.sourceId, sourceFolderId: asset.sourceFolderId, sourceFolderName: asset.sourceFolderName, sourceFilename: asset.sourceFilename, workflow: asset.workflow, usageType: asset.usageType, contentTitle: asset.contentTitle, startSec: asset.startSec, endSec: asset.endSec, completedAt: asset.completedAt });
    }
    sortLibraryNewestFirst();
    if (state.active === "library") render();
    return true;
  } catch (error) {
    if (state.active === "library") notify(`素材库读取失败：${error.message}`);
    return false;
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
    if (!["queued", "processing", "partial", "failed", "paused"].includes(status) || response.batch?.active) return;
    state.split.runId = latest.runId;
    state.split.serviceBaseUrl = response.baseUrl || "";
    state.split.mode = response.batch?.workflow === "ffmpeg_gemini_naming" ? "ffmpeg_gemini_naming" : "ffmpeg_only";
    state.split.keepAudio = response.batch?.keepAudio !== false;
    state.split.removeSubtitles = response.batch?.removeSubtitles === true;
    state.split.subtitleOptions = response.batch?.subtitleOptions || defaultSubtitleOptions();
    state.split.batch = batchFromResponse(response);
    addBatchResultsToLibrary(state.split.batch);
    if (state.active === "split") render();
    notify("发现未完成的批量任务，可以继续处理");
  } catch {}
}
async function loadLatestInterruptedRemake() {
  const item = state.remake;
  if (latestRemakeChecked || item.runId || item.reference || item.products.length || item.result) return;
  latestRemakeChecked = true;
  try {
    const response = await videoClient.getLatestRecoverableKlingRun();
    if (!isCurrentRemake(item) || item.runId || item.reference || item.products.length || item.result) return;
    const run = response.run;
    if (!run || run.userStopped) return;
    item.productSubject = run.productSubject || "";
    item.useSavedVoice = Boolean(run.voiceAudio);
    item.restoredVoiceName = run.voiceName || null;
    item.selectedVoiceId = run.voiceId || item.voices.find(voice => voice.name === run.voiceName)?.id || null;
    if (run.stage === "image" && run.imageProvider === "wawapi") {
      Object.assign(item, {
        runId: run.id, serviceBaseUrl: response.baseUrl || "", videoMode: run.videoMode,
        duration: Number(run.duration) || 5, voiceScript: run.voiceScript || "",
        voiceEnabled: run.audioMode !== "silent", keyframeTimes: run.keyframeTimes || [],
        editedKeyframes: run.editedKeyframes || [], imageReady: false,
        imageCompleted: (run.imageTasks || []).filter(t => t.status === "SUCCEEDED").length,
        imageTotal: run.keyframes?.length || 4,
        error: { stage: "image", rawStage: "image", technicalMessage: run.message || "", message: "发现未完成的关键帧任务，请重试继续" }
      });
      if (state.active === "remake") render();
      notify("已找回关键帧任务，点击重试可继续，不会重做已完成图片");
      return;
    }
    const editedKeyframes = Array.isArray(run.editedKeyframes) ? run.editedKeyframes.filter(Boolean) : [];
    if (!editedKeyframes.length) return;
    Object.assign(item, {
      runId: run.id,
      videoTaskSubmitted: Boolean(run.videoTaskId),
      serviceBaseUrl: response.baseUrl || "",
      duration: Number(run.duration) || 5,
      videoMode: run.videoMode === "reference_video" ? "reference_video" : "multi_keyframes",
      voiceScript: String(run.voiceScript || ""),
      voiceEnabled: run.audioMode !== "silent",
      audio: run.audioMode === "silent" ? "silent" : "voice",
      editedKeyframes,
      keyframeTimes: Array.isArray(run.keyframeTimes) ? run.keyframeTimes : [],
      selectedRetryIndexes: [],
      imageReady: false,
      videoRetryConfirm: false,
      stage: "根据确认关键帧生成视频",
      error: run.videoTaskId
        ? { stage: "video", rawStage: "video", message: friendlyRemakeError(run.message, "video"), technicalMessage: run.message || "", confirmedFailed: String(run.status || "").toUpperCase() === "FAILED" }
        : { stage: "video", rawStage: "video", message: friendlyRemakeError(run.message, "video"), technicalMessage: run.message || "", videoRetryAvailable: true, submissionUncertain: ["submitting", "uncertain"].includes(run.videoSubmission?.status), preservedKeyframeCount: editedKeyframes.length }
    });
    if (state.active === "remake") render();
    notify(`已找回 ${editedKeyframes.length} 张替换关键帧，无需重新生成`);
  } catch {}
}
async function loadKlingConfig() {
  try {
    state.remake.config = await videoClient.getKlingConfig();
    state.remake.configError = null;
    if (state.active === "remake") render();
  } catch (error) {
    state.remake.configError = "服务配置读取失败，请稍后重新进入商品替换";
    notify(state.remake.configError);
    if (state.active === "remake") render();
  }
}
async function loadVoices() {
  try {
    state.remake.voices = await videoClient.listVoices();
    if (state.remake.selectedVoiceId && !state.remake.voices.some((voice) => voice.id === state.remake.selectedVoiceId)) state.remake.selectedVoiceId = null;
    if (!state.remake.selectedVoiceId && state.remake.useSavedVoice) state.remake.selectedVoiceId = state.remake.voices.find(voice => voice.name === state.remake.restoredVoiceName)?.id || null;
    if (!state.remake.selectedVoiceId && !state.remake.useSavedVoice && state.remake.voices.length) state.remake.selectedVoiceId = state.remake.voices[0].id;
    if (state.active === "remake") render();
  } catch {}
}
async function loadKlingAssets() {
  if (klingAssetsLoading) return;
  klingAssetsLoading = true;
  const revision = klingAssetsRevision;
  try {
    const response = await videoClient.listKlingAssets();
    // An earlier list response must not replace a video that just completed.
    if (revision !== klingAssetsRevision) return;
    replaceKlingLibraryAssets(response);
    sortLibraryNewestFirst();
    if (state.active === "library") render();
    return true;
  } catch { return false; } finally { klingAssetsLoading = false; }
}
function replaceKlingLibraryAssets(response) {
  const assets = (response.assets || []).map(asset => ({ name: asset.name, url: new URL(asset.relativeUrl, response.baseUrl).toString(), kind: asset.kind === "image" ? "image" : "video", origin: "产品替换", remoteKey: `${asset.runId}:${asset.relativeUrl}`, runId: asset.runId, sourceId: asset.sourceId, sourceFolderName: asset.sourceFolderName, sourceFilename: asset.sourceFilename, workflow: "remake", voiceName: asset.voiceName, completedAt: asset.completedAt }));
  state.library = state.library.filter(item => !(item.remoteKey && (item.workflow === "remake" || item.origin === "产品替换")));
  state.library.push(...assets);
}
function refreshServiceAssets(service, loadAssets) {
  const identity = `${service.pid ?? ""}:${service.port ?? ""}`;
  if (assetServiceInstances.get(service.key) === identity) return;
  void loadAssets().then((loaded) => {
    const current = latestServices.find((item) => item.key === service.key);
    if (current?.status !== "ready") return;
    const currentIdentity = `${current.pid ?? ""}:${current.port ?? ""}`;
    if (currentIdentity === identity) {
      if (loaded) assetServiceInstances.set(service.key, identity);
    } else if (loaded !== undefined) {
      // A restart during an in-flight scan still needs one scan of the new service.
      refreshServiceAssets(current, loadAssets);
    }
  });
}
function showServices(services) {
  latestServices = services;
  const ready = services.filter((service) => service.status === "ready").length;
  serviceStatus.textContent = ready === 2 ? "两个本地服务已就绪" : `${ready}/${services.length || 2} 个服务就绪`;
  serviceStatus.className = ready === 2 ? "ready" : services.some((service) => service.status === "error") ? "error" : "";
  for (const key of assetServiceInstances.keys()) {
    if (!services.some((service) => service.key === key && service.status === "ready")) assetServiceInstances.delete(key);
  }
  for (const service of services) {
    if (service.status !== "ready") continue;
    if (service.key === "shot") {
      if (!state.split.config) void loadShotConfig();
      refreshServiceAssets(service, loadShotAssets);
      void loadLatestInterruptedBatch();
    } else if (service.key === "kling") {
      if (!state.remake.config) void loadKlingConfig();
      refreshServiceAssets(service, loadKlingAssets);
      void loadLatestInterruptedRemake();
      if (!state.remake.voices.length) void loadVoices();
    }
  }
}
if (uiPreviewMode === "folder-processing" || uiPreviewMode === "combined" || uiPreviewMode === "batch-split") {
  state.active = "split";
  state.split.batch = {
    id: "folder_batch_preview",
    folderMode: true,
    status: "processing",
    active: true,
    preview: true,
    mode: "ffmpeg_gemini_naming",
    keepAudio: true,
    selectedFolderId: "folder_shampoo_b",
    folders: [
      {
        id: "folder_shampoo_a", name: "洗发水A", status: "completed", bytes: 286 * 1024 * 1024,
        videos: [
          { id: "a_01", name: "室内产品展示01.mp4", status: "completed", clipCount: 8, detail: "32 秒" },
          { id: "a_02", name: "人物手持展示02.mp4", status: "completed", clipCount: 6, detail: "27 秒" },
          { id: "a_03", name: "产品细节特写03.mp4", status: "completed", clipCount: 7, detail: "30 秒" },
          { id: "a_04", name: "使用效果展示04.mp4", status: "completed", clipCount: 9, detail: "41 秒" }
        ]
      },
      {
        id: "folder_shampoo_b", name: "洗发水B", status: "processing", bytes: 314 * 1024 * 1024,
        videos: [
          { id: "b_01", name: "自然光商品展示01.mp4", status: "completed", clipCount: 7, detail: "29 秒" },
          { id: "b_02", name: "浴室场景产品口播02.mp4", status: "failed", detail: "命名服务响应超时" },
          { id: "b_03", name: "洗发过程演示03.mp4", status: "processing", stage: "naming_processing", detail: "正在分析第 5 / 9 个片段" },
          { id: "b_04", name: "使用后效果展示04.mp4", status: "queued" }
        ]
      },
      {
        id: "folder_conditioner_c", name: "护发素C", status: "queued", bytes: 391 * 1024 * 1024,
        videos: [
          { id: "c_01", name: "产品包装展示01.mp4", status: "queued" },
          { id: "c_02", name: "人物口播介绍02.mp4", status: "queued" },
          { id: "c_03", name: "涂抹使用演示03.mp4", status: "queued" },
          { id: "c_04", name: "发丝细节展示04.mp4", status: "queued" },
          { id: "c_05", name: "效果对比展示05.mp4", status: "queued" }
        ]
      },
      ...["发膜D", "护发精油E", "蓬松喷雾F", "头皮护理G", "修护套装H", "洗护旅行装I", "儿童洗发水J", "控油洗发水K", "染后修护L"].map((name, folderIndex) => ({
        id: `folder_waiting_${folderIndex + 4}`,
        name,
        status: "queued",
        bytes: (180 + folderIndex * 17) * 1024 * 1024,
        videos: Array.from({ length: 3 + folderIndex % 4 }, (_, videoIndex) => ({
          id: `waiting_${folderIndex + 4}_${videoIndex + 1}`,
          name: `${name}素材${String(videoIndex + 1).padStart(2, "0")}.mp4`,
          status: "queued"
        }))
      }))
    ]
  };
  serviceStatus.textContent = "文件夹处理预览 · 未启动真实服务";
  serviceStatus.className = "";
  render();
} else if (uiPreviewMode === "voice-result") {
  state.active = "remake";
  Object.assign(state.remake, {
    duration: 5,
    voiceScript: "麻辣鲜香，肉质Q弹，现捞现做。",
    voices: [{ id: "preview-voice", name: "螺蛳视频人物", duration: 12.7, sampleUrl: null }],
    selectedVoiceId: "preview-voice",
    result: { name: "商品替换成片_克隆配音.mp4", url: "../../../video-mix-standalone/assets/video-remake/spring-water-result-5s.mp4", runId: "preview-run", sourceId: "preview-run", duration: 5, voiceName: "螺蛳视频人物", completedAt: new Date().toISOString() },
    config: { configured: true, klingConfigured: true, referenceVideoConfigured: true }
  });
  serviceStatus.textContent = "结果界面预览 · 未启动真实服务";
  serviceStatus.className = "";
  render();
} else if (uiPreviewMode === "processing") {
  state.active = "remake";
  Object.assign(state.remake, {
    running: true,
    progress: 78,
    routeIndex: 2,
    stage: "根据关键帧生成替换视频",
    videoMode: "multi_keyframes",
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
