# Wan3 四视角人物替换试验

## 环境与启动

需要 Python 3.12、FFmpeg 和 FFprobe。将 FFmpeg、FFprobe 加入系统 `PATH` 后，在本目录执行：

```powershell
python -m pip install -r requirements.txt
python app.py
```

然后访问 http://127.0.0.1:7863。

`启动Wan3试验.cmd` 是当前开发电脑的快捷启动脚本，使用其他电脑时请按上面的通用命令启动，或将脚本中的 Python 路径改为本机路径。

程序截取2～15秒输入视频，并接收同一目标人物的正面、左侧、右侧、背面4张参考图，调用北京地域 `wan3.0-video`。默认5秒、480P，关闭提示词自动扩写并固定随机种子。

## 免费额度与计费

官方当前说明为首次开通后提供30秒免费额度，按“输入视频时长 + 输出视频时长”消耗，有效期90天。程序只能显示本次预计消耗的额度秒数，不能读取账号的剩余额度；免费额度不足时可能转为付费，以百炼控制台为准。

## 操作

1. 填写北京地域 API Key 和业务空间ID；二者不会写入本地文件。
2. 依次选择正面、左侧、右侧、背面4张图和输入视频。
3. 编辑提示词，选择起始时间、时长和分辨率，点击冻结素材。
4. 检查本地片段和预计额度，勾选确认后提交一次。
5. 程序保存任务ID、服务响应和结果视频。断线后填写运行编号，点击继续查询。

Wan3没有“保留原音频”参数。程序要求模型输出无声视频，下载后使用 FFmpeg 将输入片段的原音轨重新合入最终 `output.mp4`。

任务创建接口不会自动重试。若提交超时，先在百炼调用记录中确认是否已有任务，避免重复消耗额度或计费。

官方文档：

- https://help.aliyun.com/zh/model-studio/wan3-video-generation-guide
- https://help.aliyun.com/zh/model-studio/wan3-video-generation-api-reference
