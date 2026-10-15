import test from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

async function listen(server) {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return server.address().port;
}

async function stop(child) {
  if (!child || child.exitCode !== null) return;
  await new Promise(resolve => { child.once("exit", resolve); child.kill(); });
}

async function seedRun(dir, id, frameCount) {
  const runDir = path.join(dir, id);
  const frameDir = path.join(runDir, "keyframes", "source");
  const productDir = path.join(runDir, "inputs", "product-image");
  await Promise.all([frameDir, productDir, path.join(runDir, "kling-output")].map(directory => mkdir(directory, { recursive: true })));
  const productImages = [];
  for (let index = 0; index < 3; index++) {
    const productPath = path.join(productDir, `product-${index + 1}.png`);
    await writeFile(productPath, png);
    productImages.push({ id: `${id}-product-${index + 1}`, name: `product-${index + 1}.png`, mime: "image/png", size: png.length, path: productPath });
  }
  const keyframes = [];
  for (let index = 0; index < frameCount; index++) {
    const framePath = path.join(frameDir, `frame-${index + 1}.png`);
    await writeFile(framePath, png);
    keyframes.push({ id: `${id}-frame-${index + 1}`, name: `frame-${index + 1}.png`, mime: "image/png", size: png.length, path: framePath });
  }
  await writeFile(path.join(runDir, "run.json"), JSON.stringify({
    id, stage: "image", status: "FAILED", imageStatus: "FAILED", videoMode: "multi_keyframes",
    keyframes, productImage: productImages[0], productImages,
    imagePrompt: "将商品自然替换到场景中。主体说明：杯身中央的白色标记必须完整保留。",
    productSubject: "杯身中央的白色标记必须完整保留",
    imageTasks: [], editedKeyframes: [], publicBaseUrl: "http://127.0.0.1:1/", createdAt: new Date().toISOString()
  }));
}

