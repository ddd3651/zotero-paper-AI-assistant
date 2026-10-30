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
    await check('Citation highlighted matching source text in the real PDF', () => {
      const layer = reader._internalReader._primaryView._iframeWindow.document.querySelector('[data-paper-chat-highlight]');
      return layer?.children.length && [...layer.children].some(n => n.getBoundingClientRect().width > 0);
    });
    await action('click', panel.querySelector('.pc-model-trigger'));
    await check('Settings panel opens', () => !panel.querySelector('.pc-settings-menu').hidden);
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
