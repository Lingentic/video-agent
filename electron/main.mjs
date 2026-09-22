import { app, BrowserWindow, Menu, dialog, ipcMain, shell } from "electron";
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, openAsBlob } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const productName = "章域·视频混剪智能体";
app.setName(productName);

if (app.isPackaged) {
  const packagedUserData = path.join(app.getPath("appData"), "zhangyu-ai-video-client");
  mkdirSync(packagedUserData, { recursive: true });
  app.setPath("userData", packagedUserData);
}

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(rootDir, "..");
const resourceRoot = app.isPackaged ? process.resourcesPath : projectRoot;
const clientDataRoot = path.resolve(process.env.CLIENT_DATA_DIR || (app.isPackaged ? path.join(app.getPath("videos"), productName) : path.join(projectRoot, "client-data")));
const shotRunsDir = path.join(clientDataRoot, "video-shot", "runs-v1");
const klingRunsDir = path.join(clientDataRoot, "kling-h3", "runs");
const voiceDataRoot = path.join(clientDataRoot, "voices");
const voiceRegistryPath = path.join(voiceDataRoot, "voices.json");
const revoicedOutputRoot = path.join(clientDataRoot, "kling-h3", "revoiced");
const builtinVoiceResourceRoot = app.isPackaged ? path.join(resourceRoot, "builtin-voices") : path.join(projectRoot, "packaging-resources", "builtin-voices");
const builtinVoices = [{
  id: "qwen-audio-3.0-tts-plus-snail0918-ec843776a98841228ddfc50356086c82",
  name: "老葛",
  model: "qwen-audio-3.0-tts-plus",
  createdAt: "2026-09-18T10:15:39+08:00",
  duration: 14.721458,
  resourceName: "laoge-reference.wav"
}];
const bundledFfmpegPath = path.join(resourceRoot, "tools", "ffmpeg", "ffmpeg.exe");
const bundledFfprobePath = path.join(resourceRoot, "tools", "ffmpeg", "ffprobe.exe");
const bundledCloudflaredPath = path.join(resourceRoot, "tools", "cloudflared", "cloudflared.exe");
const runtimeFfmpegPath = process.env.FFMPEG_PATH || (app.isPackaged ? bundledFfmpegPath : "ffmpeg");
const runtimeFfprobePath = process.env.FFPROBE_PATH || (app.isPackaged ? bundledFfprobePath : "ffprobe");
const rendererPath = path.join(rootDir, "renderer", "index.html");
const uiPreviewMode = process.argv.find((argument) => argument.startsWith("--ui-preview="))?.slice("--ui-preview=".length) || "";
const serviceDefinitions = {
  kling: {
    label: "Kling-H3",
    cwd: app.isPackaged ? path.join(resourceRoot, "services", "product-remake") : path.join(projectRoot, "Kling-H3路线B-Electron交付包-20260904", "module"),
    entry: "server.mjs",
    healthPath: "/api/config",
    publicPath: "/"
  },
  shot: {
    label: "镜头切分",
    cwd: app.isPackaged ? path.join(resourceRoot, "services", "video-shot") : path.join(projectRoot, "video-shot-engine-electron-delivery-20260904"),
    entry: path.join("src", "server.mjs"),
    healthPath: "/api/health",
    publicPath: "/"
  }
};

const services = new Map();
let mainWindow;
let stopping = false;
const quickTunnelMaxAttempts = 4;
const quickTunnelRetryDelaysMs = [0, 1200, 2400, 4000];

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitForHealth(baseUrl, healthPath, timeoutMs = 10000) {
  const startedAt = Date.now();
  let lastError = "服务尚未响应";
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const remainingMs = Math.max(1, timeoutMs - (Date.now() - startedAt));
      const response = await fetch(`${baseUrl}${healthPath}`, { signal: AbortSignal.timeout(Math.min(2500, remainingMs)) });
      if (response.ok) return await response.json();
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error.message;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`${lastError}（等待 ${timeoutMs}ms）`);
}

function serviceUrl(service) {
  return `http://127.0.0.1:${service.port}${service.definition.publicPath}`;
}

function serializeService(service) {
  return {
    key: service.key,
    label: service.definition.label,
    status: service.status,
    port: service.port || null,
    url: service.port ? serviceUrl(service) : null,
    error: service.error || null,
    pid: service.child?.pid || null,
    referenceVideoReady: Boolean(service.tunnelUrl)
  };
}

function cloudflaredCommand() {
  const candidates = [
    process.env.CLOUDFLARED_PATH,
    app.isPackaged ? bundledCloudflaredPath : null,
    process.platform === "win32" ? path.join(process.env["ProgramFiles(x86)"] || "", "cloudflared", "cloudflared.exe") : null,
    process.platform === "win32" ? path.join(process.env.ProgramFiles || "", "cloudflared", "cloudflared.exe") : null
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate)) || "cloudflared";
}

