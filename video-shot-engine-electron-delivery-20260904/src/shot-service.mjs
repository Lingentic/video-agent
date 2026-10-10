import fsp from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ffmpegPath, ffprobePath, inspectMediaTools } from "./runtime-paths.mjs";
const execFileAsync = promisify(execFile);
export const SHOT_DETECTION_VERSION = "3-single-threshold";

export function assertCurrentShotDetection(record) {
  if (record.shotDetectionVersion !== SHOT_DETECTION_VERSION) {
    const error = new Error("镜头检测版本不一致，不能恢复或继续命名此任务；请创建新任务。历史成果仍可查看。");
    error.code = "SHOT_DETECTION_VERSION_MISMATCH";
    throw error;
  }
}

export function parseSceneCuts(stderr) { const cuts=[]; const re=/lavfi\.scd\.score:\s*([\d.]+),\s*lavfi\.scd\.time:\s*([\d.]+)/g; for(const m of String(stderr).matchAll(re)){const score=Number(m[1]),timeSec=Number(m[2]);if(Number.isFinite(score)&&Number.isFinite(timeSec))cuts.push({timeSec,score});} return cuts; }

// scdet has already applied the task threshold; only minimum shot duration is enforced here.
export function planShots(cuts,durationSec,{minDurationSec=0.2}={}) { const accepted=[]; for(const c of [...cuts].sort((a,b)=>a.timeSec-b.timeSec)){const prev=accepted.at(-1)?.timeSec??0;if(c.timeSec-prev<minDurationSec||durationSec-c.timeSec<minDurationSec)continue;accepted.push(c);} const boundaries=[0,...accepted.map(c=>c.timeSec),durationSec]; return boundaries.slice(0,-1).map((startSec,i)=>({shotId:`shot_${String(i+1).padStart(3,"0")}`,startSec,endSec:boundaries[i+1],durationSec:boundaries[i+1]-startSec,startCutScore:i?accepted[i-1].score:null,endCutScore:accepted[i]?.score??null})); }

async function probe(file, signal, runCommand) { const {stdout}=await runCommand(ffprobePath,["-v","error","-show_entries","format=duration:stream=r_frame_rate","-of","json",file],{signal}); const value=JSON.parse(stdout); const stream=value.streams?.find((item)=>item.r_frame_rate&&item.r_frame_rate!=="0/0"); const [num,den]=String(stream?.r_frame_rate||"30/1").split("/").map(Number); return { durationSec:Number(value.format.duration), fps:Number.isFinite(num/den)?num/den:30 }; }

export async function processVideo({runDir,inputPath,threshold=20,minDurationSec=0.2,keepAudio=false,artifactsDir=runDir,signal}, {runCommand=execFileAsync,inspectTools=inspectMediaTools}={}) {
  signal?.throwIfAborted(); const mediaTools=await inspectTools(); await fsp.mkdir(artifactsDir,{recursive:true}); await fsp.writeFile(path.join(artifactsDir,"ffmpeg_runtime.json"),`${JSON.stringify(mediaTools,null,2)}\n`,"utf8"); if(!mediaTools.ffmpeg.available||!mediaTools.ffprobe.available) throw new Error(`FFmpeg 工具不可用：${[mediaTools.ffmpeg,mediaTools.ffprobe].filter((tool)=>!tool.available).map((tool)=>`${tool.name}: ${tool.error}`).join("；")}`); const { durationSec, fps }=await probe(inputPath,signal,runCommand); const candidateThreshold=threshold;
  signal?.throwIfAborted(); const {stderr}=await runCommand(ffmpegPath,["-hide_banner","-nostats","-i",inputPath,"-vf",`scdet=threshold=${threshold}`,"-an","-f","null","-"],{maxBuffer:32*1024*1024,signal});
  const rawCuts=parseSceneCuts(stderr); const candidateCuts=rawCuts; const shots=planShots(candidateCuts,durationSec,{minDurationSec});
  await fsp.writeFile(path.join(artifactsDir,"scene_cuts.json"),JSON.stringify({shotDetectionVersion:SHOT_DETECTION_VERSION,threshold,candidateThreshold,fps,clusterWindowFrames:0,minDurationSec,rawCuts,candidateCuts},null,2));
  const outDir=path.join(artifactsDir,"shot_segments"); await fsp.mkdir(outDir,{recursive:true}); const records=[];
  for (const shot of shots) {
    signal?.throwIfAborted();
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
    await runCommand(ffmpegPath, args, { maxBuffer: 4 * 1024 * 1024, signal });
    records.push({ ...shot, startFrame, endFrame, frameCount, startSec, endSec: endFrame / fps, durationSec, filePath: `artifacts/shot_segments/${fileName}` });
  }
  await fsp.writeFile(path.join(outDir,"shot_segments.json"),JSON.stringify(records,null,2));
  return {shotDetectionVersion:SHOT_DETECTION_VERSION,mediaTools,durationSec,threshold,candidateThreshold,fps,clusterWindowFrames:0,minDurationSec,keepAudio,cuts:candidateCuts,rawCuts,shots:records};
}
