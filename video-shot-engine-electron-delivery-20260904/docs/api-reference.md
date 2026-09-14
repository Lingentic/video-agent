# API 接口说明

默认 Base URL：`http://127.0.0.1:3141`。Electron 应使用实际启动端口。

## 健康与配置

### `GET /api/health`

无副作用、无外部请求。就绪响应：

```json
{ "ok": true, "service": "video-shot-engine", "version": "0.1.0" }
```

### `GET /api/config`

返回运行模式、模型、端口、上传限制、价格和 Key 是否配置。不会返回 Key 明文。

## 创建任务

### `POST /api/runs`

单视频，`multipart/form-data`：

| 字段 | 类型 | 说明 |
|---|---|---|
| `video` | file | 必填 |
| `threshold` | number | 默认12 |
| `minDurationSec` | number | 默认0.2，最低0.1 |
| `keepAudio` | `on`/缺省 | 最终切片是否保留音频 |
| `autoName` | `on`/缺省 | 切分后是否自动命名 |

返回 `runId`。FFmpeg阶段在该请求内完成，Gemini命名可能在响应后继续。

### `POST /api/batches`

批量视频，`multipart/form-data`。文件字段名为 `videos`，最多100个，其他字段同单视频。返回 HTTP 202：

```json
{ "batchId": "batch_...", "itemCount": 25 }
```

批次在后台串行处理，客户端应轮询查询接口。

## 查询任务

- `GET /api/runs/latest`：最后更新的运行 ID。
- `GET /api/runs/:runId`：单视频状态、标签、命名清单和失败信息。
- `GET /api/batches/:batchId`：批次及所有视频状态，`batch.active` 表示当前进程中是否仍有后台执行。

建议处理中每2秒轮询一次，终态停止轮询。

## 恢复与重试

- `POST /api/batches/:batchId/resume`：只处理失败或未完成项，已完成项跳过。
- `POST /api/batches/:batchId/items/:videoId/retry`：只重试指定失败视频。
- `POST /api/runs/:runId/name`：为已切分的单视频启动命名。
- `POST /api/runs/:runId/resume-naming`：恢复单视频命名。

后台任务接受成功返回 HTTP 202，不代表最终完成，必须继续查询状态。

## 文件访问

运行目录通过 `/runs/*` 暴露。批次 CSV：

```text
GET /runs/<batchId>/catalog.csv
```

Electron 更推荐通过主进程打开本地输出目录，不要把任意文件系统路径直接暴露给 renderer。

## HTTP约定

- `200`：同步查询或单视频创建成功。
- `202`：后台任务已接受。
- `400`：参数、状态或恢复条件不满足。
- `404`：运行或批次不存在。
- `500`：创建或本地处理失败。