function startQuickTunnel(service, timeoutMs = 45000) {
  const startedAt = Date.now();
  const child = spawn(cloudflaredCommand(), ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${service.port}`], {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  service.tunnelChild = child;
  service.tunnelUrl = null;
  service.tunnelError = null;
  return new Promise((resolve, reject) => {
    let settled = false;
    let verifying = false;
    let registered = false;
    let discoveredUrl = null;
    let output = "";
    let warmupTimer = null;
    const timer = setTimeout(() => finish(new Error("Cloudflare Quick Tunnel 启动超时")), timeoutMs);
    const finish = (error, url) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (warmupTimer) clearTimeout(warmupTimer);
      if (error) reject(error); else resolve(url);
    };
    const verifyWhenReady = () => {
      if (!discoveredUrl || !registered || verifying || settled) return;
      verifying = true;
      service.tunnelUrl = discoveredUrl;
      warmupTimer = setTimeout(() => {
        warmupTimer = null;
        const remainingMs = Math.max(1, timeoutMs - (Date.now() - startedAt));
        void waitForHealth(discoveredUrl, service.definition.healthPath, remainingMs).then(() => finish(null, discoveredUrl), finish);
      }, 2000);
    };
    const capture = (chunk) => {
      const text = String(chunk);
      output = `${output}${text}`.slice(-12000);
      service.output.push(`[tunnel] ${text.trim()}`);
      service.output = service.output.slice(-80);
      const match = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
      if (match) discoveredUrl = match[0].replace(/\/$/, "");
      if (/Registered tunnel connection/i.test(output)) registered = true;
      verifyWhenReady();
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    child.once("error", (error) => finish(error));
    child.once("exit", (code, signal) => {
      if (!settled) return finish(new Error(`Cloudflare Quick Tunnel 退出：code=${code ?? "null"}, signal=${signal ?? "null"}`));
      if (stopping) return;
      if (service.tunnelChild !== child) return;
      service.tunnelUrl = null;
      service.tunnelError = "Cloudflare Quick Tunnel 已停止";
      notifyStatus();
    });
  });
}

async function runQuickTunnelRound(service) {
    if (service.tunnelUrl && service.tunnelChild?.exitCode === null) {
      try {
        await waitForHealth(service.tunnelUrl, service.definition.healthPath, 8000);
        service.tunnelError = null;
        return service.tunnelUrl;
      } catch (error) {
        service.output.push(`[tunnel] 已有通道失效，准备重建：${error.message}`);
        service.output = service.output.slice(-80);
        const staleChild = service.tunnelChild;
        service.tunnelUrl = null;
        await stopChild(staleChild);
        if (service.tunnelChild === staleChild) service.tunnelChild = null;
      }
    }
    let lastError = null;
    for (let attempt = 1; attempt <= quickTunnelMaxAttempts; attempt += 1) {
      const delayMs = quickTunnelRetryDelaysMs[attempt - 1] || 0;
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      try {
        return await startQuickTunnel(service);
      } catch (error) {
        lastError = error;
        service.output.push(`[tunnel] 第 ${attempt}/${quickTunnelMaxAttempts} 次连接失败：${error.message}`);
        service.output = service.output.slice(-80);
        const failedChild = service.tunnelChild;
        service.tunnelUrl = null;
        await stopChild(failedChild);
        if (service.tunnelChild === failedChild) service.tunnelChild = null;
      }
    }
    const friendlyError = new Error("网络通道暂时未连接成功，请再试一次。尚未提交生成任务，不会产生费用。");
    friendlyError.cause = lastError;
    try {
      service.tunnelUrl = null;
      service.tunnelError = friendlyError.message;
      throw friendlyError;
    } finally {
      notifyStatus();
    }
}

async function ensureQuickTunnel(service, { freshAttemptsAfterSharedFailure = true } = {}) {
  const sharedRound = service.tunnelPromise;
  if (sharedRound) {
    try {
      return await sharedRound;
    } catch (error) {
      if (!freshAttemptsAfterSharedFailure) throw error;
      service.output.push("[tunnel] 启动预热未成功，当前生成操作开始独立重试");
      service.output = service.output.slice(-80);
    }
  }
  if (service.tunnelPromise) return await service.tunnelPromise;
  const round = runQuickTunnelRound(service);
  const trackedRound = round.finally(() => {
    if (service.tunnelPromise === trackedRound) service.tunnelPromise = null;
  });
  service.tunnelPromise = trackedRound;
  return await trackedRound;
}

function getReadyShotService() {
  const service = services.get("shot");
  if (!service || service.status !== "ready") throw new Error("镜头切分服务尚未就绪");
  return service;
}

async function shotRequest(pathname, options = {}) {
  const service = getReadyShotService();
  const response = await fetch(new URL(pathname, serviceUrl(service)), options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `镜头切分服务请求失败：HTTP ${response.status}`);
  return { ...body, baseUrl: serviceUrl(service) };
}

async function getLatestShotRun() {
  const service = getReadyShotService();
  const response = await fetch(new URL("api/runs/latest", serviceUrl(service)));
  if (response.status === 404) return { runId: null, baseUrl: serviceUrl(service) };
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `镜头切分服务请求失败：HTTP ${response.status}`);
  return { ...body, baseUrl: serviceUrl(service) };
}

const KLING_IMAGE_PROMPT = `Image 1 is the source scene. Image 2 is the reference image of the replacement product.

Image 1 contains the original scene and the object that must be replaced. Image 2 contains the only valid replacement product. The main object held, worn, touched, or otherwise used by the person in image 1 is the mandatory replacement target. Replace that object with the exact product shown in image 2. The replacement is mandatory: do not remove the original object without inserting the replacement, leave it unchanged, or substitute any other product. The final image must visibly contain the product from image 2 in the same physical position and interaction as the original object. Use image 2 only as the product reference and ignore its background, props, people, text, and lighting setup.

Preserve the replacement product's identity and intrinsic design exactly, including silhouette, proportions, construction, component placement, colors, materials, surface finish, distinctive details, branding, graphics, labels, and packaging artwork. Do not redesign, simplify, hybridize, stretch, compress, crop, rewrite, obscure, or invent product features. Do not retain visual or structural details from the original object being replaced.

Adapt only the product's scale, position, orientation, perspective, illumination, reflections, depth, and cast shadow so it fits naturally into image 1. Preserve physically correct contact, support, depth, weight, and occlusion when the product is held, worn, touched, attached, inserted, or placed on a surface.

Preserve every non-target element in image 1, including subject identity, face, anatomy, pose, clothing, environment, composition, camera viewpoint, perspective, lighting, shadows, depth of field, and background geometry. Do not add duplicate products, detached components, extra fingers or limbs, floating elements, invented text, or unrelated changes. If perfect integration is difficult, keep the replacement product clearly visible and complete rather than deleting it or leaving an empty hand. The result must look like an authentic frame from the original scene and be suitable as the first frame of a realistic video.`;

const klingDurations = new Set([5, 8, 10, 15]);
const klingOmniDurations = new Set([5, 10, 15]);
const KLING_OMNI_PROMPT_MAX_BYTES = 3072;
const normalizeKlingDuration = (value) => klingDurations.has(Number(value)) ? Number(value) : 5;

function klingVideoPrompt(script, videoMode = "first_frame", duration = 5, keyframeTimes = []) {
  const seconds = normalizeKlingDuration(duration);
  if (videoMode === "multi_keyframes") {
    const anchors = keyframeTimes.map((time, index) => `<Picture ${index + 1}> is the verified scene and product anchor for approximately ${Number(time).toFixed(2)} seconds.`).join("\n");
    const speechGuidance = script
      ? `Human motion is limited to the natural interpolation already implied by adjacent pictures, plus lip and jaw movement required for the exact dialogue, subtle blinking, breathing, and micro-expressions. Preserve identity, face, anatomy, clothing, hands, environment, background geometry, lighting, shadows, and all existing visible text. Use exactly one shot with no cut, transition, new scene, new subject, new object, extra limb, unrelated action, or sudden motion.\n\nThe supplied reference audio defines the speaker's timbre, vocal identity, cadence, accent, and delivery style. The only permitted spoken content is: <d>[Chinese] ${script}</d>. Treat it as a strict word-for-word whitelist. Never add, omit, translate, rewrite, paraphrase, repeat, extend, or improvise words. Add no greeting, filler, additional dialogue, singing, subtitle, caption, or new on-screen text. Do not extend speech to fill ${seconds} seconds; after the line ends, lips stop and the remainder is quiet.\n\noverall_soundscape:\nQuiet natural ambience consistent with the supplied pictures, with only the exact specified Mandarin dialogue. No additional speech or attention-directing sound.`
      : `Human motion is limited to the natural interpolation already implied by adjacent pictures, subtle blinking, breathing, and micro-expressions. Preserve identity, face, anatomy, clothing, hands, environment, background geometry, lighting, shadows, and all existing visible text. Use exactly one shot with no cut, transition, new scene, new subject, new object, extra limb, unrelated action, or sudden motion. Every visible person remains silent with closed or naturally resting lips. Do not generate speech, vocalization, singing, subtitle, caption, or new on-screen text.\n\noverall_soundscape:\nNo speech or vocalization. Any generated ambience must remain unobtrusive; the exported result will be delivered without an audio track.`;
    return `subject_definitions:
<Subject 1> is the same replacement product shown consistently across all reference pictures. Every picture provides a verified appearance and scene-placement reference for this single product.
${anchors}

summary:
[reference generation + keyframe guidance] Generate one coherent, realistic ${seconds}-second video by interpolating the supplied pictures in their given chronological order. Preserve the same product, people, scene, framing, and physical interaction.

retention_analysis:
<Subject 1> (appears throughout [Shot 1]): fully_preserved - its silhouette, proportions, construction, colors, materials, branding, graphics, labels, and visible details remain identical to the supplied pictures. Each supplied picture is fully preserved as a chronological visual anchor.

detailed_description:
The target is one continuous live-action shot. The reference pictures are ordered from the beginning to the end of the video and define the approved product appearance, composition, position, scale, orientation, grip, contact, support, occlusion, lighting, and perspective at successive moments. Interpolate only the minimum natural motion needed between adjacent pictures. Do not invent a product pose, viewing angle, surface, label, pattern, or trajectory that is absent from the supplied pictures.

The camera and product depth must follow the supplied pictures without adding emphasis. Do not introduce a push-in, zoom, close-up, reframing, focus pull, product reveal, presentation gesture, arm extension, or movement toward the viewer unless that exact change is already established by two adjacent pictures. Never make the product larger or closer than it appears in either adjacent anchor. Do not flip, mirror, turn over, spin, rotate, redesign, morph, stretch, compress, duplicate, simplify, detach, float, or merge <Subject 1> with another object.

${speechGuidance}

non_diegetic_music:
N/A`;
  }
  if (videoMode === "reference_video") return `Edit @source_video into one coherent, realistic ${seconds}-second video. Replace only its main original product with the exact product in @product_image. The replacement is mandatory in every frame where the original product appears. Never keep, blend, alternate with, or return to the original product.

PRODUCT IDENTITY — HIGHEST PRIORITY:
Use @product_image as the only valid product reference. Preserve its silhouette, proportions, construction, component placement, colors, materials, finish, branding, graphics, labels, packaging artwork, and distinctive details. Do not redesign, simplify, distort, stretch, crop, obscure, duplicate, or invent features. Ignore the reference-image background and unrelated objects.

ANGLE AND ORIENTATION:
Never mirror, flip, reverse, turn over, or rotate the replacement into a product angle not visibly supported by @product_image. Do not invent an unseen side, back, top, bottom, interior, label area, closure, component, or package face. If @source_video requires an unsupported angle, constrain the product motion and retain the closest supported view.

SOURCE PRESERVATION:
Preserve @source_video's people and identities, faces, anatomy, clothing, hands, environment, background, framing, camera viewpoint, shot timing, motion, gestures, perspective, lighting, shadows, depth, focus, occlusion order, and physical interaction. Do not add cuts, transitions, scenes, people, products, camera moves, text, subtitles, captions, or unrelated changes.

PLACEMENT AND MOTION:
Replace the product at the original product's exact position, scale, depth, orientation, perspective, grip, contact, support, reflections, lighting, shadow, motion trajectory, and occlusions. It must not drift, float, detach, jump, or become pinned to screen coordinates. Never move it closer to the lens, enlarge it, create a close-up, or add a product-presentation gesture unless that exact action already exists in @source_video.

AUDIO AND SPEECH:
Do not synthesize or add any new speech, dialogue, vocalization, music, or sound effect. If the output settings retain the source audio, preserve its original spoken words and timing without rewriting, extending, or adding content. Add no subtitle, caption, or on-screen text.`;

  return `For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.

integrated_multimodal_description: [Shot 1] Generate one continuous, realistic, live-action ${seconds}-second shot beginning exactly from <Picture 1>. Every visible detail in <Picture 1> is a binding visual anchor. Preserve the people, identities, faces, anatomy, clothing, hands, environment, composition, crop, camera position, lens perspective, spatial relationships, lighting, shadows, background geometry, depth of field, and all existing visible text.

The replaced object visible in <Picture 1> is <Protected Object>. <Protected Object> is an ordinary anchored part of the existing scene. It is not the subject of a demonstration, presentation, reveal, advertisement, close-up, or camera emphasis.

Highest-priority composition rule: the camera holds a perfectly static shot for the entire ${seconds} seconds. The camera position, focal length, field of view, crop, framing, perspective, and focus remain locked to <Picture 1>. There is no push-in, zoom-in, dolly, tracking, reframing, crop change, close-up, focus pull toward <Protected Object>, or simulated camera movement. The overall composition at every moment, including the final frame, remains nearly identical to <Picture 1>.

Highest-priority depth rule: <Protected Object> remains on the same depth plane and at the same distance from the camera throughout the shot. It must never move closer to the lens or become more prominent in frame. Its apparent width, height, screen area, and center position remain effectively unchanged from <Picture 1>. No person may lift, raise, extend, thrust, offer, point, or move <Protected Object> toward the viewer. A supporting hand, wrist, elbow, arm, body, fixture, or surface must remain at the same depth and may not carry it forward. Any motion that would make <Protected Object> larger or closer is forbidden and must be omitted.

Motion is deliberately minimal. The only preferred human motion is natural lip and jaw movement required for the exact dialogue, plus subtle blinking, breathing, and micro-expressions. Do not invent hand gestures, arm extension, object handling, presentation behavior, walking toward the camera, or body movement toward the camera. If <Protected Object> is held or supported, preserve the original grip, contact points, support, occlusion, orientation, position, and distance. Background elements may show only imperceptible natural movement consistent with the existing scene.

Preserve <Protected Object> exactly across all frames: silhouette, proportions, construction, component placement, colors, materials, surface finish, branding, graphics, labels, artwork, and visible details. Keep the same orientation, same visible face, and same viewing angle as <Picture 1>. Do not flip, mirror, turn over, spin, rotate, redesign, morph, stretch, compress, duplicate, simplify, detach, float, or merge it with another object. Never reveal or invent an unsupported side, back, top, bottom, interior, label area, geometry, or detail. If any proposed motion would expose an unseen surface, omit that motion and keep <Protected Object> fixed.

The only permitted spoken content in the entire video is this exact line: <d>[Chinese] ${script}</d>. Treat it as a strict word-for-word whitelist. If a clearly visible primary person is suitable for speaking, that person speaks exactly this line with natural Mandarin pacing and synchronized lip movement. Otherwise, the exact line is spoken as off-screen Mandarin voiceover while every visible person's lips remain closed. Never add, omit, translate, rewrite, paraphrase, repeat, extend, or improvise words. Add no greeting, explanation, transition, filler, acknowledgement, dialogue, singing, subtitle, caption, or new on-screen text. Do not extend the dialogue to fill ${seconds} seconds; after the line ends, the speaker stops moving their lips and the remainder is quiet.

There is exactly one shot with no cut, transition, scene change, new subject, new object, duplicated object, extra limb, unrelated action, or sudden motion. When a visual action conflicts with composition, depth, object identity, or dialogue constraints, preserve the anchored first-frame state and omit the action.

overall_soundscape: Quiet natural ambience consistent with <Picture 1>, with only the exact specified Mandarin dialogue. No additional speech, vocalization, object sound effect, dramatic impact, or attention-directing sound.

non_diegetic_music: N/A`;
}

