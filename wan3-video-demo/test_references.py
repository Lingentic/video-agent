import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

import httpx
from PIL import Image
import app


class WorkflowTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.runs_patch = patch.object(app, 'RUNS', self.root)
        self.runs_patch.start()
        self.addCleanup(self.temporary.cleanup)
        self.addCleanup(self.runs_patch.stop)
        self.addCleanup(app.cleanup_exposures)

    def frozen_run(self):
        run_id = 'a' * 32
        directory = self.root / run_id
        directory.mkdir()
        references = app.reference_records(['人物.jpg'], ['scene.jpg'])
        for name in ['input.mp4', 'original-audio.wav', *(r['filename'] for r in references)]:
            (directory / name).write_bytes(b'frozen media')
        run = {'id': run_id, 'status': 'prepared', 'model': app.MODEL, 'provider': app.PROVIDER,
               'native_audio': True, 'resolution': '480P', 'duration': 5, 'seed': 1,
               'prompt': app.prompt_with_mapping(app.DEFAULT_PROMPT, references), 'references': references,
               'media_sha256': {p.name: app.file_hash(p) for p in directory.iterdir()}}
        app.save(run)
        return run

    def mocked_submit(self, run, response=None, exception=None, status=200):
        exposure = MagicMock()
        c = MagicMock()
        c.__enter__.return_value = c
        if exception:
            c.post.side_effect = exception
        else:
            c.post.return_value = httpx.Response(status, json=response)
        with patch.object(app, 'PublicMedia', return_value=exposure), patch.object(app, 'client', return_value=c), \
             patch.object(app, 'validate_public_urls', return_value=['https://test/video', 'https://test/person', 'https://test/scene', 'https://test/audio']), \
             patch.object(app, 'poll', return_value=iter([])):
            result = list(app.submit(run['id'], 'secret-key', '', True))
        return c, exposure, result

    def test_group_boundaries_and_audio_mapping(self):
        references = app.reference_records(['p1', 'p2'], ['s1'])
        self.assertEqual([r['group'] for r in references], ['person', 'person', 'scene'])
        self.assertEqual(len(app.reference_records(['p'] * 4, ['s'] * 6)), 10)
        for person, scene in (([], ['s']), (['p'], []), (['p'] * 5, ['s'] * 6)):
            with self.assertRaises(Exception):
                app.reference_records(person, scene)
        prompt = app.prompt_with_mapping(app.DEFAULT_PROMPT, references)
        self.assertIn('音频1：从视频1同步提取', prompt)
        self.assertIn('画外', app.DEFAULT_PROMPT)
        self.assertEqual(app.DEFAULT_PROMPT, app.DEFAULT_PROMPT_PATH.read_text(encoding='utf-8').strip())
        for filename in ('01_正面.jpg', '02_侧面A.jpg', '03_侧面B.jpg', '04_背面.jpg',
                         '01_跟拍全身.png', '02_全身反打_v2.png', '03_墙边近景.png'):
            self.assertIn(filename, app.DEFAULT_PROMPT)
        for dialogue in ('我去，你今天好高啊', '怎么一米五七看起来像一米七一样', '你懂什么'):
            self.assertIn(dialogue, app.DEFAULT_PROMPT)
        payload = app.build_payload({'prompt': prompt, 'resolution': '480P', 'duration': 15, 'seed': 1},
                                    'https://video', ['https://p', 'https://s'], 'https://audio')
        self.assertEqual(payload['model'], 'wan3.0-video')
        self.assertTrue(payload['parameters']['audio'])
        self.assertEqual([m['type'] for m in payload['input']['media']], ['reference_video', 'reference_image', 'reference_image', 'reference_audio'])

    def test_real_ffmpeg_local_preparation(self):
        source = self.root / 'source.mp4'
        app.command(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=256x256:r=30:d=4',
                     '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', str(source)])
        images = []
        for name in ('person.jpg', 'scene.jpg'):
            path = self.root / name
            Image.new('RGB', (256, 256), 'white').save(path)
            images.append(str(path))
        with patch.object(app, 'client') as client, patch.object(app, 'PublicMedia') as public:
            run_id, preview, audio, message, approval, mapping = app.prepare([images[0]], [images[1]], str(source), 1, 2, '480P', app.DEFAULT_PROMPT, 1)
            client.assert_not_called()
            public.assert_not_called()
        run = app.load(run_id)
        self.assertTrue(run['native_audio'])
        self.assertTrue(run['input_has_audio'])
        self.assertAlmostEqual(run['audio_duration'], 2, places=2)
        self.assertEqual(len(run['media_sha256']), 4)
        self.assertFalse(approval['value'])
        self.assertIn('共2张参考图', message)
        self.assertIn('音频1', mapping)
        self.assertTrue(Path(preview).is_file() and Path(audio).is_file())
        self.assertEqual(len(app.frozen_media_paths(run, self.root / run_id)), 4)

    def test_no_audio_rejected_before_freezing(self):
        with patch.object(app, 'media_info', return_value=(5, 256, 256, False)), patch.object(app, 'command') as command:
            with self.assertRaisesRegex(Exception, '没有音轨'):
                app.prepare(['p'], ['s'], 'v', 0, 2, '480P', 'prompt', 1)
            command.assert_not_called()
        self.assertEqual(list(self.root.iterdir()), [])

    def test_native_submission_and_no_secrets_persisted(self):
        run = self.frozen_run()
        c, exposure, _ = self.mocked_submit(run, {'output': {'task_id': 'task-123'}})
        args, kwargs = c.post.call_args
        self.assertEqual(args[0], app.API_HOST + '/services/aigc/video-generation/video-synthesis')
        self.assertEqual(kwargs['headers'], {'Authorization': 'Bearer secret-key', 'X-DashScope-Async': 'enable'})
        self.assertTrue(kwargs['json']['parameters']['audio'])
        saved = app.load(run['id'])
        self.assertEqual(saved['status'], 'submitted')
        self.assertEqual(saved['task_id'], 'task-123')
        self.assertNotIn('secret-key', json.dumps(saved))
        self.assertNotIn('https://test', json.dumps(saved))
        exposure.start.assert_called_once()

    def test_unknown_timeout_5xx_are_not_retried(self):
        for response, exception, status in (({'id': 'openai-shape'}, None, 200), (None, httpx.ReadTimeout('secret-key https://private/url'), 200), ({'message': 'upstream timeout'}, None, 502)):
            with self.subTest(response=response):
                if (self.root / ('a' * 32)).exists():
                    run = app.load('a' * 32)
                    run['status'] = 'prepared'
                    app.save(run)
                else:
                    run = self.frozen_run()
                c, exposure, result = self.mocked_submit(run, response, exception, status)
                self.assertEqual(app.load(run['id'])['status'], 'submission_unknown')
                c.post.assert_called_once()
                exposure.close.assert_not_called()
                self.assertNotIn('secret-key', str(result))
                retry_client, _, _ = self.mocked_submit(app.load(run['id']), {'output': {'task_id': 'bad-retry'}})
                retry_client.post.assert_not_called()

    def test_business_error_200_fails_and_closes(self):
        run = self.frozen_run()
        c, exposure, _ = self.mocked_submit(run, {'code': 400, 'message': 'secret-key invalid'})
        self.assertEqual(app.load(run['id'])['status'], 'submission_failed')
        self.assertNotIn('secret-key', json.dumps(app.load(run['id'])))
        exposure.close.assert_called_once()
        c.post.assert_called_once()

    def test_changed_or_legacy_materials_never_submit(self):
        run = self.frozen_run()
        (self.root / run['id'] / 'input.mp4').write_bytes(b'changed')
        c, exposure, result = self.mocked_submit(run, {})
        c.post.assert_not_called()
        exposure.start.assert_not_called()
        self.assertIn('重新冻结', str(result))
        with self.assertRaisesRegex(ValueError, '旧冻结'):
            app.frozen_media_paths({'model': 'wan3.0-video-prime'}, self.root)

    def test_key_fallback_and_sanitization(self):
        env = self.root / '.env'
        env.write_text('OTHER_KEY=ignored\nXINHANKR_API_KEY="fallback-secret"\n', encoding='utf-8')
        with patch.object(app, 'KEY_ENV_FILE', env), patch.dict(os.environ, {'XINHANKR_API_KEY': ''}):
            self.assertEqual(app.auth('')['Authorization'], 'Bearer fallback-secret')
            self.assertEqual(app.auth('override')['Authorization'], 'Bearer override')
        self.assertNotIn('fallback-secret', app.safe_message('fallback-secret failed', 'fallback-secret'))

    def test_legacy_local_playback_and_no_gateway_query(self):
        run = self.frozen_run()
        run.pop('provider')
        run['task_id'] = 'legacy-task'
        app.save(run)
        with patch.object(app, 'client') as client:
            result = list(app.poll(run['id'], 'new-key', ''))
            self.assertIn('旧百炼', result[0][0])
            (self.root / run['id'] / 'output.mp4').write_bytes(b'legacy output')
            result = list(app.poll(run['id'], 'new-key', ''))
            self.assertTrue(result[0][2].endswith('output.mp4'))
            client.assert_not_called()

    def test_poll_preserves_generated_audio_and_reports_silent_result(self):
        run = self.frozen_run()
        run['task_id'] = 'native-task'
        app.save(run)
        for terminal, has_audio in (('FAILED', True), ('SUCCEEDED', False)):
            exposure = MagicMock()
            app.EXPOSURES[run['id']] = exposure
            def transport(request):
                if request.url.path.endswith('/tasks/native-task'):
                    return httpx.Response(200, json={'output': {'task_status': terminal, 'video_url': 'https://generated/output.mp4'}})
                return httpx.Response(200, content=b'generated-video-native-sound')
            with patch.object(app, 'client', side_effect=lambda proxy: httpx.Client(transport=httpx.MockTransport(transport))), \
                 patch.object(app, 'media_info', return_value=(5, 256, 256, has_audio)), patch.object(app, 'command') as command:
                result = list(app.poll(run['id'], 'key', ''))
                command.assert_not_called()
            exposure.close.assert_called_once()
            if terminal == 'SUCCEEDED':
                self.assertEqual(Path(result[-1][2]).read_bytes(), b'generated-video-native-sound')
                self.assertFalse(app.load(run['id'])['output_has_audio'])
                self.assertIn('声音要求未达成', result[-1][0])

    def test_ui_and_invalidation(self):
        with patch.object(app, 'client') as client:
            run_id, video, audio, message, approved, mapping = app.invalidate_preparation(['p'], ['s'])
            self.assertEqual(run_id, '')
            self.assertIsNone(video)
            self.assertIsNone(audio)
            self.assertFalse(approved['value'])
            self.assertIn('重新冻结', message)
            demo = app.build_ui()
            self.assertIsNotNone(demo)
            self.assertFalse(any(
                target[1] == 'unload'
                for dependency in demo.config['dependencies']
                for target in dependency.get('targets', [])
            ), '页面关闭不能清理其他页面的已提交任务素材')
            client.assert_not_called()


if __name__ == '__main__':
    unittest.main()
