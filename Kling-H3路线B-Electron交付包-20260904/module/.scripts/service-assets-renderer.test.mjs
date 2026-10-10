import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../../../electron/renderer/app.js", import.meta.url), "utf8");
const start = source.indexOf("async function loadShotAssets()");
const end = source.indexOf('if (uiPreviewMode === "folder-processing"', start);
assert.ok(start >= 0 && end > start);
const functions = source.slice(start, end);
const tick = () => new Promise(resolve => setImmediate(resolve));
const services = () => [{key:"shot",status:"ready",pid:10,port:3100},{key:"kling",status:"ready",pid:20,port:8700}];

function fixture(overrides = {}) {
  const calls = {shot:0,kling:0};
  const deps = {
    state:{active:"library",library:[],split:{config:{}},remake:{config:{},voices:[{}]}},
    videoClient:{
      listShotAssets:async()=>{calls.shot++; return {assets:[]};},
      listKlingAssets:async()=>{calls.kling++; return {assets:[]};},
      ...overrides
    },
    serviceStatus:{},sortLibraryNewestFirst(){},render(){},notify(){},loadShotConfig(){},URL
  };
  const api = Function("deps", `const {${Object.keys(deps)}}=deps;
    let shotAssetsLoading=false,klingAssetsLoading=false,klingAssetsRevision=0,latestBatchChecked=true,latestRemakeChecked=true;
    const assetServiceInstances=new Map(); let latestServices=[];
    ${functions}; return {showServices,loadShotAssets,loadKlingAssets};`)(deps);
  return {...api,calls};
}

test("unchanged ready notifications skip scans while explicit refresh and readiness transitions still scan", async () => {
  const h=fixture(), current=services();
  h.showServices(current); await tick();
  for(let i=0;i<5;i++){h.showServices(current); await tick();}
  assert.deepEqual(h.calls,{shot:1,kling:1});
  await h.loadShotAssets(); await h.loadKlingAssets();
  assert.deepEqual(h.calls,{shot:2,kling:2});
  h.showServices([{...current[0],status:"stopped"},current[1]]); await tick();
  h.showServices(current); await tick();
  assert.deepEqual(h.calls,{shot:3,kling:2});
  h.showServices([current[0],{...current[1],pid:21,port:8701}]); await tick();
  assert.deepEqual(h.calls,{shot:3,kling:3});
});

test("failed scans are retried by the next ready notification", async () => {
  let attempts=0;
  const h=fixture({listShotAssets:async()=>{attempts++; if(attempts===1)throw Error("offline"); return {assets:[]};}});
  h.showServices(services()); await tick();
  h.showServices(services()); await tick();
  h.showServices(services()); await tick();
  assert.equal(attempts,2);
});

test("a service changing during an in-flight scan is scanned once again after that scan finishes", async () => {
  let resolve, attempts=0;
  const h=fixture({listShotAssets:async()=>{attempts++; return attempts===1 ? new Promise(yes=>{resolve=yes;}) : {assets:[]};}});
  h.showServices(services()); await tick();
  const restarted=services(); restarted[0].pid=11;
  h.showServices(restarted); await tick();
  assert.equal(attempts,1);
  resolve({assets:[]}); await tick(); await tick();
  assert.equal(attempts,2);
  h.showServices(restarted); await tick();
  assert.equal(attempts,2);
});
