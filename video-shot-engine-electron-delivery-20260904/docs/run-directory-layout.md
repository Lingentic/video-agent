# 运行目录规范

`RUNS_DIR` 必须指向可写、可持久化的用户数据目录。不要使用安装目录、asar内部或临时解包目录。

## 批次目录

```text
RUNS_DIR/
├─ _uploads/
└─ batch_<timestamp>_<suffix>/
   ├─ batch.json
   ├─ catalog.json
   ├─ catalog.csv
   └─ items/
      └─ video_001/
         ├─ input.mp4
         ├─ named_segments/
         ├─ item.json
         └─ artifacts/
```

单视频目录为 `run_<timestamp>_<suffix>/`，同样包含 `input.*`、`named_segments/` 和 `artifacts/`。

## `artifacts/` 关键文件

| 文件 | 用途 |
|---|---|
| `scene_cuts.json` | FFmpeg候选切点和阈值 |
| `ffmpeg_runtime.json` | 实际执行的 FFmpeg/ffprobe 路径、来源、版本和主机信息 |
| `shot_segments/` | 内部原始切片，不在 UI 列出 |
| `analysis_input_numbered.mp4` | 发送给 Gemini 的编号压缩视频 |
| `analysis_input_config.json` | 分析代理编码参数和大小 |
| `naming_prompt_snapshot.txt` | 本次实际提示词 |
| `naming_schema_snapshot.json` | 本次实际输出 Schema |
| `shot_manifest_for_gemini.json` | 镜头与候选点映射 |
| `provider_attempts.json` | 每层、每次请求状态与用量 |
| `provider_responses.json` | 收到的 HTTP 200 原始响应集合 |
| `usage.json` | 累计 Token 与费用 |
| `shot_labels_raw.json` | 模型原始标签 |
| `shot_labels_normalized.json` | 本地校验后的标签 |
| `rename_manifest.json` | 命名文件与时间范围映射 |
| `error.json`/`naming_error.json` | 结构化失败信息 |

## 对客户端的可见性

默认只展示输入文件名、成功拆分段数、最终 `named_segments/`、`catalog.csv`、状态、耗时、Token和费用。`artifacts/` 应放在诊断入口，不要把内部切片逐个列在主界面。

## 仅 FFmpeg 切割类别

选择 `ffmpeg_only` 时不会调用 Gemini，切片保存在 `artifacts/shot_segments/`。运行记录中的 `workflow` 为 `ffmpeg_only`，并同时写入 `artifacts/ffmpeg_runtime.json`：

- `client_directory`：实际可执行文件位于 `CLIENT_RESOURCES_DIR` 下，表示使用客户端随包资源；
- `system_path`：通过系统 `PATH` 解析到可执行文件；
- `configured_path`：使用显式配置的其他绝对或相对路径。

`versionLine` 只有在对应程序实际成功执行 `-version` 后才会写入，可作为跨主机运行证据；工具不可用时仍会记录 `source: unavailable` 和错误信息。不同主机的结果应结合 `host`、`resolvedPath` 和 `versionLine` 比较。

## 删除与迁移规则

- 成功运行完成后，服务会立即删除运行目录中的 `input.*` 和 Gemini 分析副本；失败或中断运行保留输入副本最多 7 天，服务启动时自动清理超期副本。
- 清理只针对当前 `RUNS_DIR` 内的任务输入和分析副本，不删除用户原视频、`shot_segments/`、`named_segments/` 或运行记录。
- 删除整个批次会同时删除输入副本、最终片段和恢复数据，必须二次确认。
- 删除 `artifacts/analysis_input_numbered.mp4` 可节省空间，但恢复时可能需要重新编码。
- 删除状态、标签或请求记录会破坏恢复与费用统计。
- 运行中的批次禁止移动。
- `_uploads/` 孤立文件只能在确认无活动任务后清理。
