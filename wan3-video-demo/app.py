import json
import html
import math
import os
import re
import subprocess
import threading
import time
import uuid
import atexit
import hashlib
import wave
from pathlib import Path

import gradio as gr
import httpx
from PIL import Image, ImageOps
from media_server import PublicMedia, validate_public_urls


ROOT = Path(__file__).resolve().parent
RUNS = ROOT / 'runs'
RUNS.mkdir(exist_ok=True)
API_HOST = 'https://token.xinhankr.com/api/v1'
MODEL = 'wan3.0-video'
PROVIDER = 'xinhankr-native-v1'
CLOUDFLARED = ROOT.parent / 'packaging-resources/tools/cloudflared/cloudflared.exe'
KEY_ENV_FILE = ROOT.parent / 'Kling-H3路线B-Electron交付包-20260904/module/.env'
EXPOSURES = {}
LOCK = threading.Lock()

DEFAULT_PROMPT_PATH = ROOT / 'assets/walkway-shot-test-20261010/Wan3提示词-新站原音频版-20261012.txt'
DEFAULT_PROMPT = DEFAULT_PROMPT_PATH.read_text(encoding='utf-8').strip()
CONFIRM_LABEL = '确认向新站外传1段视频、参考图和原片音频，并调用付费生成'


def close_exposure(run_id):
	exposure = EXPOSURES.pop(run_id, None)
	if exposure:
		exposure.close()


def cleanup_exposures():
	for run_id in list(EXPOSURES):
		close_exposure(run_id)


atexit.register(cleanup_exposures)


def file_hash(path):
	with path.open('rb') as source:
		return hashlib.file_digest(source, 'sha256').hexdigest()


def audio_info(path):
	with wave.open(str(path), 'rb') as source:
		if source.getnchannels() != 1 or source.getframerate() != 44100 or source.getsampwidth() != 2:
			raise ValueError('音频参考必须是44100Hz、单声道PCM16 WAV。')
		return source.getnframes() / source.getframerate()


def save(run):
	path = RUNS / run['id'] / 'run.json'
	temp = path.with_suffix('.tmp')
	temp.write_text(json.dumps(run, ensure_ascii=False, indent=2), encoding='utf-8')
	temp.replace(path)


def load(run_id):
	if not re.fullmatch(r'(?:[0-9a-f]{32}|\d+)', run_id or ''):
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


def reference_records(person_references, scene_references):
	person_references = person_references or []
	scene_references = scene_references or []
	if not person_references or not scene_references:
		raise gr.Error('人物参考组和场景参考组各至少需要1张图片。')
	if len(person_references) + len(scene_references) > 10:
		raise gr.Error('人物参考图与场景参考图总数不能超过10张。')
	records = []
	for group, paths in (('person', person_references), ('scene', scene_references)):
		for index, source_path in enumerate(paths, 1):
			records.append({
				'group': group,
				'filename': f'reference-{group}-{index:02d}.jpg',
				'original_name': Path(source_path).name
			})
	return records


def format_reference_mapping(references, frozen=False):
	if not references:
		return '选择人物参考图和场景参考图后，将显示编号映射。'
	count = len(references)
	rows = [f'**{"已冻结" if frozen else "当前选择"}：{count}张参考图**（输入视频为视频1；音频1为该片段同步提取的原音轨）']
	for index, item in enumerate(references, 1):
		group_name = '人物参考组' if item['group'] == 'person' else '场景参考组'
		rows.append(f'图{index}（{group_name}）：{html.escape(item["original_name"])}')
	return '\n\n'.join(rows)


def prompt_with_mapping(prompt, references):
	lines = ['参考素材编号映射：', '视频1：输入视频片段。', '音频1：从视频1同步提取的原片音轨，起点和区间与视频1一致。']
	for index, item in enumerate(references, 1):
		group_name = '人物参考组' if item['group'] == 'person' else '场景参考组'
		lines.append(f'图{index}属于{group_name}：{item["original_name"]}。')
	return '\n'.join(lines) + '\n\n' + prompt.strip()


def update_reference_mapping(person_references, scene_references):
	try:
		references = reference_records(person_references, scene_references)
	except gr.Error as error:
		return str(error)
	return format_reference_mapping(references)


def invalidate_preparation(person_references, scene_references):
	return (
		'', None, None, '素材或参数已更改，请重新冻结。尚未外传或调用。',
		gr.update(value=False, label=CONFIRM_LABEL),
		update_reference_mapping(person_references, scene_references)
	)


