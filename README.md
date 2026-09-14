# 章域 AI 视频客户端

这是当前 Electron 客户端的开发源码仓库，包含统一桌面界面、素材拆分服务和商品替换服务。仓库不包含 API Key、运行结果、安装包和本机工具二进制。

## 源码结构

| 目录 | 用途 |
| --- | --- |
| `electron/renderer/` | 客户端前端页面、样式、交互和图片资源；复刻前端主要查看这里 |
| `electron/preload.cjs` | 前端可调用的 Electron 安全桥接接口 |
| `electron/main.mjs` | Electron 窗口、IPC、本地服务和文件处理 |
| `video-shot-engine-electron-delivery-20260904/` | 素材拆分与 Gemini 命名服务 |
| `Kling-H3路线B-Electron交付包-20260904/module/` | 商品替换服务 |
| `scripts/` | 构建辅助脚本 |
| `build/` | 客户端图标等构建资源 |
| `packaging-resources/` | 第三方工具许可证；可执行文件不进入 Git 仓库 |

前端使用原生 HTML、CSS 和 JavaScript，没有 React/Vue 构建步骤。直接从 `electron/renderer/index.html` 开始阅读即可；涉及本地文件、服务请求和打开目录的操作，需要结合 `electron/preload.cjs` 与 `electron/main.mjs`。

## 开发环境

- Windows 10/11
- Node.js 20 或更高版本
- npm
- FFmpeg 与 FFprobe（开发运行时放入系统 `PATH`）
- Cloudflared（仅“参考视频生成”模式需要，放入系统 `PATH`）

首次克隆后安装依赖：

```powershell
npm ci
npm ci --prefix .\video-shot-engine-electron-delivery-20260904
```

也可以在 Windows 上双击 `安装开发依赖.cmd`。

## 配置

从示例文件创建本机配置：

```powershell
Copy-Item .\video-shot-engine-electron-delivery-20260904\.env.example .\video-shot-engine-electron-delivery-20260904\.env
Copy-Item '.\Kling-H3路线B-Electron交付包-20260904\module\.env.example' '.\Kling-H3路线B-Electron交付包-20260904\module\.env'
```

然后只在本机 `.env` 中填写对应 API Key。`.env` 已被 Git 忽略，禁止把真实 Key 写入源码、提交记录或截图。

## 运行与检查

请在**仓库根目录**运行以下命令，也就是同时包含 `package.json`、`electron/` 和两个服务目录的 `video-agent` 文件夹：

```powershell
cd "你的仓库路径\video-agent"
npm start
```

也可以双击 `启动客户端.cmd`。提交前运行：

```powershell
npm run check
npm test --prefix .\video-shot-engine-electron-delivery-20260904
npm run check --prefix .\video-shot-engine-electron-delivery-20260904
npm run check --prefix '.\Kling-H3路线B-Electron交付包-20260904\module'
```

以上检查不会主动调用计费 API。

## 本地数据与打包说明

开发版运行数据默认写入仓库根目录的 `client-data/`，该目录不会提交。安装版数据默认写入用户“视频”目录下的 `章域 AI/`。

安装包需要 FFmpeg、FFprobe 和 Cloudflared。它们体积较大，其中 FFmpeg 单文件超过 GitHub 普通仓库的文件限制，因此本仓库只保留许可证，不提交 `.exe`。需要重新打包时，应先将对应程序放回：

```text
packaging-resources/tools/ffmpeg/ffmpeg.exe
packaging-resources/tools/ffmpeg/ffprobe.exe
packaging-resources/tools/cloudflared/cloudflared.exe
```

再执行 `npm run pack:win`。安装包应放到 GitHub Releases 或其他制品存储，不要提交到源码分支。
