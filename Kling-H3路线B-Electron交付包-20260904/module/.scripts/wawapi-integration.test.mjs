import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("..", import.meta.url));
const pause = ms => new Promise(r => setTimeout(r, ms));
for (const productCount of [1, 3]) test(`WawAPI edit (${productCount} product references): multipart, progressive persistence, failed-only retry, no GET resubmission`, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "waw-client-test-"));
  const serverPath = path.join(dir, "server.mjs");
  await copyFile(path.join(root, "server.mjs"), serverPath);
  const source = path.join(dir, "source-scene.png");
  const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  await writeFile(source, bytes);
  let calls = 0, failAt = 2, received = [], gatewayAt = 0, badAt = 0;
  const provider = http.createServer(async (req, res) => {
    let chunks=[]; for await (const b of req) chunks.push(b);
    const body=Buffer.concat(chunks).toString("utf8"); received.push(body); calls++;
    assert.equal(req.url, "/v1/images/edits");
    assert.match(req.headers["content-type"], /multipart\/form-data; boundary=/);
    assert.equal((body.match(/name="image"/g)||[]).length, 1 + productCount);
    assert.deepEqual([...body.matchAll(/name="image"; filename="([^"]+)"/g)].map(match => match[1]), ["scene.png", ...Array.from({length:productCount}, (_, i) => productCount === 1 ? "frame.png" : `product-${i + 1}.png`)]);
    assert.match(body, /gpt-image-2/);
    assert.match(body, /medium/);
    await pause(40);
    if(calls===failAt) return req.socket.destroy();
    if(calls===gatewayAt) { res.writeHead(504, {"content-type":"application/json"}); return res.end(JSON.stringify({error:{message:"upstream timeout"}})); }
    res.setHeader("content-type","application/json");
    res.end(JSON.stringify({data:[{b64_json:(calls===badAt ? Buffer.from("not an image") : bytes).toString("base64")}]}));
  });
  let client;
  try {
    await new Promise(r=>provider.listen(0,"127.0.0.1",r));
    const runDir=path.join(dir,"test-run"); await mkdir(path.join(runDir,"kling-output"),{recursive:true});
    const frames=[0,1,2,3].map(i=>({id:"frame"+i,name:"frame.png",mime:"image/png",size:bytes.length,path:source}));
    const products = productCount === 1 ? [frames[0]] : [1,2,3].map(i => ({...frames[0], id:`product${i}`, name:`product-${i}.png`}));
    await writeFile(path.join(runDir,"run.json"),JSON.stringify({id:"test-run",stage:"image",status:"FAILED",videoMode:"multi_keyframes",keyframes:frames,productImage:products[0],...(productCount === 3 ? {productImages:products} : {}),imagePrompt:"将第一张图片中人物手中的物品自然地替换成第二张的主体物品",imageTasks:[],editedKeyframes:[],createdAt:new Date().toISOString()}));
    const probe=http.createServer(); await new Promise(r=>probe.listen(0,"127.0.0.1",r)); const port=probe.address().port; await new Promise(r=>probe.close(r));
    client=spawn(process.execPath,[serverPath],{cwd:root,env:{...process.env,PORT:String(port),HOST:"127.0.0.1",RUNS_DIR:dir,MOCK_PIPELINE:"false",WAW_API_KEY:"test-only",WAW_API_BASE:"http://127.0.0.1:"+provider.address().port+"/v1"},stdio:"ignore",windowsHide:true});
    const base="http://127.0.0.1:"+port;
    for(let i=0;i<100;i++){try{if((await fetch(base+"/api/health")).ok)break;}catch{} await pause(50);}
    const retry=(indexes=[0,1,2,3])=>fetch(base+"/api/runs/test-run/image/retry",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({indexes})});
    const poll=async()=>{for(let i=0;i<150;i++){const r=await(await fetch(base+"/api/runs/test-run")).json();if(["FAILED","SUCCEEDED"].includes(r.status))return r;await pause(100);}throw Error("timed out");};
    assert.equal((await retry()).status,202);
    const failed=await poll(); assert.equal(failed.status,"FAILED"); assert.equal(calls,2);
    assert.deepEqual(failed.productImages.map(item => item.id), products.map(item => item.id));
    assert.equal(failed.productImage.id, products[0].id);
    assert.equal(failed.productImages.some(item => "path" in item), false);
    assert.equal(failed.imageTasks[0].status,"SUCCEEDED"); assert.equal(failed.imageTasks[1].status,"UNCERTAIN");
    const savedId=failed.editedKeyframes[0].id;
    await fetch(base+"/api/runs/test-run"); assert.equal(calls,2);
    failAt=0;
    assert.equal((await retry()).status,202);
    const result=await poll(); assert.equal(result.status,"SUCCEEDED"); assert.equal(calls,5);
    assert.equal(result.editedKeyframes[0].id,savedId); assert.equal(result.editedKeyframes.length,4);
    assert.equal((await retry([2])).status,202);
    const redone=await poll(); assert.equal(redone.status,"SUCCEEDED"); assert.equal(calls,6);
    assert.equal(redone.editedKeyframes[0].id,savedId);
    assert.notEqual(redone.editedKeyframes[2].id,result.editedKeyframes[2].id);
    const resumeOnly = () => fetch(base+"/api/runs/test-run/image/retry",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({indexes:[0],continueOnly:true})});
    assert.equal((await resumeOnly()).status,200); assert.equal(calls,6);
    gatewayAt=7;
    await retry([1]); const gateway=await poll();
    assert.equal(gateway.imageTasks[1].status,"UNCERTAIN");
    const beforeRestart=JSON.parse(await readFile(path.join(runDir,"run.json"),"utf8"));
    assert.equal(beforeRestart.imageTasks[1].providerError.message,"upstream timeout");
    const childArgs=client.spawnargs.slice(1);
    await new Promise(resolve=>{client.once("exit",resolve);client.kill();});
    client=spawn(process.execPath,childArgs,{cwd:root,env:{...process.env,PORT:String(port),HOST:"127.0.0.1",RUNS_DIR:dir,MOCK_PIPELINE:"false",WAW_API_KEY:"test-only",WAW_API_BASE:"http://127.0.0.1:"+provider.address().port+"/v1"},stdio:"ignore",windowsHide:true});
    for(let i=0;i<100;i++){try{if((await fetch(base+"/api/health")).ok)break;}catch{} await pause(50);}
    assert.equal((await poll()).imageTasks[1].status,"UNCERTAIN"); assert.equal(calls,7);
    for (const product of products) assert.equal((await fetch(base+`/media/${product.id}/${product.name}`)).status, 200);
    await resumeOnly(); const recovered=await poll(); assert.equal(recovered.status,"SUCCEEDED"); assert.equal(calls,8);
    assert.equal(recovered.editedKeyframes[0].id,savedId);
    badAt=9; await retry([2]); const bad=await poll(); assert.equal(bad.status,"FAILED");
    await resumeOnly(); assert.equal((await poll()).status,"SUCCEEDED"); assert.equal(calls,10);
    await new Promise(resolve=>{client.once("exit",resolve);client.kill();});
    const archived=JSON.parse(await readFile(path.join(runDir,"run.json"),"utf8"));
    archived.status="FAILED"; archived.imageStatus="FAILED";
    archived.imageTasks[2].status="ARCHIVE_FAILED";
    archived.imageTasks[2].responsePath=path.join(runDir,"expired-response.json");
    archived.imageTasks[2].editedImage=null; archived.editedKeyframes[2]=null;
    await writeFile(path.join(runDir,"run.json"),JSON.stringify(archived));
    client=spawn(process.execPath,childArgs,{cwd:root,env:{...process.env,PORT:String(port),HOST:"127.0.0.1",RUNS_DIR:dir,MOCK_PIPELINE:"false",WAW_API_KEY:"test-only",WAW_API_BASE:"http://127.0.0.1:"+provider.address().port+"/v1"},stdio:"ignore",windowsHide:true});
    for(let i=0;i<100;i++){try{if((await fetch(base+"/api/health")).ok)break;}catch{} await pause(50);}
    await resumeOnly(); assert.equal((await poll()).status,"SUCCEEDED"); assert.equal(calls,10,"local original must not trigger paid edit");
    const disk=JSON.parse(await readFile(path.join(runDir,"run.json"),"utf8"));
    assert.deepEqual(disk.productImages.map(item => item.id), products.map(item => item.id));
    assert.equal(disk.productImage.id, products[0].id);
    const png=await readFile(disk.editedKeyframes[0].path); assert.equal(png.readUInt32BE(16),864); assert.equal(png.readUInt32BE(20),1536);
    assert.equal(JSON.stringify(disk).includes("test-only"),false);
    console.log("isolated results:",dir);
  } finally { client?.kill(); provider.closeAllConnections(); await new Promise(r=>provider.close(r)); }
});