function getReadyKlingService() {
  const service = services.get("kling");
  if (!service || service.status !== "ready") throw new Error("商品替换服务尚未就绪");
  return service;
}

async function klingRequest(pathname, options = {}) {
  const service = getReadyKlingService();
  const response = await fetch(new URL(pathname, serviceUrl(service)), options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `商品替换服务请求失败：HTTP ${response.status}`);
  return { ...body, baseUrl: serviceUrl(service) };
}

async function getKlingConfig() {
  const config = await klingRequest("api/config");
  const service = getReadyKlingService();
  return { ...config, referenceVideoConfigured: Boolean(service.tunnelUrl), tunnelError: service.tunnelError || null };
}

function mediaType(filePath, kind) {
  const extension = path.extname(filePath).toLowerCase();
  if (kind === "video") return extension === ".mov" ? "video/quicktime" : "video/mp4";
  if (kind === "audio") {
    if (extension === ".wav") return "audio/wav";
    if (extension === ".m4a") return "audio/mp4";
    return "audio/mpeg";
  }
  if (extension === ".webp") return "image/webp";
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  return "image/png";
}

async function uploadKlingMedia(runId, filePath, kind, category, name = path.basename(filePath)) {
  const query = new URLSearchParams({ runId, kind, category, name });
  return klingRequest(`api/media?${query}`, { method: "POST", headers: { "Content-Type": mediaType(filePath, kind) }, body: await openAsBlob(filePath, { type: mediaType(filePath, kind) }) });
}

