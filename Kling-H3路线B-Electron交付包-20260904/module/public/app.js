const el = Object.fromEntries([...document.querySelectorAll("[id]")].map((node) => [node.id, node]));
let config;
let currentRun;
let sourceDuration = 0;
let sourceUrl;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function formatBytes(bytes) {
  return bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function normalized(value) {
  const status = String(value || "").toUpperCase();
  if (["SUCCEEDED", "SUCCEED", "SUCCESS", "COMPLETED"].includes(status)) return "succeeded";
  if (["FAILED", "ERROR", "CANCELLED"].includes(status)) return "failed";
  return ["RUNNING", "PROCESSING"].includes(status) ? "processing" : "submitted";
}

function updateControls() {
  const ready = config?.configured && el.videoInput.files[0] && el.productInput.files[0] && el.imagePrompt.value.trim();
  el.startImageButton.disabled = !ready;
  const videoState = normalized(currentRun?.videoStatus);
  const videoBusy = currentRun?.videoTaskId && ["submitted", "processing"].includes(videoState);
  el.startVideoButton.disabled = !currentRun?.editedImage?.url || normalized(currentRun?.imageStatus) !== "succeeded" || videoBusy;
  el.startVideoButton.textContent = currentRun?.videoTaskId && ["succeeded", "failed"].includes(videoState)
    ? "复用首帧重新生成视频"
    : videoBusy ? "视频生成中" : "确认首帧并生成视频";
  el.imagePromptCount.textContent = el.imagePrompt.value.length;
  el.videoPromptCount.textContent = el.videoPrompt.value.length;
  const baseRate = el.resolution.value === "480P" ? 0.3 : 0.5;
  el.cost.textContent = `¥${(Number(el.duration.value || 5) * baseRate * 0.35).toFixed(2)}`;
}

function showImage(node, empty, media) {
  if (!media?.url) {
    node.removeAttribute("src");
    delete node.dataset.ready;
    empty.hidden = false;
    return;
  }
  node.src = media.url;
  node.dataset.ready = "true";
  empty.hidden = true;
}

function formatElapsed(ms) {
  if (!Number.isFinite(ms)) return "--";
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)} 秒`;
  return `${Math.floor(seconds / 60)} 分 ${Math.round(seconds % 60)} 秒`;
}

function formatActualUsage(billing) {
  const parts = [];
  for (const item of [billing?.kling, billing?.h3]) {
    if (!item) continue;
    const label = item.provider === "kling" ? "Kling" : "H3";
    if (Number.isFinite(item.amount)) parts.push(`${label} ${item.currency || ""}${item.amount}`.trim());
    if (Number.isFinite(item.credits)) parts.push(`${label} ${item.credits} credits`);
    if (Number.isFinite(item.tokens)) parts.push(`${label} ${item.tokens} tokens`);
  }
  return parts.join(" / ") || "接口暂未返回实扣数据";
}

function renderRun(run) {
  currentRun = run;
  el.runId.textContent = run.id;
  el.imageStatus.textContent = run.stage === "image" ? run.message : "替换首帧已完成";
  el.videoStatus.textContent = run.stage === "video" ? run.message : "确认替换首帧后可提交";
  showImage(el.firstFramePreview, el.firstFrameEmpty, run.firstFrame);
  showImage(el.editedImagePreview, el.editedImageEmpty, run.editedImage);
  if (run.output?.url) {
    el.resultVideo.src = run.output.url;
    el.resultVideo.dataset.ready = "true";
    el.resultEmpty.hidden = true;
    el.downloadLink.href = run.output.url;
    el.downloadLink.hidden = false;
  } else {
    el.resultVideo.removeAttribute("src");
    delete el.resultVideo.dataset.ready;
    el.resultEmpty.hidden = false;
    el.downloadLink.hidden = true;
  }
  el.runJson.textContent = JSON.stringify(run, null, 2);
  el.totalElapsed.textContent = formatElapsed(run.timing?.totalElapsedMs);
  el.imageElapsed.textContent = formatElapsed(run.timing?.imageElapsedMs);
  el.videoElapsed.textContent = formatElapsed(run.timing?.videoElapsedMs);
  el.actualUsage.textContent = formatActualUsage(run.billing);
  updateControls();
}

async function api(path, options) {
  const response = await fetch(path, options);
  const payload = await response.json();
  if (!response.ok) throw Object.assign(new Error(payload.error || "请求失败"), { details: payload });
  return payload;
}

async function upload(file, kind, category, runId) {
  const query = new URLSearchParams({ kind, category, runId, name: file.name });
  return api(`/api/media?${query}`, { method: "POST", headers: { "Content-Type": file.type || "application/octet-stream" }, body: file });
}

async function extractFirstFrame(file) {
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  const url = URL.createObjectURL(file);
  try {
    video.src = url;
    await new Promise((resolve, reject) => { video.onloadeddata = resolve; video.onerror = () => reject(new Error("无法读取原视频")); });
    await new Promise((resolve) => {
      video.onseeked = resolve;
      video.currentTime = Math.min(0.05, Math.max(0, video.duration - 0.01));
      if (video.currentTime === 0) resolve();
    });
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d").drawImage(video, 0, 0);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("首帧提取失败");
    return new File([blob], "first-frame.png", { type: "image/png" });
  } finally { URL.revokeObjectURL(url); }
}

async function poll(runId, stage) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    await sleep(3000);
    const run = await api(`/api/runs/${runId}`);
    renderRun(run);
    if (["succeeded", "failed"].includes(normalized(run.status))) return run;
  }
  throw new Error(`${stage}轮询超过 15 分钟，可从历史 Run 继续查询`);
}

async function startImageStage() {
  const videoFile = el.videoInput.files[0];
  const productFile = el.productInput.files[0];
  if (!videoFile || !productFile) return;
  el.startImageButton.disabled = true;
  el.imageStatus.textContent = "正在创建 Run 文件夹并上传素材";
  try {
    const { runId } = await api("/api/run-id", { method: "POST" });
    const firstFrameFile = await extractFirstFrame(videoFile);
    const [sourceVideo, productImage, firstFrame] = await Promise.all([
      upload(videoFile, "video", "inputs/source-video", runId),
      upload(productFile, "image", "inputs/product-image", runId),
      upload(firstFrameFile, "image", "first-frame", runId)
    ]);
    const run = await api("/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runId, sourceVideoId: sourceVideo.id, productImageId: productImage.id, firstFrameId: firstFrame.id, imagePrompt: el.imagePrompt.value.trim(), videoPrompt: el.videoPrompt.value.trim(), resolution: el.resolution.value, duration: Number(el.duration.value) })
    });
    renderRun(run);
    await poll(run.id, "图片阶段");
    await loadHistory();
  } catch (error) {
    el.imageStatus.textContent = `失败：${error.message}`;
  } finally { updateControls(); }
}

async function startVideoStage() {
  if (!currentRun) return;
  const confirmResubmit = Boolean(currentRun.videoTaskId);
  if (confirmResubmit && !window.confirm("这会重新提交视频生成任务并可能再次计费，是否继续？")) return;
  el.startVideoButton.disabled = true;
  el.videoStatus.textContent = "正在提交 MiniMax-H3-open";
  try {
    const run = await api(`/api/runs/${currentRun.id}/video`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ videoPrompt: el.videoPrompt.value.trim(), resolution: el.resolution.value, duration: Number(el.duration.value), confirmResubmit })
    });
    renderRun(run);
    await poll(run.id, "视频阶段");
    await loadHistory();
  } catch (error) {
    el.videoStatus.textContent = `失败：${error.message}`;
  } finally { updateControls(); }
}

async function loadHistory() {
  const payload = await api("/api/runs");
  el.history.replaceChildren(...payload.runs.slice(0, 20).map((run) => {
    const button = document.createElement("button");
    button.type = "button";
    const label = run.derivedFromRunId ? "H3 重试" : run.stage === "video" ? "H3 视频" : "O1 图片";
    button.innerHTML = `<span>${new Date(run.createdAt).toLocaleString()}</span><strong>${label} · ${run.status}</strong><code>${run.id}</code>`;
    button.addEventListener("click", async () => renderRun(await api(`/api/runs/${run.id}`)));
    return button;
  }));
}

el.videoInput.addEventListener("change", () => {
  const file = el.videoInput.files[0];
  el.videoZone.dataset.ready = file ? "true" : "false";
  el.videoMeta.textContent = file ? `${file.name} / ${formatBytes(file.size)}` : "MP4 / MOV";
  if (sourceUrl) URL.revokeObjectURL(sourceUrl);
  if (file) {
    sourceUrl = URL.createObjectURL(file);
    const probe = document.createElement("video");
    probe.src = sourceUrl;
    probe.onloadedmetadata = () => { sourceDuration = probe.duration; el.videoMeta.textContent += ` / ${sourceDuration.toFixed(2)} 秒`; };
  }
  updateControls();
});

el.productInput.addEventListener("change", () => {
  const file = el.productInput.files[0];
  el.productZone.dataset.ready = file ? "true" : "false";
  el.productMeta.textContent = file ? `${file.name} / ${formatBytes(file.size)}` : "一张主体清晰的商品参考图";
  updateControls();
});

el.imagePrompt.addEventListener("input", updateControls);
el.videoPrompt.addEventListener("input", updateControls);
el.resolution.addEventListener("change", updateControls);
el.duration.addEventListener("change", updateControls);
el.startImageButton.addEventListener("click", startImageStage);
el.startVideoButton.addEventListener("click", startVideoStage);

try {
  for (let value = 4; value <= 15; value += 1) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = `${value} 秒`;
    el.duration.append(option);
  }
  el.duration.value = "5";
  config = await api("/api/config");
  el.connection.dataset.state = config.configured ? "ready" : "error";
  el.connection.lastElementChild.textContent = config.mock ? "Mock 模式" : config.configured ? "API 已配置" : "等待两个 API Key";
  updateControls();
  await loadHistory();
} catch (error) {
  el.connection.dataset.state = "error";
  el.connection.lastElementChild.textContent = "服务不可用";
}
