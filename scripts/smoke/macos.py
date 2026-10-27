"""Real macOS desktop smoke, restricted to disposable GitHub runners."""
import hashlib
import json
import os
from pathlib import Path
import plistlib
import shlex
import shutil
import subprocess
import sys
import time
import urllib.request

if sys.platform != 'darwin' or os.environ.get('GITHUB_ACTIONS') != 'true':
    raise SystemExit('Run only in an authorized disposable macOS GitHub runner')
repo = Path.cwd()
root = Path(os.environ['RUNNER_TEMP']) / "paper-chat 中文 & 100% ! 'smoke"
root.mkdir()
evidence = repo / 'dist/macos-smoke-evidence'
evidence.mkdir(parents=True)
proc = None
mounts = []
config = json.loads((repo / 'bridge/config.json').read_text())
def call(args, **kwargs):
    return subprocess.run(args, check=True, timeout=90, **kwargs)
def apple(code):
    return call(['osascript', '-e', code], capture_output=True, text=True).stdout
try:
    url = 'https://download.zotero.org/client/release/10.0.6/Zotero-10.0.6.dmg'
    dmg = root / 'zotero.dmg'
    call(['curl', '-fL', '--max-time', '80', url, '-o', str(dmg)], stdout=subprocess.DEVNULL)
    attached = plistlib.loads(call(['hdiutil', 'attach', '-readonly', '-nobrowse', '-plist', str(dmg)], capture_output=True).stdout)
    mounts = [Path(e['mount-point']) for e in attached['system-entities'] if 'mount-point' in e]
    app = root / 'Zotero.app'
    call(['ditto', str(next(m for m in mounts if (m / 'Zotero.app').exists()) / 'Zotero.app'), str(app)])
    call(['codesign', '--verify', '--deep', '--strict', str(app)])
    signature = call(['codesign', '-dv', '--verbose=2', str(app)], capture_output=True, text=True).stderr
    (evidence / 'environment.json').write_text(json.dumps({'source': url, 'sha256': hashlib.sha256(dmg.read_bytes()).hexdigest(), 'signature': signature, 'os': apple('system version of (system info)')}, indent=2))
    for mount in mounts: call(['hdiutil', 'detach', str(mount)])
    mounts = []
    call([sys.executable, 'scripts/smoke/prepare.py', str(root), str(repo)])
    fixture = root / 'mock-codex'
    fixture.write_text('#!/bin/sh\nexec ' + shlex.quote(shutil.which('node')) + ' ' + shlex.quote(str(repo / 'scripts/smoke/mock-codex.mjs')) + ' "$@"\n')
    fixture.chmod(0o700)
    env = dict(os.environ, PAPER_CHAT_CODEX=str(fixture))
    # Generated .command starts the actual bridge, using only ephemeral config.
    manual = subprocess.Popen([str(repo / '启动伴读服务.command')], env=env, stdout=(root/'manual.txt').open('w'), stderr=subprocess.STDOUT)
    def request(path):
        req = urllib.request.Request(config['url'] + path) if 'url' in config else urllib.request.Request('http://127.0.0.1:' + str(config['port']) + path)
        req.add_header('Authorization', 'Bearer ' + config['token'])
        return json.load(urllib.request.urlopen(req, timeout=3))
    end = time.monotonic() + 30
    while True:
        try:
            status = request('/status')
            if status.get('ok') and status.get('model') == 'gpt-smoke-mock': break
        except Exception: pass
        if time.monotonic() > end: raise RuntimeError('Manual .command bridge startup failed')
        time.sleep(.25)
    (evidence/'manual-start.json').write_text(json.dumps({'success':True,'method':'generated .command executed as executable, real bridge and mock CLI'}))
    req = urllib.request.Request('http://127.0.0.1:' + str(config['port']) + '/shutdown', data=b'{}', headers={'Authorization':'Bearer '+config['token'],'Content-Type':'application/json'})
    urllib.request.urlopen(req, timeout=3).close()
    manual.wait(timeout=10)
    clicker = root / 'native-click'
    call(['swiftc', 'scripts/smoke/click.swift', '-o', str(clicker)])
    proc = subprocess.Popen([str(app/'Contents/MacOS/zotero'), '-no-remote', '-profile', str(root/'profile'), '-ZoteroDebugText'], env=env, stdout=(root/'stdout.txt').open('w'), stderr=(root/'stderr.txt').open('w'))
    time.sleep(15)
    apple('tell application "System Events"\n tell process "Zotero"\n set frontmost to true\n click menu item "Run JavaScript" of menu 1 of menu item "Developer" of menu 1 of menu bar item "Tools" of menu bar 1\n end tell\nend tell')
    code = 'var s={Zotero,Services,IOUtils,PathUtils,ChromeUtils,setTimeout}; Services.scriptloader.loadSubScript(Services.io.newFileURI(Zotero.File.pathToFile(' + json.dumps(str(repo/'scripts/smoke/harness/bootstrap.js')) + ')).spec,s); s.run(' + json.dumps(str(root)) + ').catch(e=>Zotero.logError(e));'
    call(['pbcopy'], input=code.encode())
    apple('tell application "System Events" to keystroke "v" using command down')
    time.sleep(1)
    apple('tell application "System Events" to keystroke "r" using command down')
    result = None
    last = 0
    end = time.monotonic()+240
    while time.monotonic()<end:
        time.sleep(1)
        try: result=json.loads((root/'result.json').read_text())
        except (OSError,json.JSONDecodeError): continue
        if result.get('error') or result.get('success'): break
        action=result.get('action',{})
        if action.get('id',0)>last:
            x,y=int(action['x']),int(action['y'])
            call([str(clicker), str(x), str(y)])
            if action['type']=='send-question': apple('tell application "System Events" to key code 36 using command down')
            last=action['id']
    if not result or not result.get('success'): raise RuntimeError('Desktop smoke failed: '+str(result))
except Exception as error:
    (evidence/'host-error.json').write_text(json.dumps({'error':str(error), 'stderr':getattr(error, 'stderr', None)},indent=2))
    raise
finally:
    subprocess.run(['screencapture','-x',str(evidence/'desktop.png')], timeout=15)
    subprocess.run(['pbcopy'],input=b'',timeout=5)
    if (root/'result.json').exists(): shutil.copy(root/'result.json',evidence)
    for name in ['stdout.txt','stderr.txt','manual.txt']:
        if (root/name).exists(): (evidence/name).write_text((root/name).read_text(errors='replace').replace(config['token'],'[REDACTED TEST TOKEN]'))
    if proc: proc.terminate()
    for mount in mounts: subprocess.run(['hdiutil','detach',str(mount)],timeout=15)
    try:
        req=urllib.request.Request('http://127.0.0.1:'+str(config['port'])+'/shutdown',data=b'{}',headers={'Authorization':'Bearer '+config['token'],'Content-Type':'application/json'})
        urllib.request.urlopen(req,timeout=3).close()
    except Exception: pass