test("Product reference API validates 1-3 IDs, binds explicitly, restores every reference, and clones video variants", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "product-reference-test-"));
  const serverPath = path.join(dir, "server.mjs");
  await copyFile(path.join(root, "server.mjs"), serverPath);
  const probe = http.createServer();
  await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  let client;
  const start = async () => {
    client = spawn(process.execPath, [serverPath], { cwd: root, env: {...process.env, PORT: String(port), HOST: "127.0.0.1", RUNS_DIR: dir, MOCK_PIPELINE: "true"}, stdio: "ignore", windowsHide: true });
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(base + "/api/health")).ok) return; } catch {}
      await pause(50);
    }
    throw Error("client service did not start");
  };
  const stop = () => new Promise(resolve => { client.once("exit", resolve); client.kill(); });
  const post = (url, body) => fetch(base + url, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify(body)});
  try {
    await start();
    const {runId} = await (await post("/api/run-id", {})).json();
    const upload = async (kind, category, name, attach = true) => {
      const response = await fetch(base + "/api/media?" + new URLSearchParams({runId, kind, category, name, attach: String(attach)}), {method: "POST", headers: {"content-type": kind === "video" ? "video/mp4" : "image/png"}, body: Buffer.from(name)});
      assert.equal(response.status, 201);
      return response.json();
    };
    const video = await upload("video", "inputs/source-video", "source.mp4");
    const products = [];
    for (let i = 1; i <= 4; i++) products.push(await upload("image", "inputs/product-image", `product-${i}.png`, false));
    const frames = [await upload("image", "keyframes/source", "scene-1.png"), await upload("image", "keyframes/source", "scene-2.png")];
    const draft = await (await fetch(base + `/api/runs/${runId}`)).json();
    assert.deepEqual(draft.productImages, [], "detached uploads must not become active references");
    const body = {runId, sourceVideoId: video.id, videoMode: "multi_keyframes", keyframeIds: frames.map(item => item.id), imagePrompt: "use all product references", videoPrompt: "motion", duration: 5, resolution: "768P", audioMode: "silent"};
    for (const ids of [[], products.map(item => item.id), [products[0].id, products[0].id], "invalid", [video.id]]) {
      const rejected = await post("/api/runs", {...body, productImageIds: ids});
      assert.equal(rejected.status, 400);
      assert.equal((await (await fetch(base + `/api/runs/${runId}`)).json()).status, "draft");
    }
    const selected = products.slice(0, 3);
    const accepted = await post("/api/runs", {...body, productImageIds: selected.map(item => item.id)});
    assert.equal(accepted.status, 201);
    const run = await accepted.json();
    assert.deepEqual(run.productImages.map(item => item.id), selected.map(item => item.id));
    assert.equal(run.productImage.id, selected[0].id);
    assert.equal(run.imageRequest.input.messages[0].content.length, 5, "Bailian mock retains text, scene, and every product reference");
    await stop();
    const runPath = path.join(dir, runId, "run.json");
    const saved = JSON.parse(await readFile(runPath, "utf8"));
    saved.imageStatus = saved.status = "SUCCEEDED";
    saved.editedKeyframes = saved.keyframes;
    saved.editedImage = saved.keyframes[0];
    saved.videoTaskId = "completed-video";
    saved.videoStatus = "SUCCEEDED";
    await writeFile(runPath, JSON.stringify(saved));
    await start();
    for (const item of selected) assert.equal((await fetch(base + item.url)).status, 200);
    const variantResponse = await post(`/api/runs/${runId}/video`, {videoMode: "multi_keyframes", videoPrompt: "new motion", duration: 5, resolution: "768P", audioMode: "silent", confirmResubmit: true});
    assert.equal(variantResponse.status, 201);
    const variant = await variantResponse.json();
    assert.equal(variant.derivedFromRunId, runId);
    assert.equal(variant.productImages.length, 3);
    assert.equal(variant.productImage.id, variant.productImages[0].id);
    for (let i = 0; i < 3; i++) {
      assert.notEqual(variant.productImages[i].id, selected[i].id);
      assert.equal(await (await fetch(base + variant.productImages[i].url)).text(), `product-${i + 1}.png`);
    }
    const {runId: legacyId} = await (await post("/api/run-id", {})).json();
    const legacy = await post("/api/runs", {...body, runId: legacyId, productImageId: selected[0].id});
    assert.equal(legacy.status, 201);
    assert.equal((await legacy.json()).productImages.length, 1);
  } finally { client?.kill(); }
});
