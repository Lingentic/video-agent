# 视频镜头切分引擎 Electron 交付包

这是当前可运行的本地视频处理引擎源码快照，供 Electron 客户端开发接入。核心流程为 FFmpeg 镜头检测、xinhankr Gemini 复核与命名、批量串行处理、失败恢复、Token/费用记录。此包不包含真实 API Key、历史运行记录、用户视频、`node_modules` 或 FFmpeg 二进制。

## 快速验证

环境要求：Node.js 20+、可执行的 FFmpeg 和 ffprobe。

```powershell
npm ci
npm test
npm run check
npm run smoke
npm run verify:delivery
```

`npm run smoke` 不调用 Gemini，也不产生 API 费用。需要人工打开现有 Web 界面时，复制 `.env.example` 为 `.env`，按需填写用户自己的 Key，然后执行 `start.cmd`，访问 `http://127.0.0.1:3141/`。

## Electron 接入入口

推荐 Electron 主进程把本引擎作为受管 Node 子进程启动，并设置：

```text
HOST=127.0.0.1
PORT=<客户端分配的空闲端口>
RUNS_DIR=<app.getPath("userData")下的可写目录>
PUBLIC_DIR=<应用resources中的public目录>
FFMPEG_PATH=<应用resources中的ffmpeg.exe>
FFPROBE_PATH=<应用resources中的ffprobe.exe>
XINHANKR_API_KEY=<安全来源，不可硬编码进安装包>
```

启动后轮询 `GET /api/health`，收到 `{ "ok": true }` 再加载页面或调用 API；退出应用时终止由当前 Electron 实例创建的子进程，不要按进程名批量结束 Node。

## 文档

- [Electron 接入说明](docs/electron-integration.md)
- [API 接口说明](docs/api-reference.md)
- [运行目录规范](docs/run-directory-layout.md)
- [状态与错误处理](docs/states-and-errors.md)
- [FFmpeg 分发说明](docs/ffmpeg-distribution.md)
- [引擎运行说明](docs/engine-operations.md)

`fixtures/example-batch/` 是脱敏、无媒体文件的界面开发样例，只用于展示数据结构，不可作为真实处理结果验收。

## 已验证基线

交付前的真实批次基线为 25/25 视频完成、184 个命名片段、推理 Token 为 0。该结果证明当前样本批次可运行，不代表任意素材或第三方网关永远成功。正式验收必须同时检查请求成功率、文件数量、命名与画面一致性。

## 安全边界

Electron 包可以被用户解包，不能安全保存统一商业 API Key。对外产品应由业务后端持有供应商 Key；若采用用户自带 Key，应通过系统凭据库保存，并且前端渲染进程不得直接读取明文 Key。