function ffprobeCommand() {
  return runtimeFfprobePath;
}

async function videoDurationSeconds(videoPath) {
  const { stdout } = await execFileAsync(ffprobeCommand(), ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", videoPath], { windowsHide: true, encoding: "utf8", maxBuffer: 1024 * 1024 });
  const duration = Number(String(stdout).trim());
  if (!Number.isFinite(duration) || duration <= 0) throw new Error("无法读取参考视频时长");
  return duration;
}

async function inspectReferenceAudio(videoPath) {
  if (!videoPath) throw new Error("请先选择参考视频");
  const { stdout } = await execFileAsync(ffprobeCommand(), ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=codec_name", "-show_entries", "format=duration", "-of", "json", videoPath], { windowsHide: true, encoding: "utf8", maxBuffer: 1024 * 1024 });
  const result = JSON.parse(stdout || "{}");
  const duration = Number(result?.format?.duration || 0);
  return {
    hasAudio: Array.isArray(result?.streams) && result.streams.length > 0,
    duration: Number.isFinite(duration) && duration > 0 ? duration : null,
    codec: result?.streams?.[0]?.codec_name || null
  };
}

function keyframeCount(duration) {
  return duration <= 5 ? 4 : duration <= 10 ? 5 : 6;
}

async function createKlingRun({ videoPath, productPath, voiceScript, audioMode, videoMode, duration, voiceId }) {
  if (!videoPath || !productPath) throw new Error("请先选择产品图和参考视频");
  const selectedVideoMode = videoMode === "reference_video" ? "reference_video" : "multi_keyframes";
  const script = selectedVideoMode === "reference_video" ? "" : String(voiceScript || "").trim();
  const voiceEnabled = selectedVideoMode !== "reference_video" && audioMode !== "silent";
  const selectedVoice = voiceEnabled ? await resolveVoice(voiceId) : null;
  const selectedVoiceSource = voiceEnabled ? "upload" : "source_video";
  if (voiceEnabled && !script) throw new Error("声音与口型开启时请输入台词");
  if (voiceEnabled && !selectedVoice?.samplePath) throw new Error("所选声音缺少本地参考样本，请重新创建声音");
  const config = await klingRequest("api/config");
  if (selectedVideoMode === "reference_video" ? !config.klingConfigured : !config.configured) throw new Error(selectedVideoMode === "reference_video" ? "Kling API Key 尚未配置" : "商品替换服务尚未配置两个 API Key");
  const selectedDuration = normalizeKlingDuration(duration);
  if (selectedVideoMode === "reference_video") {
    if (!klingOmniDurations.has(selectedDuration)) throw new Error("Kling 3.0 Omni 参考视频模式仅支持 5、10 或 15 秒");
    const videoPrompt = klingVideoPrompt(script, selectedVideoMode, selectedDuration);
    if (Buffer.byteLength(videoPrompt, "utf8") > KLING_OMNI_PROMPT_MAX_BYTES) throw new Error("Kling 3.0 Omni 提示词超过 3072 字节，请缩短台词");
    const sourceDuration = await videoDurationSeconds(videoPath);
    if (sourceDuration < 3 || sourceDuration > 10) throw new Error("Kling 3.0 Omni 参考视频时长必须在 3–10 秒之间");
    const { runId } = await klingRequest("api/run-id", { method: "POST" });
    const publicBaseUrl = await ensureQuickTunnel(getReadyKlingService());
    const [sourceVideo, productImage] = await Promise.all([
      uploadKlingMedia(runId, videoPath, "video", "inputs/source-video"),
      uploadKlingMedia(runId, productPath, "image", "inputs/product-image")
    ]);
    return klingRequest("api/runs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ runId, sourceVideoId: sourceVideo.id, productImageId: productImage.id, imagePrompt: KLING_IMAGE_PROMPT, videoPrompt, voiceScript: script, audioMode: audioMode === "silent" ? "silent" : "voice", videoMode: selectedVideoMode, publicBaseUrl, resolution: "720P", duration: selectedDuration }) });
  }
  const { runId } = await klingRequest("api/run-id", { method: "POST" });
  const publicBaseUrl = await ensureQuickTunnel(getReadyKlingService());
  const tempDir = path.join(app.getPath("temp"), "video-client-electron", "keyframes", runId);
  await mkdir(tempDir, { recursive: true });
  try {
    const sourceDuration = await videoDurationSeconds(videoPath);
    const count = keyframeCount(selectedDuration);
    const span = Math.max(0, Math.min(sourceDuration, selectedDuration) - 0.05);
    const keyframeTimes = Array.from({ length: count }, (_, index) => Number((span * index / (count - 1)).toFixed(3)));
    const keyframePaths = keyframeTimes.map((_, index) => path.join(tempDir, `keyframe-${index + 1}.png`));
    for (let index = 0; index < keyframePaths.length; index += 1) {
      await execFileAsync(runtimeFfmpegPath, ["-y", "-ss", String(keyframeTimes[index]), "-i", videoPath, "-frames:v", "1", keyframePaths[index]], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
    }
    const [sourceVideo, productImage, ...keyframes] = await Promise.all([
      uploadKlingMedia(runId, videoPath, "video", "inputs/source-video"),
      uploadKlingMedia(runId, productPath, "image", "inputs/product-image"),
      ...keyframePaths.map((filePath, index) => uploadKlingMedia(runId, filePath, "image", "keyframes/source", `keyframe-${index + 1}.png`))
    ]);
    const voiceAudio = voiceEnabled
      ? await uploadKlingMedia(runId, selectedVoice.samplePath, "audio", "inputs/voice-audio")
      : null;
    return klingRequest("api/runs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ runId, sourceVideoId: sourceVideo.id, productImageId: productImage.id, voiceAudioId: voiceAudio?.id || null, voiceSource: selectedVoiceSource, keyframeIds: keyframes.map((item) => item.id), keyframeTimes, imagePrompt: KLING_IMAGE_PROMPT, videoPrompt: klingVideoPrompt(script, selectedVideoMode, selectedDuration, keyframeTimes), voiceScript: script, audioMode: voiceEnabled ? "voice" : "silent", videoMode: selectedVideoMode, publicBaseUrl, resolution: "768P", duration: selectedDuration }) });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function startKlingVideo(runId, voiceScript, videoMode, duration, keyframeTimes, confirmResubmit = false, voiceEnabled = true) {
  const selectedVideoMode = videoMode === "reference_video" ? "reference_video" : "multi_keyframes";
  const selectedDuration = normalizeKlingDuration(duration);
  const publicBaseUrl = selectedVideoMode === "reference_video" || voiceEnabled ? await ensureQuickTunnel(getReadyKlingService()) : null;
  if (selectedVideoMode === "reference_video" && !klingOmniDurations.has(selectedDuration)) throw new Error("Kling 3.0 Omni 参考视频模式仅支持 5、10 或 15 秒");
  const resolution = selectedVideoMode === "reference_video" ? "720P" : "768P";
  const normalizedVoiceScript = voiceEnabled ? String(voiceScript || "").trim() : "";
  const videoPrompt = klingVideoPrompt(normalizedVoiceScript, selectedVideoMode, selectedDuration, Array.isArray(keyframeTimes) ? keyframeTimes : []);
  if (selectedVideoMode === "reference_video" && Buffer.byteLength(videoPrompt, "utf8") > KLING_OMNI_PROMPT_MAX_BYTES) throw new Error("Kling 3.0 Omni 提示词超过 3072 字节，请缩短台词");
  return klingRequest(`api/runs/${encodeURIComponent(runId)}/video`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ videoPrompt, voiceScript: normalizedVoiceScript, audioMode: voiceEnabled ? "voice" : "silent", videoMode: selectedVideoMode, publicBaseUrl, resolution, duration: selectedDuration, confirmResubmit }) });
}

async function resumeKlingRun(runId) {
  return klingRequest(`api/runs/${encodeURIComponent(runId)}/resume`, { method: "POST" });
}

async function retryKlingImage(runId, indexes) {
  return klingRequest(`api/runs/${encodeURIComponent(runId)}/image/retry`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ indexes: Array.isArray(indexes) ? indexes : [] }) });
}

