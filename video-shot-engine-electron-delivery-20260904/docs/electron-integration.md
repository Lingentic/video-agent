# Electron 接入说明

## 推荐架构

```text
Electron renderer
  -> HTTP 请求 127.0.0.1:<port>
Electron main
  -> 创建并监管 Node 引擎子进程
Node 引擎
  -> FFmpeg/ffprobe
  -> xinhankr Gemini
  -> 用户数据目录中的 runs-v1
```

第一版不要把 Express 路由和处理状态机重写进 Electron 主进程。将现有服务作为子进程复用，可以保持 Web 版与客户端版行为一致，也便于独立测试和排错。

## 启动顺序

1. Electron 主进程选择一个空闲本机端口。
2. 创建可写的数据目录，例如 `path.join(app.getPath("userData"), "video-shot-engine")`。
3. 从 `process.resourcesPath` 解析 `public`、`ffmpeg.exe`、`ffprobe.exe` 和引擎入口。
4. 以环境变量启动 `node src/server.mjs`。
5. 每 100 至 200 毫秒请求一次 `GET /api/health`，最长等待 10 秒。
6. 健康检查成功后创建窗口或加载引擎 URL。
7. 应用退出时，只终止本实例保存的子进程句柄。

开发模式可以使用系统 Node。正式打包时可让 Electron 自身执行 Node 入口，或随应用提供独立 Node runtime；具体方式由客户端构建方案决定，但必须验证 `child_process`、ESM、原生网络和路径行为。

## 必传环境变量

| 变量 | 建议值 | 说明 |
|---|---|---|
| `HOST` | `127.0.0.1` | 不向局域网暴露本地 API |
| `PORT` | 动态空闲端口 | 避免固定端口冲突 |
| `RUNS_DIR` | `app.getPath("userData")` 下 | 安装目录通常不可写 |
| `PUBLIC_DIR` | `process.resourcesPath/public` | 静态页面位置 |
| `FFMPEG_PATH` | `process.resourcesPath/bin/ffmpeg.exe` | 不依赖系统 PATH |
| `FFPROBE_PATH` | `process.resourcesPath/bin/ffprobe.exe` | 不依赖系统 PATH |
| `XINHANKR_MODEL` | `gemini-3.6-flash` | 当前已验证模型 |
| `XINHANKR_BASE_URL` | `https://token.xinhankr.com` | 当前供应商地址 |

`XINHANKR_API_KEY` 由产品密钥方案决定。统一商业 Key 应放在业务服务端；用户自带 Key可存系统凭据库。不要写入 renderer、源码、asar、日志或更新包。

## Renderer 建议

客户端可以第一阶段直接加载本地服务页面，也可以重做界面后调用同一 API。重做时应保留：多文件选择和上传、批次进度轮询、每个视频的状态和重试、Token与费用、打开输出目录、目录 CSV、恢复批次和单视频重试。

不要在 renderer 中直接执行 FFmpeg、访问 Key或拼接任意本地文件路径。

## 生命周期与崩溃恢复

- 保存引擎子进程 PID、端口和本次 Electron 实例标识。
- 健康检查失败时读取引擎 stderr，并向用户显示可操作错误。
- 客户端异常退出后，下一次启动应检查端口对应的服务身份，不要仅凭 PID 判断。
- `batch.status=processing` 且服务重启后任务不会自动继续，界面应显示“可恢复”。
- 恢复批次只处理未完成或失败项；已完成项跳过。

## 当前边界

- 当前批次为串行处理。
- 供应商接口是同步 `generateContent`，超时请求无法通过任务 ID 查询是否仍在执行。
- 费用是按配置单价估算，最终以供应商账单为准。
- 正式客户端必须保持 API 仅监听回环地址。

