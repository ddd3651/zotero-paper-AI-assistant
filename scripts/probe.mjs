import { CodexClient } from '../bridge/codex.mjs';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
const configFile = fileURLToPath(new URL('../bridge/config.json', import.meta.url));
const config = existsSync(configFile) ? JSON.parse(readFileSync(configFile, 'utf8')) : {};
const client = new CodexClient({ cwd: fileURLToPath(new URL('../bridge', import.meta.url)), networkProxy: config.codexNetworkProxy || '' });
try {
  console.log('登录验证：', JSON.stringify(await client.start()));
  const models = await client.call('model/list', {});
  console.log('可用模型：', models.data.map(m => ({ id: m.id, model: m.model, isDefault: m.isDefault })));
  const result = await client.ask({
    model: models.data.find(m => m.isDefault)?.model,
    instructions: '你是本地 Zotero 集成的连接测试助手，只回答用户要求的内容，不调用工具。',
    prompt: '这是连接测试。只回复：ZOTERO_CODEX_OK',
  });
  console.log('真实回答：', result.text);
  await client.release(result.threadId);
} catch (error) {
  console.error('验证失败：', error.message);
  process.exitCode = 1;
} finally { client.close(); }
