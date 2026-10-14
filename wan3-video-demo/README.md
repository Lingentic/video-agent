# Wan3 人物与场景参考试验

2026-10-12：独立 demo 切换到新站 `token.xinhankr.com` 的 `wan3.0-video`，启用模型原生声音，并把冻结片段同步提取的原片音轨作为 `reference_audio`。原视频、人物参考图、场景参考图和原片音频直接交给模型；输出保存模型返回的声音，不在本地合入原音轨。

2026-10-12：默认提示词已改为[原片专用提示词](assets/walkway-shot-test-20261010/Wan3提示词-新站原音频版-20261012.txt)，逐张说明4张人物图和3张场景图，明确5秒内三个镜头及画外拍摄者、画中女性的对白和音色来源。[default_prompt.txt](default_prompt.txt)保留为通用备用稿，不再自动加载。专用稿不自动适配新的图片、原片起点或时长；换素材时必须同步修改对应描述。原片音频只是模型参考，不能保证字词、音色或口型百分之百复制；混合多人音轨也不保证自动准确分离。

对白依据原片画面字幕及本地SenseVoiceSmall识别交叉核对，未人工试听认证。前两句识别为“我去你今天好高啊”“怎么一米五七看起来像一米七一样”；最后约0.66秒的局部识别只得到“什么”，字幕为“你懂什么”。专用稿按字幕补出完整回应句，但明确只保留音频中实际已有的音节及截取边界，不续写、补音或强行压缩整句。识别工具和模型仅位于临时目录，未加入demo依赖，未调用云端识别或视频生成。

## 启动

使用现有 `facefusion` Python 环境和 FFmpeg / FFprobe，依赖清单没有新增。现有 `启动Wan3试验.cmd` 继续可用，也可在本目录执行：

```powershell
& 'C:\Users\17794\miniconda3\envs\facefusion\python.exe' app.py
```

本地页面：http://127.0.0.1:7863 。Quick Tunnel 使用项目已有 `../packaging-resources/tools/cloudflared/cloudflared.exe`。

## 操作与外传范围

1. 填写新站 API Key；留空按顺序读取环境变量 `XINHANKR_API_KEY`、已有商品替换模块 `../Kling-H3路线B-Electron交付包-20260904/module/.env` 中同名字段。只读取命名字段，不保存密钥，不使用百炼密钥或业务空间ID。
2. 选择人物组、场景组各至少1张图片，总数最多10张；顺序固定为人物组在前、场景组在后。
3. 选择视频起点和2～15秒整数时长，编辑提示词、分辨率和种子，点击冻结。冻结只做本地预处理：产生 `input.mp4`、参考 JPEG、`original-audio.wav` 和含哈希的记录。音频从冻结视频中提取，单声道44100Hz PCM16，1～15秒且不超过15MB；没有音轨会报错。
4. 检查视频、原片音频和图片编号。页面分别显示输入、音频和请求输出时长，不把输入加输出当作新站计费口径。修改素材或参数后，冻结编号、视频和音频预览、确认自动清除。
5. 勾选视频、参考图、原片音频外传及付费生成确认后，提交一次。此时才建立临时只读素材服务和 Quick Tunnel，文件名严格限制为本次冻结文件，以随机令牌URL访问。服务支持 HEAD / Range GET，拒绝路径穿越；不开放目录、`run.json`、密钥、整个工作区或历史任务。
6. 提交前验证每个公网 HTTPS 地址的 MIME 和长度。只调用一次生成 POST，保存可识别的任务ID；自动查询并下载结果。若输出无音轨，会明确提示声音要求未达成，不自造音频。

新站是付费通道，不能承诺百炼免费额度适用；价格和计费以新站为准。未知响应、提交超时及网关5xx按 `submission_unknown` 记录，禁止重提；请先核对新站调用记录。HTTP200中的明确业务拒绝也不会当作成功。

任务完成或明确失败时关闭隧道和服务。查询中断及提交结果未知时，在当前进程仍运行期间保留素材服务，退出进程会清理。关闭或刷新网页不会触发全局清理，不会误关其他页面任务的素材服务；生成期间请保持本地服务运行。退出后未完成任务可能无法继续读取素材。继续查询只查已有任务，不创建新任务或恢复旧素材公网地址。

## 路由与验证边界

原生 `POST /api/v1/services/aigc/video-generation/video-synthesis`，`GET /api/v1/tasks/{task_id}`，Bearer 鉴权，提交带 `X-DashScope-Async: enable`。请求保留 `input` / `parameters`，`audio: true`，媒体顺序为 `reference_video`、人物和场景 `reference_image`、`reference_audio`。原生任务响应解析 `output.task_id` / `task_status` / `video_url`；未知结构保守记录，不冒充成功。

官方文档和当日核对记录：

- [万相原生透传说明](https://token.xinhankr.com/docs/examples/doc0014)
- [新站参考素材说明](https://token.xinhankr.com/docs/ali-kling/doc0026)
- [本地接口核对记录](xinhankr-contract-20261012.md)

本次改造验证只包含静态检查、外部请求和 tunnel 的 Mock 测试、本地 HTTP 服务测试，以及真实 FFmpeg 的临时目录音视频冻结。未执行真实公网隧道、素材外传或付费生成；新站原生响应、生成声音与画面质量仍需授权后的真实任务验证。

```powershell
& 'C:\Users\17794\miniconda3\envs\facefusion\python.exe' -m py_compile app.py media_server.py test_references.py test_media_server.py
& 'C:\Users\17794\miniconda3\envs\facefusion\python.exe' -m unittest -v test_references test_media_server
```

## 历史记录

旧百炼 `wan3.0-video` / `wan3.0-video-prime` 任务与成片保留，旧结果按当时方式处理声音。已完成的本地 `output.mp4` 可以播放；新站密钥不会查询旧百炼任务，旧冻结记录必须重新冻结后才能提交新站。

历史4次8秒成片仍位于 `runs/0/`、`runs/1/`、`runs/2/`、`runs/3/`；`runs/2/` 的超分结果和普通缩放对照保留。FaceFusion旧源码位于工作区根 `_归档/2026-10-10/人物替换旧路线/facefusion-local/`，AI试衣旧路线位于 `_归档/2026-10-09/历史实验/aitryon-plus-demo/`。
