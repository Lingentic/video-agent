import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const moduleRoot = fileURLToPath(new URL("..", import.meta.url));
const mainSource = await readFile(new URL("../../../electron/main.mjs", import.meta.url), "utf8");
const librarySource = mainSource.slice(mainSource.indexOf("async function listKlingAssets("), mainSource.indexOf("async function getLatestRecoverableKlingRun("));
const exportSource = mainSource.slice(mainSource.indexOf("function exportFolderName("), mainSource.indexOf("async function startService("));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function library(deps) {
  return Function("deps", `const { ${Object.keys(deps).join(",")} } = deps; ${exportSource}\n${librarySource}; return {listKlingAssets, exportLibraryTask};`)(deps);
}

async function fixture(dir, id, overrides = {}) {
  const root = path.join(dir, "runs", id);
  await mkdir(path.join(root, "kling-output"), { recursive: true });
  const frames = [];
  for (let i = 1; i <= 3; i++) {
    const file = path.join(root, "kling-output", `${i}.png`);
    await writeFile(file, `edited frame ${i}`);
    frames.push({ id: `${id}-${i}`, name: `${i}.png`, path: file, mime: "image/png" });
  }
  const run = { id, sourceVideo: {name:"参考.mp4"}, stage:"image", status:"SUCCEEDED", editedKeyframes:frames, createdAt:"2026-10-01T00:00:00Z", ...overrides };
  await writeFile(path.join(root, "run.json"), JSON.stringify(run));
  const publicItem = item => item ? {...item, path:undefined, url:`/media/${item.id}/${item.name}`} : null;
  return {...run, editedKeyframes:(run.editedKeyframes || []).map(publicItem), editedImage:publicItem(run.editedImage), firstFrame:publicItem(run.firstFrame), output:publicItem(run.output)};
}

