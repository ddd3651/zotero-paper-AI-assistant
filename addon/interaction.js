/* Clipboard handling for HTML embedded in Zotero's chrome window. */
var PaperChatInteraction = {
  editable(target) { return target?.closest?.('textarea,input:not([type=range]):not([type=checkbox]),[contenteditable=true]'); },
  selected(state, target) {
    const selection = state.panel.ownerDocument.defaultView.getSelection();
    if (selection?.rangeCount && !selection.isCollapsed && state.panel.contains(selection.anchorNode) && state.panel.contains(selection.focusNode)) {
      return selection.toString();
    }
    const edit = this.editable(target);
    if (edit && typeof edit.selectionStart === 'number') return edit.value.slice(edit.selectionStart, edit.selectionEnd);
    return '';
  },
  transcript(state) {
    return state.messages.map(entry => `## ${entry.role === 'user' ? PaperChatText.t("common.you") : PaperChatText.t("common.ai")}\n\n${entry.text}`).join('\n\n---\n\n');
  },
  copyIcon(button, copied = false) {
    const doc = button.ownerDocument;
    const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('width', '16'); svg.setAttribute('height', '16');
    svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.7'); svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    const path = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', copied ? 'm5 12 4 4L19 6' : 'M9 9h11v11H9z M15 5V3H3v12h2');
    svg.append(path); button.replaceChildren(svg);
  },
  copy(state, text, button) {
    if (!text) return;
    try {
      Zotero.Utilities.Internal.copyTextToClipboard(String(text));
      if (button) {
        const original = button._pcCopyLabel || button.getAttribute('aria-label') || PaperChatText.t("copy.answer");
        button._pcCopyLabel = original;
        this.copyIcon(button, true);
        button.setAttribute('aria-label', PaperChatText.t("copy.copied"));
        if (button._pcCopyTimer) state.panel.ownerDocument.defaultView.clearTimeout(button._pcCopyTimer);
        button._pcCopyTimer = state.panel.ownerDocument.defaultView.setTimeout(() => {
          if (state.disposed) return;
          this.copyIcon(button); button.setAttribute('aria-label', original);
        }, 1200);
      }
    } catch (error) { state.error.textContent = PaperChatText.t("interaction.text01") + error.message; }
  },
  mount(plugin, state, head) {
    const doc = state.panel.ownerDocument, win = doc.defaultView;
    state.log.tabIndex = 0;
    state.log.setAttribute('aria-label', PaperChatText.t("interaction.text02"));
    const popup = doc.createXULElement('menupopup');
    (doc.querySelector('popupset') || doc.documentElement).append(popup);
    const keydown = event => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === 'c') {
        const text = this.selected(state, event.target);
        if (!text) return;
        event.preventDefault(); event.stopPropagation();
        this.copy(state, text);
      } else if (key === 'a' && !this.editable(event.target) && state.log.contains(event.target)) {
        event.preventDefault(); event.stopPropagation();
        const range = doc.createRange(); range.selectNodeContents(state.log);
        const selection = win.getSelection(); selection.removeAllRanges(); selection.addRange(range);
      }
    };
    const contextmenu = event => {
      // Native text-field menus already support undo, cut, copy, paste and selection.
      if (this.editable(event.target)) return;
      event.preventDefault(); event.stopPropagation();
      const selection = this.selected(state, event.target);
      const message = event.target.closest?.('.pc-message');
      const body = message?.querySelector('.pc-markdown,.pc-plain');
      popup.replaceChildren();
      const item = (label, text) => {
        const node = doc.createXULElement('menuitem');
        node.setAttribute('label', label); node.disabled = !text;
        node.addEventListener('command', () => this.copy(state, text)); popup.append(node);
      };
      item(PaperChatText.t("copy.selection"), selection);
      if (body?._paperChatEntry) item(PaperChatText.t("copy.message"), body._paperChatEntry.text);
      item(PaperChatText.t("copy.conversation"), this.transcript(state));
      popup.openPopupAtScreen(event.screenX, event.screenY, true);
    };
    state.panel.addEventListener('keydown', keydown, true);
    state.panel.addEventListener('contextmenu', contextmenu);
    const selectionchange = () => {
      if (state.disposed) return;
      const selection = win.getSelection();
      for (const node of state.log.querySelectorAll('.pc-markdown')) {
        if (node._pcPendingRender == null || selection && !selection.isCollapsed &&
          (node.contains(selection.anchorNode) || node.contains(selection.focusNode))) continue;
        const text = node._pcPendingRender; node._pcPendingRender = null;
        plugin.render(state, node, text);
      }
    };
    doc.addEventListener('selectionchange', selectionchange);
    state.interactionCleanup = () => {
      if (state.activityTimer) win.clearInterval(state.activityTimer);
      state.panel.removeEventListener('keydown', keydown, true);
      state.panel.removeEventListener('contextmenu', contextmenu);
      doc.removeEventListener('selectionchange', selectionchange);
      popup.hidePopup(); popup.remove();
    };
  },
  message(plugin, state, body, wrap) {
    if (body._paperChatEntry.role !== 'assistant') return;
    const footer = plugin.el(body.ownerDocument, 'div', null, 'pc-message-actions');
    const copy = plugin.el(body.ownerDocument, 'button', null, 'pc-copy-message');
    copy.title = PaperChatText.t("copy.answer"); copy.setAttribute('aria-label', PaperChatText.t("copy.answer"));
    this.copyIcon(copy);
    copy.addEventListener('click', () => this.copy(state, body._paperChatEntry.text, copy));
    footer.append(copy); wrap.append(footer);
  },
  duration(ms) {
    const seconds = Math.max(0, Math.floor(ms / 1000));
    return seconds < 60 ? PaperChatText.t("interaction.format01", {seconds: (seconds)}) : PaperChatText.t("interaction.format02", {value1: (Math.floor(seconds / 60)), value2: (seconds % 60)});
  },
  activity(plugin, state, body) {
    const doc = body.ownerDocument;
    const details = plugin.el(doc, 'details', null, 'pc-activity');
    const label = plugin.el(doc, 'summary', PaperChatText.t("activity.preparing"));
    label.title = PaperChatText.t("interaction.text03");
    const summary = plugin.el(doc, 'div', PaperChatText.t("interaction.text04"), 'pc-reasoning-summary pc-markdown');
    const searchInfo = plugin.el(doc, 'div', '', 'pc-search-info'); searchInfo.hidden = true;
    details.append(label, searchInfo, summary); body.before(details);
    body._pcActivity = { details, label, summary, searchInfo };
    label.addEventListener('click', () => { body._pcActivity.userToggled = true; });
    return body._pcActivity;
  },
  progress(plugin, state, body, job) {
    const ui = body._pcActivity || this.activity(plugin, state, body);
    const entry = body._paperChatEntry;
    if (job) {
      entry.activity = { startedAt: job.startedAt, firstTextAt: job.firstTextAt,
        finishedAt: job.finishedAt, status: job.status, summary: job.summary || '', searches: job.searches || [] };
    }
    const data = entry.activity || { startedAt: Date.now(), status: 'running' };
    const end = data.finishedAt || Date.now();
    const elapsed = this.duration(end - data.startedAt);
    const thinking = this.duration((data.firstTextAt || end) - data.startedAt);
    const running = data.status === 'running';
    const searching = data.searches?.some(item => item.status === 'searching');
    const phase = running ? (searching ? PaperChatText.t("activity.searching") : data.firstTextAt ? PaperChatText.t("activity.generating") : PaperChatText.t("activity.thinking")) :
      data.status === 'completed' ? PaperChatText.t("activity.completed") : data.status === 'cancelled' ? PaperChatText.t("activity.stopped") : PaperChatText.t("activity.failed");
    ui.label.textContent = `${phase} · ${elapsed}${data.firstTextAt ? PaperChatText.t("interaction.format03", {thinking: (thinking)}) : ''}`;
    if (ui.searchInfo) {
      ui.searchInfo.hidden = !data.searches?.length;
      ui.searchInfo.textContent = data.searches?.length ? PaperChatText.t("interaction.format04", {value1: (data.searches.length), value2: (data.searches.at(-1).query || PaperChatText.t("interaction.text05"))}) : '';
    }
    const summaryText = data.summary || (running ? PaperChatText.t("interaction.text06") : PaperChatText.t("interaction.text07"));
    if (ui.lastSummary !== summaryText) {
      if (data.summary) ui.summary.replaceChildren(PaperChatMarkdown.render(ui.summary.ownerDocument, summaryText));
      else ui.summary.textContent = summaryText;
      ui.lastSummary = summaryText;
    }
    if (data.summary && !ui.receivedSummary) {
      ui.receivedSummary = true;
      if (running && !ui.userToggled) ui.details.open = true;
    }
    if (!running && !ui.userToggled) ui.details.open = false;
    ui.details.dataset.status = data.status;
    if (running) state.status.textContent = PaperChatText.t("interaction.format05", {phase: (phase), elapsed: (elapsed)});
  },
};
