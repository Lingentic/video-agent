import fsp from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ffmpegPath, ffprobePath, inspectMediaTools } from "./runtime-paths.mjs";
const execFileAsync = promisify(execFile);

export function parseSceneCuts(stderr) { const cuts=[]; const re=/lavfi\.scd\.score:\s*([\d.]+),\s*lavfi\.scd\.time:\s*([\d.]+)/g; for(const m of String(stderr).matchAll(re)){const score=Number(m[1]),timeSec=Number(m[2]);if(Number.isFinite(score)&&Number.isFinite(timeSec))cuts.push({timeSec,score});} return cuts; }

export function clusterSceneCuts(cuts, fps = 30, { clusterWindowFrames = 1 } = {}) {
  const windowSec = Math.max(1, Number(clusterWindowFrames)) / Math.max(1, Number(fps)); const clustered = [];
  for (const cut of [...cuts].sort((a, b) => a.timeSec - b.timeSec)) {
    const last = clustered.at(-1);
    if (last && cut.timeSec - last.timeSec <= windowSec) { continue; }
    else clustered.push({ ...cut });
  }
  return clustered;
}

export function planShots(cuts,durationSec,{threshold=20,minDurationSec=0.2}={}) { const accepted=[]; for(const c of [...cuts].sort((a,b)=>a.timeSec-b.timeSec)){if(c.score<threshold)continue;const prev=accepted.at(-1)?.timeSec??0;if(c.timeSec-prev<minDurationSec||durationSec-c.timeSec<minDurationSec)continue;accepted.push(c);} const boundaries=[0,...accepted.map(c=>c.timeSec),durationSec]; return boundaries.slice(0,-1).map((startSec,i)=>({shotId:`shot_${String(i+1).padStart(3,"0")}`,startSec,endSec:boundaries[i+1],durationSec:boundaries[i+1]-startSec,startCutScore:i?accepted[i-1].score:null,endCutScore:accepted[i]?.score??null})); }

async function probe(file) { const {stdout}=await execFileAsync(ffprobePath,["-v","error","-show_entries","format=duration:stream=r_frame_rate","-of","json",file]); const value=JSON.parse(stdout); const stream=value.streams?.find((item)=>item.r_frame_rate&&item.r_frame_rate!=="0/0"); const [num,den]=String(stream?.r_frame_rate||"30/1").split("/").map(Number); return { durationSec:Number(value.format.duration), fps:Number.isFinite(num/den)?num/den:30 }; }

export async function processVideo({runDir,inputPath,threshold=20,minDurationSec=0.2,keepAudio=false,artifactsDir=runDir}) {
  const mediaTools=await inspectMediaTools(); await fsp.mkdir(artifactsDir,{recursive:true}); await fsp.writeFile(path.join(artifactsDir,"ffmpeg_runtime.json"),`${JSON.stringify(mediaTools,null,2)}\n`,"utf8"); if(!mediaTools.ffmpeg.available||!mediaTools.ffprobe.available) throw new Error(`FFmpeg 工具不可用：${[mediaTools.ffmpeg,mediaTools.ffprobe].filter((tool)=>!tool.available).map((tool)=>`${tool.name}: ${tool.error}`).join("；")}`); const { durationSec, fps }=await probe(inputPath); const candidateThreshold=Math.max(1,Math.min(5,threshold));
  const {stderr}=await execFileAsync(ffmpegPath,["-hide_banner","-nostats","-i",inputPath,"-vf",`scdet=threshold=${candidateThreshold}`,"-an","-f","null","-"],{maxBuffer:32*1024*1024});
  const rawCuts=parseSceneCuts(stderr); const candidateCuts=clusterSceneCuts(rawCuts,fps,{clusterWindowFrames:1}); const shots=planShots(candidateCuts,durationSec,{threshold,minDurationSec}); const outDir=path.join(artifactsDir,"shot_segments"); await fsp.mkdir(outDir,{recursive:true}); const records=[];
  for (const shot of shots) {
    const fileName = `${shot.shotId}.mp4`;
    const startFrame = Math.max(0, Math.round(shot.startSec * fps));
    const endFrame = Math.max(startFrame + 1, Math.round(shot.endSec * fps));
    const frameCount = endFrame - startFrame;
    const startSec = startFrame / fps;
    const durationSec = frameCount / fps;
    const args = ["-y", "-i", inputPath, "-ss", String(startSec), "-t", String(durationSec), "-map", "0:v:0", "-frames:v", String(frameCount)];
    if (keepAudio) args.push("-map", "0:a?", "-c:a", "aac");
    else args.push("-an");
    args.push("-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-movflags", "+faststart", path.join(outDir, fileName));
    await execFileAsync(ffmpegPath, args, { maxBuffer: 4 * 1024 * 1024 });
    records.push({ ...shot, startFrame, endFrame, frameCount, startSec, endSec: endFrame / fps, durationSec, filePath: `artifacts/shot_segments/${fileName}` });
  }
  await fsp.writeFile(path.join(artifactsDir,"scene_cuts.json"),JSON.stringify({threshold,candidateThreshold,fps,clusterWindowFrames:1,rawCuts,candidateCuts},null,2)); await fsp.writeFile(path.join(outDir,"shot_segments.json"),JSON.stringify(records,null,2));
  return {shotDetectionVersion:"2-primary-threshold",mediaTools,durationSec,threshold,candidateThreshold,fps,clusterWindowFrames:1,minDurationSec,keepAudio,cuts:candidateCuts,rawCuts,shots:records};
}
