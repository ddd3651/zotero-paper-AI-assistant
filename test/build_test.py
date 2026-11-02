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
from project_files import project_files, audit_files, user_data_dir


# Windows child processes need these OS variables even in an otherwise clean
# fixture environment. Avoid inheriting plugin settings, proxies or credentials.
CLEAN_ENV = {key: value for key, value in os.environ.items()
             if key.casefold() in {'systemroot', 'windir', 'temp', 'tmp'}}


class PackagingTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / 'project'
        self.root.mkdir()
        self.data_dir = Path(self.temp.name) / 'private-data'
        self.node = build.shutil.which('node')
        if not self.node:
            self.node = str(Path.home() / '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node')
        for target in ['build.user_data_dir', 'project_files.user_data_dir']:
            patched = patch(target, return_value=self.data_dir)
            patched.start()
            self.addCleanup(patched.stop)
        self.write('package.json', json.dumps({'version': '1.2.3'}))
        self.write('addon/manifest.json', json.dumps({'version': '1.2.3'}))
        self.write('addon/bootstrap.js', '// addon\n')
        self.write('addon/vendor/katex-LICENSE', 'Vendor license\n')
        self.write('bridge/server.mjs', '// server\n')
        migration_source = Path(__file__).resolve().parent.parent / 'bridge/paths.mjs'
        self.write('bridge/paths.mjs', migration_source.read_text(encoding='utf-8'))
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
        with patch.object(build.shutil, 'which', return_value=self.node), patch.dict(build.os.environ, CLEAN_ENV, clear=True):
            xpi = build.build_local(self.root, self.root / 'dist')
            config_path = self.data_dir / 'config.json'
            self.assertFalse((self.root / 'bridge/config.json').exists())
            config = json.loads(config_path.read_text())
            self.assertEqual(len(config['token']), 64)
            if os.name != 'nt':
                self.assertEqual(stat.S_IMODE(config_path.stat().st_mode), 0o600)
            config.update(model='selected-model', customPrompt='retained', external={'apiKey': 'local-fixture-key'})
            config_path.write_text(json.dumps(config), encoding='utf-8')
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
        with patch.dict(os.environ, CLEAN_ENV, clear=True), patch('shutil.which', return_value=self.node):
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

    def test_first_build_backs_up_full_legacy_config_and_histories_without_changing_originals(self):
        raw = ('{\r\n "port": 23456, "token": "fixture-token", "model": "manual-model", '
               '"reasoningEffort": "high", "customPrompt": "保留提示词", '
               '"contextBudget": {"contextWindow": 65432}, '
               '"codexNetworkProxy": "http://localhost:9000", '
               '"external": {"apiKey": "fixture-key"}, "unknown": {"future": true}\r\n}\r\n').encode('utf-8')
        legacy = self.root / 'bridge/config.json'
        legacy.write_bytes(raw)
        self.write('bridge/runtime/conversations/chat.json', 'fixture-history')
        with patch.object(build.shutil, 'which', return_value=self.node), patch.dict(os.environ, {**CLEAN_ENV, 'HTTPS_PROXY': 'http://localhost:8888'}, clear=True):
            xpi = build.build_local(self.root, self.root / 'dist')
            build.build_local(self.root, self.root / 'dist')
        self.assertEqual(legacy.read_bytes(), raw)
        self.assertEqual((self.data_dir / 'config.json').read_bytes(), raw)
        backups = list((self.data_dir / 'backups').glob('*.json'))
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].read_bytes(), raw)
        self.assertEqual((self.data_dir / 'conversations/chat.json').read_text(), 'fixture-history')
        self.assertEqual((self.root / 'bridge/runtime/conversations/chat.json').read_text(), 'fixture-history')
        with zipfile.ZipFile(xpi) as zipped:
            settings = json.loads(zipped.read('config.js').decode().split(' = ', 1)[1].rstrip(';\n'))
            self.assertEqual(settings['dataDir'], str(self.data_dir))
            self.assertEqual(settings['url'], 'http://127.0.0.1:23456')
            self.assertEqual(settings['token'], 'fixture-token')
            self.assertNotIn('fixture-key', zipped.read('config.js').decode())
            self.assertFalse(any('backups/' in name or 'conversations/' in name for name in zipped.namelist()))

    def test_fixed_settings_win_over_a_new_project_legacy_configuration(self):
        self.data_dir.mkdir()
        fixed = {'token': 'already-saved', 'port': 23457, 'external': {'apiKey': 'saved-api'},
                 'unknown': 'untouched', 'contextBudget': {'contextWindow': 87654}}
        (self.data_dir / 'config.json').write_text(json.dumps(fixed), encoding='utf-8')
        self.write('bridge/config.json', json.dumps({'token': 'stale', 'port': 23458}))
        with patch.object(build.shutil, 'which', return_value=self.node), patch.dict(os.environ, CLEAN_ENV, clear=True):
            build.build_local(self.root, self.root / 'dist')
        self.assertEqual(json.loads((self.data_dir / 'config.json').read_text()), fixed)

    def test_failed_backup_stops_build_without_creating_replacement_credentials(self):
        self.write('bridge/config.json', '{"token":"keep-fixture","port":23127}')
        self.data_dir.mkdir()
        (self.data_dir / 'backups').write_text('blocked', encoding='utf-8')
        with patch.object(build.shutil, 'which', return_value=self.node):
            with self.assertRaisesRegex(SystemExit, '原文件已保留'):
                build.build_local(self.root, self.root / 'dist')
        self.assertFalse((self.data_dir / 'config.json').exists())
        self.assertFalse((self.root / 'dist').exists())
        self.assertEqual(json.loads((self.root / 'bridge/config.json').read_text())['token'], 'keep-fixture')

    def test_launchers_pass_explicit_data_dir_as_one_literal_argument(self):
        data = self.root / "用户数据 & 100% ! 'space"
        launcher = build.write_launcher(self.root, '/tmp/node', 'win32', data_dir=data)
        encoded = launcher.read_text().split('-EncodedCommand ')[1].split()[0]
        command = base64.b64decode(encoded).decode('utf-16le')
        self.assertIn("'--data-dir' '" + str(data).replace("'", "''") + "'", command)
        launcher = build.write_launcher(self.root, '/tmp/node', 'darwin', data_dir=data)
        import shlex
        args = shlex.split(launcher.read_text(encoding='utf-8').splitlines()[-1])
        self.assertEqual(args[-2:], ['--data-dir', str(data)])

    def test_fixed_data_inside_source_is_rejected_before_build_or_migration(self):
        data = self.root / 'addon' / 'private-data'
        with patch('build.user_data_dir', return_value=data), patch('project_files.user_data_dir', return_value=data):
            data.mkdir(parents=True)
            (data / 'config.json').write_text(json.dumps({'token': 'private-fixture-token', 'port': 23456}), encoding='utf-8')
            (data / 'arbitrary.json').write_text('DO-NOT-PUBLISH-FIXTURE', encoding='utf-8')
            with patch.object(build.shutil, 'which', return_value=self.node), patch.dict(os.environ, CLEAN_ENV, clear=True):
                with self.assertRaisesRegex(SystemExit, '不能相互嵌套'):
                    build.build_local(self.root, self.root / 'dist')
            self.assertFalse((self.root / 'dist').exists())
            source = build.build_source(self.root, self.root / 'dist')
            with zipfile.ZipFile(source) as zipped:
                self.assertFalse(any('/private-data/' in name for name in zipped.namelist()))

    def test_source_as_data_directory_or_below_data_directory_is_rejected(self):
        for data in [self.root, self.root.parent]:
            with patch('build.user_data_dir', return_value=data), patch.object(build.shutil, 'which', return_value=self.node):
                with self.assertRaisesRegex(SystemExit, '不能相互嵌套'):
                    build.build_local(self.root, self.root / 'dist')

    def test_old_override_configs_backups_and_all_runtime_trees_never_enter_packages(self):
        private = [
            'addon/old-user-data/config.json',
            'addon/old-user-data/CONFIG.JSON',
            'addon/old-user-data/config.json.abcd.tmp',
            'addon/old-user-data/config.json.lock/owner.json',
            'addon/old-user-data/backups/defaults.json',
            'addon/old-user-data/migrations/receipt.json',
            'addon/old-user-data/runtime/log.txt',
            'addon/old-user-data/conversations/chat.json',
            'bridge/former-override/config.json',
            'bridge/former-override/backups/config-copy.json',
            'bridge/former-override/runtime/conversations/history.json',
            'docs/backup-copy/config.json',
        ]
        for name in private:
            self.write(name, 'OLD-DIRECTORY-PRIVATE-CANARY')
        with patch.object(build.shutil, 'which', return_value=self.node), patch.dict(os.environ, CLEAN_ENV, clear=True):
            xpi = build.build_local(self.root, self.root / 'dist')
        source = build.build_source(self.root, self.root / 'dist')
        for archive in [xpi, source]:
            with zipfile.ZipFile(archive) as zipped:
                for name in zipped.namelist():
                    self.assertNotIn(b'OLD-DIRECTORY-PRIVATE-CANARY', zipped.read(name))
        for name in private:
            self.assertEqual((self.root / name).read_text(), 'OLD-DIRECTORY-PRIVATE-CANARY')

    def test_build_calls_prepare_and_never_rewrites_a_python_snapshot(self):
        self.data_dir.mkdir()
        fixed = {'token': 'fixture-keep', 'port': 23457, 'unknown': {'retained': True}}
        path = self.data_dir / 'config.json'
        path.write_text(json.dumps(fixed), encoding='utf-8')
        run = build.subprocess.run
        operations = []

        def intercept(args, **kwargs):
            result = run(args, **kwargs)
            operations.append(args[2])
            if args[2] == '--prepare':
                # Simulate an intervening settings save after prepare exits.
                latest = json.loads(path.read_text())
                latest['customPrompt'] = 'freshly saved synthetic prompt'
                path.write_text(json.dumps(latest), encoding='utf-8')
            return result

        with patch.object(build.shutil, 'which', return_value=self.node), patch.object(build.subprocess, 'run', side_effect=intercept), patch.dict(os.environ, CLEAN_ENV, clear=True):
            build.build_local(self.root, self.root / 'dist')
        self.assertEqual(operations, ['--resolve', '--prepare'])
        actual = json.loads(path.read_text())
        self.assertEqual(actual, {**fixed, 'customPrompt': 'freshly saved synthetic prompt'})

    def test_audit_checks_both_fixed_and_legacy_credentials_without_printing_them(self):
        self.data_dir.mkdir()
        (self.data_dir / 'config.json').write_text(json.dumps({'token': 'new-private-token', 'external': {'apiKey': 'new-private-api'}}), encoding='utf-8')
        self.write('bridge/config.json', json.dumps({'token': 'old-private-token'}))
        for secret in ['new-private-token', 'new-private-api', 'old-private-token']:
            self.write('addon/leak.js', secret)
            with self.assertRaisesRegex(ValueError, 'addon/leak.js') as caught:
                audit_files(self.root, project_files(self.root))
            self.assertNotIn(secret, str(caught.exception))

    def test_data_directory_selection_override_matches_node_on_current_platform(self):
        import subprocess
        expected = self.root / "数据 & ! % 'space"
        env = {'PAPER_CHAT_DATA_DIR': str(expected)}
        # Call the unpatched imported selector; build and audit selectors stay
        # isolated through setUp even if this assertion fails.
        self.assertEqual(user_data_dir(environ=env), expected.resolve())
        code = ('import {defaultDataDir} from ' + json.dumps((self.root / 'bridge/paths.mjs').as_uri())
                + '; console.log(defaultDataDir());')
        result = subprocess.run([self.node, '--input-type=module', '-e', code],
                                env={**os.environ, **env}, capture_output=True, text=True, encoding='utf-8', check=True)
        self.assertEqual(Path(result.stdout.strip()).resolve(), expected.resolve())

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
