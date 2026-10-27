var PaperChat;
var PaperChatText;
var PaperChatCore;
var PaperChatConfig;
var PaperChatMarkdown;
var marked;
var katex;
var PaperChatMath;
var PaperChatEvidence;
var PaperChatReader;
var PaperChatSelection;
var PaperChatAppearance;
var PaperChatAPISettings;
var PaperChatInteraction;

function install() {}
function uninstall() {}

async function startup({ rootURI }) {
  Services.scriptloader.loadSubScript(rootURI + 'config.js', this);
  Services.scriptloader.loadSubScript(rootURI + 'ui-text.js', this);
  const { NetUtil } = ChromeUtils.importESModule('resource://gre/modules/NetUtil.sys.mjs');
  const textChannel = NetUtil.newChannel({ uri: rootURI + 'ui-text.json', loadUsingSystemPrincipal: true });
  PaperChatText.configure(JSON.parse(await Zotero.File.getContentsAsync(textChannel, 'UTF-8')));
  Services.scriptloader.loadSubScript(rootURI + 'core.js', this);
  Services.scriptloader.loadSubScript(rootURI + 'vendor/marked.umd.js', this);
  Services.scriptloader.loadSubScript(rootURI + 'vendor/katex.min.js', this);
  Services.scriptloader.loadSubScript(rootURI + 'math.js', this);
  Services.scriptloader.loadSubScript(rootURI + 'markdown.js', this);
  Services.scriptloader.loadSubScript(rootURI + 'evidence.js', this);
  Services.scriptloader.loadSubScript(rootURI + 'reader-tools.js', this);
  Services.scriptloader.loadSubScript(rootURI + 'selection.js', this);
  Services.scriptloader.loadSubScript(rootURI + 'appearance.js', this);
  Services.scriptloader.loadSubScript(rootURI + 'api-settings.js', this);
  Services.scriptloader.loadSubScript(rootURI + 'interaction.js', this);
  Services.scriptloader.loadSubScript(rootURI + 'panel.js', this);
  await PaperChat.start();
}

async function shutdown() {
  await PaperChat?.stop();
  PaperChat = null;
}
