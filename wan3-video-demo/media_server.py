"""Expose only explicitly frozen media, for the lifetime of a submitted task."""
import mimetypes
import os
import re
import secrets
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlsplit


class PublicMedia:
    def __init__(self, paths, executable):
        self.paths = {path.name: path.resolve(strict=True) for path in paths}
        if len(self.paths) != len(paths) or any(not path.is_file() for path in self.paths.values()):
            raise ValueError('公开素材列表无效。')
        self.executable = executable
        self.token = secrets.token_urlsafe(32)
        self.server = None
        self.process = None
        self.base_url = None
        self.connected = False
        self.closed = False

    def start(self):
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_HEAD(self):
                self.send_media(False)

            def do_GET(self):
                self.send_media(True)

            def send_media(self, body):
                path = unquote(urlsplit(self.path).path)
                prefix = '/' + owner.token + '/'
                name = path[len(prefix):] if path.startswith(prefix) else ''
                if not name or '/' in name or '\\' in name or name not in owner.paths:
                    self.send_error(404)
                    return
                source = owner.paths[name]
                total = source.stat().st_size
                begin, end = 0, total - 1
                status = 200
                requested = self.headers.get('Range')
                if requested:
                    match = re.fullmatch(r'bytes=(\d*)-(\d*)', requested)
                    if not match or not any(match.groups()):
                        self.send_error(416)
                        return
                    first, last = match.groups()
                    if first:
                        begin = int(first)
                        end = min(int(last), end) if last else end
                    else:
                        begin = max(0, total - int(last))
                    if begin > end or begin >= total:
                        self.send_response(416)
                        self.send_header('Content-Range', f'bytes */{total}')
                        self.end_headers()
                        return
                    status = 206
                self.send_response(status)
                self.send_header('Content-Type', {'wav': 'audio/wav', 'mp4': 'video/mp4', 'jpg': 'image/jpeg'}.get(source.suffix[1:], mimetypes.guess_type(name)[0] or 'application/octet-stream'))
                self.send_header('Content-Length', str(end - begin + 1))
                self.send_header('Accept-Ranges', 'bytes')
                self.send_header('Cache-Control', 'no-store')
                if status == 206:
                    self.send_header('Content-Range', f'bytes {begin}-{end}/{total}')
                self.end_headers()
                if body:
                    with source.open('rb') as stream:
                        stream.seek(begin)
                        remaining = end - begin + 1
                        while remaining:
                            chunk = stream.read(min(65536, remaining))
                            if not chunk:
                                break
                            self.wfile.write(chunk)
                            remaining -= len(chunk)

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.server.daemon_threads = True
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        try:
            self.process = subprocess.Popen(
                [str(self.executable), 'tunnel', '--url', f'http://127.0.0.1:{self.server.server_port}', '--no-autoupdate'],
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding='utf-8', errors='replace',
                creationflags=0x08000000 if os.name == 'nt' else 0,
            )
            ready = threading.Event()

            def read_logs():
                for line in self.process.stdout:
                    match = re.search(r'https://[a-z0-9-]+\.trycloudflare\.com', line)
                    if match:
                        self.base_url = match.group(0)
                    if 'Registered tunnel connection' in line:
                        self.connected = True
                    if self.base_url and self.connected:
                        ready.set()
                ready.set()

            threading.Thread(target=read_logs, daemon=True).start()
            if not ready.wait(45) or not self.base_url or not self.connected or self.process.poll() is not None:
                raise ValueError('Quick Tunnel 未能建立，请检查网络后重新冻结。')
            return self
        except Exception:
            self.close()
            raise

    def url(self, path):
        if path.name not in self.paths or self.paths[path.name] != path.resolve():
            raise ValueError('素材未列入公开列表。')
        return self.base_url + '/' + self.token + '/' + path.name

    def close(self):
        if self.closed:
            return
        self.closed = True
        if self.process:
            if self.process.poll() is None:
                self.process.terminate()
                try:
                    self.process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    self.process.kill()
                    self.process.wait(timeout=5)
            if self.process.stdout:
                self.process.stdout.close()
        if self.server:
            self.server.shutdown()
            self.server.server_close()


def validate_public_urls(client, exposure, paths):
    """Prove MIME and byte length of each HTTPS media URL before generation."""
    urls = []
    for path in paths:
        url = exposure.url(path)
        if not url.startswith('https://'):
            raise ValueError('素材URL必须为HTTPS。')
        expected = {'.mp4': 'video/mp4', '.jpg': 'image/jpeg', '.wav': 'audio/wav'}[path.suffix]
        response = client.head(url)
        if response.status_code != 200 or response.headers.get('content-type', '').split(';')[0] != expected or response.headers.get('content-length') != str(path.stat().st_size):
            raise ValueError(f'{path.name}公网素材验证失败。请重新冻结后再提交。')
        urls.append(url)
    return urls