async function listKlingAssets() {
  const response = await klingRequest("api/runs");
  let revoicedAssets = [];
  try {
    const files = await readdir(revoicedOutputRoot);
    revoicedAssets = (await Promise.all(files.filter((name) => name.endsWith(".json")).map(async (name) => {
      try {
        const meta = JSON.parse(await readFile(path.join(revoicedOutputRoot, name), "utf8"));
        if (!meta.path || !existsSync(meta.path)) return null;
        return { runId: meta.runId, sourceId: meta.runId, sourceFilename: meta.sourceFilename || "商品替换", sourceFolderName: path.parse(meta.sourceFilename || "商品替换").name, workflow: "remake", name: meta.name || "商品替换成片_克隆配音.mp4", relativeUrl: pathToFileURL(meta.path).toString(), completedAt: meta.completedAt, audioMode: "voice", voiceName: meta.voiceName };
      } catch { return null; }
    }))).filter(Boolean);
  } catch {}
  const revoicedRunIds = new Set(revoicedAssets.map((asset) => asset.runId));
  const providerAssets = (response.runs || []).filter((run) => run.stage === "video" && String(run.status).toUpperCase() === "SUCCEEDED" && run.output?.url && !revoicedRunIds.has(run.id)).map((run) => ({ runId: run.id, sourceId: run.id, sourceFilename: run.sourceVideo?.name || "商品替换", sourceFolderName: path.parse(run.sourceVideo?.name || "商品替换").name, workflow: "remake", name: run.output.name || "商品替换成片.mp4", relativeUrl: run.output.url, completedAt: run.updatedAt || run.createdAt, audioMode: run.audioMode || "voice" }));
  return {
    baseUrl: response.baseUrl,
    assets: [...revoicedAssets, ...providerAssets]
  };
}

async function getLatestRecoverableKlingRun() {
  const response = await klingRequest("api/runs");
  const run = (response.runs || []).find((entry) => {
    const status = String(entry.status || "").toUpperCase();
    return entry.stage === "video"
      && status !== "SUCCEEDED"
      && !entry.output?.url
      && Array.isArray(entry.editedKeyframes)
      && entry.editedKeyframes.length > 0;
  }) || null;
  return { run, baseUrl: response.baseUrl };
}