def prepare(person_references, scene_references, video, start, duration, resolution, prompt, seed):
	references = reference_records(person_references, scene_references)
	if not video:
		raise gr.Error('请提供一段输入视频。')
	if not prompt or not prompt.strip():
		raise gr.Error('提示词不能为空。')
	start = float(start)
	duration_value = float(duration)
	if not math.isfinite(start) or start < 0:
		raise gr.Error('开始时间必须是非负数。')
	if not duration_value.is_integer() or not 2 <= duration_value <= 15:
		raise gr.Error('测试时长必须是2～15秒之间的整数。')
	duration = int(duration_value)
	total, _, _, source_has_audio = media_info(video)
	if not source_has_audio:
		raise gr.Error('原视频没有音轨，无法提供原片音频参考。')
	if start + duration > total:
		raise gr.Error(f'从该时间起不足{duration}秒，请提前选择开始位置或缩短时长。')

	run_id = uuid.uuid4().hex
	directory = RUNS / run_id
	directory.mkdir()
	for reference, source_path in zip(references, (person_references or []) + (scene_references or [])):
		prepare_reference(source_path, directory / reference['filename'])
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

	if not has_audio:
		raise ValueError('冻结片段没有音轨，无法提取原片音频。')
	audio_path = directory / 'original-audio.wav'
	command(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-i', str(directory / 'input.mp4'),
		'-map', '0:a:0', '-vn', '-t', str(duration), '-c:a', 'pcm_s16le', '-ar', '44100', '-ac', '1', str(audio_path)])
	audio_duration = audio_info(audio_path)
	if not 1 <= audio_duration <= 15 or audio_path.stat().st_size > 15 * 1024 * 1024:
		raise ValueError('原片音频必须为1～15秒且不超过15MB。')
	if abs(audio_duration - actual) > 0.15:
		raise ValueError('原片音频与冻结视频时长不一致，请检查源音轨。')
	paths = [directory / 'input.mp4', *(directory / item['filename'] for item in references), audio_path]
	run = {
		'id': run_id,
		'status': 'prepared',
		'model': MODEL,
		'provider': PROVIDER,
		'native_audio': True,
		'duration': duration,
		'input_duration': actual,
		'input_has_audio': has_audio,
		'resolution': resolution,
		'prompt': prompt_with_mapping(prompt, references),
		'references': references,
		'seed': int(seed),
		'audio_duration': audio_duration,
		'media_sha256': {path.name: file_hash(path) for path in paths},
		'created': time.time()
	}
	save(run)
	message = (
		f'素材已冻结：{width}×{height}、{actual:.2f}秒、人物图{len(person_references or [])}张、场景图{len(scene_references or [])}张，共{len(references)}张参考图、输出{resolution}。'
		f'原片音频{audio_duration:.2f}秒，请求输出{duration}秒，开启模型原生声音。新站为付费通道，计费以新站为准；尚未外传或调用。'
	)
	return run_id, str(directory / 'input.mp4'), str(audio_path), message, gr.update(value=False, label=f'确认向新站外传1段视频、{len(references)}张参考图和原片音频，并调用付费生成'), format_reference_mapping(references, frozen=True)


def client(proxy):
	return httpx.Client(proxy=proxy.strip() or None, timeout=httpx.Timeout(120, connect=20), trust_env=False, follow_redirects=True)


def auth(key):
	key = (key or '').strip() or os.environ.get('XINHANKR_API_KEY', '').strip()
	if not key and KEY_ENV_FILE.is_file():
		for line in KEY_ENV_FILE.read_text(encoding='utf-8-sig').splitlines():
			match = re.fullmatch(r'\s*XINHANKR_API_KEY\s*=\s*(.*?)\s*', line)
			if match:
				key = match.group(1).strip().strip('"\'')
				break
	if not key:
		raise ValueError('请填写新站 API Key，或设置 XINHANKR_API_KEY。')
	return {'Authorization': 'Bearer ' + key}


def safe_message(value, key=''):
	text = str(value)
	if key:
		text = text.replace(key, '[密钥隐藏]')
	text = re.sub(r'Bearer\s+\S+', 'Bearer [密钥隐藏]', text, flags=re.I)
	return re.sub(r'https?://[^\s"\'<>]+', '[URL隐藏]', text)


class BusinessRejection(ValueError):
	pass


