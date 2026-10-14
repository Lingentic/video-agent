import io
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

import httpx
from media_server import PublicMedia, validate_public_urls


class MediaServerTests(unittest.TestCase):
    def test_allowlist_head_range_traversal_and_cleanup(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            media = root / 'input.mp4'
            media.write_bytes(b'0123456789')
            (root / 'run.json').write_text('private', encoding='utf-8')
            process = MagicMock()
            process.stdout = io.StringIO('https://mock.trycloudflare.com\nRegistered tunnel connection\n')
            process.poll.return_value = None
            with patch('media_server.subprocess.Popen', return_value=process):
                exposure = PublicMedia([media], 'mock-cloudflared').start()
            try:
                base = f'http://127.0.0.1:{exposure.server.server_port}/{exposure.token}/'
                with httpx.Client(trust_env=False) as c:
                    head = c.head(base + 'input.mp4')
                    self.assertEqual(head.status_code, 200)
                    self.assertEqual(head.headers['content-length'], '10')
                    self.assertEqual(head.headers['content-type'], 'video/mp4')
                    ranged = c.get(base + 'input.mp4', headers={'Range': 'bytes=2-5'})
                    self.assertEqual(ranged.status_code, 206)
                    self.assertEqual(ranged.content, b'2345')
                    self.assertEqual(ranged.headers['content-range'], 'bytes 2-5/10')
                    self.assertEqual(c.get(base + 'input.mp4', headers={'Range': 'bytes=-3'}).content, b'789')
                    self.assertEqual(c.get(base + 'input.mp4', headers={'Range': 'bytes=99-'}).status_code, 416)
                    for suffix in ('run.json', '%2e%2e%2frun.json', '..%5crun.json', ''):
                        self.assertEqual(c.get(base + suffix).status_code, 404)
                    self.assertEqual(c.get(f'http://127.0.0.1:{exposure.server.server_port}/wrong/input.mp4').status_code, 404)
                    self.assertEqual(c.post(base + 'input.mp4').status_code, 501)
            finally:
                exposure.close()
                exposure.close()
            process.terminate.assert_called_once()
            process.wait.assert_called_once()

    def test_public_validation_uses_head_checks_mime_length(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / 'original-audio.wav'
            path.write_bytes(b'1234')
            exposure = PublicMedia([path], 'unused')
            exposure.base_url = 'https://mock.trycloudflare.com'
            methods = []
            def transport(request):
                methods.append(request.method)
                return httpx.Response(200, headers={'content-type': 'audio/wav', 'content-length': '4'})
            with httpx.Client(transport=httpx.MockTransport(transport)) as c:
                self.assertEqual(validate_public_urls(c, exposure, [path]), [exposure.url(path)])
            self.assertEqual(methods, ['HEAD'])
            for headers in ({'content-type': 'text/html', 'content-length': '4'}, {'content-type': 'audio/wav', 'content-length': '3'}):
                with httpx.Client(transport=httpx.MockTransport(lambda request: httpx.Response(200, headers=headers))) as c:
                    with self.assertRaisesRegex(ValueError, '验证失败'):
                        validate_public_urls(c, exposure, [path])


if __name__ == '__main__':
    unittest.main()
