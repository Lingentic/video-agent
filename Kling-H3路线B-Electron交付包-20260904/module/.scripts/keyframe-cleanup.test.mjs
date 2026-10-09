import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:net";
const exec = promisify(execFile);
const source = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
const code = source.slice(source.indexOf("async function cleanupRunKeyframes("), source.indexOf("async function restoreRuns("));
const exists = async file => { try { await fs.stat(file); return true; } catch { return false; } };
async function fixture(t, overrides = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "keyframe-cleanup-"));
  t.after(() => fs.rm(directory, {recursive:true,force:true}));
  const runRoot = path.join(directory,"run");
  for (const category of ["output","keyframes/source","first-frame","kling-output","inputs/source-video","inputs/product-image","inputs/voice-audio"]) await fs.mkdir(path.join(runRoot,category),{recursive:true});
  async function mediaFile(category, name, id) {
    const file = path.join(runRoot,category,name); await fs.writeFile(file,"fixture content"); return {id:id||name,path:file,name};
  }
  const original = await mediaFile("inputs/source-video","source.mp4"), product = await mediaFile("inputs/product-image","product.jpg"), audio = await mediaFile("inputs/voice-audio","sample.wav");
  const frames = [await mediaFile("keyframes/source","source.png"),await mediaFile("kling-output","edited.png")];
  const raw = await mediaFile("kling-output","raw.png"), receipt = await mediaFile("kling-output","receipt.json");
  const orphan = await mediaFile("kling-output","11111111-1111-1111-1111-111111111111-original.png");
  const note = await mediaFile("kling-output","user-note.txt");
  const output = await mediaFile("output","final.mp4","final");
  const run = {id:"run",stage:"video",status:"SUCCEEDED",sourceVideo:original,productImage:product,productImages:[product],voiceAudio:audio,keyframes:[frames[0]],editedKeyframes:[frames[1]],editedImage:frames[1],imageTasks:[{taskId:"paid-image-task",status:"SUCCEEDED",editedImage:frames[1],rawPath:raw.path,responsePath:receipt.path}],output};
  const snapshots=[], deletions=[];
  const deps = {
    RUNS_DIR:directory, imageWorkers:new Set(), submissionClaims:new Set(), frameCleanupWorkers:new Map(),media:new Map(frames.map(item=>[item.id,item])),
    normalized:value=>String(value).toLowerCase(), ...fs, ...path, process,
    execFileAsync:async()=>({stdout:JSON.stringify({format:{duration:"5"},streams:[{codec_type:"video",width:864,height:1536}]})}),
    persistRun:async value=>snapshots.push(structuredClone(value)),
    unlink:async file=>{assert.ok(snapshots.length,"must save final output before deleting frames");deletions.push(file);await fs.unlink(file);},
    ...overrides
  };
  const cleanup=Function("deps",`const {${Object.keys(deps)}}=deps;${code};return cleanupRunKeyframes;`)(deps);
  return {run,cleanup,directory,runRoot,original,product,audio,frames,raw,receipt,orphan,note,output,snapshots,deletions,deps};
}
test("archived final video deletes only owned keyframes and caches, preserves inputs and receipts, and is idempotent",async t=>{
  const h=await fixture(t); await Promise.all([h.cleanup(h.run),h.cleanup(h.run)]);
  for(const item of [...h.frames,h.raw,h.receipt,h.orphan]) assert.equal(await exists(item.path),false);
  for(const item of [h.original,h.product,h.audio,h.output,h.note]) assert.equal(await exists(item.path),true);
  assert.ok(h.run.keyframeCleanup.completedAt);
  assert.equal(h.run.keyframeCleanup.deletedFileCount,5);
  assert.equal(h.run.imageTasks[0].taskId,"paid-image-task");
  assert.ok(h.run.editedKeyframes[0].localDeletedAt);
  assert.equal(h.run.imageTasks[0].rawPath,null);
  assert.equal(h.deps.media.size,0);
  const count=h.deletions.length;await h.cleanup(h.run);assert.equal(h.deletions.length,count);
});
test("image-only, failed, processing, missing/invalid final video and active submissions retain every frame",async t=>{
  const h=await fixture(t);
  for(const change of [{stage:"image"},{status:"FAILED"},{status:"PROCESSING"},{output:{id:"none",path:path.join(h.runRoot,"output","missing.mp4")}},{output:h.original}]) {
    await h.cleanup({...h.run,...change});assert.equal(h.deletions.length,0);
  }
  h.deps.submissionClaims.add(h.run.id);await h.cleanup(h.run);assert.equal(h.deletions.length,0);h.deps.submissionClaims.clear();
  const invalid=await fixture(t,{execFileAsync:async()=>{throw Error("invalid video");}});await invalid.cleanup(invalid.run);assert.equal(invalid.deletions.length,0);
});
test("path traversal and reference aliases cannot delete source, reference or outside files",async t=>{
  const h=await fixture(t);
  const outside=path.join(h.directory,"outside.png");await fs.writeFile(outside,"untouched");
  h.run.keyframes.push({id:"outside",path:outside},h.product);
  h.run.productImages.push(h.frames[1]); // A protected reference even if malformed metadata puts it in the frame directory.
  await h.cleanup(h.run);
  assert.equal(await exists(outside),true);assert.equal(await exists(h.product.path),true);assert.equal(await exists(h.frames[1].path),true);
  const invalid=await fixture(t);await invalid.cleanup({...invalid.run,id:"../run"});assert.equal(invalid.deletions.length,0);
});
test("cleanup failure preserves final success and a retry clears missing-file metadata without charging",async t=>{
  const h=await fixture(t);
  let calls=0;
  h.deps.unlink=async file=>{if(++calls===2)throw Error("locked file");await fs.unlink(file);};
  // Rebuild with the injected unlink to fail after one deletion.
  const cleanup=Function("deps",`const {${Object.keys(h.deps)}}=deps;${code};return cleanupRunKeyframes;`)(h.deps);
  await cleanup(h.run);assert.equal(h.run.status,"SUCCEEDED");assert.equal(h.run.keyframeCleanup.pending,true);
  await cleanup(h.run);assert.ok(h.run.keyframeCleanup.completedAt);assert.ok(h.run.keyframes[0].localDeletedAt);
  assert.equal(await exists(h.output.path),true);
});
test("cleanup is hooked into completed polling and restart, not before final archive",()=>{
  assert.match(source,/indexRunMedia\(run\);\s+await cleanupRunKeyframes\(run\);/);
  assert.match(source,/if \(normalized\(run.status\) === "succeeded"\) \{ await cleanupRunKeyframes\(run\); return; \}/);
  assert.match(source,/await persistRun\(run\);\s+await cleanupRunKeyframes\(run\);\s+await logRun\(run, "run_refreshed"/);
});
test("service restart validates a real MP4 then removes successful-task frames without provider calls",async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),"keyframe-cleanup-http-"));
  let child;
  t.after(async()=>{if(child && child.exitCode===null)child.kill();if(child && child.exitCode===null)await new Promise(resolve=>child.once("exit",resolve));await fs.rm(directory,{recursive:true,force:true});});
  const root=path.join(directory,"runs","completed-run");
  await fs.mkdir(path.join(root,"output"),{recursive:true});await fs.mkdir(path.join(root,"kling-output"));await fs.mkdir(path.join(root,"inputs","source-video"),{recursive:true});
  const output=path.join(root,"output","final.mp4"),frame=path.join(root,"kling-output","edited.png"),original=path.join(root,"inputs","source-video","original.mp4");
  await exec(process.env.FFMPEG_PATH || "ffmpeg",["-y","-f","lavfi","-i","color=c=blue:s=64x64:d=0.4","-c:v","libx264","-pix_fmt","yuv420p",output],{windowsHide:true,maxBuffer:1024*1024});
  await fs.copyFile(output,original);await fs.writeFile(frame,"paid image fixture");
  const run={id:"completed-run",stage:"video",status:"SUCCEEDED",output:{id:"final",path:output,name:"final.mp4",mime:"video/mp4"},sourceVideo:{id:"source",path:original,name:"source.mp4"},editedKeyframes:[{id:"frame",path:frame,name:"edited.png"}],imageTasks:[{taskId:"paid-frame-id",status:"SUCCEEDED"}],createdAt:new Date().toISOString()};
  await fs.writeFile(path.join(root,"run.json"),JSON.stringify(run));
  const listener=createServer();await new Promise(resolve=>listener.listen(0,"127.0.0.1",resolve));const port=listener.address().port;await new Promise(resolve=>listener.close(resolve));
  const serverFile=path.join(directory,"server.mjs");await fs.writeFile(serverFile,source);
  child=spawn(process.execPath,[serverFile],{windowsHide:true,stdio:"ignore",env:{...process.env,RUNS_DIR:path.join(directory,"runs"),PORT:String(port),HOST:"127.0.0.1",MOCK_PIPELINE:"true",WAW_API_KEY:"",AIMANPLAY_TOKEN:"",KLING_API_KEY:"",XINHANKR_API_KEY:""}});
  let ready=false;
  for(let i=0;i<100;i++){try{ready=(await fetch(`http://127.0.0.1:${port}/api/health`)).ok;if(ready)break;}catch{}await new Promise(resolve=>setTimeout(resolve,50));}
  assert.ok(ready,"isolated service starts");
  const response=await fetch(`http://127.0.0.1:${port}/api/runs/completed-run`);assert.equal(response.status,200);const record=await response.json();
  assert.equal(record.status,"SUCCEEDED");assert.deepEqual(record.editedKeyframes,[null]);assert.ok(record.keyframeCleanup.completedAt);
  assert.equal(await exists(frame),false);assert.equal(await exists(output),true);assert.equal(await exists(original),true);
  const saved=JSON.parse(await fs.readFile(path.join(root,"run.json"),"utf8"));assert.ok(saved.editedKeyframes[0].localDeletedAt);assert.equal(saved.imageTasks[0].taskId,"paid-frame-id");
});
