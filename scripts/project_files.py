"""Publishing boundary shared by source packaging and repository checks."""
import json
import os
from pathlib import Path
import sys

ROOT_FILES = {'.gitignore', '.gitattributes', 'README.md', 'package.json', 'THIRD_PARTY_NOTICES.md', 'LICENSE'}
DIRECTORIES = {'addon', 'bridge', 'scripts', 'test', 'docs', '.github'}
EXTENSIONS = {'.swift', '.ps1', '.js', '.mjs', '.json', '.py', '.md', '.sh', '.yml', '.yaml', '.txt'}


def user_data_dir(environ=None, platform=None, home=None):
    """Pure path selection; never creates or migrates a directory."""
    environ = os.environ if environ is None else environ
    platform = sys.platform if platform is None else platform
    home = Path.home() if home is None else Path(home)
    if platform == 'win32':
        environ = {key.upper(): value for key, value in environ.items()}
    override = environ.get('PAPER_CHAT_DATA_DIR')
    if override:
        return Path(override).resolve()
    if platform == 'win32':
        return Path(environ.get('APPDATA') or home / 'AppData' / 'Roaming') / 'Zotero Paper Chat'
    if platform == 'darwin':
        return home / 'Library' / 'Application Support' / 'Zotero Paper Chat'
    xdg = environ.get('XDG_DATA_HOME')
    return (Path(xdg) if xdg and Path(xdg).is_absolute() else home / '.local' / 'share') / 'Zotero Paper Chat'


def inside(path, directory):
    try:
        path.resolve().relative_to(directory.resolve())
        return True
    except ValueError:
        return False


def private_path(relative):
    """Exclude old data trees as well as the currently selected data directory."""
    parts = [part.casefold() for part in relative.parts]
    if any(part in {'node_modules', '__pycache__', 'runtime', 'conversations', 'backups', 'migrations', '.git'} for part in parts):
        return True
    return any(part == 'config.json' or part.startswith('config.json.') for part in parts) or relative.as_posix() == 'addon/config.js'


def project_files(root):
    files = []
    # Traverse allowed directories only: tmp/ may contain a complete Zotero library.
    candidates = [root / name for name in ROOT_FILES if (root / name).exists()]
    private_directory = user_data_dir()
    for name in DIRECTORIES:
        folder = root / name
        if folder.exists() and not inside(folder, private_directory):
            # Prune rather than walk the user's private data, including when a
            # CI override happens to live inside an otherwise public folder.
            for current, dirs, names in os.walk(folder, followlinks=False):
                dirs[:] = [name for name in dirs
                           if not private_path((Path(current) / name).relative_to(root))
                           and not inside(Path(current) / name, private_directory)]
                candidates.extend(Path(current) / name for name in names)
    for path in sorted(candidates):
        rel = path.relative_to(root)
        if inside(path, private_directory):
            continue
        if private_path(rel):
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
    for private in {root / 'bridge/config.json', user_data_dir() / 'config.json'}:
        if private.exists():
            try:
                config = json.loads(private.read_text(encoding='utf-8'))
            except (ValueError, OSError):
                raise ValueError('无法读取本机配置，已停止发布检查。') from None
            if not isinstance(config, dict):
                raise ValueError('本机配置格式错误，已停止发布检查。')
            external = config.get('external', {})
            forbidden.extend(value for value in [config.get('token'), external.get('apiKey') if isinstance(external, dict) else None]
                             if isinstance(value, str) and value)
    for path in files:
        text = path.read_text(encoding='utf-8')
        if any(value in text for value in forbidden):
            raise ValueError('发布检查发现本机路径或凭据，文件：' + path.relative_to(root).as_posix())


if __name__ == '__main__':
    root = Path(__file__).resolve().parent.parent
    files = project_files(root)
    audit_files(root, files)
    print(f'发布检查通过：{len(files)} 个文件，无本机配置、已知密钥或个人绝对路径。')