def response_json(response, secret=''):
	try:
		data = response.json()
	except ValueError:
		raise ValueError(f'服务返回非JSON内容，HTTP {response.status_code}')
	if not isinstance(data, dict):
		raise ValueError('服务JSON结构未知，请核对新站调用记录。')
	if response.status_code >= 500 or response.status_code == 408:
		raise ValueError(f'HTTP {response.status_code}：上游提交结果未知，请核对新站调用记录，禁止自动重提。')
	code = data.get('code')
	if response.is_error or data.get('error') or (code is not None and str(code).lower() not in ('0', '200', 'success', 'ok')):
		error_type = BusinessRejection if response.status_code in (200, 400, 401, 402, 403, 404, 422, 429) else ValueError
		raise error_type(safe_message(f'HTTP {response.status_code}: {code or ""} {data.get("message", "请求失败")} {data.get("error", "")}', secret))
	return data


def build_payload(run, video_url, reference_urls, audio_url):
	media = [{'type': 'reference_video', 'url': video_url}]
	media.extend({'type': 'reference_image', 'url': url} for url in reference_urls)
	media.append({'type': 'reference_audio', 'url': audio_url})
	return {
		'model': MODEL,
		'input': {'prompt': run['prompt'], 'media': media},
		'parameters': {
			'resolution': run['resolution'],
			'ratio': 'adaptive',
			'duration': run['duration'],
			'audio': True,
			'prompt_extend': False,
			'watermark': False,
			'seed': run['seed']
		}
	}


def frozen_reference_paths(run, directory):
	if 'references' in run:
		references = run['references']
		if not isinstance(references, list) or not references:
			raise ValueError('冻结记录中的参考图列表无效。')
		paths = []
		for reference in references:
			group = reference.get('group')
			filename = reference.get('filename', '')
			if group not in ('person', 'scene') or not re.fullmatch(r'reference-(person|scene)-\d{2}\.jpg', filename) or not filename.startswith(f'reference-{group}-'):
				raise ValueError('冻结记录中的参考图 metadata 无效。')
			paths.append(directory / filename)
		return paths
	raise ValueError('旧冻结记录需要重新冻结后才能提交到新站。')


def frozen_media_paths(run, directory):
	if run.get('provider') != PROVIDER or run.get('native_audio') is not True or run.get('model') != MODEL:
		raise ValueError('旧冻结记录需要重新冻结后才能提交到新站。')
	paths = [directory / 'input.mp4', *frozen_reference_paths(run, directory), directory / 'original-audio.wav']
	for path in paths:
		if not path.is_file() or run.get('media_sha256', {}).get(path.name) != file_hash(path):
			raise ValueError('冻结素材已变化或缺失，请重新冻结。')
	return paths


def submit(run_id, key, proxy, approved):
	if not approved:
		raise gr.Error('请先勾选视频、参考图、原片音频外传及付费生成确认。')
	if not LOCK.acquire(blocking=False):
		raise gr.Error('已有提交正在处理，请等待。')
	run = None
	secret = ''
	try:
		headers = auth(key)
		secret = headers['Authorization'][7:]
		run = load(run_id)
		if run['status'] != 'prepared':
			raise ValueError('这组素材已经提交或尝试提交。请继续查询，勿重复生成。')
		directory = RUNS / run_id
		paths = frozen_media_paths(run, directory)
		run['status'] = 'exposing'
		save(run)
		yield '正在建立本次素材专用临时HTTPS地址并验证；尚未调用生成……', '', None
		exposure = PublicMedia(paths, CLOUDFLARED)
		EXPOSURES[run_id] = exposure
		exposure.start()
		with client(proxy) as c:
			urls = validate_public_urls(c, exposure, paths)
			payload = build_payload(run, urls[0], urls[1:-1], urls[-1])
			run['status'] = 'submitting'
			run['request_summary'] = {
				'model': MODEL,
				'input': {'prompt': run['prompt'], 'media': [item['type'] for item in payload['input']['media']]},
				'parameters': payload['parameters']
			}
			save(run)
			response = c.post(
				API_HOST + '/services/aigc/video-generation/video-synthesis',
				headers={**headers, 'X-DashScope-Async': 'enable'},
				json=payload
			)
			data = response_json(response, secret)
			output = data.get('output')
			task_id = output.get('task_id') if isinstance(output, dict) else None
			if not task_id and isinstance(output, dict) and output.get('task_status') in ('FAILED', 'CANCELED'):
				raise BusinessRejection(safe_message(f'任务创建被拒绝：{output.get("code", "")} {output.get("message", "")}', secret))
			run['task_id'] = task_id if isinstance(task_id, str) and re.fullmatch(r'[A-Za-z0-9_-]+', task_id) else None
			run['submission'] = {'response_keys': sorted(data), 'task_id': run['task_id'], 'request_id': safe_message(data.get('request_id', ''), secret)}
			run['status'] = 'submitted' if run['task_id'] else 'submission_unknown'
			save(run)
			if not run['task_id']:
				raise ValueError('响应未包含可识别的原生任务ID。禁止重复提交，请核对新站调用记录。')
		yield from poll(run_id, key, proxy)
	except Exception as error:
		if run and run['status'] in ('exposing', 'submitting'):
			run['status'] = ('submission_failed' if isinstance(error, BusinessRejection) else 'submission_unknown') if run['status'] == 'submitting' else 'exposure_failed'
			run['error'] = safe_message(error, secret)
			save(run)
		if run and run['status'] in ('exposure_failed', 'submission_failed'):
			close_exposure(run_id)
		yield f'未完成：{safe_message(error, secret)}', (run or {}).get('task_id') or '', None
	finally:
		LOCK.release()


