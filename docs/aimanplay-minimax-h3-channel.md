# Aimanplay MiniMax H3 低成本渠道备选

记录日期：2026-09-21

当前状态（2026-09-28）：已将客户端多关键帧商品替换的视频生成代码切换到本渠道；`AIMANPLAY_TOKEN` 暂未配置，尚未进行客户端真实付费验证。参考原视频的 Kling 3.0 Omni 路线保持不变。

## 渠道与模型

- 平台：Aimanplay（菠萝 max）
- 模型广场：https://aimanplay.cn/pricing
- API 文档：https://aimanplay.cn/minimaxh3_api.md
- 模型 ID：`minimax_h3_image_audio_to_video_v2_15s`
- 能力：图片与音频参考生成视频
- 输入上限：9 张参考图片、3 条参考音频
- 输出时长：1–15 秒
- 输出分辨率：`480p竖`、`768p竖`、`480p横`、`768p横`
- 标示价格：约 ¥0.06/秒；5 秒约 ¥0.30
- 平台说明：任务失败自动退款

## 调用流程

1. 使用 Aimanplay API Key 请求 `POST /api/video-upload/oss-sts`。
2. 使用平台返回的一小时临时凭证，将图片和音频上传到平台配置的阿里云 OSS。
3. 调用 `POST /v1/videos`，传入模型、提示词、时长、分辨率及 `ref_image_*`、`ref_audio_*` URL。
4. 每 3 秒调用 `GET /v1/videos/{task_id}` 查询状态。
5. 完成后调用 `GET /v1/videos/{task_id}/content` 下载成片。

这条路线不依赖 Quick Tunnel，模型直接从 OSS 读取素材。

## 2026-09-21 实测

测试完全复用了客户端上一轮商品替换任务的：

- 4 张已替换商品的关键帧；
- `laoge-reference.wav` 参考音频；
- 完整原始视频提示词；
- 5 秒、768P 竖屏规格。

结果：

- 仅提交 1 个视频任务；
- 状态正常经历 `queued` → `in_progress` → `completed`；
- 成片成功下载；
- 实际时长 5.1667 秒；
- 分辨率 768 × 1344；
- 24 FPS、H.264；
- 含 AAC 双声道音轨；
- 文件约 4.91 MB；
- 抽帧初检中人物、背景和商品均保持连续，没有明显换景或商品消失。

模型直接根据参考音频生成声音和口型，本次没有调用 Qwen TTS，也没有在生成后替换音轨。

## 可复现资产

独立 Demo：

`C:\Users\17794\Documents\ChatGPT\视频客户端\aimanplay-h3-demo`

成片：

`C:\Users\17794\Documents\ChatGPT\视频客户端\aimanplay-h3-demo\outputs\result.mp4`

运行状态：

`C:\Users\17794\Documents\ChatGPT\视频客户端\aimanplay-h3-demo\outputs\state.json`

Demo 已实现：

- 本地素材校验；
- API Key 与 OSS 可用性检查；
- OSS 上传复用；
- 任务 ID 立即持久化；
- 中断后继续查询原任务；
- 提交结果不确定时停止自动重提，避免重复计费；
- 默认关闭付费运行开关。

## 正式使用前需要确认

- 主观检查音色相似度、台词准确度和口型同步质量；
- 向平台确认 OSS 素材保留时间、自动清理策略与隐私政策；
- 确认生产环境的稳定性、并发限制和长期价格；
- 在客户端服务的 `.env` 中配置 `AIMANPLAY_TOKEN`，然后进行一次完整链路验证；
- 若正式接入，用户界面不得暴露 OSS、任务 ID 或供应商底层错误。

## 安全说明

API Key 不写入本文档、不提交 Git，只保存在独立 Demo 的本地 `.env` 中。
