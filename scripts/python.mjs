// npm invokes this through Node on every OS; do not require a python3 alias on Windows.
import { spawnSync } from 'node:child_process';
const candidates = process.platform === 'win32' ? [['py', '-3'], ['python'], ['python3']] : [['python3'], ['python']];
let selected;
for (const [command, ...prefix] of candidates) {
  const result = spawnSync(command, [...prefix, '-c', 'import sys; sys.exit(0 if sys.version_info >= (3,9) else 1)'], { stdio: 'ignore', windowsHide: true });
  if (!result.error && result.status === 0) { selected = [command, ...prefix]; break; }
}
if (!selected) {
  console.error('找不到 Python 3.9 或更新版本。请安装 Python 并重新打开终端。');
  process.exit(1);
}
const [command, ...prefix] = selected;
const result = spawnSync(command, [...prefix, ...process.argv.slice(2)], { stdio: 'inherit', windowsHide: true });
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
