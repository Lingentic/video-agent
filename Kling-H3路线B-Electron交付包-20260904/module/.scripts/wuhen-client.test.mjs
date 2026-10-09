import assert from "node:assert/strict";
import test from "node:test";
import {readFile} from "node:fs/promises";
import vm from "node:vm";
import path from "node:path";
const main=await readFile(new URL("../../../electron/main.mjs",import.meta.url),"utf8");
const renderer=await readFile(new URL("../../../electron/renderer/app.js",import.meta.url),"utf8");
const preload=await readFile(new URL("../../../electron/preload.cjs",import.meta.url),"utf8");
function part(source,start,end){return source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)));}
test("IPC keeps folder grouping and common model/method without manual crop while default stays off",()=>{
  let client;const calls=[];
  vm.runInNewContext(preload,{require:()=>({contextBridge:{exposeInMainWorld:(_,value)=>{client=value;}},ipcRenderer:{invoke:(...args)=>calls.push(args)},webUtils:{getPathForFile: file=>file.path}})});
  const options={model:"video_removal_std",method:"sel_area"},rect={x1:0.1,y1:0.7,x2:0.9,y2:0.8};
  client.createShotBatch([{file:{path:"a.mp4"},subtitleRectNormalized:rect},{path:"b.mp4",folderId:"folder",subtitleRectNormalized:rect}],"ffmpeg_only",true,true,options);
  assert.equal(calls[0][1].removeSubtitles,true);assert.deepEqual(JSON.parse(JSON.stringify(calls[0][1].subtitleOptions)),options);
  assert.equal(calls[0][1].entries[0].path,"a.mp4");assert.equal(calls[0][1].entries[1].folderId,"folder");assert.equal(calls[0][1].entries[1].subtitleRectNormalized,undefined);assert.equal(client.configureSubtitles,undefined);
  client.createShotRun({path:"a.mp4"},"ffmpeg_only",true);assert.equal(calls[1][1].removeSubtitles,false);
});
test("main starts only the dedicated transfer tunnel when enabled and forwards settings to the backend",async()=>{
  const requests=[],tunnels=[];
  const deps={path,FormData,openAsBlob:async()=>new Blob(["fixture"]),prepareSubtitleTunnel:async()=>tunnels.push("tunnel"),shotRequest:async(route,init)=>{requests.push({route,init});return {batchId:"batch_test"};}};
  const code=part(main,"async function createShotBatch(","async function resumeShotBatch(");
  const create=Function("deps",`const {${Object.keys(deps)}}=deps;${code};return createShotBatch;`)(deps);
  const entries=[{path:"a.mp4",folderId:"folder",subtitleRectNormalized:{x1:0,y1:0.8,x2:1,y2:0.9}}];
  await create({entries,workflow:"ffmpeg_only",removeSubtitles:false});assert.equal(tunnels.length,0);assert.equal(requests[0].init.body.get("removeSubtitles"),"off");
  const options={model:"video_removal_pro",method:"sel_area"};await create({entries,workflow:"ffmpeg_only",removeSubtitles:true,subtitleOptions:options});
  assert.equal(tunnels.length,1);const body=requests[1].init.body;assert.deepEqual(JSON.parse(body.get("subtitleOptions")),{model:"video_removal_std",method:"sel_area"});assert.equal(JSON.parse(body.get("folderManifest"))[0].subtitleRectNormalized,undefined);assert.equal(JSON.parse(body.get("folderManifest"))[0].sourceFolderId,"folder");
});
test("tunnel reuses configured transport port and sends no API key to the public receiver",async()=>{
  const requests=[],ensures=[];const service={};
  const deps={getReadyShotService:()=>service,stopChild:async()=>{},ensureQuickTunnel:async value=>{ensures.push(value);return "https://fixture.trycloudflare.com";},shotRequest:async(route,options)=>{requests.push({route,options});return {subtitleConfigured:true,subtitleTransportPort:32001};}};
  const fn=Function("deps",`const {${Object.keys(deps)}}=deps;${part(main,"async function prepareSubtitleTunnel(","async function createShotRun(")};return prepareSubtitleTunnel;`)(deps);
  await fn();await fn();assert.equal(ensures[0],ensures[1]);assert.equal(ensures[0].port,32001);assert.equal(ensures[0].definition.healthPath,"/api/health");
  assert.deepEqual(JSON.parse(requests.find(r=>r.route==="api/subtitle-transport").options.body),{publicBaseUrl:"https://fixture.trycloudflare.com"});
  deps.shotRequest=async()=>({subtitleConfigured:false});
  const blocked=Function("deps",`const {${Object.keys(deps)}}=deps;${part(main,"async function prepareSubtitleTunnel(","async function createShotRun(")};return prepareSubtitleTunnel;`)(deps);await assert.rejects(blocked(),/配置无痕/);
  assert.match(main,/credentials", "wuhen.key"/);assert.match(main,/env\.WUHEN_API_KEY = subtitleKey/);assert.match(main,/stopChild\(service.subtitleTunnel\?\.tunnelChild\)/);
});
test("client uses provisioned credentials and displays fixed processing without configuration or crop controls",()=>{
  const state={split:{config:{subtitleConfigured:true},sources:[{name:"one.mp4"},{name:"two.mp4"}]}};
  const fn=Function("state","defaultSubtitleOptions","step","options",`${part(renderer,"function subtitleStep(","function batchProcessingRoute(")};return subtitleStep;`)(state,()=>({model:"video_removal_std",method:"sel_area"}),(_n,_title,_hint,content)=>content,(_id,values)=>values.join(" "));
  const html=fn({removeSubtitles:true});assert.match(html,/固定处理画面底部字幕/);assert.doesNotMatch(html,/STD|PRO|处理模型|框选字幕|配置无痕|服务密钥|one\.mp4|two\.mp4/);
  assert.doesNotMatch(renderer,/subtitleModel/);
  assert.doesNotMatch(renderer,/subtitle-config-open|subtitle-region-open|subtitleApiKey|openSubtitleConfig/);
  assert.match(main,/readEnvValue\(path\.join\(definition\.cwd, "\.env"\), "WUHEN_API_KEY"\)/);
  assert.doesNotMatch(part(renderer,"async function runSplitBatch(","async function runSplit("),/请先为每条视频设置字幕区域/);
});
test("queue count and processing percentage are not confused and paused tasks can be restored",()=>{
  const code=part(renderer,"function subtitleStageDescription(","function batchFromResponse(");
  const stage=Function("batchStageText",`${code};return subtitleStageDescription;`)(()=>"处理中");
  assert.match(stage({subtitle:{status:"queued",queueAhead:3}}),/前方 3 个任务/);assert.doesNotMatch(stage({subtitle:{status:"queued",queueAhead:3}}),/%/);
  assert.match(stage({subtitle:{status:"processing",progress:32}}),/32%/);
  assert.match(renderer, /\["queued", "processing", "partial", "failed", "paused"\]\.includes\(status\)/);
  assert.match(renderer,/\$\{subtitleStep\(item, item.running\)\}/);
  assert.match(renderer,/\$\{subtitleStep\(batch, true\)\}/);
  assert.doesNotMatch(renderer,/填写智凌 API/);
});