test("library exposes completed local edited frames for history, partial and stopped tasks; final videos take priority", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "subject-library-"));
  try {
    await mkdir(path.join(dir, "revoiced"));
    const runs = [];
    for (const [id, overrides] of [
      ["history", {}], ["partial", {stage:"image",status:"FAILED"}],
      ["stopped", {userStopped:{stage:"image"}}], ["video-failed", {stage:"video",status:"FAILED"}],
      ["video-wait", {stage:"video",status:"PROCESSING"}]
    ]) runs.push(await fixture(dir, id, overrides));
    const partialFile = path.join(dir, "runs", "partial", "run.json");
    const partial = JSON.parse(await readFile(partialFile, "utf8"));
    partial.editedKeyframes[1] = null;
    runs.find(run => run.id === "partial").editedKeyframes[1] = null;
    await rm(partial.editedKeyframes[2].path);
    await writeFile(partialFile, JSON.stringify(partial));
    const providerPath = path.join(dir, "runs", "provider", "output", "final.mp4");
    await mkdir(path.dirname(providerPath), {recursive:true});
    await writeFile(providerPath, "final video");
    runs.push(await fixture(dir, "provider", {stage:"image",status:"FAILED",output:{id:"final",name:"成片.mp4",path:providerPath}}));
    runs.push(await fixture(dir, "revoice", {stage:"video",status:"FAILED"}));
    runs.push(await fixture(dir, "missing-video", {stage:"video",status:"SUCCEEDED",output:{id:"missing",name:"lost.mp4",path:path.join(dir,"runs","missing-video","output","lost.mp4")}}));
    for (const [suffix, date] of [["old","2026-10-01"],["new","2026-10-02"]]) {
      const file = path.join(dir, "revoiced", `${suffix}.mp4`);
      await writeFile(file, suffix);
      await writeFile(`${file}.json`, JSON.stringify({runId:"revoice",path:file,name:`${suffix}.mp4`,completedAt:date}));
    }
    runs.push(await fixture(dir, "original-only", {editedKeyframes:[],keyframes:[{id:"original",url:"/media/original/frame.png"}]}));
    const deletedRevoice = path.join(dir,"revoiced","deleted.mp4");
    await writeFile(`${deletedRevoice}.json`,JSON.stringify({runId:"missing-video",path:deletedRevoice,completedAt:"2026-10-08"}));
    const output = path.join(dir, "exports");
    await mkdir(output);
    const deps = {path, pathToFileURL, fileURLToPath, readFile, readdir, stat, mkdir, copyFile,
      klingRunsDir:path.join(dir,"runs"),revoicedOutputRoot:path.join(dir,"revoiced"),
      klingRequest:async()=>({runs,baseUrl:"http://localhost/"}),
      mainWindow:null,dialog:{showOpenDialog:async()=>({canceled:false,filePaths:[output]})}};
    const api = library(deps);
    const {assets} = await api.listKlingAssets();
    assert.equal(assets.filter(item=>item.runId === "history").length, 3);
    assert.deepEqual(assets.filter(item=>item.runId === "partial").map(item=>item.name), ["关键帧1.png"]);
    for (const id of ["history","stopped","video-failed","video-wait","missing-video"]) {
      const images = assets.filter(item=>item.runId === id);
      assert.equal(images.length, 3);
      assert.ok(images.every(item=>item.kind === "image" && item.sourceId === id && item.relativeUrl.startsWith("/media/")));
    }
    assert.deepEqual(assets.filter(item=>item.runId === "provider").map(item=>item.kind), ["video"]);
    assert.deepEqual(assets.filter(item=>item.runId === "revoice").map(item=>item.name), ["new.mp4"]);
    assert.equal(assets.filter(item=>item.runId === "original-only").length, 0);
    assert.ok(assets.every(item=>!item.path));
    const exported = await api.exportLibraryTask({kind:"remake",runId:"history",sourceId:"history",name:"整组图片"});
    assert.equal(exported.count, 3);
    assert.deepEqual((await readdir(exported.destination)).sort(), ["关键帧1.png","关键帧2.png","关键帧3.png"]);
    for (let i = 1; i <= 3; i++) assert.equal(await readFile(path.join(exported.destination, `关键帧${i}.png`), "utf8"), `edited frame ${i}`);
    const videoExport = await api.exportLibraryTask({kind:"remake",runId:"provider",sourceId:"provider",name:"视频"});
    assert.equal(videoExport.count, 1);
    assert.equal(await readFile(path.join(videoExport.destination, "成片.mp4"), "utf8"), "final video");
    const voiceExport = await api.exportLibraryTask({kind:"remake",runId:"revoice",sourceId:"revoice",name:"配音"});
    assert.equal(voiceExport.count, 1);
    assert.equal(await readFile(path.join(voiceExport.destination,"new.mp4"),"utf8"), "new");
    await assert.rejects(api.exportLibraryTask({kind:"remake",runId:"..",sourceId:".."}), /任务文件路径无效|没有可导出/);
    const outside = path.join(dir, "outside.png");
    await writeFile(outside,"outside");
    const altered = JSON.parse(await readFile(path.join(dir,"runs","history","run.json"),"utf8"));
    altered.editedKeyframes[0].path = outside;
    await writeFile(path.join(dir,"runs","history","run.json"),JSON.stringify(altered));
    assert.equal((await api.listKlingAssets()).assets.filter(item=>item.runId === "history").length, 2);
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test("legacy first_frame editedImage is archived and exported only when no valid editedKeyframes remain", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "legacy-frame-library-"));
  try {
    const runs = [];
    for (const [id, editedKeyframes] of [["legacy",undefined],["null-frames",[null]]]) {
      const file = path.join(dir,"runs",id,"kling-output","edited.png");
      await mkdir(path.dirname(file),{recursive:true});
      await writeFile(file,`${id} edited first frame`);
      runs.push(await fixture(dir,id,{videoMode:"first_frame",editedKeyframes,editedImage:{id:`${id}-edited`,name:"edited.png",path:file},firstFrame:{id:`${id}-original`,name:"original.png",path:file}}));
    }
    const preferred = await fixture(dir,"preferred");
    const preferredPath = path.join(dir,"runs","preferred","run.json");
    const saved = JSON.parse(await readFile(preferredPath,"utf8"));
    saved.editedImage = saved.editedKeyframes[0];
    preferred.editedImage = preferred.editedKeyframes[0];
    await writeFile(preferredPath,JSON.stringify(saved));
    runs.push(preferred);
    runs.push(await fixture(dir,"original-only",{videoMode:"first_frame",editedKeyframes:undefined,firstFrame:{id:"original",name:"original.png",path:path.join(dir,"runs","original-only","kling-output","1.png")}}));
    runs.push(await fixture(dir,"missing-edit",{videoMode:"first_frame",editedKeyframes:[],editedImage:{id:"missing-edit",name:"gone.png",path:path.join(dir,"runs","missing-edit","kling-output","gone.png")}}));
    const exportsRoot = path.join(dir,"exports");
    await mkdir(exportsRoot);
    const api = library({path,pathToFileURL,fileURLToPath,readFile,readdir,stat,mkdir,copyFile,
      klingRunsDir:path.join(dir,"runs"),revoicedOutputRoot:path.join(dir,"revoiced"),
      klingRequest:async()=>({runs,baseUrl:"http://localhost/"}),mainWindow:null,
      dialog:{showOpenDialog:async()=>({canceled:false,filePaths:[exportsRoot]})}});
    const {assets} = await api.listKlingAssets();
    for (const id of ["legacy","null-frames"]) {
      const images = assets.filter(asset=>asset.runId === id);
      assert.equal(images.length,1);
      assert.equal(images[0].kind,"image");
      assert.equal(images[0].mediaId,`${id}-edited`);
      assert.equal(images[0].relativeUrl,`/media/${id}-edited/edited.png`);
      const result = await api.exportLibraryTask({kind:"remake",runId:id,sourceId:id,name:id});
      assert.equal(result.count,1);
      assert.equal(await readFile(path.join(result.destination,"关键帧1.png"),"utf8"),`${id} edited first frame`);
    }
    assert.equal(assets.filter(asset=>asset.runId === "preferred").length,3);
    assert.equal(assets.filter(asset=>["original-only","missing-edit"].includes(asset.runId)).length,0);
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test("subject persists through the real local HTTP route and is inherited by a Mock video variant", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "subject-http-"));
  let child;
  try {
    const serverPath = path.join(dir,"server.mjs");
    await copyFile(path.join(moduleRoot,"server.mjs"),serverPath);
    const probe = http.createServer();
    await new Promise(resolve=>probe.listen(0,"127.0.0.1",resolve));
    const port = probe.address().port;
    await new Promise(resolve=>probe.close(resolve));
    child = spawn(process.execPath,[serverPath],{windowsHide:true,stdio:"ignore",env:{...process.env,PORT:String(port),HOST:"127.0.0.1",RUNS_DIR:path.join(dir,"runs"),MOCK_PIPELINE:"true"}});
    const base = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let i=0;i<100;i++) { try { ready = (await fetch(`${base}/api/health`)).ok; if(ready)break; } catch {} await pause(50); }
    assert.ok(ready,"isolated Mock server starts");
    const request = async (route,options) => {
      const res=await fetch(`${base}${route}`,options); const body=await res.json();
      assert.ok(res.ok,JSON.stringify(body)); return body;
    };
    const post = (route,body)=>request(route,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
    const {runId} = await post("/api/run-id",{});
    assert.equal((await request(`/api/runs/${runId}`)).productSubject, "");
    const upload=async (kind,category,name)=>request(`/api/media?${new URLSearchParams({runId,kind,category,name})}`,{method:"POST",headers:{"Content-Type":kind === "video" ? "video/mp4" : kind === "audio" ? "audio/wav" : "image/png"},body:"local mock bytes"});
    const video=await upload("video","inputs/source-video","5秒.mp4");
    assert.equal(video.name,"5秒.mp4");
    assert.ok(video.url.endsWith(encodeURIComponent("5秒.mp4")));
    const uploadedRecord=JSON.parse(await readFile(path.join(dir,"runs",runId,"run.json"),"utf8"));
    assert.equal(uploadedRecord.sourceVideo.name,"5秒.mp4");
    assert.equal(path.basename(uploadedRecord.sourceVideo.path),`${video.id}.mp4`);
    assert.equal((await fetch(`${base}${video.url}`)).status,200);
    const product=await upload("image","inputs/product-image","C:\\参考图\\绿色水瓶.png");
    assert.equal(product.name,"绿色水瓶.png");
    const audio=await upload("audio","inputs/voice-audio","voice.wav");
    const frames=await Promise.all([1,2].map(i=>upload("image","keyframes/source",`frame-${i}.png`)));
    const body={runId,sourceVideoId:video.id,productImageId:product.id,voiceAudioId:audio.id,voiceSource:"upload",voiceScript:"测试",audioMode:"voice",videoMode:"multi_keyframes",keyframeIds:frames.map(item=>item.id),imagePrompt:"原始提示词\n\n主体：水杯",productSubject:"  水杯  ",videoPrompt:"motion",resolution:"768P",duration:5};
    const rejected=await fetch(`${base}/api/runs`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({...body,productSubject:"杯".repeat(201)})});
    assert.equal(rejected.status,400);
    const created=await post("/api/runs",body);
    assert.equal(created.productSubject,"水杯");
    assert.equal(JSON.parse(await readFile(path.join(dir,"runs",runId,"run.json"),"utf8")).productSubject,"水杯");
    await pause(800);
    const completed=await request(`/api/runs/${runId}`);
    assert.equal(completed.imageStatus,"SUCCEEDED");
    const initial=await post(`/api/runs/${runId}/video`,{videoMode:"multi_keyframes"});
    assert.equal(initial.productSubject,"水杯");
    await pause(800);
    assert.equal((await request(`/api/runs/${runId}`)).status,"SUCCEEDED");
    const variant=await post(`/api/runs/${runId}/video`,{videoMode:"multi_keyframes",confirmResubmit:true});
    assert.notEqual(variant.id,runId);
    assert.equal(variant.productSubject,"水杯");
    assert.equal(variant.imagePrompt,body.imagePrompt);
    assert.equal(variant.sourceVideo.name,"5秒.mp4");
    assert.equal(JSON.parse(await readFile(path.join(dir,"runs",variant.id,"run.json"),"utf8")).productSubject,"水杯");
    assert.equal((await request("/api/runs")).runs.find(run=>run.id === variant.id).productSubject,"水杯");
  } finally {
    if (child && child.exitCode === null) await new Promise(resolve=>{child.once("exit",resolve);child.kill();});
    await rm(dir,{recursive:true,force:true});
  }
});
