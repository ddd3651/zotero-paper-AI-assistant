// Executed by the test-only Run JavaScript driver, not shipped in the product XPI.
async function run(root) {
  const result = { model: 'LOCAL MOCK ONLY; no user account or real model', checks: [], success: false };
  const save = () => IOUtils.writeUTF8(PathUtils.join(root, 'result.json'), JSON.stringify(result, null, 2));
  const check = async (name, fn, ms = 45000) => {
    const end = Date.now() + ms;
    let value;
    while (Date.now() < end) {
      try { value = await fn(); } catch (_) {}
      if (value) { result.checks.push(name); await save(); return value; }
      await Zotero.Promise.delay(250);
    }
    throw new Error('Timed out: ' + name);
  };
  let actionId = 0;
  const observed = new WeakSet();
  result.inputEvents = [];
  const action = async (type, node) => {
    for (const doc of [node.ownerDocument, Zotero.getMainWindow().document]) if (!observed.has(doc)) {
      observed.add(doc);
      for (const type of ['pointerdown', 'pointerup', 'click']) doc.addEventListener(type, event => {
        result.inputEvents.push({ action: actionId, type, trusted: event.isTrusted, target: event.target.outerHTML?.slice(0, 220) });
        result.inputEvents = result.inputEvents.slice(-12);
      }, true);
    }
    Zotero.getMainWindow().focus();
    node.scrollIntoView({ block: 'center' });
    await Zotero.Promise.delay(300);
    node.addEventListener('click', event => { result.lastClick = { action: actionId, trusted: event.isTrusted, label: node.textContent.slice(0, 80) }; save(); }, { once: true });
    const rect = node.getBoundingClientRect(), win = node.ownerDocument.defaultView;
    result.action = { id: ++actionId, type, x: Math.round(win.mozInnerScreenX + rect.x + rect.width / 2), y: Math.round(win.mozInnerScreenY + rect.y + rect.height / 2) };
    result.action.geometry = { connected: node.isConnected, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      windowDragging: win.getComputedStyle(node).getPropertyValue('-moz-window-dragging'), innerWidth: win.innerWidth, screenX: win.mozInnerScreenX, screenY: win.mozInnerScreenY,
      localHit: node.ownerDocument.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)?.outerHTML?.slice(0, 300),
      topHit: Zotero.getMainWindow().document.elementFromPoint(result.action.x - Zotero.getMainWindow().mozInnerScreenX, result.action.y - Zotero.getMainWindow().mozInnerScreenY)?.outerHTML?.slice(0, 300) };
    await save();
  };
  try {
    await save();
    await Zotero.initializationPromise;
    await check('Zotero main window initialized', () => Zotero.getMainWindow()?.ZoteroPane);
    result.zoteroVersion = Zotero.version;
    Zotero.getMainWindow().maximize();
    const { AddonManager } = ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');
    const config = JSON.parse(await IOUtils.readUTF8(PathUtils.join(root, 'harness.json')));
    const install = await AddonManager.getInstallForFile(Zotero.File.pathToFile(config.xpi));
    await install.install();
    await check('Unmodified product XPI installed and active', async () => (await AddonManager.getAddonByID('paper-chat@zotero-paper-chat.local'))?.isActive);
    const item = await Zotero.Attachments.importFromFile({ file: Zotero.File.pathToFile(config.pdf), libraryID: Zotero.Libraries.userLibraryID });
    let reader = await Zotero.Reader.open(item.id);
    await reader._initPromise;
    let panel = await check('Real PDF reader mounted product panel', () => reader._iframe.ownerDocument.querySelector('.paper-chat-panel'));
    await check('Plugin auto-started real bridge and discovered mock CLI', () => !panel.querySelector('.pc-model-trigger').disabled && panel.querySelector('.pc-model-trigger').textContent.includes('smoke-mock'));
    await check('Resize edge overrides native button limits and is hit-testable along the panel', () => {
      const handle = panel.querySelector('.pc-resize-panel');
      if (!handle) return false;
      const rect = handle.getBoundingClientRect(), bounds = panel.getBoundingClientRect();
      const style = handle.ownerDocument.defaultView.getComputedStyle(handle);
      return rect.width >= 6 && rect.height >= bounds.height * .95
        && style.maxHeight === 'none' && style.cursor === 'col-resize'
        && [.2, .5, .8].every(fraction => handle.ownerDocument.elementFromPoint(
          rect.x + rect.width / 2, rect.y + rect.height * fraction) === handle);
    });
    await check('DOM drag fallback tracks repeated moves through capture loss and relayout without snapback', async () => {
      const doc = panel.ownerDocument, win = doc.defaultView, handle = panel.querySelector('.pc-resize-panel');
      const rect = handle.getBoundingClientRect(), before = panel.getBoundingClientRect().width;
      const font = win.getComputedStyle(panel).fontSize, zoom = win.getComputedStyle(panel).zoom;
      const start = rect.x + rect.width / 2, sign = Number(win.getComputedStyle(panel).order) < 0 ? 1 : -1;
      const fire = (target, type, x) => target.dispatchEvent(new win.PointerEvent(type, {
        bubbles: true, cancelable: true, pointerId: 987654, pointerType: 'mouse', isPrimary: true,
        button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: x, clientY: rect.y + rect.height / 2,
      }));
      // Synthetic pointer capture is unavailable: this deliberately exercises the document fallback.
      fire(handle, 'pointerdown', start);
      let tracked = !!doc.querySelector('.pc-resize-overlay');
      try {
        for (const step of [...Array.from({ length: 20 }, (_, i) => i + 1), ...Array.from({ length: 20 }, (_, i) => 19 - i)]) {
          fire(doc, 'pointermove', start + sign * step * 2);
          if (step === 5) fire(handle, 'lostpointercapture', start + sign * step * 2);
          if (step === 10) win.dispatchEvent(new win.Event('resize'));
          await Zotero.Promise.delay(15);
          tracked &&= Math.abs(panel.getBoundingClientRect().width - before - step * 2) < 1.5;
        }
      } finally { fire(doc, 'pointerup', start); }
      return tracked && !doc.querySelector('.pc-resize-overlay')
        && Math.abs(panel.getBoundingClientRect().width - before) < 1.5
        && font === win.getComputedStyle(panel).fontSize && zoom === win.getComputedStyle(panel).zoom;
    });
    await check('Composer contracts progressively and restores controls without changing input or fonts', async () => {
      const doc = panel.ownerDocument, win = doc.defaultView;
      const area = panel.querySelector('.pc-input-area'), grip = panel.querySelector('.pc-resize-composer');
      const input = panel.querySelector('.pc-compose>textarea'), model = panel.querySelector('.pc-model-row');
      const hint = panel.querySelector('.pc-hint'), bottom = panel.querySelector('.pc-bottom');
      const status = panel.querySelector('.pc-context-status'), clear = panel.querySelector('.pc-clear');
      const font = win.getComputedStyle(input).fontSize, draft = input.value;
      const visible = node => win.getComputedStyle(node).display !== 'none' && node.getBoundingClientRect().height > 0;
      const fire = (target, type, y) => target.dispatchEvent(new win.PointerEvent(type, {
        bubbles: true, cancelable: true, pointerId: 987655, pointerType: 'mouse', isPrimary: true,
        button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: grip.getBoundingClientRect().x + 30, clientY: y,
      }));
      const samples = [];
      input.value = 'Synthetic resize draft.';
      try {
        for (const target of [240, 180, 140, 95, 240]) {
          const y = grip.getBoundingClientRect().y + 6;
          const scale = parseFloat(win.getComputedStyle(panel).zoom) || 1;
          fire(grip, 'pointerdown', y);
          fire(doc, 'pointermove', y + area.getBoundingClientRect().height - target * scale);
          fire(doc, 'pointerup', y);
          await Zotero.Promise.delay(60);
          const inputBounds = input.getBoundingClientRect(), bottomBounds = bottom.getBoundingClientRect();
          samples.push({ target, height: area.getBoundingClientRect().height,
            line: parseFloat(win.getComputedStyle(input).lineHeight), density: area.getAttribute('data-pc-density'),
            hint: visible(hint), model: visible(model), footer: visible(status) && visible(clear)
              && visible(panel.querySelector('.pc-settings-trigger')),
            ordered: inputBounds.bottom <= bottomBounds.top + 1
              && (!visible(model) || inputBounds.bottom <= model.getBoundingClientRect().top + 1),
            draft: input.value === 'Synthetic resize draft.', font: win.getComputedStyle(input).fontSize === font });
        }
        result.composerSamples = samples;
        return samples.every(sample => sample.footer && sample.ordered && sample.draft && sample.font)
          && samples[0].hint && samples[0].model && !samples[1].hint && samples[1].model
          && !samples[2].hint && !samples[2].model && samples[4].hint && samples[4].model
          && samples[0].line > samples[1].line && samples[1].line > samples[2].line
          && samples[2].line >= samples[3].line && samples[3].height < samples[0].height;
      } finally { input.value = draft; }
    });
    reader.close();
    await check('Reader closes without leaving a live PDF tab', () => !Zotero.Reader._readers.includes(reader));
    reader = await Zotero.Reader.open(item.id);
    await reader._initPromise;
    panel = await check('Reopened reader mounts exactly one ready panel', () => {
      const panels = reader._iframe.ownerDocument.querySelectorAll('.paper-chat-panel');
      return panels.length === 1 && !panels[0].querySelector('.pc-model-trigger').disabled && panels[0];
    });
    for (let i = 0; i < 2; i++) {
      const toggle = reader._iframeWindow.document.querySelector('[data-paper-chat-toggle]');
      if (!toggle) throw new Error('Reader toolbar toggle missing');
      await action('click', toggle);
      await check('Toolbar hides panel cycle ' + (i + 1), () => panel.hidden);
      await action('click', reader._iframeWindow.document.querySelector('[data-paper-chat-toggle]'));
      await check('Toolbar reopens panel cycle ' + (i + 1), () => !panel.hidden);
    }
    const input = panel.querySelector('textarea[aria-label="向AI提问"]');
    input.value = '总结全文';
    await action('send-question', input);
    const answer = await check('Native modifier+Enter sent extracted PDF through real bridge to mock CLI', () => {
      const node = [...panel.querySelectorAll('.pc-markdown')].find(n => n.textContent.includes('MOCK RESPONSE'));
      return node?.textContent.includes('MOCK RESPONSE') && node;
    });
    await check('Markdown table and math rendered in Zotero', () => answer.querySelector('table') && answer.querySelector('math'));
    const citation = await check('Page citation rendered', () => answer.querySelector('.pc-cite'));
    await action('click', citation);
    await check('Citation navigated real PDF to page two', () => {
      const win = reader._internalReader?._primaryView?._iframeWindow;
      const app = win?.PDFViewerApplication || win?.wrappedJSObject?.PDFViewerApplication;
      return app?.pdfViewer?.currentPageNumber === 2;
    });
    await check('Citation scrolls matching source text into the visible PDF viewport', () => {
      const doc = reader._internalReader._primaryView._iframeWindow.document;
      const layer = doc.querySelector('[data-paper-chat-highlight]');
      const viewport = doc.getElementById('viewerContainer').getBoundingClientRect();
      return layer?.children.length && [...layer.children].some(node => {
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && rect.bottom > viewport.top && rect.top < viewport.bottom
          && rect.right > viewport.left && rect.left < viewport.right;
      });
    });
    await action('click', panel.querySelector('.pc-settings-trigger'));
    await check('Settings panel opens', () => !panel.querySelector('.pc-settings-menu').hidden);
    await action('click', panel.querySelector('[role=tab][aria-controls$="-prompt-panel"]'));
    await check('Prompt settings tab opens', () => panel.querySelector('.pc-prompt-input').closest('[role=tabpanel]').hidden === false);
    const prompt = panel.querySelector('.pc-prompt-input');
    prompt.value = 'Synthetic regression prompt; no real model.';
    prompt.dispatchEvent(new prompt.ownerDocument.defaultView.Event('input', { bubbles: true }));
    await action('click', [...panel.querySelectorAll('.pc-settings-menu button')].find(n => n.textContent === '保存提示词'));
    await check('Custom prompt saved through real settings endpoint', () => panel.querySelector('.pc-prompt-status').textContent === '自定义提示词已保存');
    await action('click', panel.querySelector('.pc-settings-title button'));
    await check('Settings panel closes', () => panel.querySelector('.pc-settings-menu').hidden);
    answer.scrollIntoView({ block: 'start' });
    await Zotero.Promise.delay(1000);
    result.success = true;
  } catch (error) {
    result.error = String(error.message || error) + '\n' + (error.stack || '');
    const panel = Zotero.getMainWindow()?.document.querySelector('.paper-chat-panel');
    result.panelHTML = panel?.outerHTML || '';
    result.panelError = panel?.querySelector('.pc-error')?.textContent || '';
    result.panelStatus = panel?.querySelector('.pc-status')?.textContent || '';
  }
  await save();
  // Remain open briefly so the host captures the actual desktop before cleanup.
}
