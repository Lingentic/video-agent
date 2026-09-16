import json
import math
import os
import re
import subprocess
import threading
import time
import uuid
from pathlib import Path

import gradio as gr
import httpx
from PIL import Image, ImageOps


ROOT = Path(__file__).resolve().parent
RUNS = ROOT / 'runs'
RUNS.mkdir(exist_ok=True)
UPLOAD_HOST = 'https://dashscope.aliyuncs.com/api/v1'
MODEL = 'wan3.0-video'
LOCK = threading.Lock()
REFERENCE_NAMES = ['front', 'left', 'right', 'back']

DEFAULT_PROMPT = '''这是对视频1进行的局部编辑，不是参考视频重新生成。

视频1是唯一的输出画面、镜头、动作和时序基准。输出视频必须与视频1逐帧对齐。图1至图4只用于确定目标女性的身份和人物外观，不得使用参考图重新设计镜头、场景、动作或构图。

仅编辑视频1中主要女性所占据的区域，将她完整替换为图1至图4中的目标女性。除主要女性外，视频1中的所有区域均为禁止编辑区域。

背景、建筑、车辆、路人、前景人物、手持物、字幕、光照、阴影、镜头位置、运镜、景别和画面裁切必须直接遵循视频1，不得删除、添加、移动、替换或重新生成任何非主体内容。

目标女性严格继承原人物逐帧的位置、大小、姿势、身体朝向、动作节奏、手部动作、视线以及与周围物体的遮挡和交互关系。

只允许改变主要女性的身份、面部、肤色、发型、体型、身体外观和服装。其他内容保持视频1原样。不要重新演绎视频1，不要生成新的场景，不要生成声音。'''


def save(run):
	path = RUNS / run['id'] / 'run.json'
	temp = path.with_suffix('.tmp')
	temp.write_text(json.dumps(run, ensure_ascii=False, indent=2), encoding='utf-8')
	temp.replace(path)


def load(run_id):
	if not re.fullmatch(r'[0-9a-f]{32}', run_id or ''):
		raise ValueError('请填写有效的本地运行编号。')
	return json.loads((RUNS / run_id / 'run.json').read_text(encoding='utf-8'))


def command(args):
	result = subprocess.run(args, capture_output=True, timeout=180, creationflags=0x08000000 if os.name == 'nt' else 0)
	if result.returncode:
		raise ValueError(result.stderr.decode('utf-8', errors='replace')[-1800:])
	return result.stdout


def media_info(path):
	data = json.loads(command(['ffprobe', '-v', 'error', '-show_streams', '-show_format', '-of', 'json', str(path)]))
	video = next(stream for stream in data['streams'] if stream['codec_type'] == 'video')
	has_audio = any(stream['codec_type'] == 'audio' for stream in data['streams'])
	return float(data['format']['duration']), int(video['width']), int(video['height']), has_audio


def prepare_reference(source_path, destination):
	with Image.open(source_path) as source:
		image = ImageOps.exif_transpose(source).convert('RGB')
		image.thumbnail((8000, 8000))
		if min(image.size) < 240 or not 1 / 8 <= image.width / image.height <= 8:
			raise ValueError(f'{destination.stem}参考图不符合尺寸或宽高比要求。')
		image.save(destination, quality=95)
	if destination.stat().st_size > 20 * 1024 * 1024:
		raise ValueError(f'{destination.stem}参考图超过20MB。')


