# FFmpeg 分发说明

引擎依赖 `ffmpeg` 完成镜头检测、分析代理编码和片段导出，依赖 `ffprobe` 读取时长和帧率。开发环境默认从 PATH 查找；Electron 正式包应通过绝对路径传入：

```text
FFMPEG_PATH=<resources>/bin/ffmpeg.exe
FFPROBE_PATH=<resources>/bin/ffprobe.exe
```

推荐布局：

```text
resources/
├─ engine/
│  ├─ src/
│  ├─ public/
│  ├─ package.json
│  └─ node_modules/
└─ bin/
   ├─ ffmpeg.exe
   └─ ffprobe.exe
```

不要把需执行的二进制留在不可执行的 asar 内部。使用 `asarUnpack` 或额外资源复制。启动引擎前先运行 `ffmpeg.exe -version` 和 `ffprobe.exe -version`，失败时直接显示路径或权限问题。`npm run smoke` 已包含该检查。

本包没有附带 FFmpeg 二进制，也不能替客户端选择构建。FFmpeg 的 LGPL/GPL义务取决于实际构建选项。客户端负责人必须固定来源和版本、保存构建配置、随应用提供对应许可文本，并确认源码提供义务。Electron、Node.js 和 npm 依赖也应在发布前生成第三方许可证清单。

