import { app, BrowserWindow, Menu, dialog, ipcMain, safeStorage, shell } from "electron";
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, openAsBlob } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import os from "node:os";
import { createDiagnostics } from "./diagnostics.mjs";

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
const subtitleCredentialPath = path.join(app.getPath("userData"), "credentials", "wuhen.key");
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
    label: "商品替换",
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
const diagnostics = createDiagnostics({
  dataRoot: clientDataRoot,
  metadata: { version: app.getVersion(), platform: process.platform, arch: process.arch, osRelease: os.release(), electron: process.versions.electron, node: process.versions.node, packaged: app.isPackaged },
  privatePaths: [app.getPath("home"), projectRoot, resourceRoot, clientDataRoot]
});
let mainWindow;
let stopping = false;
let diagnosticExportPending = false;
const quickTunnelMaxAttempts = 4;
const quickTunnelRetryDelaysMs = [0, 1200, 2400, 4000];

async function loadDiagnosticSecrets() {
  const secretValues = [];
  for (const [key, value] of Object.entries(process.env)) {
    if (/(?:API_KEY|TOKEN|SECRET|PASSWORD|ACCESS_KEY)/i.test(key) && value) secretValues.push(value);
  }
  for (const definition of Object.values(serviceDefinitions)) {
    try {
      const content = await readFile(path.join(definition.cwd, ".env"), "utf8");
      for (const line of content.split(/\r?\n/)) {
        const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
        if (match && /(?:API_KEY|TOKEN|SECRET|PASSWORD|ACCESS_KEY)/i.test(match[1])) {
          const value = match[2].replace(/^(['"])(.*)\1$/, "$2");
          if (value) secretValues.push(value);
        }
      }
    } catch {}
  }
  try { const key = await readSubtitleCredential(); if (key) secretValues.push(key); } catch {}
  diagnostics.setSecrets(secretValues);
}

function diagnosticError(error) {
  return { name: error?.name, message: error?.message || String(error), code: error?.code, stack: error?.stack, cause: error?.cause ? { name: error.cause.name, message: error.cause.message, code: error.cause.code } : undefined };
}

async function diagnosticJsonRequest(module, endpoint, url, options, fallbackError) {
  const startedAt = Date.now();
  try {
    const response = await fetch(url, options);
    const body = await response.json().catch(() => ({}));
    const run = body?.run || body?.batch || body || {};
    const configuration = endpoint === "api/config" ? { ready: body?.configured, namingReady: body?.apiKeyConfigured, subtitleReady: body?.subtitleConfigured, model: body?.model, imageModel: body?.imageModel, videoModel: body?.videoModel } : undefined;
    void diagnostics.record("request.completed", { module, endpoint, method: options?.method || "GET", httpStatus: response.status, durationMs: Date.now() - startedAt, runId: run.id || run.runId || body?.runId || body?.batchId, stage: run.stage, status: run.status, requestId: body?.request_id || response.headers.get("x-request-id"), cloudTaskId: run.videoTaskId, configuration });
    const failedItems = (Array.isArray(body?.items) ? body.items : Array.isArray(run.items) ? run.items : [])
      .filter(item => String(item.status).toLowerCase() === "failed" || item.error || item.namingError)
      .map(item => ({ videoId: item.videoId, stage: item.stage, failedStage: item.failedStage, status: item.status, failedAt: item.updatedAt || item.finishedAt,
        error: item.error, namingError: item.namingError, errorRecord: item.errorRecord ? diagnosticError(item.errorRecord) : undefined }));
    if (response.ok && (String(run.status).toLowerCase() === "failed" || run.error || run.namingError || failedItems.length)) {
      void diagnostics.record("task.failed", { module, endpoint, runId: run.id || run.runId || run.batchId || body?.runId || body?.batchId,
        stage: run.stage, status: run.status, failedAt: run.updatedAt || run.finishedAt, error: run.error || run.message, namingError: run.namingError, cloudTaskId: run.videoTaskId, failedItems }, "error");
    }
    if (!response.ok) throw new Error(body.error || body.message || body.code || `${fallbackError}：HTTP ${response.status}`);
    return body;
  } catch (error) {
    void diagnostics.record("request.failed", { module, endpoint, durationMs: Date.now() - startedAt, error: diagnosticError(error) }, "error");
    throw error;
  }
}

function handleClientIpc(channel, handler) {
  const tracked = /^(?:kling-(?:create|start|resume|retry|stop)|voice-(?:create|delete|revoice)|shot-(?:create|resume|retry|cancel)|library-export)/.test(channel);
  ipcMain.handle(channel, async (...args) => {
    const startedAt = Date.now();
    if (tracked) void diagnostics.record("operation.started", { channel });
    try {
      const result = await handler(...args);
      if (tracked) {
        const run = result?.run || result?.batch || result;
        void diagnostics.record("operation.completed", { channel, durationMs: Date.now() - startedAt, runId: run?.id || result?.runId || result?.batchId, stage: run?.stage, status: run?.status });
      }
      return result;
    } catch (error) {
      void diagnostics.record("operation.failed", { channel, durationMs: Date.now() - startedAt, error: diagnosticError(error) }, "error");
      throw error;
    }
  });
}

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

async function waitForHealth(baseUrl, healthPath, timeoutMs = 10000, signal) {
  const startedAt = Date.now();
  let lastError = "服务尚未响应";
  while (Date.now() - startedAt < timeoutMs) {
    signal?.throwIfAborted();
    try {
      const remainingMs = Math.max(1, timeoutMs - (Date.now() - startedAt));
      const requestTimeout = AbortSignal.timeout(Math.min(2500, remainingMs));
      const response = await fetch(`${baseUrl}${healthPath}`, { signal: signal ? AbortSignal.any([signal, requestTimeout]) : requestTimeout });
      if (response.ok) return await response.json();
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      signal?.throwIfAborted();
      lastError = error.message;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  signal?.throwIfAborted();
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
      void diagnostics.record("tunnel.output", { module: service.key, message: text });
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
  const body = await diagnosticJsonRequest("shot", pathname.split("?")[0], new URL(pathname, serviceUrl(service)), options, "镜头切分服务请求失败");
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

const KLING_IMAGE_PROMPT = "将第一张图片中人物手中的物品自然地替换成第二张的主体物品";
const KLING_MULTI_PRODUCT_IMAGE_PROMPT = "将第一张图片中人物手中的物品自然地替换成其余参考图片中的同一主体物品";

const klingDurations = new Set([5, 8, 10, 15]);
const klingOmniDurations = new Set([5, 10, 15]);
const KLING_OMNI_PROMPT_MAX_BYTES = 3072;
const normalizeKlingDuration = (value) => klingDurations.has(Number(value)) ? Number(value) : 5;

function klingVideoPrompt(script, videoMode = "first_frame", duration = 5, keyframeTimes = []) {
  const seconds = normalizeKlingDuration(duration);
  if (videoMode === "multi_keyframes") {
    const anchors = keyframeTimes.map((time, index) => index === 0
      ? "<Picture 1> is the opening frame of [Shot 1] at 0.00 seconds and defines the camera composition, person placement, product distance, apparent size, and natural holding position."
      : `<Picture ${index + 1}> provides appearance, scene, and hand-contact references from the source moment at approximately ${Number(time).toFixed(2)} seconds. Its details guide the corresponding phase while the opening frame defines the camera and product staging.`).join("\n");
    const pictureRetention = keyframeTimes.map((_, index) => index === 0
      ? "<Picture 1> ([Shot 1] first frame): fully_preserved - the opening composition, person placement, product appearance, distance, and holding position are retained."
      : `<Picture ${index + 1}> ([Shot 1] appearance and contact reference): partially_preserved - person identity, product details, setting, and realistic hand contact are retained; posture adapts to the opening frame's stable camera and product staging.`).join("\n");
    const audioDefinition = script ? "\n<Audio 1> is the voice-timbre and delivery reference for <Subject 1> (S1)." : "";
    const audioRetention = script ? "\n<Audio 1>: reference - its timbre, accent, and delivery guide the newly spoken dialogue of <Subject 1>." : "";
    const speech = script
      ? `<Subject 1> (S1) speaks naturally in Mandarin, using the voice timbre and delivery of <Audio 1>, and says exactly: <d>[Chinese] ${script}</d> The audible dialogue consists exclusively of this line, with every word and punctuation mark preserved. The lips and jaw move in sync with the spoken words. The line is delivered once at a natural pace within ${seconds} seconds. As the line ends, the lips settle into a relaxed resting position and the person continues breathing and blinking quietly through the final frame.`
      : "<Subject 1> remains quietly present, with relaxed resting lips, gentle breathing, occasional blinking, and subtle facial expressions throughout the shot.";
    return `subject_definitions:
<Subject 1> is the person holding the product in the supplied pictures. Their identity, face, clothing, and position in the scene are defined by these pictures.
<Subject 2> is the replacement product held by <Subject 1>, with its shape, proportions, material, colors, branding, and visible details defined by the supplied pictures.
${anchors}${audioDefinition}

summary:
[keyframe completion${keyframeTimes.length > 1 ? " + reference generation" : ""}${script ? " + audio reference" : ""}] Generate one continuous, realistic ${seconds}-second shot beginning from <Picture 1> and using the later pictures as appearance and contact references. <Subject 1> holds <Subject 2> naturally in the established scene${script ? " and speaks the specified Mandarin line with the voice referenced from <Audio 1>" : ""}. The camera remains fixed and the product stays at a stable distance from the person and the camera.

retention_analysis:
<Subject 1> (appears in [Shot 1]): fully_preserved - identity, face, clothing, and position in the scene remain consistent with the pictures.
<Subject 2> (appears in [Shot 1]): fully_preserved - product shape, proportions, materials, colors, branding, and visible details remain consistent with the pictures.
${pictureRetention}${audioRetention}

detailed_description:
The video has the realistic photographic style, lighting, and environment established by the supplied pictures.
[Shot 1] The shot begins from <Picture 1>. <Subject 1> holds <Subject 2> in the natural position established by this opening picture. The camera holds a static shot for the entire ${seconds} seconds. Its position, viewing angle, focal length, framing, and focus remain constant. The person and the surrounding background keep their original placement in this composition.

<Subject 2> remains steadily held at the original depth, maintaining the distance from the camera and its apparent size established in <Picture 1>. The arms remain comfortably positioned around the initial holding position. The fingers maintain realistic contact and support, with the same visible product surfaces and a consistent orientation. Small changes in the hands and shoulders follow the person’s gentle breathing while the product remains stable relative to the body.

The later pictures guide the appearance and hand-contact details of the same person, product, and scene through successive phases. Use small, smooth changes in facial expression and natural holding posture that fit the opening frame's camera composition, stable product distance, and apparent size. The opening frame's staging takes priority throughout the shot. The movement stays restrained and continuous, with the person, hands, and product sharing a physically consistent motion.

${speech}

Light, shadows, reflections, product details, and existing scene text remain consistent with the reference pictures as the person breathes and moves naturally. The shot settles into a calm, steady final moment with the product still supported in the original holding area.

overall_soundscape:
${script ? "Quiet natural ambience appropriate to the reference scene remains softly audible beneath the speech." : "N/A"}

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
  const body = await diagnosticJsonRequest("remake", pathname.split("?")[0], new URL(pathname, serviceUrl(service)), options, "商品替换服务请求失败");
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

async function uploadKlingMedia(runId, filePath, kind, category, name = path.basename(filePath), attachToRun = true) {
  const query = new URLSearchParams({ runId, kind, category, name });
  if (!attachToRun) query.set("attach", "false");
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

async function createKlingRun({ videoPath, productPaths, productPath, voiceScript, audioMode, videoMode, duration, voiceId, productSubject }) {
  const selectedProductPaths = Array.isArray(productPaths) ? productPaths : productPath ? [productPath] : [];
  if (!videoPath || !selectedProductPaths.length || selectedProductPaths.some(filePath => typeof filePath !== "string" || !filePath.trim())) throw new Error("请先选择产品图和参考视频");
  if (selectedProductPaths.length > 3) throw new Error("最多上传 3 张商品参考图");
  const selectedVideoMode = videoMode === "reference_video" ? "reference_video" : "multi_keyframes";
  if (selectedVideoMode === "reference_video" && selectedProductPaths.length !== 1) throw new Error("当前参考原视频模式仅支持 1 张商品图");
  const selectedProductSubject = String(productSubject || "").trim();
  if (selectedProductSubject.length > 200) throw new Error("替换主体说明不能超过 200 字");
  const baseImagePrompt = selectedProductPaths.length > 1 ? KLING_MULTI_PRODUCT_IMAGE_PROMPT : KLING_IMAGE_PROMPT;
  const imagePrompt = selectedProductSubject
    ? `${baseImagePrompt}\n\n商品参考图中用于替换的主体为：${selectedProductSubject}。商品参考图里的其他物品和背景不作为替换内容。`
    : baseImagePrompt;
  const script = selectedVideoMode === "reference_video" ? "" : String(voiceScript || "").trim();
  const voiceEnabled = selectedVideoMode !== "reference_video" && audioMode !== "silent";
  const selectedVoice = voiceEnabled ? await resolveVoice(voiceId) : null;
  const selectedVoiceSource = voiceEnabled ? "upload" : "source_video";
  if (voiceEnabled && !script) throw new Error("声音与口型开启时请输入台词");
  if (voiceEnabled && !selectedVoice?.samplePath) throw new Error("所选声音缺少本地参考样本，请重新创建声音");
  const config = await klingRequest("api/config");
  if (selectedVideoMode !== "reference_video" && !config.imageConfigured) throw new Error("图片生成服务尚未配置，请先配置 WawAPI 密钥");
  if (selectedVideoMode === "reference_video" ? !config.klingConfigured : !config.configured) throw new Error(selectedVideoMode === "reference_video" ? "参考原视频服务尚未配置" : "商品替换的视频生成服务尚未配置");
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
      uploadKlingMedia(runId, selectedProductPaths[0], "image", "inputs/product-image")
    ]);
    return klingRequest("api/runs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ runId, sourceVideoId: sourceVideo.id, productImageId: productImage.id, productSubject: selectedProductSubject, imagePrompt, videoPrompt, voiceScript: script, audioMode: audioMode === "silent" ? "silent" : "voice", videoMode: selectedVideoMode, publicBaseUrl, resolution: "720P", duration: selectedDuration }) });
  }
  const { runId } = await klingRequest("api/run-id", { method: "POST" });
  const publicBaseUrl = null; // WawAPI edits uploads files directly.
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
    const [sourceVideo, productImages, keyframes] = await Promise.all([
      uploadKlingMedia(runId, videoPath, "video", "inputs/source-video"),
      Promise.all(selectedProductPaths.map(filePath => uploadKlingMedia(runId, filePath, "image", "inputs/product-image", path.basename(filePath), false))),
      Promise.all(keyframePaths.map((filePath, index) => uploadKlingMedia(runId, filePath, "image", "keyframes/source", `keyframe-${index + 1}.png`)))
    ]);
    const voiceAudio = voiceEnabled
      ? await uploadKlingMedia(runId, selectedVoice.samplePath, "audio", "inputs/voice-audio")
      : null;
    return klingRequest("api/runs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ runId, sourceVideoId: sourceVideo.id, productImageIds: productImages.map(item => item.id), productSubject: selectedProductSubject, voiceAudioId: voiceAudio?.id || null, voiceName: selectedVoice?.name || null, voiceSource: selectedVoiceSource, keyframeIds: keyframes.map((item) => item.id), keyframeTimes, imagePrompt, videoPrompt: klingVideoPrompt(script, selectedVideoMode, selectedDuration, keyframeTimes), voiceScript: script, audioMode: voiceEnabled ? "voice" : "silent", videoMode: selectedVideoMode, publicBaseUrl, resolution: "768P", duration: selectedDuration }) });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function startKlingVideo(runId, voiceScript, videoMode, duration, keyframeTimes, confirmResubmit = false, voiceEnabled = true, voiceId = null) {
  const selectedVideoMode = videoMode === "reference_video" ? "reference_video" : "multi_keyframes";
  const selectedDuration = normalizeKlingDuration(duration);
  const publicBaseUrl = selectedVideoMode === "reference_video" ? await ensureQuickTunnel(getReadyKlingService()) : null;
  if (selectedVideoMode === "reference_video" && !klingOmniDurations.has(selectedDuration)) throw new Error("Kling 3.0 Omni 参考视频模式仅支持 5、10 或 15 秒");
  const resolution = selectedVideoMode === "reference_video" ? "720P" : "768P";
  const normalizedVoiceScript = voiceEnabled ? String(voiceScript || "").trim() : "";
  let voiceUpdate = {};
  if (selectedVideoMode !== "reference_video" && voiceEnabled && voiceId) {
    const voice = await resolveVoice(voiceId);
    if (!voice.samplePath) throw new Error("所选声音缺少本地参考样本，请重新创建声音");
    const uploaded = await uploadKlingMedia(runId, voice.samplePath, "audio", "inputs/voice-audio", undefined, false);
    voiceUpdate = { voiceAudioId: uploaded.id, voiceName: voice.name, voiceId: voice.id, voiceSource: "upload" };
  }
  const videoPrompt = klingVideoPrompt(normalizedVoiceScript, selectedVideoMode, selectedDuration, Array.isArray(keyframeTimes) ? keyframeTimes : []);
  if (selectedVideoMode === "reference_video" && Buffer.byteLength(videoPrompt, "utf8") > KLING_OMNI_PROMPT_MAX_BYTES) throw new Error("Kling 3.0 Omni 提示词超过 3072 字节，请缩短台词");
  return klingRequest(`api/runs/${encodeURIComponent(runId)}/video`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ videoPrompt, voiceScript: normalizedVoiceScript, audioMode: voiceEnabled ? "voice" : "silent", videoMode: selectedVideoMode, publicBaseUrl, resolution, duration: selectedDuration, confirmResubmit, ...voiceUpdate }) });
}

async function resumeKlingRun(runId) {
  return klingRequest(`api/runs/${encodeURIComponent(runId)}/resume`, { method: "POST" });
}

async function stopKlingRun(runId, stage) {
  if (typeof runId !== "string" || !runId || !["image", "video"].includes(stage)) throw new Error("未找到可中止的任务");
  return klingRequest(`api/runs/${encodeURIComponent(runId)}/stop`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ stage }) });
}

async function retryKlingImage(runId, indexes, continueOnly = false) {
  return klingRequest(`api/runs/${encodeURIComponent(runId)}/image/retry`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ indexes: Array.isArray(indexes) ? indexes : [], continueOnly }) });
}

async function listKlingAssets() {
  const response = await klingRequest("api/runs");
  let revoicedAssets = [];
  try {
    const files = await readdir(revoicedOutputRoot);
    revoicedAssets = (await Promise.all(files.filter((name) => name.endsWith(".json")).map(async (name) => {
      try {
        const meta = JSON.parse(await readFile(path.join(revoicedOutputRoot, name), "utf8"));
        if (!meta.path || !(await stat(localTaskFile(revoicedOutputRoot, meta.path))).isFile()) return null;
        return { kind: "video", runId: meta.runId, sourceId: meta.runId, sourceFilename: meta.sourceFilename || "商品替换", sourceFolderName: path.parse(meta.sourceFilename || "商品替换").name, workflow: "remake", name: meta.name || "商品替换成片_克隆配音.mp4", relativeUrl: pathToFileURL(meta.path).toString(), completedAt: meta.completedAt, audioMode: "voice", voiceName: meta.voiceName };
      } catch { return null; }
    }))).filter(Boolean);
  } catch {}
  revoicedAssets = [...new Map(revoicedAssets.sort((a, b) => String(a.completedAt || "").localeCompare(String(b.completedAt || ""))).map((asset) => [asset.runId, asset])).values()];
  const revoicedRunIds = new Set(revoicedAssets.map((asset) => asset.runId));
  const providerAssets = (await Promise.all((response.runs || []).map(async (run) => {
    if (revoicedRunIds.has(run.id) || !/^[a-zA-Z0-9_.-]+$/.test(run.id)) return [];
    try {
      const runRoot = localTaskFile(klingRunsDir, run.id);
      const savedRun = JSON.parse(await readFile(path.join(runRoot, "run.json"), "utf8"));
      const hasLocalFile = async (item) => {
        try { return Boolean(item?.path) && (await stat(localTaskFile(runRoot, item.path))).isFile(); }
        catch { return false; }
      };
      const common = { runId: run.id, sourceId: run.id, sourceFilename: run.sourceVideo?.name || "商品替换", sourceFolderName: path.parse(run.sourceVideo?.name || "商品替换").name, workflow: "remake", completedAt: run.updatedAt || run.createdAt, audioMode: run.audioMode || "voice" };
      if (run.output?.url && await hasLocalFile(savedRun.output)) {
        return [{ ...common, kind: "video", name: run.output.name || "商品替换成片.mp4", relativeUrl: run.output.url }];
      }
      const images = (await Promise.all((run.editedKeyframes || []).map(async (item, index) => {
        const savedItem = (savedRun.editedKeyframes || []).find((entry) => entry?.id === item?.id);
        if (!item?.id || !item.url || !await hasLocalFile(savedItem)) return null;
        const extension = path.extname(item.name || "") || ".png";
        return { ...common, kind: "image", mediaId: item.id, name: `关键帧${index + 1}${extension}`, relativeUrl: item.url };
      }))).filter(Boolean);
      if (images.length) return images;
      const item = run.editedImage;
      if (!item?.id || !item.url || savedRun.editedImage?.id !== item.id || !await hasLocalFile(savedRun.editedImage)) return [];
      const extension = path.extname(item.name || "") || ".png";
      return [{ ...common, kind: "image", mediaId: item.id, name: `关键帧1${extension}`, relativeUrl: item.url }];
    } catch { return []; }
  }))).flat();
  return {
    baseUrl: response.baseUrl,
    assets: [...revoicedAssets, ...providerAssets]
  };
}

async function getLatestRecoverableKlingRun() {
  const response = await klingRequest("api/runs");
  const run = (response.runs || []).find((entry) => {
    if (entry.userStopped) return false;
    const status = String(entry.status || "").toUpperCase();
    if (entry.stage === "image" && entry.imageProvider === "wawapi" && !entry.output?.url) return true;
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
const voicePreviewText = "你好，这里是我的声音。希望接下来的作品，能带给你不一样的惊喜。";

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
    hasGeneratedPreview: Boolean(voice.previewPath),
    sampleUrl: voice.previewPath || voice.samplePath ? pathToFileURL(voice.previewPath || voice.samplePath).toString() : null
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
  const body = await diagnosticJsonRequest("voice", pathname, `${dashscopeApiBase}/${pathname}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  }, "声音服务请求失败");
  return body;
}

async function createVoice({ sourcePath, name }) {
  if (!sourcePath) throw new Error("请先上传一段参考音频");
  const duration = await videoDurationSeconds(sourcePath);
  if (duration < 8 || duration > 15) throw new Error("参考音频时长需在 8–15 秒之间");
  await mkdir(voiceDataRoot, { recursive: true });
  const localId = `voice_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  const samplePath = path.join(voiceDataRoot, `${localId}.mp3`);
  const previewPath = path.join(voiceDataRoot, `${localId}-preview.wav`);
  await execFileAsync(runtimeFfmpegPath, ["-y", "-i", sourcePath, "-map", "0:a:0", "-vn", "-ac", "1", "-ar", "24000", "-c:a", "libmp3lame", "-b:a", "96k", samplePath], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 });

  let voiceId = null;
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
    voiceId = response.output?.voice_id;
    if (!voiceId) throw new Error("声音服务没有返回音色 ID");
    const previewResponse = await dashscopeRequest("SpeechSynthesizer", {
      model: voiceTargetModel,
      input: { text: voicePreviewText, voice: voiceId, format: "wav", sample_rate: 24000, rate: 1, pitch: 1, language_hints: ["zh"] }
    });
    const previewUrl = previewResponse.output?.audio?.url;
    if (!previewUrl) throw new Error("声音服务没有返回试听音频");
    const audioResponse = await fetch(previewUrl);
    if (!audioResponse.ok) throw new Error("试听音频下载失败，请稍后重试");
    await writeFile(previewPath, Buffer.from(await audioResponse.arrayBuffer()));
    const voices = await readVoiceRegistry();
    const voice = { id: voiceId, name: String(name || "新音色").trim().slice(0, 20) || "新音色", model: voiceTargetModel, createdAt: new Date().toISOString(), duration, samplePath, previewPath, previewText: voicePreviewText, enrollmentRequestId: response.request_id || null, previewRequestId: previewResponse.request_id || null };
    voices.unshift(voice);
    await writeVoiceRegistry(voices);
    return publicVoice(voice);
  } catch (error) {
    await rm(samplePath, { force: true });
    await rm(previewPath, { force: true });
    if (voiceId) {
      try { await dashscopeRequest("customization", { model: "voice-enrollment", input: { action: "delete_voice", voice_id: voiceId } }); } catch {}
    }
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
  if (voice.previewPath) await rm(voice.previewPath, { force: true });
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

async function readSubtitleCredential() {
  try {
    if (!safeStorage.isEncryptionAvailable()) return "";
    return safeStorage.decryptString(await readFile(subtitleCredentialPath));
  } catch { return ""; }
}

async function configureSubtitles(apiKey) {
  if (typeof apiKey !== "string" || !apiKey.trim() || apiKey.trim().length > 512 || /[\r\n\x00]/.test(apiKey)) throw new Error("请输入有效的去字幕服务密钥");
  if (!safeStorage.isEncryptionAvailable()) throw new Error("系统安全存储不可用，未保存密钥");
  const key = apiKey.trim();
  await mkdir(path.dirname(subtitleCredentialPath), { recursive: true });
  const temporary = `${subtitleCredentialPath}.tmp`;
  await writeFile(temporary, safeStorage.encryptString(key));
  await rename(temporary, subtitleCredentialPath);
  try {
    await shotRequest("api/subtitle-config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ apiKey: key }) });
    return shotRequest("api/config");
  } catch { throw new Error("密钥已安全保存，但服务暂未更新。请重新打开客户端后再试。"); }
}

async function prepareSubtitleTunnel() {
  const service = getReadyShotService();
  const config = await shotRequest("api/config");
  if (!config.subtitleConfigured) throw new Error("请先配置无痕去字幕服务");
  const port = Number(config.subtitleTransportPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("去字幕文件通道尚未就绪");
  if (!service.subtitleTunnel || service.subtitleTunnel.port !== port) {
    if (service.subtitleTunnel) await stopChild(service.subtitleTunnel.tunnelChild);
    service.subtitleTunnel = { port, definition: { healthPath: "/api/health", publicPath: "/" }, output: [] };
  }
  const publicBaseUrl = await ensureQuickTunnel(service.subtitleTunnel);
  await shotRequest("api/subtitle-transport", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ publicBaseUrl }) });
}

async function createShotRun({ filePath, workflow, keepAudio = true, removeSubtitles = false }) {
  if (!filePath || typeof filePath !== "string") throw new Error("未找到视频文件路径");
  const selectedWorkflow = workflow === "ffmpeg_gemini_naming" ? workflow : "ffmpeg_only";
  if (selectedWorkflow === "ffmpeg_gemini_naming") {
    const config = await shotRequest("api/config");
    if (!config.apiKeyConfigured) throw new Error("命名服务未配置");
  }
  if (removeSubtitles) await prepareSubtitleTunnel();
  const form = new FormData();
  form.append("video", await openAsBlob(filePath), path.basename(filePath));
  form.append("workflow", selectedWorkflow);
  form.append("keepAudio", keepAudio === false ? "off" : "on");
  form.append("removeSubtitles", removeSubtitles === true ? "on" : "off");
  if (removeSubtitles) form.append("subtitleOptions", JSON.stringify({ model: "video_removal_std", method: "sel_area" }));
  return shotRequest("api/runs", { method: "POST", body: form });
}

async function createShotBatch({ entries, filePaths, workflow, keepAudio = true, removeSubtitles = false }) {
  const normalizedEntries = Array.isArray(entries) && entries.length
    ? entries.map((entry) => typeof entry === "string" ? { path: entry } : entry)
    : (Array.isArray(filePaths) ? filePaths.map((filePath) => ({ path: filePath })) : []);
  if (normalizedEntries.length < 1 || normalizedEntries.length > 25 || normalizedEntries.some((entry) => !entry?.path || typeof entry.path !== "string")) throw new Error("批量处理需要选择 1–25 个视频");
  const selectedWorkflow = workflow === "ffmpeg_gemini_naming" ? workflow : "ffmpeg_only";
  if (selectedWorkflow === "ffmpeg_gemini_naming") {
    const config = await shotRequest("api/config");
    if (!config.apiKeyConfigured) throw new Error("命名服务未配置");
  }
  if (removeSubtitles) await prepareSubtitleTunnel();
  const form = new FormData();
  for (const entry of normalizedEntries) form.append("videos", await openAsBlob(entry.path), path.basename(entry.path));
  form.append("folderManifest", JSON.stringify(normalizedEntries.map((entry) => ({
    sourceFolderId: entry.folderId || null,
    sourceFolderName: entry.folderName || null,
    sourceRelativePath: entry.relativePath || path.basename(entry.path)
  }))));
  form.append("workflow", selectedWorkflow);
  form.append("keepAudio", keepAudio === false ? "off" : "on");
  form.append("removeSubtitles", removeSubtitles === true ? "on" : "off");
  if (removeSubtitles) form.append("subtitleOptions", JSON.stringify({ model: "video_removal_std", method: "sel_area" }));
  return shotRequest("api/batches", { method: "POST", body: form });
}

async function resumeShotBatch(batchId, videoId = null) {
  const id = validateBatchId(batchId);
  const response = await shotRequest(`api/batches/${id}`);
  if (response.batch?.removeSubtitles && response.batch.status !== "completed") await prepareSubtitleTunnel();
  const endpoint = videoId ? `api/batches/${id}/items/${encodeURIComponent(videoId)}/retry` : `api/batches/${id}/resume`;
  return shotRequest(endpoint, { method: "POST" });
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
    for (const videoPath of videos) entries.push({ path: videoPath, url: pathToFileURL(videoPath).toString(), name: path.basename(videoPath), sizeBytes: (await stat(videoPath)).size, folderId, folderName, relativePath: path.relative(folderPath, videoPath) });
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

function exportFolderName(value) {
  const name = String(value || "任务结果").replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/[. ]+$/g, "").trim();
  return (name || "任务结果").slice(0, 80);
}

function exportClipName(asset) {
  const original = String(asset.name || "未命名素材.mp4");
  const extension = path.extname(original) || ".mp4";
  let title = String(asset.contentTitle || "").trim();
  if (!title) {
    title = path.basename(original, extension).replace(/^\d{1,4}[_\-\s]+/, "");
    const usage = String(asset.usageType || "").trim();
    if (usage) {
      const suffix = new RegExp(`[_\\-\\s]+${usage.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i");
      title = title.replace(suffix, "");
    }
  }
  return `${exportFolderName(title).slice(0, 80 - extension.length)}${extension}`;
}

function localTaskFile(root, ...parts) {
  const target = path.resolve(root, ...parts);
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("任务文件路径无效");
  return target;
}

async function exportLibraryTask({ kind, runId, sourceId, name } = {}) {
  if (typeof runId !== "string" || typeof sourceId !== "string") throw new Error("任务信息不完整");
  const files = [];
  if (kind === "split") {
    if (runId.startsWith("batch_")) validateBatchId(runId);
    else validateRunId(runId);
    const { assets } = await listShotAssets();
    const selected = assets.filter((asset) => asset.runId === runId && asset.sourceId === sourceId);
    for (const asset of selected) {
      const source = localTaskFile(path.join(shotRunsDir, runId), asset.relativePath);
      const folders = asset.usageType ? [exportFolderName(asset.usageType)] : [];
      files.push({ source, folders, name: exportClipName(asset) });
    }
  } else if (kind === "remake") {
    if (sourceId !== runId || !/^[a-zA-Z0-9_.-]+$/.test(runId)) throw new Error("任务信息无效");
    const { assets } = await listKlingAssets();
    const selected = assets.filter((entry) => entry.runId === runId && entry.sourceId === sourceId);
    const exportAssets = selected.some((asset) => asset.kind !== "image") ? selected.slice(0, 1) : selected;
    for (const asset of exportAssets) {
      let source;
      if (asset.relativeUrl.startsWith("file:")) {
        source = fileURLToPath(asset.relativeUrl);
        const relative = path.relative(revoicedOutputRoot, source);
        if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("成片路径无效");
      } else {
        const run = JSON.parse(await readFile(path.join(klingRunsDir, runId, "run.json"), "utf8"));
        if (asset.kind === "image") {
          const frame = (run.editedKeyframes || []).find((item) => item?.id === asset.mediaId)
            || (run.editedImage?.id === asset.mediaId ? run.editedImage : null);
          if (!frame?.path) throw new Error("未找到本地替换关键帧");
          source = localTaskFile(localTaskFile(klingRunsDir, runId), frame.path);
        } else {
          if (!run.output?.path) throw new Error("未找到本地成片");
          source = localTaskFile(path.join(klingRunsDir, runId), "output", path.basename(run.output.path));
        }
      }
      files.push({ source, folders: [], name: exportFolderName(asset.name) });
    }
  } else throw new Error("不支持的任务类型");
  if (!files.length) throw new Error("当前任务没有可导出的本地结果");
  for (const file of files) {
    try { if (!(await stat(file.source)).isFile()) throw new Error("不是文件"); }
    catch { throw new Error(`任务结果文件已移动或丢失：${file.name}`); }
  }

  const selection = await dialog.showOpenDialog(mainWindow, { title: "选择任务结果的保存位置", properties: ["openDirectory", "createDirectory"] });
  if (selection.canceled || !selection.filePaths.length) return { canceled: true };
  const parent = selection.filePaths[0];
  const baseName = exportFolderName(name);
  let destination;
  for (let index = 1; index <= 1000; index += 1) {
    const candidate = path.join(parent, index === 1 ? baseName : `${baseName} (${index})`);
    try { await mkdir(candidate); destination = candidate; break; }
    catch (error) { if (error.code !== "EEXIST") throw error; }
  }
  if (!destination) throw new Error("保存位置已有过多同名文件夹");
  const usedNames = new Set();
  for (const file of files) {
    let target = path.join(destination, ...file.folders, file.name);
    const original = path.parse(target);
    for (let index = 2; usedNames.has(target.toLowerCase()); index += 1) target = path.join(original.dir, `${original.name} (${index})${original.ext}`);
    usedNames.add(target.toLowerCase());
    try {
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(file.source, target);
    } catch (error) {
      throw new Error(`导出中断，已复制的文件保存在 ${destination}。${error.message}`);
    }
  }
  return { canceled: false, destination, count: files.length };
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
    const subtitleKey = await readEnvValue(path.join(definition.cwd, ".env"), "WUHEN_API_KEY") || process.env.WUHEN_API_KEY || await readSubtitleCredential();
    if (subtitleKey) env.WUHEN_API_KEY = subtitleKey;
  } else if (key === "kling") {
    env.RUNS_DIR = klingRunsDir;
    env.PUBLIC_DIR = path.join(definition.cwd, "public");
    const moduleKey = await readEnvValue(path.join(definition.cwd, ".env"), "XINHANKR_API_KEY");
    const shotKey = await readEnvValue(path.join(serviceDefinitions.shot.cwd, ".env"), "XINHANKR_API_KEY");
    if (moduleKey || shotKey) env.XINHANKR_API_KEY = moduleKey || shotKey;
  }

  const service = { key, definition, port, status: "starting", error: null, output: [] };
  const startupController = new AbortController();
  const startupStartedAt = Date.now();
  service.startupController = startupController;
  void diagnostics.record("service.starting", { module: key, port });
  const child = spawn(process.execPath, [definition.entry], {
    cwd: definition.cwd,
    env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  service.child = child;
  services.set(key, service);
  const capture = (chunk, stream) => {
    service.output.push(String(chunk).trim());
    service.output = service.output.slice(-80);
    void diagnostics.record("service.output", { module: key, stream, message: String(chunk) });
  };
  child.stdout.on("data", (chunk) => capture(chunk, "stdout"));
  child.stderr.on("data", (chunk) => capture(chunk, "stderr"));
  child.once("error", (error) => {
    startupController.abort(error);
    service.status = "error";
    service.error = error.message;
    void diagnostics.record("service.error", { module: key, error: diagnosticError(error) }, "error");
  });
  child.once("exit", (code, signal) => {
    const expected = stopping || Boolean(service.expectedStop);
    void diagnostics.record("service.exited", { module: key, code, signal, expected }, expected ? "info" : "error");
    if (!expected && service.status !== "ready") {
      service.status = "error";
      service.error = `进程退出：code=${code ?? "null"}, signal=${signal ?? "null"}`;
      startupController.abort(new Error(service.error));
    } else if (!expected) {
      service.status = "stopped";
    }
    notifyStatus();
  });

  try {
    // Local cold starts can involve dependency loading and historical input cleanup.
    // Keep the public tunnel's shorter budgets unchanged; fail early on child exit.
    await waitForHealth(`http://127.0.0.1:${port}`, definition.healthPath, 30000, startupController.signal);
    service.status = "ready";
    void diagnostics.record("service.ready", { module: key, port, durationMs: Date.now() - startupStartedAt });
    notifyStatus();
    if (key === "kling") {
      void ensureQuickTunnel(service, { freshAttemptsAfterSharedFailure: false }).then(notifyStatus).catch((error) => {
        service.tunnelError = error.message;
        service.tunnelUrl = null;
        service.output.push(`[tunnel] ${error.message}`);
        void diagnostics.record("tunnel.failed", { module: key, error: diagnosticError(error) }, "error");
        notifyStatus();
      });
    }
    return service;
  } catch (error) {
    service.status = "error";
    service.error = error.message;
    void diagnostics.record("service.start_failed", { module: key, durationMs: Date.now() - startupStartedAt, error: diagnosticError(error) }, "error");
    await stopService(service);
    service.status = "error";
    service.error = error.message;
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
  service.expectedStop = true;
  service.startupController?.abort(new Error("服务启动已中止"));
  service.status = "stopping";
  await Promise.all([stopChild(service.tunnelChild), stopChild(service.subtitleTunnel?.tunnelChild), stopChild(service.child)]);
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
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    void diagnostics.record("renderer.process_gone", { reason: details.reason, exitCode: details.exitCode }, "error");
  });
  mainWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription, _url, isMainFrame) => {
    if (isMainFrame) void diagnostics.record("renderer.load_failed", { errorCode, message: errorDescription }, "error");
  });
  return loadRenderer();
}

handleClientIpc("get-services", () => [...services.values()].map(serializeService));
handleClientIpc("start-services", async () => {
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
handleClientIpc("open-workspace", (_event, key) => openWorkspace(key));
handleClientIpc("kling-get-config", () => getKlingConfig());
handleClientIpc("kling-list-assets", () => listKlingAssets());
handleClientIpc("kling-get-latest-recoverable", () => getLatestRecoverableKlingRun());
handleClientIpc("kling-create-run", (_event, payload) => createKlingRun(payload || {}));
handleClientIpc("kling-get-run", (_event, runId) => klingRequest(`api/runs/${encodeURIComponent(runId)}`));
handleClientIpc("kling-start-video", (_event, runId, voiceScript, videoMode, duration, keyframeTimes, confirmResubmit, voiceEnabled, voiceId) => startKlingVideo(runId, voiceScript, videoMode, duration, keyframeTimes, confirmResubmit, voiceEnabled, voiceId));
handleClientIpc("kling-inspect-reference-audio", (_event, videoPath) => inspectReferenceAudio(videoPath));
handleClientIpc("kling-resume-run", (_event, runId) => resumeKlingRun(runId));
handleClientIpc("kling-stop-run", (_event, runId, stage) => stopKlingRun(runId, stage));
handleClientIpc("kling-retry-image", (_event, runId, indexes, continueOnly) => retryKlingImage(runId, indexes, continueOnly));
handleClientIpc("voice-list", () => listVoices());
handleClientIpc("voice-create", (_event, payload) => createVoice(payload || {}));
handleClientIpc("voice-delete", (_event, voiceId) => deleteVoice(voiceId));
handleClientIpc("voice-revoice-video", (_event, payload) => revoiceVideo(payload || {}));
handleClientIpc("shot-get-config", () => shotRequest("api/config"));
handleClientIpc("shot-configure-subtitles", (_event, apiKey) => configureSubtitles(apiKey));
handleClientIpc("shot-list-assets", () => listShotAssets());
handleClientIpc("library-export-task", (_event, payload) => exportLibraryTask(payload));
handleClientIpc("shot-pick-folders", () => pickShotFolders());
handleClientIpc("shot-create-run", (_event, payload) => createShotRun(payload || {}));
handleClientIpc("shot-create-batch", (_event, payload) => createShotBatch(payload || {}));
handleClientIpc("shot-get-run", (_event, runId) => shotRequest(`api/runs/${validateRunId(runId)}`));
handleClientIpc("shot-resume-naming", (_event, runId) => shotRequest(`api/runs/${validateRunId(runId)}/resume-naming`, { method: "POST" }));
handleClientIpc("shot-get-latest", () => getLatestShotRun());
handleClientIpc("shot-get-batch", (_event, batchId) => shotRequest(`api/batches/${validateBatchId(batchId)}`));
handleClientIpc("shot-cancel-batch", (_event, batchId) => shotRequest(`api/batches/${validateBatchId(batchId)}/cancel`, { method: "POST" }));
handleClientIpc("shot-resume-batch", (_event, batchId) => resumeShotBatch(batchId));
handleClientIpc("shot-retry-batch-item", (_event, batchId, videoId) => resumeShotBatch(batchId, videoId));
handleClientIpc("go-home", () => {
  if (!mainWindow || mainWindow.isDestroyed()) throw new Error("主窗口不可用");
  return loadRenderer().then(() => mainWindow.setTitle(productName));
});
handleClientIpc("open-logs", async () => {
  await mkdir(clientDataRoot, { recursive: true });
  const error = await shell.openPath(clientDataRoot);
  if (error) throw new Error(error);
  return clientDataRoot;
});

handleClientIpc("export-diagnostics", async () => {
  if (diagnosticExportPending) throw new Error("诊断日志正在导出，请稍候");
  diagnosticExportPending = true;
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const selection = await dialog.showSaveDialog(mainWindow, {
      title: "导出诊断日志",
      defaultPath: path.join(app.getPath("desktop"), `章域诊断日志-${stamp}.zip`),
      filters: [{ name: "诊断日志压缩包", extensions: ["zip"] }]
    });
    if (selection.canceled || !selection.filePath) return { canceled: true };
    await loadDiagnosticSecrets();
    await diagnostics.record("diagnostics.export_requested", { services: [...services.values()].map(({ key, status, port }) => ({ key, status, port })) });
    const result = await diagnostics.exportBundle(selection.filePath, { services: [...services.values()].map(serializeService) });
    void diagnostics.record("diagnostics.export_completed", { fileCount: result.fileCount, taskCount: result.taskCount });
    shell.showItemInFolder(result.path);
    return { canceled: false, path: result.path, fileCount: result.fileCount, taskCount: result.taskCount, warningCount: result.warnings?.length || 0 };
  } finally {
    diagnosticExportPending = false;
  }
});

ipcMain.on("diagnostics-event", (event, payload) => {
  if (!mainWindow || event.sender !== mainWindow.webContents || !payload || typeof payload !== "object") return;
  const fields = {};
  for (const key of ["module", "runId", "stage", "message", "stack", "code"]) {
    if (typeof payload[key] === "string") fields[key] = payload[key].slice(0, 16384);
  }
  void diagnostics.record("renderer.error", fields, "error");
});

process.on("uncaughtExceptionMonitor", (error) => {
  void diagnostics.record("client.uncaught_exception", { error: diagnosticError(error) }, "error");
});

app.whenReady().then(async () => {
  await loadDiagnosticSecrets();
  void diagnostics.record("client.started");
  app.setAppUserModelId("ai.zhangyu.video-mix-agent");
  await ensureBuiltinVoices();
  await createMainWindow();
  if (!uiPreviewMode) void startServices();
}).catch(async (error) => {
  await diagnostics.record("client.start_failed", { error: diagnosticError(error) }, "error");
  dialog.showErrorBox("客户端启动失败", `客户端未能正常启动，请联系维护者并提供诊断日志。\n日志位置：${path.join(clientDataRoot, "diagnostics")}`);
  app.quit();
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
  void Promise.all([...services.values()].map(stopService)).finally(async () => {
    await diagnostics.record("client.stopped");
    await diagnostics.flush();
    app.exit(0);
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
