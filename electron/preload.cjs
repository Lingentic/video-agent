const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("videoClient", {
  getServices: () => ipcRenderer.invoke("get-services"),
  startServices: () => ipcRenderer.invoke("start-services"),
  openWorkspace: (key) => ipcRenderer.invoke("open-workspace", key),
  goHome: () => ipcRenderer.invoke("go-home"),
  openLogs: () => ipcRenderer.invoke("open-logs"),
  getKlingConfig: () => ipcRenderer.invoke("kling-get-config"),
  listKlingAssets: () => ipcRenderer.invoke("kling-list-assets"),
  createKlingRun: (videoFile, productFile, voiceScript, audioMode, videoMode, duration, voiceId) => ipcRenderer.invoke("kling-create-run", {
    videoPath: webUtils.getPathForFile(videoFile),
    productPath: webUtils.getPathForFile(productFile),
    voiceScript,
    audioMode,
    videoMode,
    duration,
    voiceId
  }),
  getKlingRun: (runId) => ipcRenderer.invoke("kling-get-run", runId),
  startKlingVideo: (runId, voiceScript, videoMode, duration, keyframeTimes, confirmResubmit = false, voiceEnabled = true) => ipcRenderer.invoke("kling-start-video", runId, voiceScript, videoMode, duration, keyframeTimes, confirmResubmit, voiceEnabled),
  inspectReferenceAudio: (videoFile) => ipcRenderer.invoke("kling-inspect-reference-audio", webUtils.getPathForFile(videoFile)),
  resumeKlingRun: (runId) => ipcRenderer.invoke("kling-resume-run", runId),
  retryKlingImage: (runId, indexes) => ipcRenderer.invoke("kling-retry-image", runId, indexes),
  listVoices: () => ipcRenderer.invoke("voice-list"),
  createVoice: (sourceFile, name) => ipcRenderer.invoke("voice-create", { sourcePath: webUtils.getPathForFile(sourceFile), name }),
  deleteVoice: (voiceId) => ipcRenderer.invoke("voice-delete", voiceId),
  revoiceVideo: (videoUrl, runId, voiceId, text) => ipcRenderer.invoke("voice-revoice-video", { videoUrl, runId, voiceId, text }),
  getShotConfig: () => ipcRenderer.invoke("shot-get-config"),
  listShotAssets: () => ipcRenderer.invoke("shot-list-assets"),
  createShotRun: (file, workflow, keepAudio) => ipcRenderer.invoke("shot-create-run", {
    filePath: webUtils.getPathForFile(file),
    workflow,
    keepAudio
  }),
  createShotBatch: (files, workflow, keepAudio) => ipcRenderer.invoke("shot-create-batch", {
    filePaths: files.map((file) => webUtils.getPathForFile(file)),
    workflow,
    keepAudio
  }),
  getShotRun: (runId) => ipcRenderer.invoke("shot-get-run", runId),
  resumeShotNaming: (runId) => ipcRenderer.invoke("shot-resume-naming", runId),
  getLatestShotRun: () => ipcRenderer.invoke("shot-get-latest"),
  getShotBatch: (batchId) => ipcRenderer.invoke("shot-get-batch", batchId),
  resumeShotBatch: (batchId) => ipcRenderer.invoke("shot-resume-batch", batchId),
  retryShotBatchItem: (batchId, videoId) => ipcRenderer.invoke("shot-retry-batch-item", batchId, videoId),
  onServicesUpdated: (callback) => {
    const listener = (_event, services) => callback(services);
    ipcRenderer.on("services-updated", listener);
    return () => ipcRenderer.removeListener("services-updated", listener);
  }
});