async function readEnvValue(filePath, key) {
  try {
    const line = (await readFile(filePath, "utf8")).split(/\r?\n/).find((value) => value.trim().startsWith(`${key}=`));
    if (!line) return "";
    return line.slice(line.indexOf("=") + 1).trim().replace(/^(['"])(.*)\1$/, "$2");
  } catch { return ""; }
}

const voiceTargetModel = "qwen-audio-3.0-tts-plus";
const dashscopeApiBase = "https://dashscope.aliyuncs.com/api/v1/services/audio/tts";

async function voiceApiKey() {
  const service = getReadyKlingService();
  const envPath = path.join(service.definition.cwd, ".env");
  return (await readEnvValue(envPath, "DASHSCOPE_API_KEY")) || (await readEnvValue(envPath, "BAILIAN_API_KEY"));
}

async function readVoiceRegistry() {
  try {
    const parsed = JSON.parse(await readFile(voiceRegistryPath, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeVoiceRegistry(voices) {
  await mkdir(voiceDataRoot, { recursive: true });
  const tempPath = `${voiceRegistryPath}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(voices, null, 2)}\n`, "utf8");
  await rename(tempPath, voiceRegistryPath);
}

function publicVoice(voice) {
  return {
    id: voice.id,
    name: voice.name,
    model: voice.model,
    createdAt: voice.createdAt,
    duration: voice.duration,
    builtin: voice.builtin === true,
    demo: voice.demo === true,
    sampleUrl: voice.samplePath ? pathToFileURL(voice.samplePath).toString() : null
  };
}

async function ensureBuiltinVoices() {
  await mkdir(voiceDataRoot, { recursive: true });
  const voices = await readVoiceRegistry();
  for (const definition of builtinVoices) {
    const sourcePath = path.join(builtinVoiceResourceRoot, definition.resourceName);
    if (!existsSync(sourcePath)) throw new Error(`内置音色资源缺失：${definition.resourceName}`);
    const samplePath = path.join(voiceDataRoot, `builtin-${definition.resourceName}`);
    if (!existsSync(samplePath)) await copyFile(sourcePath, samplePath);
    const index = voices.findIndex((voice) => voice.id === definition.id);
    const seededVoice = { ...definition, builtin: true, demo: false, samplePath };
    delete seededVoice.resourceName;
    if (index < 0) voices.unshift(seededVoice);
    else voices[index] = { ...voices[index], ...seededVoice };
  }
  await writeVoiceRegistry(voices);
}

async function listVoices() {
  return (await readVoiceRegistry()).map(publicVoice);
}

async function resolveVoice(voiceId) {
  const voice = (await readVoiceRegistry()).find((entry) => entry.id === voiceId);
  if (!voice) throw new Error("所选声音不存在，请重新选择或创建声音");
  if (voice.demo === true) throw new Error("演示音色仅用于查看选择和删除逻辑，不能提交真实生成");
  return voice;
}

async function dashscopeRequest(pathname, payload) {
  const key = await voiceApiKey();
  if (!key) throw new Error("声音服务尚未配置阿里云百炼 API Key");
  const response = await fetch(`${dashscopeApiBase}/${pathname}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || body.code || `声音服务请求失败：HTTP ${response.status}`);
  return body;
}

async function createVoice({ sourcePath, name }) {
  if (!sourcePath) throw new Error("请先选择包含清晰人声的参考视频");
  const duration = await videoDurationSeconds(sourcePath);
  if (duration < 3) throw new Error("参考声音至少需要 3 秒");
  await mkdir(voiceDataRoot, { recursive: true });
  const localId = `voice_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  const samplePath = path.join(voiceDataRoot, `${localId}.mp3`);
  await execFileAsync(runtimeFfmpegPath, ["-y", "-i", sourcePath, "-map", "0:a:0", "-t", String(Math.min(30, duration)), "-vn", "-ac", "1", "-ar", "24000", "-c:a", "libmp3lame", "-b:a", "96k", samplePath], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 });

  try {
    const { runId } = await klingRequest("api/run-id", { method: "POST" });
    const uploaded = await uploadKlingMedia(runId, samplePath, "audio", "inputs/voice-audio", `${localId}.mp3`);
    const publicBaseUrl = await ensureQuickTunnel(getReadyKlingService());
    const prefix = `zy${Date.now().toString(36).slice(-8)}`.slice(0, 10);
    const response = await dashscopeRequest("customization", {
      model: "voice-enrollment",
      input: {
        action: "create_voice",
        target_model: voiceTargetModel,
        prefix,
        url: new URL(uploaded.url, publicBaseUrl).toString(),
        language_hints: ["zh"],
        max_prompt_audio_length: Math.min(30, duration),
        enable_preprocess: true,
        enable_volume_normalization: "true"
      }
    });
    const voiceId = response.output?.voice_id;
    if (!voiceId) throw new Error("声音服务没有返回音色 ID");
    const voices = await readVoiceRegistry();
    const voice = { id: voiceId, name: String(name || "新建声音").trim().slice(0, 20) || "新建声音", model: voiceTargetModel, createdAt: new Date().toISOString(), duration: Math.min(30, duration), samplePath };
    voices.unshift(voice);
    await writeVoiceRegistry(voices);
    return publicVoice(voice);
  } catch (error) {
    await rm(samplePath, { force: true });
    throw error;
  }
}

async function deleteVoice(voiceId) {
  const voices = await readVoiceRegistry();
  const voice = voices.find((entry) => entry.id === voiceId);
  if (!voice) return { deleted: false };
  if (voice.builtin === true) throw new Error("内置音色不能删除");
  if (voice.demo !== true) await dashscopeRequest("customization", { model: "voice-enrollment", input: { action: "delete_voice", voice_id: voice.id } });
  await writeVoiceRegistry(voices.filter((entry) => entry.id !== voice.id));
  if (voice.samplePath) await rm(voice.samplePath, { force: true });
  return { deleted: true };
}

function atempoFilter(rate) {
  const parts = [];
  let remaining = rate;
  while (remaining > 2) { parts.push("atempo=2"); remaining /= 2; }
  while (remaining < 0.5) { parts.push("atempo=0.5"); remaining /= 0.5; }
  parts.push(`atempo=${remaining.toFixed(6)}`);
  return parts.join(",");
}

async function detectSpeechWindow(videoPath, duration) {
  try {
    const sink = process.platform === "win32" ? "NUL" : "/dev/null";
    const { stderr } = await execFileAsync(runtimeFfmpegPath, ["-hide_banner", "-nostats", "-i", videoPath, "-map", "0:a:0", "-af", "silencedetect=n=-35dB:d=0.15", "-f", "null", sink], { windowsHide: true, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
    const starts = [...String(stderr).matchAll(/silence_start:\s*([0-9.]+)/g)].map((match) => Number(match[1]));
    const ends = [...String(stderr).matchAll(/silence_end:\s*([0-9.]+)/g)].map((match) => Number(match[1]));
    const start = starts[0] <= 0.1 && ends.length ? ends[0] : 0;
    const lastStart = starts.at(-1);
    const lastEnd = ends.at(-1);
    const end = Number.isFinite(lastStart) && (!Number.isFinite(lastEnd) || lastStart > lastEnd) ? lastStart : duration;
    if (end - start >= 0.5) return { start, end };
  } catch {}
  return { start: 0, end: duration };
}

async function materializeVideo(videoUrl, targetPath) {
  if (String(videoUrl).startsWith("file:")) {
    await copyFile(fileURLToPath(videoUrl), targetPath);
    return;
  }
  const response = await fetch(videoUrl);
  if (!response.ok) throw new Error(`无法读取已生成视频：HTTP ${response.status}`);
  await writeFile(targetPath, Buffer.from(await response.arrayBuffer()));
}

async function revoiceVideo({ videoUrl, runId, voiceId, text }) {
  if (!videoUrl || !runId) throw new Error("缺少可重新配音的视频结果");
  if (!String(text || "").trim()) throw new Error("请输入需要生成的台词");
  const voice = await resolveVoice(voiceId);
  const tempRoot = path.join(app.getPath("temp"), "video-client-electron", "revoice", `${runId}-${Date.now()}`);
  const sourceVideoPath = path.join(tempRoot, "source.mp4");
  const generatedAudioPath = path.join(tempRoot, "voice.wav");
  await mkdir(tempRoot, { recursive: true });
  await mkdir(revoicedOutputRoot, { recursive: true });
  try {
    await materializeVideo(videoUrl, sourceVideoPath);
    const response = await dashscopeRequest("SpeechSynthesizer", {
      model: voice.model || voiceTargetModel,
      input: { text: String(text).trim(), voice: voice.id, format: "wav", sample_rate: 24000, rate: 1, pitch: 1, language_hints: ["zh"] }
    });
    const audioUrl = response.output?.audio?.url;
    if (!audioUrl) throw new Error("声音服务没有返回生成音频");
    const audioResponse = await fetch(audioUrl);
    if (!audioResponse.ok) throw new Error(`下载生成音频失败：HTTP ${audioResponse.status}`);
    await writeFile(generatedAudioPath, Buffer.from(await audioResponse.arrayBuffer()));
    const [videoDuration, audioDuration] = await Promise.all([videoDurationSeconds(sourceVideoPath), videoDurationSeconds(generatedAudioPath)]);
    const speechWindow = await detectSpeechWindow(sourceVideoPath, videoDuration);
    const outputPath = path.join(revoicedOutputRoot, `${runId}-${Date.now()}.mp4`);
    const targetSpeechDuration = Math.max(0.5, speechWindow.end - speechWindow.start);
    const rate = Math.max(0.05, audioDuration / targetSpeechDuration);
    const delayMs = Math.max(0, Math.round(speechWindow.start * 1000));
    await execFileAsync(runtimeFfmpegPath, ["-y", "-i", sourceVideoPath, "-i", generatedAudioPath, "-filter_complex", `[1:a]${atempoFilter(rate)},adelay=${delayMs}:all=1,apad[a]`, "-map", "0:v:0", "-map", "[a]", "-t", String(videoDuration), "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", outputPath], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    const completedAt = new Date().toISOString();
    const name = "商品替换成片_克隆配音.mp4";
    await writeFile(`${outputPath}.json`, `${JSON.stringify({ runId, path: outputPath, name, voiceId: voice.id, voiceName: voice.name, completedAt }, null, 2)}\n`, "utf8");
    return { name, url: pathToFileURL(outputPath).toString(), voiceId: voice.id, voiceName: voice.name, duration: videoDuration, completedAt };
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

function validateRunId(runId) {
  if (!/^run_[a-zA-Z0-9_]+$/.test(runId || "")) throw new Error("运行 ID 无效");
  return runId;
}

function validateBatchId(batchId) {
  if (!/^batch_[a-zA-Z0-9_]+$/.test(batchId || "")) throw new Error("批次 ID 无效");
  return batchId;
}

async function createShotRun({ filePath, workflow, keepAudio = true }) {
  if (!filePath || typeof filePath !== "string") throw new Error("未找到视频文件路径");
  const selectedWorkflow = workflow === "ffmpeg_gemini_naming" ? workflow : "ffmpeg_only";
  if (selectedWorkflow === "ffmpeg_gemini_naming") {
    const config = await shotRequest("api/config");
    if (!config.apiKeyConfigured) throw new Error("命名服务未配置");
  }
  const form = new FormData();
  form.append("video", await openAsBlob(filePath), path.basename(filePath));
  form.append("workflow", selectedWorkflow);
  form.append("keepAudio", keepAudio === false ? "off" : "on");
  return shotRequest("api/runs", { method: "POST", body: form });
}

async function createShotBatch({ entries, filePaths, workflow, keepAudio = true }) {
  const normalizedEntries = Array.isArray(entries) && entries.length
    ? entries.map((entry) => typeof entry === "string" ? { path: entry } : entry)
    : (Array.isArray(filePaths) ? filePaths.map((filePath) => ({ path: filePath })) : []);
  if (normalizedEntries.length < 1 || normalizedEntries.length > 25 || normalizedEntries.some((entry) => !entry?.path || typeof entry.path !== "string")) throw new Error("批量处理需要选择 1–25 个视频");
  const selectedWorkflow = workflow === "ffmpeg_gemini_naming" ? workflow : "ffmpeg_only";
  if (selectedWorkflow === "ffmpeg_gemini_naming") {
    const config = await shotRequest("api/config");
    if (!config.apiKeyConfigured) throw new Error("命名服务未配置");
  }
  const form = new FormData();
  for (const entry of normalizedEntries) form.append("videos", await openAsBlob(entry.path), path.basename(entry.path));
  form.append("folderManifest", JSON.stringify(normalizedEntries.map((entry) => ({
    sourceFolderId: entry.folderId || null,
    sourceFolderName: entry.folderName || null,
    sourceRelativePath: entry.relativePath || path.basename(entry.path)
  }))));
  form.append("workflow", selectedWorkflow);
  form.append("keepAudio", keepAudio === false ? "off" : "on");
  return shotRequest("api/batches", { method: "POST", body: form });
}

const shotVideoExtensions = new Set([".mp4", ".mov", ".mkv", ".avi", ".webm", ".m4v"]);

async function collectShotFolderVideos(folderPath) {
  const videos = [];
  const walk = async (currentPath) => {
    const entries = await readdir(currentPath, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, "zh-CN", { numeric: true }))) {
      const fullPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) await walk(fullPath);
      else if (entry.isFile() && shotVideoExtensions.has(path.extname(entry.name).toLowerCase())) videos.push(fullPath);
    }
  };
  await walk(folderPath);
  return videos;
}

async function pickShotFolders() {
  const selection = await dialog.showOpenDialog(mainWindow, {
    title: "选择商品素材文件夹",
    properties: ["openDirectory", "multiSelections"]
  });
  if (selection.canceled || !selection.filePaths.length) return { folders: [], entries: [] };
  const folders = [];
  const entries = [];
  for (const [folderIndex, folderPath] of selection.filePaths.entries()) {
    const folderName = path.basename(folderPath);
    const folderId = `folder_${folderIndex + 1}_${Buffer.from(folderPath).toString("base64url").slice(-10)}`;
    const videos = await collectShotFolderVideos(folderPath);
    folders.push({ id: folderId, name: folderName, path: folderPath, videoCount: videos.length });
    for (const videoPath of videos) entries.push({ path: videoPath, name: path.basename(videoPath), sizeBytes: (await stat(videoPath)).size, folderId, folderName, relativePath: path.relative(folderPath, videoPath) });
  }
  if (!entries.length) throw new Error("所选文件夹中没有可处理的视频");
  if (entries.length > 25) throw new Error(`共找到 ${entries.length} 个视频，单次最多处理 25 个`);
  return { folders, entries };
}

async function listShotAssets() {
  const service = getReadyShotService();
  const runsDir = shotRunsDir;
  const assets = [];
  const scanErrors = [];
  let entries = [];
  try { entries = await readdir(runsDir, { withFileTypes: true }); } catch { return { baseUrl: serviceUrl(service), assets }; }
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^(run|batch)_[a-zA-Z0-9_]+$/.test(entry.name)) continue;
    try {
      if (entry.name.startsWith("batch_")) {
        const batchDir = path.join(runsDir, entry.name);
        const batch = JSON.parse(await readFile(path.join(batchDir, "batch.json"), "utf8"));
        for (const itemRef of batch.items || []) {
          const itemDir = path.join(batchDir, "items", itemRef.videoId);
          const item = JSON.parse(await readFile(path.join(itemDir, "item.json"), "utf8"));
          if (item.status !== "completed") continue;
          let clips = item.shots || [];
          let named = false;
          try { clips = JSON.parse(await readFile(path.join(itemDir, "artifacts", "rename_manifest.json"), "utf8")); named = true; } catch {}
          const sourceFilename = item.sourceFilename || itemRef.sourceFilename || "素材";
          const sourceFolderName = item.sourceFolderName || path.parse(sourceFilename).name;
          const sourceId = item.sourceFolderId || `${batch.batchId || entry.name}:${item.videoId}`;
          const workflow = item.workflow || batch.workflow || (named ? "ffmpeg_gemini_naming" : "ffmpeg_only");
          for (const clip of clips) {
            const itemRelativePath = clip.namedPath || clip.filePath;
            if (!itemRelativePath) continue;
            assets.push({ runId: batch.batchId || entry.name, relativePath: path.posix.join("items", item.videoId, String(itemRelativePath).replaceAll("\\", "/")), name: clip.namedFilename || `${clip.shotId || "片段"}.mp4`, startSec: clip.startSec, endSec: clip.endSec, usageType: clip.usageType || null, contentTitle: clip.contentTitle || null, sourceId, sourceFolderName, sourceFilename, workflow, keepAudio: item.keepAudio, mediaTools: item.mediaTools || null, completedAt: item.completedAt || item.updatedAt || batch.finishedAt || batch.createdAt || null });
          }
        }
        continue;
      }
      const runDir = path.join(runsDir, entry.name);
      let run;
      try { run = JSON.parse(await readFile(path.join(runDir, "artifacts", "run.json"), "utf8")); }
      catch { run = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8")); }
      if (run.status !== "completed") continue;
      let clips = run.shots || [];
      let named = false;
      try { clips = JSON.parse(await readFile(path.join(runDir, "artifacts", "rename_manifest.json"), "utf8")); named = true; } catch {}
      const sourceFilename = run.sourceFilename || "素材";
      const sourceFolderName = run.sourceFolderName || path.parse(sourceFilename).name;
      const sourceId = run.sourceFolderId || run.runId || entry.name;
      const workflow = run.workflow || (named ? "ffmpeg_gemini_naming" : "ffmpeg_only");
      for (const clip of clips) {
        const relativePath = clip.namedPath || clip.filePath;
        if (!relativePath) continue;
        assets.push({ runId: run.runId || entry.name, relativePath, name: clip.namedFilename || `${clip.shotId || "片段"}.mp4`, startSec: clip.startSec, endSec: clip.endSec, usageType: clip.usageType || null, contentTitle: clip.contentTitle || null, sourceId, sourceFolderName, sourceFilename, workflow, keepAudio: run.keepAudio, mediaTools: run.mediaTools || null, completedAt: run.completedAt || run.updatedAt || run.createdAt || null });
      }
    } catch (error) {
      scanErrors.push({ entry: entry.name, message: error.message });
    }
  }
  return { baseUrl: serviceUrl(service), assets, scanErrors };
}

async function startService(key) {
  const definition = serviceDefinitions[key];
  if (!definition) throw new Error(`未知服务：${key}`);
  const existing = services.get(key);
  if (existing?.status === "ready") return existing;

  const port = await findFreePort();
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
    HOST: "127.0.0.1",
    PORT: String(port),
    FFMPEG_PATH: runtimeFfmpegPath,
    FFPROBE_PATH: runtimeFfprobePath,
    CLIENT_RESOURCES_DIR: resourceRoot
  };
  if (key === "shot") {
    env.RUNS_DIR = shotRunsDir;
    env.PUBLIC_DIR = path.join(definition.cwd, "public");
  } else if (key === "kling") {
    env.RUNS_DIR = klingRunsDir;
    env.PUBLIC_DIR = path.join(definition.cwd, "public");
    const moduleKey = await readEnvValue(path.join(definition.cwd, ".env"), "XINHANKR_API_KEY");
    const shotKey = await readEnvValue(path.join(serviceDefinitions.shot.cwd, ".env"), "XINHANKR_API_KEY");
    if (moduleKey || shotKey) env.XINHANKR_API_KEY = moduleKey || shotKey;
  }

  const service = { key, definition, port, status: "starting", error: null, output: [] };
  const child = spawn(process.execPath, [definition.entry], {
    cwd: definition.cwd,
    env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  service.child = child;
  services.set(key, service);
  const capture = (chunk) => {
    service.output.push(String(chunk).trim());
    service.output = service.output.slice(-80);
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  child.once("error", (error) => {
    service.status = "error";
    service.error = error.message;
  });
  child.once("exit", (code, signal) => {
    if (!stopping && service.status !== "ready") {
      service.status = "error";
      service.error = `进程退出：code=${code ?? "null"}, signal=${signal ?? "null"}`;
    } else if (!stopping) {
      service.status = "stopped";
    }
    notifyStatus();
  });

  try {
    await waitForHealth(`http://127.0.0.1:${port}`, definition.healthPath);
    service.status = "ready";
    notifyStatus();
    if (key === "kling") {
      void ensureQuickTunnel(service, { freshAttemptsAfterSharedFailure: false }).then(notifyStatus).catch((error) => {
        service.tunnelError = error.message;
        service.tunnelUrl = null;
        service.output.push(`[tunnel] ${error.message}`);
        notifyStatus();
      });
    }
    return service;
  } catch (error) {
    service.status = "error";
    service.error = error.message;
    await stopService(service);
    throw new Error(`${definition.label} 启动失败：${error.message}`);
  }
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  child.kill();
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
      resolve();
    }, 1500);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function stopService(service) {
  if (!service) return;
  service.status = "stopping";
  await Promise.all([stopChild(service.tunnelChild), stopChild(service.child)]);
}

function notifyStatus() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("services-updated", [...services.values()].map(serializeService));
}

function loadRenderer() {
  const options = uiPreviewMode ? { query: { preview: uiPreviewMode } } : undefined;
  return mainWindow.loadFile(rendererPath, options);
}

async function openWorkspace(key) {
  const service = services.get(key);
  if (!service || service.status !== "ready") throw new Error(`${serviceDefinitions[key]?.label || key} 尚未就绪`);
  if (!mainWindow || mainWindow.isDestroyed()) throw new Error("主窗口不可用");
  await mainWindow.loadURL(serviceUrl(service));
  mainWindow.setTitle(`${productName} · ${service.definition.label}`);
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 900,
    minHeight: 620,
    title: productName,
    icon: path.join(rootDir, "renderer", "assets", "zhangyu-video-agent-icon.ico"),
    webPreferences: {
      preload: path.join(rootDir, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  Menu.setApplicationMenu(null);
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("before-input-event", (event, input) => {
    if (input.type === "keyDown" && input.control && input.shift && input.key.toUpperCase() === "H") {
      event.preventDefault();
      void loadRenderer().then(() => mainWindow.setTitle(productName));
    }
  });
  return loadRenderer();
}

ipcMain.handle("get-services", () => [...services.values()].map(serializeService));
ipcMain.handle("start-services", async () => {
  const results = [];
  for (const key of Object.keys(serviceDefinitions)) {
    try {
      results.push(serializeService(await startService(key)));
    } catch (error) {
      results.push({ key, label: serviceDefinitions[key].label, status: "error", error: error.message, port: null, url: null, pid: null });
    }
  }
  notifyStatus();
  return results;
});
ipcMain.handle("open-workspace", (_event, key) => openWorkspace(key));
ipcMain.handle("kling-get-config", () => getKlingConfig());
ipcMain.handle("kling-list-assets", () => listKlingAssets());
ipcMain.handle("kling-get-latest-recoverable", () => getLatestRecoverableKlingRun());
ipcMain.handle("kling-create-run", (_event, payload) => createKlingRun(payload || {}));
ipcMain.handle("kling-get-run", (_event, runId) => klingRequest(`api/runs/${encodeURIComponent(runId)}`));
ipcMain.handle("kling-start-video", (_event, runId, voiceScript, videoMode, duration, keyframeTimes, confirmResubmit, voiceEnabled) => startKlingVideo(runId, voiceScript, videoMode, duration, keyframeTimes, confirmResubmit, voiceEnabled));
ipcMain.handle("kling-inspect-reference-audio", (_event, videoPath) => inspectReferenceAudio(videoPath));
ipcMain.handle("kling-resume-run", (_event, runId) => resumeKlingRun(runId));
ipcMain.handle("kling-retry-image", (_event, runId, indexes) => retryKlingImage(runId, indexes));
ipcMain.handle("voice-list", () => listVoices());
ipcMain.handle("voice-create", (_event, payload) => createVoice(payload || {}));
ipcMain.handle("voice-delete", (_event, voiceId) => deleteVoice(voiceId));
ipcMain.handle("voice-revoice-video", (_event, payload) => revoiceVideo(payload || {}));
ipcMain.handle("shot-get-config", () => shotRequest("api/config"));
ipcMain.handle("shot-list-assets", () => listShotAssets());
ipcMain.handle("shot-pick-folders", () => pickShotFolders());
ipcMain.handle("shot-create-run", (_event, payload) => createShotRun(payload || {}));
ipcMain.handle("shot-create-batch", (_event, payload) => createShotBatch(payload || {}));
ipcMain.handle("shot-get-run", (_event, runId) => shotRequest(`api/runs/${validateRunId(runId)}`));
ipcMain.handle("shot-resume-naming", (_event, runId) => shotRequest(`api/runs/${validateRunId(runId)}/resume-naming`, { method: "POST" }));
ipcMain.handle("shot-get-latest", () => getLatestShotRun());
ipcMain.handle("shot-get-batch", (_event, batchId) => shotRequest(`api/batches/${validateBatchId(batchId)}`));
ipcMain.handle("shot-resume-batch", (_event, batchId) => shotRequest(`api/batches/${validateBatchId(batchId)}/resume`, { method: "POST" }));
ipcMain.handle("shot-retry-batch-item", (_event, batchId, videoId) => shotRequest(`api/batches/${validateBatchId(batchId)}/items/${encodeURIComponent(videoId)}/retry`, { method: "POST" }));
ipcMain.handle("go-home", () => {
  if (!mainWindow || mainWindow.isDestroyed()) throw new Error("主窗口不可用");
  return loadRenderer().then(() => mainWindow.setTitle(productName));
});
ipcMain.handle("open-logs", async () => {
  await mkdir(clientDataRoot, { recursive: true });
  const error = await shell.openPath(clientDataRoot);
  if (error) throw new Error(error);
  return clientDataRoot;
});

app.whenReady().then(async () => {
  app.setAppUserModelId("ai.zhangyu.video-mix-agent");
  await ensureBuiltinVoices();
  await createMainWindow();
  if (!uiPreviewMode) void startServices();
});

async function startServices() {
  await Promise.all(Object.keys(serviceDefinitions).map(async (key) => {
    try { await startService(key); }
    catch (error) {
      const service = services.get(key) || { key, definition: serviceDefinitions[key] };
      service.status = "error";
      service.error = error.message;
      services.set(key, service);
    }
  }));
  notifyStatus();
}

app.on("before-quit", (event) => {
  if (stopping) return;
  event.preventDefault();
  stopping = true;
  void Promise.all([...services.values()].map(stopService)).finally(() => app.exit(0));
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
