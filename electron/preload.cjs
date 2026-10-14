const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("videoClient", {
  getServices: () => ipcRenderer.invoke("get-services"),
  startServices: () => ipcRenderer.invoke("start-services"),
  openWorkspace: (key) => ipcRenderer.invoke("open-workspace", key),
  goHome: () => ipcRenderer.invoke("go-home"),
  openLogs: () => ipcRenderer.invoke("open-logs"),
  exportDiagnostics: () => ipcRenderer.invoke("export-diagnostics"),
  reportDiagnostic: (details) => ipcRenderer.send("diagnostics-event", details),
  getKlingConfig: () => ipcRenderer.invoke("kling-get-config"),
  listKlingAssets: () => ipcRenderer.invoke("kling-list-assets"),
  getLatestRecoverableKlingRun: () => ipcRenderer.invoke("kling-get-latest-recoverable"),
  createKlingRun: (videoFile, productFile, voiceScript, audioMode, videoMode, duration, voiceId, productSubject) => ipcRenderer.invoke("kling-create-run", {
    videoPath: webUtils.getPathForFile(videoFile),
    productPaths: (Array.isArray(productFile) ? productFile : [productFile]).map(file => webUtils.getPathForFile(file)),
    voiceScript,
    audioMode,
    videoMode,
    duration,
    voiceId,
    productSubject
  }),
  getKlingRun: (runId) => ipcRenderer.invoke("kling-get-run", runId),
  startKlingVideo: (runId, voiceScript, videoMode, duration, keyframeTimes, confirmResubmit = false, voiceEnabled = true, voiceId = null) => ipcRenderer.invoke("kling-start-video", runId, voiceScript, videoMode, duration, keyframeTimes, confirmResubmit, voiceEnabled, voiceId),
  inspectReferenceAudio: (videoFile) => ipcRenderer.invoke("kling-inspect-reference-audio", webUtils.getPathForFile(videoFile)),
  resumeKlingRun: (runId) => ipcRenderer.invoke("kling-resume-run", runId),
  stopKlingRun: (runId, stage) => ipcRenderer.invoke("kling-stop-run", runId, stage),
  retryKlingImage: (runId, indexes, continueOnly = false) => ipcRenderer.invoke("kling-retry-image", runId, indexes, continueOnly),
  listVoices: () => ipcRenderer.invoke("voice-list"),
  createVoice: (sourceFile, name) => ipcRenderer.invoke("voice-create", { sourcePath: webUtils.getPathForFile(sourceFile), name }),
  deleteVoice: (voiceId) => ipcRenderer.invoke("voice-delete", voiceId),
  revoiceVideo: (videoUrl, runId, voiceId, text) => ipcRenderer.invoke("voice-revoice-video", { videoUrl, runId, voiceId, text }),
  getShotConfig: () => ipcRenderer.invoke("shot-get-config"),
  listShotAssets: () => ipcRenderer.invoke("shot-list-assets"),
  exportLibraryTask: (task) => ipcRenderer.invoke("library-export-task", task),
  pickShotFolders: () => ipcRenderer.invoke("shot-pick-folders"),
  createShotRun: (file, workflow, keepAudio, removeSubtitles = false, subtitleOptions = {}) => ipcRenderer.invoke("shot-create-run", {
    filePath: webUtils.getPathForFile(file),
    workflow,
    keepAudio,
    removeSubtitles,
    subtitleOptions
  }),
  createShotBatch: (sources, workflow, keepAudio, removeSubtitles = false, subtitleOptions = {}) => ipcRenderer.invoke("shot-create-batch", {
    entries: sources.map((source) => ({ path: source?.path || webUtils.getPathForFile(source?.file || source), folderId: source?.folderId, folderName: source?.folderName, relativePath: source?.relativePath })),
    workflow,
    keepAudio,
    removeSubtitles,
    subtitleOptions
  }),
  getShotRun: (runId) => ipcRenderer.invoke("shot-get-run", runId),
  resumeShotNaming: (runId) => ipcRenderer.invoke("shot-resume-naming", runId),
  getLatestShotRun: () => ipcRenderer.invoke("shot-get-latest"),
  getShotBatch: (batchId) => ipcRenderer.invoke("shot-get-batch", batchId),
  cancelShotBatch: (batchId) => ipcRenderer.invoke("shot-cancel-batch", batchId),
  resumeShotBatch: (batchId) => ipcRenderer.invoke("shot-resume-batch", batchId),
  retryShotBatchItem: (batchId, videoId) => ipcRenderer.invoke("shot-retry-batch-item", batchId, videoId),
  onServicesUpdated: (callback) => {
    const listener = (_event, services) => callback(services);
    ipcRenderer.on("services-updated", listener);
    return () => ipcRenderer.removeListener("services-updated", listener);
  }
});
