"""Prepare synthetic data and an isolated profile; never uses a user library."""
import json
from pathlib import Path
import sys

root = Path(sys.argv[1]).resolve()
repo = Path(sys.argv[2]).resolve()
profile = root / 'profile'
(profile / 'extensions').mkdir(parents=True, exist_ok=True)
(root / 'data').mkdir(exist_ok=True)
# The harness is invoked using the documented Run JavaScript developer UI.
prefs = {
    'extensions.zotero.dataDir': str(root / 'data'),
    'extensions.zotero.useDataDir': True,
    'extensions.zotero.firstRun2': False,
    'extensions.zotero.showPostUpgradeBanner': False,
    'extensions.zotero.sync.autoSync': False,
    'extensions.zotero.automaticScraperUpdates': False,
    'app.update.auto': False,
    'extensions.update.enabled': False,
    'browser.shell.checkDefaultBrowser': False,
}
(profile / 'user.js').write_text('\n'.join('user_pref(' + json.dumps(k) + ', ' + json.dumps(v) + ');' for k,v in prefs.items()), encoding='utf-8')
# Minimal, valid two-page PDF made solely from synthetic ASCII text.
objects = [b'<< /Type /Catalog /Pages 2 0 R >>', b'<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>']
for i, word in enumerate(['one', 'two']):
    stream = ('BT /F1 18 Tf 60 700 Td (Synthetic paper page ' + word + '.) Tj ET').encode()
    objects.extend([f'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents {4+2*i} 0 R >>'.encode(), b'<< /Length ' + str(len(stream)).encode() + b' >>\nstream\n' + stream + b'\nendstream'])
objects.append(b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
pdf = bytearray(b'%PDF-1.4\n'); offsets = [0]
for i, obj in enumerate(objects, 1):
    offsets.append(len(pdf)); pdf.extend(f'{i} 0 obj\n'.encode() + obj + b'\nendobj\n')
xref = len(pdf); pdf.extend(f'xref\n0 {len(offsets)}\n0000000000 65535 f \n'.encode())
for offset in offsets[1:]: pdf.extend(f'{offset:010d} 00000 n \n'.encode())
pdf.extend(f'trailer\n<< /Size {len(offsets)} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n'.encode())
(root / 'synthetic.pdf').write_bytes(pdf)
(root / 'harness.json').write_text(json.dumps({'pdf': str(root / 'synthetic.pdf'), 'xpi': str(next((repo / 'dist').glob('*.xpi')))}), encoding='utf-8')
