# 镜头切分与素材命名工具

使用本地 FFmpeg/ffprobe 按 `scdet` 画面变化固定镜头边界，再由 `gemini-3.6-flash` 观看编号分析副本命名。Gemini 只返回 `shot_id`、`content_title` 和剪辑用途 `usage_type`，不能改变边界或增删、合并镜头。

## 启动

1. 复制 `.env.example` 为 `.env`，填写 `XINHANKR_API_KEY`。
2. 运行 `npm install`。
3. 运行 `npm start`，打开 `http://localhost:3141`。

供应商固定为 xinhankr 的 Google 原生 `generateContent` 接口，使用 `thinkingBudget: 0`；未配置 Key 时，本地 FFmpeg 镜头切分仍可独立使用。

结构化输出首选 Google 原生的 `generationConfig.responseJsonSchema` 与 `responseMimeType: application/json`。发送给网关的 Schema 只描述稳定字段、类型、必填项和用途枚举；精确镜头数量不使用第三方适配器兼容性不稳定的数组长度关键字，而由提示词和本地严格校验共同保证。本地同时校验镜头 ID 不缺失、不重复，导出使用 FFmpeg 已固定的整数帧边界并覆盖视频结尾。兼容层只接受语义等价的 `{ "shots": [...] }` 和顶层 `[...]` 两种外壳，不猜测缺失字段。所有兼容重试都必须保留 `thinkingConfig: { "thinkingBudget": 0 }`。

新版本运行记录默认写入独立的 `runs-v1/`。服务函数默认显著变化阈值仍为 `20`，客户端提交任务的默认阈值仍为 `12`；最短镜头默认 `0.2` 秒。正式检测仅使用任务传入的一个阈值：FFmpeg 直接执行 `scdet=threshold=<任务阈值>`，不做低阈值预扫描或后续分数过滤，也不按固定帧窗口合并相邻事件。`planShots` 按时间顺序处理全部达标事件，只因距前一个已接受切点（或开头）不足最短镜头时长、或距视频结尾不足该时长而舍弃切点；不取最高分或移动到附近峰值。

`artifacts/scene_cuts.json` 在切片导出前保存所有达标检测事件（`rawCuts` 与兼容字段 `candidateCuts` 内容相同），包括被最短镜头规则舍弃的事件，并记录 `minDurationSec`。兼容字段 `candidateThreshold` 等于任务阈值，`clusterWindowFrames` 为 `0`。检测版本为 `3-single-threshold`。切片继续按整数帧边界、指定帧数重新编码导出；本次规则仅消除合格事件被低分候选或固定窗口错误挤掉的问题，不保证已消除所有镜头边界定位误差。运行根目录只保留 `input.*`、`named_segments/` 和内部产物目录 `artifacts/`；界面不列出任何单独片段，只显示拆分段数。

发送给 xinhankr 的不是原始大文件，而是最长边约束后的 480 宽、15 FPS、目标不超过约 7 MB 的编号分析副本，保留低码率音频；Base64 估算大小和上传方式保存在 `analysis_input_config.json` 与 `gemini_file_created.json`。最终切片始终从原始视频重新导出，不受分析副本画质影响。

Gemini 提示词快照保存在每次运行的 `artifacts/naming_prompt_snapshot.txt`。FFmpeg 先固定镜头数量、编号和帧边界，Gemini 只命名，不返回或选择切点。程序沿用同一组边界导出每段，保证片段连续。

## 批量处理

文件选择框支持一次选择多个视频。选择一个文件时继续使用单视频运行；选择两个或更多文件时创建 `batch_*` 批次，视频按顺序独立执行 FFmpeg 和 Gemini，单个失败不会丢失其他视频的结果。

批次目录包含 `batch.json`、`catalog.json`、`catalog.csv`，每个视频位于 `items/video_###/`。第一版固定串行处理，一次只调用一个视频；不同视频不共享分析上下文、编号或结果。

每个 `item.json` 记录 `queuedAt`、`queueDurationMs`、`activeDurationMs`、`quotaWaitDurationMs`、Token、预估费用和历次 `attempts`。命名请求采用三层有限状态机：每一层最多尝试两次，第一次失败后静默等待再用完全相同的请求重试，只有第二次仍失败才进入下一层；拿到第一份通过完整校验的结果后立即停止。费用按页面当前价格输入 ¥1.5/百万 Token、输出 ¥7.5/百万 Token 估算，累计所有实际返回 usage 的响应；HTTP 400 等无 usage 响应不计 Token，传输超时单独标记为费用未知。失败时另存 `artifacts/error.json`，包含失败阶段、供应商响应和请求尝试。模型响应、原始标签与用量在校验前落盘，因此校验或导出失败后可优先本地恢复。

页面显示每个视频的阶段、实际处理时间、输入/输出/总 Token、API 尝试次数、最终成功层级和错误；超时请求会提示费用未知。页面不列出原始片段或命名片段，只显示成功拆分段数；批次顶部提供 `catalog.csv` 下载。

“恢复批次”只处理失败或未完成项，已完成视频跳过；每个失败视频还提供“重试此视频”，不会重跑同批其他视频。自动配额重试最多 3 次，不会无限等待。

恢复与直接命名前必须核对检测版本。旧版本或缺失版本的未完成任务明确拒绝恢复，提示创建新任务；不重新检测、不删除旧片段或命名缓存，也不调用去字幕或 Gemini。新任务创建时即记录当前版本。已完成历史成果仍可查看；服务启动时的输入保留期清理也跳过旧版本和缺失版本的任务记录。
