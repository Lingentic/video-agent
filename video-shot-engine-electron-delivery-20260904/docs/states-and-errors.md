# 状态与错误处理

## 主要阶段

```text
queued
ffmpeg_processing
ffmpeg_completed
naming_processing
analysis_video_processing
analysis_video_completed
provider_processing
provider_retry
quota_wait
naming_export
completed
```

失败时 `status=failed`，`failedStage` 指明失败前阶段。批次终态为 `completed`、`partial` 或 `failed`。服务重启后，磁盘仍为 `processing` 但接口返回 `active=false` 时应显示“已中断，可恢复”。

## Gemini三层状态机

每层第一次失败后等待，再用完全相同请求重试一次；第二次仍失败才降级。任意一次获得通过完整校验的结果后立即停止。

1. `responseJsonSchema + application/json`，失败等待5秒。
2. 仅 `application/json`，失败等待8秒。
3. 仅提示词要求 JSON，失败等待12秒。

所有请求固定 `thinkingBudget: 0`。最坏单视频6次请求，正常视频通常一次。

## 错误处理

| 类型 | 行为 |
|---|---|
| HTTP 400 | 同层再试一次，仍失败再降级 |
| HTTP 401/402/403/404 | 直接停止 |
| HTTP 429 | 外层按配额等待策略处理 |
| HTTP 5xx | 同层有限重试 |
| 超时/断线 | 同层有限重试，费用标记未知 |
| HTTP 200但JSON或业务字段不合规 | 保存响应并带具体原因纠错重试 |

动态超时：90秒以内视频300秒；90至180秒450秒；超过180秒600秒。

## 本地严格校验

- 镜头 ID 不得缺失、重复或未知；
- `shot_1` 和 `SHOT_001` 可无损归一化为 `shot_001`；
- 顶层数组可无损包装为 `{ "shots": [...] }`；
- 标题不得为空，用途必须在枚举中；
- 候选点必须属于对应镜头；
- 最后一段必须覆盖视频结尾；
- 时间线以前一段终点作为后一段起点。

结构正确不代表语义正确。文件名与画面不符需要抽检或独立复核，不能由 Schema 自动发现。

## 用量与恢复

所有返回 `usageMetadata` 的 HTTP 200 都累计，即使该次输出未通过本地校验。HTTP错误无用量时记录 `no_usage_returned`；超时或断线记录 `unknown`，客户端必须提示费用未知。

恢复只处理未完成和失败视频；成功视频不会再次调用 API。已有且通过校验的 `shot_labels_raw.json` 优先本地复用。不做跨批次缓存。

