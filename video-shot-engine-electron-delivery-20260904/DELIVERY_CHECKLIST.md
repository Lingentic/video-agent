# 交付清单

## 包含

- `src/`：当前视频处理引擎源码；
- `public/`：现有 Web UI，可直接加载或作为 Electron 重做参考；
- `test/`：16项本地单元测试；
- `scripts/local-smoke.mjs`：无费用环境和健康检查；
- `scripts/verify-delivery.mjs`：交付完整性和敏感目录检查；
- `scripts/xinhankr-*.mjs`：真实供应商实验脚本，仅供受控排障；
- `docs/`：Electron、API、目录、状态、FFmpeg和引擎说明；
- `fixtures/example-batch/`：脱敏的成功/失败状态样例；
- `package.json`、`package-lock.json`、`.env.example`、`.gitignore`；
- Windows开发启动和停止脚本。

## 不包含

- `.env` 和真实 API Key；
- `node_modules/`；
- `runs-v1/`、用户视频及历史运行记录；
- `.service.json` 和服务日志；
- FFmpeg、ffprobe、Electron或Node二进制；
- 安装包签名、自动更新和正式业务后端。

## 命令风险

- `npm test`、`npm run check`、`npm run smoke`、`npm run verify:delivery` 不调用 Gemini。
- `npm run test:xinhankr` 和 `npm run proof:xinhankr-shots` 会调用真实供应商，可能产生费用；没有明确测试授权时不要运行。

## 接收方起步顺序

1. 阅读 `README.md` 和 `docs/electron-integration.md`。
2. 执行 `npm ci`。
3. 执行四个无费用验证命令。
4. 用 `fixtures/example-batch/` 开发任务列表和错误状态。
5. 接入主进程子进程管理、动态端口和可写数据目录。
6. 确定 API Key 产品方案与 FFmpeg许可证后，再进行真实视频验收。
