# 新站 Wan3 接口核对记录

核对时间：2026-10-12。通过浏览器阅读平台自身的文档，不提交生成任务。

## 已确认

- 模型页：https://token.xinhankr.com/home/models?tab=trending&model=wan3.0-video
- 原生协议文档：https://token.xinhankr.com/docs/ali-kling/doc0026
- 万相多模态调用示例：https://token.xinhankr.com/docs/examples/doc0014
- Base URL：`https://token.xinhankr.com`
- 鉴权：`Authorization: Bearer <新站令牌>`。
- 视频提交：`POST /api/v1/services/aigc/video-generation/video-synthesis`。
- 任务查询：`GET /api/v1/tasks/{task_id}`。
- 异步请求头：`X-DashScope-Async: enable`。
- 平台说明：请求包含官方 `input`、`parameters` 时原样透传。
- “万相视频生成”文档明确展示图片、视频、音频联合参考；使用 `reference_image`、`reference_video`、`reference_audio`，不可仅上传音频。
- 图片必须明确标记参考图用途，不能依赖默认张数推断：该平台的 OpenAI 兼容接口将未指定用途的1张/2张图默认解释为首帧/首尾帧。

本 demo 选择原生协议，以保留官方 `input.media`、`parameters.audio` 等字段。使用用户链接所选的 `wan3.0-video`，不是旧版 demo 的 Prime 默认值。

## 未确认与验证边界

- 文档没有核实可用于本 demo 的文件上传接口或 Data URL 支持，因此不复用百炼 OSS 上传凭证，也不猜测上传接口。提交时使用限于本次冻结素材的临时 HTTPS 媒体地址。
- 本地测试通过不等于平台已完成真实生成。原生路由的真实账号权限、实际响应结构、模型效果及费用须由用户后续单次提交验证。
- 不将百炼的免费额度视为新站额度；不根据未经确认的输入/输出计费口径展示确定金额。
- `audio=true` 和参考原音轨是模型生成声音的请求，不保证逐字、逐音色或逐帧嘴型完全复制。输出保留模型原生声音，不后期覆写成原音轨。

官方 Wan3 依据：

- 提示词指南：https://help.aliyun.com/zh/model-studio/wan3-video-generation-prompt-guide
- API 参考：https://help.aliyun.com/zh/model-studio/wan3-video-generation-api-reference
