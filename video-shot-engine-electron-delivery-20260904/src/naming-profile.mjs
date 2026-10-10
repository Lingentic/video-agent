const USAGE_TYPES = ["商品展示", "功能讲解", "使用演示", "效果展示", "人物口播", "开场钩子", "问题引入", "场景过渡", "结尾收束", "其他"];

export function createNamingProfile(shots, durationSec, fps = 30) {
  const manifest = shots.map((shot, index) => ({
    shot_id: shot.shotId,
    start_sec: Number(shot.startSec.toFixed(6)),
    end_sec: Number(shot.endSec.toFixed(6)),
    start_frame: shot.startFrame ?? Math.round(shot.startSec * fps),
    end_frame: shot.endFrame ?? Math.round(shot.endSec * fps),
  }));
  const schema = { type: "object", properties: { shots: { type: "array", items: { type: "object", properties: { shot_id: { type: "string", enum: shots.map((shot) => shot.shotId) }, content_title: { type: "string" }, usage_type: { type: "string", enum: USAGE_TYPES } }, required: ["shot_id", "content_title", "usage_type"] } } }, required: ["shots"] };
  const fixedRanges = manifest.map((item) => `${item.shot_id}[${item.start_sec}-${item.end_sec}]`).join("\n");
  const prompt = `你是视频镜头内容命名助手。分析视频已在每个镜头顶部持续标出 SHOT_001、SHOT_002 等编号，编号与下面的 shot_id 一一对应。FFmpeg 已完成最终帧级切分，所有镜头边界均为固定结果，你不得修改边界、返回新边界、新增镜头、删除镜头或合并镜头。必须以画面中的编号确认当前镜头，禁止把前后镜头的主体、动作或口播内容写到当前编号。content_title 只描述当前编号区间内直接可见的主体和动作；音频只辅助判断 usage_type，不得用相邻区间的口播替代当前画面。usage_type 只能选：${USAGE_TYPES.join("、")}。输出的顶层必须是 JSON 对象，唯一顶层字段是 shots，shots 必须恰好包含 ${shots.length} 项。每项只能返回 shot_id、content_title、usage_type，不要返回任何时间或边界字段。不要输出 Markdown 或解释。\n固定镜头区间：\n${fixedRanges}`;
  return { id: "fixed_shot_naming", version: "5-fixed-ffmpeg-boundaries", durationSec, videoOptions: { resolution: "medium" }, manifest, schema, prompt };
}
