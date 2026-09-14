# 镜头切分与素材命名工具

使用本地 FFmpeg/ffprobe 按 `scdet` 画面变化生成镜头候选，再由 `gemini-3.6-flash` 观看原视频并复核候选边界；Gemini 只返回最终边界、`content_title` 和剪辑用途 `usage_type`，不做语义分割或其他业务分析。

## 启动

1. 复制 `.env.example` 为 `.env`，填写 `XINHANKR_API_KEY`。
2. 运行 `npm install`。
3. 运行 `npm start`，打开 `http://localhost:3141`。

供应商固定为 xinhankr 的 Google 原生 `generateContent` 接口，使用 `thinkingBudget: 0`；未配置 Key 时，本地 FFmpeg 镜头切分仍可独立使用。

结构化输出首选 Google 原生的 `generationConfig.responseJsonSchema` 与 `responseMimeType: application/json`。发送给网关的 Schema 只描述稳定字段、类型、必填项和用途枚举；精确镜头数量不使用第三方适配器兼容性不稳定的数组长度关键字，而由提示词和本地严格校验共同保证。本地同时校验镜头 ID 不缺失、不重复、候选边界属于对应镜头且最后覆盖视频结尾。兼容层只接受语义等价的 `{ "shots": [...] }` 和顶层 `[...]` 两种外壳，不猜测缺失字段。所有兼容重试都必须保留 `thinkingConfig: { "thinkingBudget": 0 }`。

新版本运行记录默认写入独立的 `runs-v1/`。默认显著变化阈值为 `20`、最短镜头为 `0.2` 秒，正式镜头严格使用页面阈值；低阈值扫描只用于收集诊断候选，不能直接生成正式切片。FFmpeg 原始事件只合并相距不超过 2 帧的重复检测点，并保留其中分数最高者；FPS、帧窗口、原始候选和去重候选都保存在 `artifacts/scene_cuts.json`。运行根目录只保留 `input.*`、`named_segments/` 和内部产物目录 `artifacts/`；界面不列出任何单独片段，只显示拆分段数。

发送给 xinhankr 的不是原始大文件，而是最长边约束后的 480 宽、15 FPS、目标不超过约 7 MB 的编号分析副本，保留低码率音频；Base64 估算大小和上传方式保存在 `analysis_input_config.json` 与 `gemini_file_created.json`。最终切片始终从原始视频重新导出，不受分析副本画质影响。

Gemini 提示词快照保存在每次运行的 `artifacts/naming_prompt_snapshot.txt`。第一版由 FFmpeg 固定镜头数量；每个切点只提供相距最多约 2 帧的真实候选，Gemini 只能选择每段的 `end_candidate_id`，不得新增、删除或合并镜头。程序自动以前一段终点作为后一段起点，保证全片连续。

## 批量处理

文件选择框支持一次选择多个视频。选择一个文件时继续使用单视频运行；选择两个或更多文件时创建 `batch_*` 批次，视频按顺序独立执行 FFmpeg 和 Gemini，单个失败不会丢失其他视频的结果。

批次目录包含 `batch.json`、`catalog.json`、`catalog.csv`，每个视频位于 `items/video_###/`。第一版固定串行处理，一次只调用一个视频；不同视频不共享分析上下文、编号或结果。

每个 `item.json` 记录 `queuedAt`、`queueDurationMs`、`activeDurationMs`、`quotaWaitDurationMs`、Token、预估费用和历次 `attempts`。命名请求采用三层有限状态机：每一层最多尝试两次，第一次失败后静默等待再用完全相同的请求重试，只有第二次仍失败才进入下一层；拿到第一份通过完整校验的结果后立即停止。费用按页面当前价格输入 ¥1.5/百万 Token、输出 ¥7.5/百万 Token 估算，累计所有实际返回 usage 的响应；HTTP 400 等无 usage 响应不计 Token，传输超时单独标记为费用未知。失败时另存 `artifacts/error.json`，包含失败阶段、供应商响应和请求尝试。模型响应、原始标签与用量在校验前落盘，因此校验或导出失败后可优先本地恢复。

页面显示每个视频的阶段、实际处理时间、输入/输出/总 Token、API 尝试次数、最终成功层级和错误；超时请求会提示费用未知。页面不列出原始片段或命名片段，只显示成功拆分段数；批次顶部提供 `catalog.csv` 下载。

“恢复批次”只处理失败或未完成项，已完成视频跳过；每个失败视频还提供“重试此视频”，不会重跑同批其他视频。自动配额重试最多 3 次，不会无限等待。