test("Waw HTTP 400 falls back to async Bailian Kling per frame; only 400 switches providers and retries start with Waw", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "image-fallback-test-"));
  const serverPath = path.join(dir, "server.mjs");
  await copyFile(path.join(root, "server.mjs"), serverPath);

  // First three entries exercise 400 -> Kling success, Waw success, 400 -> Kling failure.
  // The retry and disconnect cases follow, then provider errors which must not switch.
  const wawPlan = [400, 200, 400, 400, 400, 400, 503, 429, 401];
  const events = [];
  const taskPolls = new Map();
  const klingRequests = [];
  let klingPosts = 0;
  let allowDisconnectComplete = false;
  let appBase = "";
  const provider = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString("utf8");
    if (req.url === "/v1/images/edits") {
      const status = wawPlan.shift();
      events.push(`waw:${status}`);
      if (status !== 200) {
        res.writeHead(status, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: { message: `mock Waw HTTP ${status}` } }));
      }
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ data: [{ url: `${mockBase}/result.png` }] }));
    }
    if (req.url === "/result.png") {
      events.push("result");
      res.writeHead(200, { "content-type": "image/png" });
      return res.end(png);
    }
    if (req.url === "/api/v1/services/aigc/image-generation/generation") {
      klingPosts++;
      klingRequests.push(JSON.parse(body));
      const taskId = `kling-${klingPosts}`;
      events.push(`kling:POST:${taskId}`);
      taskPolls.set(taskId, 0);
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ output: { task_id: taskId, task_status: "PENDING" } }));
    }
    const taskMatch = req.url.match(/^\/api\/v1\/tasks\/(.+)$/);
    if (taskMatch) {
      const taskId = decodeURIComponent(taskMatch[1]);
      const polls = (taskPolls.get(taskId) || 0) + 1;
      taskPolls.set(taskId, polls);
      events.push(`kling:GET:${taskId}`);
      if (taskId === "kling-2") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ output: { task_id: taskId, task_status: "FAILED", message: "mock terminal failure" } }));
      }
      if (taskId === "kling-4" && !allowDisconnectComplete) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ output: { task_id: taskId, task_status: "PROCESSING" } }));
      }
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ output: { task_id: taskId, task_status: "SUCCEEDED", choices: [{ message: { content: [{ image: `${mockBase}/result.png` }] } }] } }));
    }
    res.writeHead(404); res.end();
  });
  const providerPort = await listen(provider);
  const mockBase = `http://127.0.0.1:${providerPort}`;
  const probe = http.createServer();
  const port = await listen(probe);
  await new Promise(resolve => probe.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  appBase = base;
  // The local result URL is served by the provider mock; public media URLs use the isolated app server.
  await seedRun(dir, "fallback-run", 3);
  await seedRun(dir, "disconnect-run", 1);
  await seedRun(dir, "waiting-run", 1);
  for (const status of [503, 429, 401]) await seedRun(dir, `reject-${status}`, 1);
  for (const id of ["fallback-run", "disconnect-run", "waiting-run", "reject-503", "reject-429", "reject-401"]) {
    const file = path.join(dir, id, "run.json");
    const run = JSON.parse(await readFile(file, "utf8"));
    run.publicBaseUrl = id === "waiting-run" ? null : base + "/";
    await writeFile(file, JSON.stringify(run));
  }
  const env = {
    ...process.env, PORT: String(port), HOST: "127.0.0.1", RUNS_DIR: dir, MOCK_PIPELINE: "false",
    WAW_API_KEY: "test-only", WAW_API_BASE: mockBase + "/v1",
    BAILIAN_IMAGE_API_KEY: "test-only", BAILIAN_IMAGE_API_BASE: mockBase,
    BAILIAN_IMAGE_POLL_MS: "20"
  };
  let client;
  const start = async () => {
    client = spawn(process.execPath, [serverPath], { cwd: root, env, stdio: "ignore", windowsHide: true });
    for (let index = 0; index < 100; index++) {
      try { if ((await fetch(base + "/api/health")).ok) return; } catch {}
      await pause(50);
    }
    throw new Error("isolated service did not start");
  };
  const retry = (id, indexes) => fetch(`${base}/api/runs/${id}/image/retry`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ indexes })
  });
  const getRun = async id => (await fetch(`${base}/api/runs/${id}`)).json();
  const waitFor = async (id, predicate) => {
    for (let index = 0; index < 200; index++) {
      const run = await getRun(id);
      if (await predicate(run)) return run;
      await pause(30);
    }
    throw new Error(`timed out waiting for ${id}`);
  };

  try {
    await start();

    assert.equal((await retry("fallback-run", [0, 1, 2])).status, 202);
    const failed = await waitFor("fallback-run", run => ["FAILED", "SUCCEEDED"].includes(run.status));
    assert.equal(failed.status, "FAILED", "terminal Kling failure leaves the image run failed");
    assert.deepEqual(failed.imageTasks.map(task => task.status), ["SUCCEEDED", "SUCCEEDED", "FAILED"]);
    assert.deepEqual(events.slice(0, 8), [
      "waw:400", "kling:POST:kling-1", "kling:GET:kling-1", "result",
      "waw:200", "result", "waw:400", "kling:POST:kling-2"
    ]);
    assert.equal(klingPosts, 2);
    const firstKlingRequest = klingRequests[0];
    const firstContent = firstKlingRequest.input.messages[0].content;
    const expectedPrompt = "将商品自然替换到场景中。主体说明：杯身中央的白色标记必须完整保留。";
    assert.equal(firstContent[0].text, expectedPrompt, "Kling receives the complete original prompt and subject description verbatim");
    assert.ok(firstContent[0].text.includes("杯身中央的白色标记必须完整保留"));
    assert.equal(firstContent.filter(item => item.image).length, 4, "Kling receives the scene and all three product references");
    assert.match(new URL(firstContent[1].image).pathname, /fallback-run-frame-1/);
    for (let index = 0; index < 3; index++) assert.match(new URL(firstContent[index + 2].image).pathname, new RegExp(`product-reference-${index + 1}\\.png$`));
    for (const reference of firstContent.slice(2).map(item => item.image)) {
      const response = await fetch(reference);
      assert.equal(response.status, 200, "each fallback product reference URL is locally fetchable");
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.deepEqual(bytes.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      assert.equal(bytes.readUInt32BE(16), 800);
      assert.equal(bytes.readUInt32BE(20), 800);
    }

    // Retrying a failed Kling fallback must submit to Waw first, then create a new Kling task.
    const beforeRetry = events.length;
    assert.equal((await retry("fallback-run", [2])).status, 202);
    const retried = await waitFor("fallback-run", run => run.status === "SUCCEEDED");
    assert.deepEqual(events.slice(beforeRetry, beforeRetry + 3), ["waw:400", "kling:POST:kling-3", "kling:GET:kling-3"]);
    assert.equal(klingPosts, 3);
    assert.equal(retried.editedKeyframes.length, 3);

    // Persist a Kling task ID, stop the server while it is still processing, then recover via GET.
    assert.equal((await retry("disconnect-run", [0])).status, 202);
    for (let index = 0; index < 200 && !events.includes("kling:GET:kling-4"); index++) await pause(10);
    assert.ok(events.includes("kling:GET:kling-4"), "fallback task ID was polled before disconnect");
    const disconnectSaved = JSON.parse(await readFile(path.join(dir, "disconnect-run", "run.json"), "utf8"));
    assert.equal(disconnectSaved.imageTasks[0].fallback.taskId, "kling-4");
    assert.equal(disconnectSaved.imageTasks[0].status, "PROCESSING");
    await stop(client);
    const beforeRecovery = events.length;
    allowDisconnectComplete = true;
    await start();
    await fetch(`${base}/api/runs/disconnect-run`);
    const recovered = await waitFor("disconnect-run", run => run.status === "SUCCEEDED");
    assert.equal(recovered.imageTasks[0].taskId, "kling-4");
    const recoveredDisk = JSON.parse(await readFile(path.join(dir, "disconnect-run", "run.json"), "utf8"));
    assert.equal(recoveredDisk.imageTasks[0].fallback.taskId, "kling-4");
    assert.equal(klingPosts, 4, "restart recovery must not submit a duplicate Kling task");
    assert.ok(events.slice(beforeRecovery).some(event => event === "kling:GET:kling-4"));
    assert.ok(events.slice(beforeRecovery).every(event => !event.startsWith("kling:POST:") && !event.startsWith("waw:")), "recovery uses only provider GETs");

    // A missing public image transport holds the fallback before any paid Kling submission.
    assert.equal((await retry("waiting-run", [0])).status, 202);
    const waiting = await waitFor("waiting-run", run => run.imageTransport?.status === "WAITING");
    assert.equal(waiting.status, "PROCESSING");
    assert.equal(klingPosts, 4, "no Kling POST occurs while the image transport is waiting");
    const waitingEvents = events.length;
    const transport = await fetch(`${base}/api/runs/waiting-run/image/transport`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ publicBaseUrl: appBase + "/" })
    });
    assert.equal(transport.status, 200);
    assert.equal((await transport.json()).imageTransport.status, "READY");
    const transported = await waitFor("waiting-run", run => run.status === "SUCCEEDED");
    assert.equal(transported.imageTasks[0].status, "SUCCEEDED");
    assert.equal(klingPosts, 5, "Kling submits only after the transport handshake");
    assert.ok(events.slice(waitingEvents).some(event => event === "kling:POST:kling-5"));

    // Authentication, rate limit, and upstream failures must remain Waw failures without a Kling request.
    for (const status of [503, 429, 401]) {
      const before = events.length;
      assert.equal((await retry(`reject-${status}`, [0])).status, 202);
      const rejected = await waitFor(`reject-${status}`, run => ["FAILED", "SUCCEEDED"].includes(run.status));
      assert.equal(rejected.status, "FAILED");
      const rejectedDisk = JSON.parse(await readFile(path.join(dir, `reject-${status}`, "run.json"), "utf8"));
      assert.equal(rejectedDisk.imageTasks[0].httpStatus, status);
      assert.equal(klingPosts, 5, `Waw HTTP ${status} must not submit to Kling`);
      assert.deepEqual(events.slice(before), [`waw:${status}`]);
    }
    for (const id of ["fallback-run", "disconnect-run"]) {
      const disk = JSON.parse(await readFile(path.join(dir, id, "run.json"), "utf8"));
      for (const item of disk.editedKeyframes.filter(Boolean)) {
      const bytes = await readFile(item.path);
      assert.deepEqual(bytes.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      }
    }
    assert.equal(JSON.stringify(JSON.parse(await readFile(path.join(dir, "fallback-run", "run.json"), "utf8"))).includes("test-only"), false);
  } finally {
    await stop(client);
    provider.closeAllConnections();
    await new Promise(resolve => provider.close(resolve));
  }
});
