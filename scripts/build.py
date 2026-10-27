#!/usr/bin/env python3
"""Build a local Zotero XPI or a shareable, credential-free source archive."""
import argparse
import base64
import sys
import json
import os
from pathlib import Path
import secrets
import shutil
import tempfile
from urllib.parse import urlsplit
import zipfile
from project_files import project_files, audit_files

ROOT = Path(__file__).resolve().parent.parent


def write_config(path, config):
    with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=path.parent, delete=False) as saved:
        json.dump(config, saved, indent=2, ensure_ascii=False)
        saved.write('\n')
    os.replace(saved.name, path)
    path.chmod(0o600)


def local_proxy(environ):
    for name in ('HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'):
        value = environ.get(name, '')
        try:
            parsed = urlsplit(value)
            if (parsed.scheme in ('http', 'https') and parsed.hostname in ('localhost', '127.0.0.1', '::1')
                    and parsed.port and not parsed.username and not parsed.password and not parsed.query and not parsed.fragment):
                return value
        except ValueError:
            pass
    return None


def build_local(root, output):
    node = shutil.which('node')
    if not node:
        bundled = Path.home() / '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node'
        if bundled.is_file():
            node = str(bundled)
    if not node:
        raise SystemExit('找不到 Node.js。请先安装 Node.js 22 或更新版本，再重新打包。')
    config_path = root / 'bridge/config.json'
    config = json.loads(config_path.read_text(encoding='utf-8')) if config_path.exists() else {
        'port': 23127, 'token': secrets.token_hex(32),
    }
    proxy = local_proxy(os.environ)
    if proxy:
        config['codexNetworkProxy'] = proxy
    write_config(config_path, config)
    settings = {'url': f'http://127.0.0.1:{config["port"]}', 'token': config['token'],
                'node': str(Path(node).resolve()), 'server': str(root / 'bridge/server.mjs'),
                'launcher': '启动伴读服务.cmd' if sys.platform == 'win32' else '启动伴读服务.command'}
    manifest = json.loads((root / 'addon/manifest.json').read_text(encoding='utf-8'))
    text_path = root / 'addon/ui-text.json'
    if text_path.exists():
        manifest.update(json.loads(text_path.read_text(encoding='utf-8'))['metadata'])
    version = manifest['version']
    output.mkdir(parents=True, exist_ok=True)
    xpi = output / f'zotero-paper-chat-{version}.xpi'
    with zipfile.ZipFile(xpi, 'w', zipfile.ZIP_DEFLATED) as archive:
        for path in sorted((root / 'addon').rglob('*')):
            if path.is_file() and path.name != 'config.js' and not path.name.startswith('.'):
                if path.is_symlink():
                    raise SystemExit('安装包中不能包含符号链接：' + str(path.relative_to(root)))
                if path.name == 'manifest.json' and path.parent == root / 'addon':
                    archive.writestr('manifest.json', json.dumps(manifest, ensure_ascii=False, indent=2))
                else:
                    archive.write(path, path.relative_to(root / 'addon').as_posix())
        archive.writestr('config.js', 'var PaperChatConfig = ' + json.dumps(settings, ensure_ascii=False) + ';\n')
    write_launcher(root, node)
    return xpi


def write_launcher(root, node, platform=None):
    platform = platform or sys.platform
    if platform == 'win32':
        # Encode PowerShell's literal arguments: cmd.exe must never expand path
        # characters such as %, &, ! or non-ASCII text in the user's directory.
        def quote(value):
            return "'" + str(value).replace("'", "''") + "'"
        command = ("Set-Location -LiteralPath " + quote(root) + "; & "
                   + quote(node) + " " + quote(root / 'bridge/server.mjs')
                   + "; exit $LASTEXITCODE")
        encoded = base64.b64encode(command.encode('utf-16le')).decode('ascii')
        launcher = root / '启动伴读服务.cmd'
        with launcher.open('w', encoding='ascii', newline='') as stream:
            stream.write('@echo off\r\npowershell.exe -NoProfile -EncodedCommand '
                         + encoded + '\r\npause\r\n')
    else:
        def quote(value):
            return "'" + str(value).replace("'", "'\\''") + "'"
        launcher = root / '启动伴读服务.command'
        launcher.write_text('#!/bin/zsh\ncd ' + quote(root) + '\nexec '
                            + quote(node) + ' bridge/server.mjs\n', encoding='utf-8')
        launcher.chmod(0o755)
    return launcher


def build_source(root, output):
    files = project_files(root)
    audit_files(root, files)
    version = json.loads((root / 'package.json').read_text(encoding='utf-8'))['version']
    output.mkdir(parents=True, exist_ok=True)
    archive_path = output / f'zotero-paper-chat-{version}-source.zip'
    with zipfile.ZipFile(archive_path, 'w', zipfile.ZIP_DEFLATED) as archive:
        for path in files:
            name = f'zotero-paper-chat-{version}/' + path.relative_to(root).as_posix()
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = (0o100755 if path.suffix == '.sh' else 0o100644) << 16
            archive.writestr(info, path.read_bytes())
    return archive_path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', action='store_true', help='只打包可分享的源码，不生成本机配置')
    parser.add_argument('--output-dir', type=Path, help='输出目录，默认 dist/')
    args = parser.parse_args()
    output = args.output_dir.resolve() if args.output_dir else ROOT / 'dist'
    print((build_source if args.source else build_local)(ROOT, output))


if __name__ == '__main__':
    main()