def prepare(front, left, right, back, video, start, duration, resolution, prompt, seed):
	references = [front, left, right, back]
	if not all(references) or not video:
		raise gr.Error('请提供正面、左侧、右侧、背面四张参考图和一段视频。')
	if not prompt or not prompt.strip():
		raise gr.Error('提示词不能为空。')
	start = float(start)
	duration_value = float(duration)
	if not math.isfinite(start) or start < 0:
		raise gr.Error('开始时间必须是非负数。')
	if not duration_value.is_integer() or not 2 <= duration_value <= 15:
		raise gr.Error('测试时长必须是2～15秒之间的整数。')
	duration = int(duration_value)
	total, _, _, _ = media_info(video)
	if start + duration > total:
		raise gr.Error(f'从该时间起不足{duration}秒，请提前选择开始位置或缩短时长。')

	run_id = uuid.uuid4().hex
	directory = RUNS / run_id
	directory.mkdir()
	for name, source_path in zip(REFERENCE_NAMES, references):
		prepare_reference(source_path, directory / f'reference-{name}.jpg')
	command([
		'ffmpeg', '-hide_banner', '-loglevel', 'error', '-ss', str(start), '-i', video, '-t', str(duration),
		'-map', '0:v:0', '-map', '0:a?', '-vf',
		"scale=w='min(1920,iw)':h='min(1920,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1",
		'-r', '30', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p',
		'-c:a', 'aac', '-movflags', '+faststart', str(directory / 'input.mp4')
	])
	actual, width, height, has_audio = media_info(directory / 'input.mp4')
	if not duration - 0.1 <= actual <= duration + 0.1 or min(width, height) < 240 or max(width, height) > 4096 or not 1 / 8 <= width / height <= 8:
		raise ValueError('预处理视频的尺寸或时长不符合API要求。')
	if (directory / 'input.mp4').stat().st_size > 100 * 1024 * 1024:
		raise ValueError('预处理视频超过100MB，请降低输入码率。')

	quota_seconds = round(actual + duration, 2)
	run = {
		'id': run_id,
		'status': 'prepared',
		'model': MODEL,
		'duration': duration,
		'input_duration': actual,
		'input_has_audio': has_audio,
		'resolution': resolution,
		'prompt': prompt.strip(),
		'seed': int(seed),
		'quota_seconds': quota_seconds,
		'created': time.time()
	}
	save(run)
	message = (
		f'素材已冻结：{width}×{height}、{actual:.2f}秒、4张参考图、输出{resolution}。'
		f'本次成功生成预计消耗约{quota_seconds:.2f}秒额度（输入+输出）；是否免费取决于账号剩余额度。尚未上传或调用。'
	)
	return run_id, str(directory / 'input.mp4'), message, False


def client(proxy):
	return httpx.Client(proxy=proxy.strip() or None, timeout=httpx.Timeout(120, connect=20), trust_env=False, follow_redirects=True)


def auth(key):
	key = key.strip() or os.environ.get('DASHSCOPE_API_KEY', '').strip()
	if not key:
		raise ValueError('请填写北京地域 API Key，或设置 DASHSCOPE_API_KEY。')
	return {'Authorization': 'Bearer ' + key}


def api_host(workspace_id):
	workspace_id = workspace_id.strip()
	if not re.fullmatch(r'[A-Za-z0-9_-]+', workspace_id):
		raise ValueError('请填写有效的北京地域业务空间ID。')
	return f'https://{workspace_id}.cn-beijing.maas.aliyuncs.com/api/v1'


def response_json(response):
	try:
		data = response.json()
	except ValueError:
		raise ValueError(f'服务返回非JSON内容，HTTP {response.status_code}')
	if response.is_error:
		raise ValueError(f'HTTP {response.status_code}: {data.get("code", "")} {data.get("message", "请求失败")} request_id={data.get("request_id", "")}')
	return data


def upload(c, headers, path):
	policy = response_json(c.get(UPLOAD_HOST + '/uploads', headers=headers, params={'action': 'getPolicy', 'model': MODEL}))['data']
	object_key = policy['upload_dir'] + '/' + uuid.uuid4().hex + path.suffix
	fields = {
		'OSSAccessKeyId': policy['oss_access_key_id'], 'Signature': policy['signature'], 'policy': policy['policy'],
		'x-oss-object-acl': policy['x_oss_object_acl'], 'x-oss-forbid-overwrite': policy['x_oss_forbid_overwrite'],
		'key': object_key, 'success_action_status': '200'
	}
	with path.open('rb') as source:
		response = c.post(policy['upload_host'], data=fields, files={'file': (path.name, source)})
	if response.status_code != 200:
		raise ValueError(f'{path.name}临时上传失败，HTTP {response.status_code}')
	return 'oss://' + object_key


def build_payload(run, video_url, reference_urls):
	media = [{'type': 'reference_video', 'url': video_url}]
	media.extend({'type': 'reference_image', 'url': url} for url in reference_urls)
	return {
		'model': MODEL,
		'input': {'prompt': run['prompt'], 'media': media},
		'parameters': {
			'resolution': run['resolution'],
			'ratio': 'adaptive',
			'duration': run['duration'],
			'audio': False,
			'prompt_extend': False,
			'watermark': False,
			'seed': run['seed']
		}
	}


