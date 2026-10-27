import hashlib
import base64
import os
import importlib.util
import json
from pathlib import Path
import stat
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'scripts'))
import build
from project_files import project_files, audit_files


class PackagingTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.write('package.json', json.dumps({'version': '1.2.3'}))
        self.write('addon/manifest.json', json.dumps({'version': '1.2.3'}))
        self.write('addon/bootstrap.js', '// addon\n')
        self.write('addon/vendor/katex-LICENSE', 'Vendor license\n')
        self.write('bridge/server.mjs', '// server\n')
        self.write('bridge/prompts/default.md', '默认提示词：根据论文回答。\n')
        self.write('README.md', '# Example\n')

    def write(self, name, content):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding='utf-8')

    def test_shareable_source_excludes_private_data_and_is_deterministic(self):
        private = {'port': 23127, 'token': 'fixture-capability', 'external': {'apiKey': 'fixture-api-key'}}
        self.write('bridge/config.json', json.dumps(private))
        for name in ['tmp/library.json', 'bridge/runtime/chat.json', 'dist/old.xpi', 'addon/config.js',
                     '启动伴读服务.command', '启动伴读服务.cmd', 'VERIFICATION.md', '.env', 'test/__pycache__/private.py']:
            self.write(name, 'private-content')
        archive = build.build_source(self.root, self.root / 'dist')
        first = hashlib.sha256(archive.read_bytes()).digest()
        with zipfile.ZipFile(archive) as zipped:
            names = zipped.namelist()
            self.assertIn('zotero-paper-chat-1.2.3/addon/vendor/katex-LICENSE', names)
            # Preserve source bytes on either LF or CRLF hosts.
            self.assertEqual(zipped.read('zotero-paper-chat-1.2.3/bridge/prompts/default.md'),
                             (self.root / 'bridge/prompts/default.md').read_bytes())
            self.assertTrue(all('private-content' not in zipped.read(n).decode() for n in names))
            self.assertFalse(any('config.js' in n or 'config.json' in n or '/tmp/' in n or '/dist/' in n for n in names))
        self.assertEqual(first, hashlib.sha256(build.build_source(self.root, self.root / 'dist').read_bytes()).digest())
        self.assertEqual(json.loads((self.root / 'bridge/config.json').read_text()), private)

    def test_local_build_creates_private_config_and_preserves_existing_settings(self):
        with patch.object(build.shutil, 'which', return_value='/usr/bin/node'), patch.dict(build.os.environ, {}, clear=True):
            xpi = build.build_local(self.root, self.root / 'dist')
            config_path = self.root / 'bridge/config.json'
            config = json.loads(config_path.read_text())
            self.assertEqual(len(config['token']), 64)
            if os.name != 'nt':
                self.assertEqual(stat.S_IMODE(config_path.stat().st_mode), 0o600)
            config.update(model='selected-model', customPrompt='retained', external={'apiKey': 'local-fixture-key'})
            self.write('bridge/config.json', json.dumps(config))
            self.write('addon/config.js', 'stale-file-must-not-be-packed')
            build.build_local(self.root, self.root / 'dist')
            self.assertEqual(json.loads(config_path.read_text()), config)
            with zipfile.ZipFile(xpi) as zipped:
                self.assertEqual(zipped.namelist().count('config.js'), 1)
                settings = zipped.read('config.js').decode()
                self.assertIn(config['token'], settings)
                self.assertNotIn('local-fixture-key', settings)
                self.assertNotIn('stale-file', settings)

    def test_ui_dictionary_controls_packaged_metadata(self):
        text = {'metadata': {'name': 'My Reader', 'description': 'Custom description'},
                'common': {'send': 'Ask'}}
        self.write('addon/ui-text.json', json.dumps(text))
        with patch.dict(os.environ, {}, clear=True), patch('shutil.which', return_value=sys.executable):
            xpi = build.build_local(self.root, self.root / 'dist')
        with zipfile.ZipFile(xpi) as zipped:
            manifest = json.loads(zipped.read('manifest.json'))
            self.assertEqual(manifest['name'], 'My Reader')
            self.assertEqual(manifest['description'], 'Custom description')
            self.assertEqual(json.loads(zipped.read('ui-text.json')), text)

    def test_windows_launcher_preserves_literal_paths_without_shell_expansion(self):
        root = self.root / "中文 & 100% ! 'space"
        root.mkdir()
        node = root / 'node.exe'
        launcher = build.write_launcher(root, node, 'win32')
        data = launcher.read_bytes()
        self.assertIn(b'\r\n', data)
        encoded = data.decode('ascii').split('-EncodedCommand ')[1].split()[0]
        command = base64.b64decode(encoded).decode('utf-16le')
        self.assertIn(str(node).replace("'", "''"), command)
        self.assertIn(str(root / 'bridge/server.mjs').replace("'", "''"), command)
        self.assertNotIn('ExecutionPolicy', command)

    def test_macos_launcher_retains_zsh_and_quotes_paths(self):
        launcher = build.write_launcher(self.root, "/tmp/Node App/node", 'darwin')
        self.assertEqual(launcher.name, '启动伴读服务.command')
        self.assertIn("exec '/tmp/Node App/node' bridge/server.mjs", launcher.read_text(encoding='utf-8'))
        self.assertTrue(launcher.read_text(encoding='utf-8').startswith('#!/bin/zsh\n'))

    def test_audit_rejects_windows_native_and_json_escaped_home(self):
        home = Path('C:/Users/fixture')
        with patch('project_files.Path.home', return_value=home):
            for value in [str(home) + '/private', str(home) + '\\private',
                          (str(home) + '\\private').replace('\\', '\\\\')]:
                self.write('addon/leak.js', value)
                with self.assertRaises(ValueError):
                    audit_files(self.root, project_files(self.root))

    def test_proxy_only_accepts_credential_free_loopback_addresses(self):
        for value in ['http://127.0.0.1:7897', 'http://localhost:8080', 'http://[::1]:8000']:
            self.assertEqual(build.local_proxy({'HTTPS_PROXY': value}), value)
        for value in ['http://user:pass@localhost:8080', 'https://example.com:443', 'socks5://localhost:8080',
                      'http://localhost:8080?key=secret', 'http://localhost:bad']:
            self.assertIsNone(build.local_proxy({'HTTPS_PROXY': value}))

    def test_audit_rejects_known_credentials_or_personal_absolute_paths(self):
        self.write('bridge/config.json', json.dumps({'token': 'sensitive-fixture'}))
        self.write('addon/leak.js', 'sensitive-fixture')
        with self.assertRaisesRegex(ValueError, 'addon/leak.js'):
            audit_files(self.root, project_files(self.root))
        self.write('addon/leak.js', str(Path.home()) + '/private-document')
        with self.assertRaisesRegex(ValueError, 'addon/leak.js'):
            audit_files(self.root, project_files(self.root))


if __name__ == '__main__':
    unittest.main()