def poll(run_id, key, proxy):
	run = load(run_id)
	destination = RUNS / run_id / 'output.mp4'
	if destination.is_file():
		message = '已保存结果，本地播放。历史结果保留当时的声音处理。'
		if run.get('provider') == PROVIDER:
			message = '生成完成，保留模型生成的原生声音。' if run.get('output_has_audio') else '模型返回无音轨，声音要求未达成；视频已保存。'
		yield message, run.get('task_id', ''), str(destination)
		return
	if run.get('provider') != PROVIDER:
		yield '这是旧百炼任务；新站密钥不能查询旧任务。请在原平台查询，旧素材需重新冻结。', run.get('task_id', ''), None
		return
	task = run.get('task_id')
	if not task:
		raise gr.Error('此记录没有任务ID，不能查询。')
	secret = ''
	try:
		with client(proxy) as c:
			headers = auth(key)
			secret = headers['Authorization'][7:]
			for _ in range(360):
				data = response_json(c.get(API_HOST + '/tasks/' + task, headers=headers), secret)
				output = data.get('output')
				if not isinstance(output, dict):
					raise ValueError('任务响应结构未知，已保留任务ID，请核对新站记录。')
				status = output.get('task_status', 'UNKNOWN')
				run['last_response'] = {'task_status': status, 'code': safe_message(output.get('code', ''), secret), 'message': safe_message(output.get('message', ''), secret)}
				run['status'] = status
				save(run)
				if status == 'SUCCEEDED':
					close_exposure(run_id)
					url = output.get('video_url')
					if not url:
						raise ValueError('任务成功但缺少结果URL，请查看run.json。')
					directory = RUNS / run_id
					destination = directory / 'output.mp4'
					if not destination.exists():
						partial = directory / 'output.part'
						with c.stream('GET', url) as response:
							response.raise_for_status()
							with partial.open('wb') as file:
								for chunk in response.iter_bytes():
									file.write(chunk)
						output_duration, _, _, output_has_audio = media_info(partial)
						run['output_duration'] = output_duration
						run['output_has_audio'] = output_has_audio
						save(run)
						partial.replace(destination)
					message = '生成完成并保存，保留模型生成的原生声音；未在本地替换音轨。' if run.get('output_has_audio') else '模型返回无音轨，声音要求未达成；视频已保存，未自造声音或替换音轨。'
					yield message, task, str(destination)
					return
				if status in ('FAILED', 'CANCELED'):
					close_exposure(run_id)
					yield f'任务状态：{status}；{run["last_response"]["code"]} {run["last_response"]["message"]}', task, None
					return
				if status not in ('PENDING', 'RUNNING'):
					raise ValueError('任务状态未知，已保留任务ID和临时素材服务，请核对新站记录。')
				yield f'任务状态：{status}；每15秒自动查询。任务ID已保存。', task, None
				time.sleep(15)
		yield '自动查询已满90分钟。点击继续查询，不会重复生成。', task, None
	except Exception as error:
		yield f'查询或下载中断：{safe_message(error, secret)}。点击继续查询即可。当前进程运行时保留临时素材服务，退出后自动关闭。', task, None


def history():
	rows = []
	for path in sorted(RUNS.glob('*/run.json'), key=lambda item: item.stat().st_mtime, reverse=True):
		run = json.loads(path.read_text(encoding='utf-8'))
		rows.append(f'{run["id"]} | {run["status"]} | {run["resolution"]} | task={run.get("task_id", "未提交")}')
	return '\n'.join(rows) or '暂无记录'