def restore_original_audio(directory, raw_output, destination):
	input_video = directory / 'input.mp4'
	_, _, _, has_audio = media_info(input_video)
	if has_audio:
		command([
			'ffmpeg', '-hide_banner', '-loglevel', 'error', '-i', str(raw_output), '-i', str(input_video),
			'-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-shortest',
			'-movflags', '+faststart', str(destination)
		])
	else:
		raw_output.replace(destination)


def submit(run_id, key, workspace_id, proxy, approved):
	if not approved:
		raise gr.Error('请先勾选上传素材和额度/付费生成确认。')
	if not LOCK.acquire(blocking=False):
		raise gr.Error('已有提交正在处理，请等待。')
	run = None
	try:
		headers = auth(key)
		host = api_host(workspace_id)
		run = load(run_id)
		if run['status'] != 'prepared':
			raise ValueError('这组素材已经提交或尝试提交。请继续查询，勿重复生成。')
		run['status'] = 'uploading'
		run['workspace_id'] = workspace_id.strip()
		save(run)
		yield '正在上传1段视频和4张参考图……', '', None
		with client(proxy) as c:
			directory = RUNS / run_id
			video_url = upload(c, headers, directory / 'input.mp4')
			reference_urls = [upload(c, headers, directory / f'reference-{name}.jpg') for name in REFERENCE_NAMES]
			payload = build_payload(run, video_url, reference_urls)
			run['status'] = 'submitting'
			run['request_summary'] = {
				'model': MODEL,
				'input': {'prompt': run['prompt'], 'media': [item['type'] for item in payload['input']['media']]},
				'parameters': payload['parameters']
			}
			save(run)
			response = c.post(
				host + '/services/aigc/video-generation/video-synthesis',
				headers={**headers, 'X-DashScope-Async': 'enable', 'X-DashScope-OssResourceResolve': 'enable'},
				json=payload
			)
			data = response_json(response)
			run['submission'] = data
			run['task_id'] = data.get('output', {}).get('task_id')
			run['status'] = 'submitted' if run['task_id'] else 'submission_unknown'
			save(run)
			if not run['task_id']:
				raise ValueError('响应未包含任务ID，请先查看百炼调用记录。')
		yield from poll(run_id, key, workspace_id, proxy)
	except Exception as error:
		if run and run['status'] in ('uploading', 'submitting'):
			run['status'] = 'submission_unknown' if run['status'] == 'submitting' else 'upload_failed'
			save(run)
		yield f'未完成：{str(error).replace(key, "[密钥隐藏]") if key else str(error)}', (run or {}).get('task_id') or '', None
	finally:
		LOCK.release()


def poll(run_id, key, workspace_id, proxy):
	run = load(run_id)
	task = run.get('task_id')
	if not task:
		raise gr.Error('此记录没有任务ID，不能查询。')
	host = api_host(workspace_id or run.get('workspace_id', ''))
	try:
		with client(proxy) as c:
			headers = auth(key)
			for _ in range(360):
				data = response_json(c.get(host + '/tasks/' + task, headers=headers))
				run['last_response'] = data
				output = data.get('output', {})
				status = output.get('task_status', 'UNKNOWN')
				run['status'] = status
				save(run)
				if status == 'SUCCEEDED':
					url = output.get('video_url') or (output.get('results') or {}).get('video_url')
					if not url:
						raise ValueError('任务成功但缺少结果URL，请查看run.json。')
					directory = RUNS / run_id
					raw_output = directory / 'raw-output.mp4'
					destination = directory / 'output.mp4'
					if not destination.exists():
						partial = raw_output.with_suffix('.part')
						with c.stream('GET', url) as response:
							response.raise_for_status()
							with partial.open('wb') as file:
								for chunk in response.iter_bytes():
									file.write(chunk)
						media_info(partial)
						partial.replace(raw_output)
						restore_original_audio(directory, raw_output, destination)
						media_info(destination)
					yield '生成完成并保存；程序已在本地重新合入输入片段的原音轨。', task, str(destination)
					return
				if status in ('FAILED', 'CANCELED', 'UNKNOWN'):
					yield f'任务状态：{status}；{output.get("code", "")} {output.get("message", "")}', task, None
					return
				yield f'任务状态：{status}；每15秒自动查询。任务ID已保存。', task, None
				time.sleep(15)
		yield '自动查询已满90分钟。点击继续查询，不会重复生成。', task, None
	except Exception as error:
		yield f'查询或下载中断：{str(error).replace(key, "[密钥隐藏]") if key else str(error)}。点击继续查询即可。', task, None


