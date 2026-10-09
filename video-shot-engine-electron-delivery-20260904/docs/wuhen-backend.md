# 无痕去字幕与拆分后端

`removeSubtitles` 默认为 false；开启后每条视频依次执行无痕去字幕、FFmpeg 拆分、可选自动命名。文件夹批量仍串行处理，已完成条目不会重跑。拆分和命名读取同一条目的 `processingInput`，原始输入保留用于恢复。

服务只读取 `WUHEN_API_KEY`，或者通过本地 `POST /api/subtitle-config {apiKey}` 更新内存凭据。返回布尔配置状态，不把凭据写入运行记录。旧智凌模块不调用；标明旧供应商的记录不能作为新的无痕任务提交。

去字幕 API 与临时通道验活使用和拆分命名相同的进程 `fetch` 及代理配置，不额外做 DNS 公网 IP 判定或创建独立的直连 dispatcher，兼容代理 Fake-IP。仍沿用普通 HTTPS 证书验证、现有超时和任务持久化；未知收费提交结果不会自动重提。

`GET /api/config` 返回 `subtitleProvider: "wuhen"`、`subtitleConfigured` 和独立接收器的 `subtitleTransportPort`。主进程自行按需建立官方 Quick Tunnel，通过本地 `POST /api/subtitle-transport {publicBaseUrl}` 配置 HTTPS `*.trycloudflare.com` 根地址；此地址不返回普通配置。启动服务和配置密钥本身不会建立隧道或提交任务。

`POST /api/runs` 或 `POST /api/batches` 的 multipart 字段新增 `subtitleOptions` JSON：

```json
{"model":"video_removal_std","method":"sel_area","rectNormalized":{"x1":0.1,"y1":0.7,"x2":0.9,"y2":0.8}}
```

模型缺省为 `video_removal_std`，方式缺省为 `sel_area`。`sel_area` 未指定区域时固定使用归一化区域 `{x1:0.05,y1:0.60,x2:0.95,y2:0.85}`；`all_area` 为全屏识别且不接受区域参数。客户端新任务不传逐视频区域；已有任务恢复仍采用原保存区域。创建任务前逐条验证结构；核心服务在实际媒体尺寸已知后按左上 floor、右下 ceil 换算像素，并验证边界和最大像素面积 480000，超限会拒绝，不会自动缩区或切换全屏。

`batch.json` 条目引用、`item.json` 和单视频 `run.json` 保存实际参数。恢复 API 不接受替换参数，同一云任务由核心服务复用任务 ID 和本地输出。旧隧道失效时不会修改原任务的上传地址；核心服务只允许原任务查询或使用已收到的本地结果。

开启去字幕的取消表示暂停本机等待：记录变为 `paused`，云任务不退款，原任务通过 resume 继续。普通任务保持原取消行为。`/runs/.../artifacts/subtitle-removal/` 只允许公开本地最终 `output.mp4`，其他任务、传输及签名记录返回 404；公开任务摘要仅保留安全字段。

`test/wuhen-pipeline.test.mjs` 使用函数注入的本地 Mock 验证默认区域持久化、参数覆盖、顺序、暂停恢复、已完成项跳过、原任务复用、单视频、净化后命名和敏感记录门禁。该测试不证明真实供应商成功、画质、实际隧道或计费行为。
