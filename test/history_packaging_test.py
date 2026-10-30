"""Regression coverage for excluding durable private chat state from source releases."""
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'scripts'))
import build
from project_files import project_files


class HistoryPackagingTest(unittest.TestCase):
    def test_source_archive_excludes_histories_and_known_private_directories(self):
        with tempfile.TemporaryDirectory(prefix='paper-chat-packaging-') as directory:
            root = Path(directory)

            def write(name, content):
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(content, encoding='utf-8')
                return path

            public = {
                'package.json': json.dumps({'version': '1.2.3'}),
                'bridge/server.mjs': '// public bridge\n',
                'bridge/conversations.mjs': '// public history implementation\n',
                'test/history-integration.test.mjs': '// public history tests\n',
                'docs/history.md': 'History documentation\n',
            }
            for name, content in public.items():
                write(name, content)
            private = {
                'bridge/runtime/conversations/index.json': '{"title":"PRIVATE-HISTORY-CANARY"}',
                'bridge/runtime/conversations/paper/conversation.json': '{"messages":["PRIVATE-HISTORY-CANARY"]}',
                'bridge/runtime/conversations/paper/conversation.json.pending.tmp': 'PRIVATE-HISTORY-CANARY',
                'bridge/runtime/conversations/paper/summary.md': 'PRIVATE-HISTORY-CANARY',
                'bridge/config.json': json.dumps({'token': 'fixture-private-token', 'external': {'apiKey': 'fixture-private-key'}}),
                'addon/config.js': 'PRIVATE-HISTORY-CANARY',
                'bridge/node_modules/dependency/history.json': 'PRIVATE-HISTORY-CANARY',
                'test/__pycache__/history.py': 'PRIVATE-HISTORY-CANARY',
                'bridge/.git/history.json': 'PRIVATE-HISTORY-CANARY',
                'tmp/library/history.json': 'PRIVATE-HISTORY-CANARY',
                'dist/history.json': 'PRIVATE-HISTORY-CANARY',
                '.env': 'PRIVATE-HISTORY-CANARY',
            }
            paths = [write(name, content) for name, content in private.items()]
            before = {path: hashlib.sha256(path.read_bytes()).digest() for path in paths}
            selected = {path.relative_to(root).as_posix() for path in project_files(root)}
            self.assertEqual(selected, set(public))

            archive = build.build_source(root, root / 'dist')
            with zipfile.ZipFile(archive) as zipped:
                prefix = 'zotero-paper-chat-1.2.3/'
                self.assertEqual(set(zipped.namelist()), {prefix + name for name in public})
                for name in zipped.namelist():
                    data = zipped.read(name)
                    self.assertNotIn(b'PRIVATE-HISTORY-CANARY', data)
                    self.assertNotIn(b'fixture-private-token', data)
                    self.assertNotIn(b'fixture-private-key', data)
            self.assertEqual(before, {path: hashlib.sha256(path.read_bytes()).digest() for path in paths})

    def test_runtime_directory_is_ignored_by_repository_rule(self):
        # Inspect the rule directly: these tests must not invoke git.
        root = Path(__file__).resolve().parent.parent
        rules = (root / '.gitignore').read_text(encoding='utf-8').splitlines()
        self.assertTrue(any(rule.strip() in {'bridge/runtime/', '/bridge/runtime/'} for rule in rules))


if __name__ == '__main__':
    unittest.main()