def history():
	rows = []
	for path in sorted(RUNS.glob('*/run.json'), key=lambda item: item.stat().st_mtime, reverse=True):
		run = json.loads(path.read_text(encoding='utf-8'))
		rows.append(f'{run["id"]} | {run["status"]} | {run["resolution"]} | task={run.get("task_id", "未提交")}')
	return '\n'.join(rows) or '暂无记录'


def build_ui():
	with gr.Blocks(title='Wan3 四视角人物替换试验') as demo:
		gr.Markdown('# Wan3 四视角人物替换试验\n可选2～15秒，使用原视频和目标人物正面、左侧、右侧、背面4张参考图。模型：`wan3.0-video`。')
		with gr.Row():
			key = gr.Textbox(label='北京地域 API Key（不写入文件）', type='password')
			workspace_id = gr.Textbox(label='北京地域业务空间ID', placeholder='例如 ws-xxxxxxxx')
		proxy = gr.Textbox(label='可选 HTTP 代理', placeholder='例如 http://127.0.0.1:7890')
		with gr.Row():
			front = gr.File(label='图1：正面', file_types=['image'], type='filepath')
			left = gr.File(label='图2：左侧', file_types=['image'], type='filepath')
			right = gr.File(label='图3：右侧', file_types=['image'], type='filepath')
			back = gr.File(label='图4：背面', file_types=['image'], type='filepath')
		video = gr.File(label='视频1：输入视频（程序按起点和时长截取）', file_types=['video'], type='filepath')
		with gr.Row():
			start = gr.Number(label='从第几秒开始截取', value=0, minimum=0)
			duration = gr.Slider(label='测试时长（2～15秒）', value=5, minimum=2, maximum=15, step=1)
			resolution = gr.Dropdown(['480P', '720P', '1080P'], value='480P', label='输出分辨率')
			seed = gr.Number(label='随机种子', value=20260915, precision=0, minimum=0, maximum=2147483647)
		prompt = gr.Textbox(label='提示词（提交前可编辑）', value=DEFAULT_PROMPT, lines=13)
		prepare_button = gr.Button('① 冻结四张参考图和测试片段')
		run_id = gr.Textbox(label='本地运行编号')
		preview = gr.Video(label='待提交的输入片段')
		estimate = gr.Textbox(label='素材与额度', interactive=False)
		approved = gr.Checkbox(label='确认上传1段视频和4张参考图；若免费额度不足，调用可能产生费用', value=False)
		submit_button = gr.Button('② 确认并开始 Wan3 生成', variant='primary')
		resume_button = gr.Button('继续查询已有任务 / 重新下载结果（不重复生成）')
		status = gr.Textbox(label='进度与错误', interactive=False)
		task = gr.Textbox(label='阿里云任务ID', interactive=False)
		output = gr.Video(label='Wan3 输出结果（已本地合入原音轨）')
		histories = gr.Textbox(label='历史任务', value=history, lines=5, interactive=False)
		refresh = gr.Button('刷新历史记录')
		gr.Markdown('参数在冻结素材时保存。提交超时不会自动重试；先核对百炼调用记录，避免重复消耗额度或计费。旧的 Wan2.7 项目和历史结果不受影响。')
		prepare_button.click(prepare, [front, left, right, back, video, start, duration, resolution, prompt, seed], [run_id, preview, estimate, approved])
		submit_button.click(submit, [run_id, key, workspace_id, proxy, approved], [status, task, output], concurrency_limit=1)
		resume_button.click(poll, [run_id, key, workspace_id, proxy], [status, task, output])
		refresh.click(history, outputs=histories)
	return demo


if __name__ == '__main__':
	build_ui().queue().launch(server_name='127.0.0.1', server_port=7863, inbrowser=True, allowed_paths=[str(RUNS)], show_error=False)
