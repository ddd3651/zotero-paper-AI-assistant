"""Publishing boundary shared by source packaging and repository checks."""
import json
from pathlib import Path

ROOT_FILES = {'.gitignore', '.gitattributes', 'README.md', 'package.json', 'THIRD_PARTY_NOTICES.md', 'LICENSE'}
DIRECTORIES = {'addon', 'bridge', 'scripts', 'test', 'docs', '.github'}
EXTENSIONS = {'.swift', '.ps1', '.js', '.mjs', '.json', '.py', '.md', '.sh', '.yml', '.yaml', '.txt'}


def project_files(root):
    files = []
    # Traverse allowed directories only: tmp/ may contain a complete Zotero library.
    candidates = [root / name for name in ROOT_FILES if (root / name).exists()]
    for name in DIRECTORIES:
        folder = root / name
        if folder.exists():
            candidates.extend(folder.rglob('*'))
    for path in sorted(candidates):
        rel = path.relative_to(root)
        if any(part in {'node_modules', '__pycache__', 'runtime', 'conversations', '.git'} for part in rel.parts):
            continue
        if rel.as_posix() in {'bridge/config.json', 'addon/config.js'}:
            continue
        if not path.is_file():
            continue
        if path.is_symlink():
            raise ValueError('发布文件不能是符号链接：' + rel.as_posix())
        if rel.as_posix() not in ROOT_FILES and path.suffix not in EXTENSIONS and 'LICENSE' not in path.name:
            continue
        files.append(path)
    return files


def audit_files(root, files):
    home = str(Path.home())
    forbidden = [home + '/', home + '\\', (home + '\\').replace('\\', '\\\\'), home.replace('\\', '/') + '/']
    private = root / 'bridge/config.json'
    if private.exists():
        config = json.loads(private.read_text(encoding='utf-8'))
        forbidden.extend(value for value in [config.get('token'), config.get('external', {}).get('apiKey')] if value)
    for path in files:
        text = path.read_text(encoding='utf-8')
        if any(value in text for value in forbidden):
            raise ValueError('发布检查发现本机路径或凭据，文件：' + path.relative_to(root).as_posix())


if __name__ == '__main__':
    root = Path(__file__).resolve().parent.parent
    files = project_files(root)
    audit_files(root, files)
    print(f'发布检查通过：{len(files)} 个文件，无本机配置、已知密钥或个人绝对路径。')