def build_ui():
	with gr.Blocks(title='Wan3 人物与场景参考试验', analytics_enabled=False) as demo:
		gr.Markdown(f'# Wan3 人物与场景参考试验\n新站付费通道，模型：`{MODEL}`。人物组、场景组各至少1张，图片共不超过10张；截取2～15秒视频并同步提取原片音频。冻结仅在本地处理，确认提交后临时外传这组素材。')
		key = gr.Textbox(label='新站 API Key（不写入文件；留空使用 XINHANKR_API_KEY 或已有商品替换配置）', type='password')
		proxy = gr.Textbox(label='可选 HTTP 代理', placeholder='例如 http://127.0.0.1:7890')
		with gr.Row():
			person_references = gr.File(label='人物参考图（多选，至少1张）', file_types=['image'], file_count='multiple', type='filepath')
			scene_references = gr.File(label='场景参考图（多选，至少1张）', file_types=['image'], file_count='multiple', type='filepath')
		reference_map = gr.Markdown('选择人物参考图和场景参考图后，将显示编号映射。')
		video = gr.File(label='视频1：输入视频（程序按起点和时长截取）', file_types=['video'], type='filepath')
		with gr.Row():
			start = gr.Number(label='从第几秒开始截取', value=0, minimum=0)
			duration = gr.Slider(label='测试时长（2～15秒）', value=5, minimum=2, maximum=15, step=1)
			resolution = gr.Dropdown(['480P', '720P', '1080P'], value='480P', label='输出分辨率')
			seed = gr.Number(label='随机种子', value=20260915, precision=0, minimum=0, maximum=2147483647)
		prompt = gr.Textbox(label='提示词（提交前可编辑）', value=DEFAULT_PROMPT, lines=13)
		gr.Markdown('当前默认提示词专用于上次5秒、三镜头素材：人物图按正面、侧面A、侧面B、背面顺序上传为图1～4；场景图按跟拍、反打、墙边近景上传为图5～7。使用原5秒片段时起点为0。换素材、图序、起点或时长时，请同步修改图号、分镜和对白；默认稿不会自动分析新视频。末句“你懂什么”依据原画面字幕补入，本地识别仅识别到“什么”；实际发声及片尾边界仍以原片音频为准。')
		prepare_button = gr.Button('① 冻结参考图、测试片段和原片音频')
		run_id = gr.Textbox(label='本地运行编号')
		preview = gr.Video(label='待提交的输入片段')
		audio_preview = gr.Audio(label='音频1：从冻结片段同步提取的原片音轨', type='filepath')
		estimate = gr.Textbox(label='素材时长与付费说明', interactive=False)
		approved = gr.Checkbox(label=CONFIRM_LABEL, value=False)
		submit_button = gr.Button('② 确认并开始 Wan3 生成', variant='primary')
		resume_button = gr.Button('继续查询已有任务 / 重新下载结果（不重复生成）')
		status = gr.Textbox(label='进度与错误', interactive=False)
		task = gr.Textbox(label='新站任务ID', interactive=False)
		output = gr.Video(label='Wan3 输出结果（模型原生声音，不合入原音轨）')
		histories = gr.Textbox(label='历史任务', value=history, lines=5, interactive=False)
		refresh = gr.Button('刷新历史记录')
		gr.Markdown('原音频作为 reference_audio 交给模型，不保证原样复制对白或声音。提示词按原片角色约束多说话人，混合音轨不能保证自动准确分离各人的音色与口型。输出保持模型原生声音，不在本地合入原音轨。参数在冻结时保存，更改后需重新冻结。提交超时或响应未知不会自动重试，请核对新站调用记录。查询中断时保留临时素材服务，任务完成、失败或进程退出时关闭；关闭或刷新网页不会清理其他页面的任务素材。生成期间请保持本地服务运行，退出后未结束任务可能无法继续读取素材。')
		for component in (person_references, scene_references, video, start, duration, resolution, prompt, seed):
			component.change(invalidate_preparation, [person_references, scene_references], [run_id, preview, audio_preview, estimate, approved, reference_map], concurrency_id='preparation', concurrency_limit=1)
		prepare_button.click(prepare, [person_references, scene_references, video, start, duration, resolution, prompt, seed], [run_id, preview, audio_preview, estimate, approved, reference_map], concurrency_id='preparation', concurrency_limit=1)
		submit_button.click(submit, [run_id, key, proxy, approved], [status, task, output], concurrency_id='generation', concurrency_limit=1)
		resume_button.click(poll, [run_id, key, proxy], [status, task, output], concurrency_id='generation', concurrency_limit=1)
		refresh.click(history, outputs=histories)
	return demo


if __name__ == '__main__':
	build_ui().queue().launch(server_name='127.0.0.1', server_port=7863, inbrowser=True, allowed_paths=[str(RUNS)], show_error=False)
