import { t } from './ui-text.mjs';
function externalError(message) {
  const error = new Error(message);
  error.name = 'PaperChatExternalError';
  return error;
}
// OpenAI-compatible Chat Completions transport. Never follow redirects with credentials.
export function normalizeExternal(value = {}, current = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw externalError(t("errors.external.error01"));
  const result = { baseUrl: '', model: '', apiKey: '', ...current };
  for (const field of ['baseUrl', 'model', 'apiKey']) {
    if (!Object.hasOwn(value, field)) continue;
    if (typeof value[field] !== 'string' || value[field].length > (field === 'apiKey' ? 8192 : 2048)) throw externalError(t("errors.external.error01"));
    result[field] = value[field].trim();
  }
  if (result.baseUrl) {
    let url;
    try { url = new URL(result.baseUrl); } catch { throw externalError(t("errors.external.error02")); }
    if (url.username || url.password || url.search || url.hash ||
        !(url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
      throw externalError(t("errors.external.error03"));
    }
    result.baseUrl = url.href.replace(/\/+$/, '');
  }
  if (/[\r\n]/.test(result.apiKey)) throw externalError(t("errors.external.error04"));
  return { baseUrl: result.baseUrl, model: result.model, apiKey: result.apiKey };
}

export function publicExternal(value = {}) {
  return { baseUrl: value.baseUrl || '', model: value.model || '', hasApiKey: !!value.apiKey };
}

// Do not include upstream response bodies, URLs or raw transport errors in diagnostics.
export function redactError(error, keys = []) {
  let message = String(error?.message || t("errors.external.text01"));
  for (const key of keys.filter(Boolean)) message = message.split(key).join('[REDACTED]');
  return message.replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]');
}

export async function askExternal({ baseUrl, model, apiKey, messages, signal, onDelta,
  timeoutMs = 240000, stream = true, fetchImpl = fetch }) {
  const settings = normalizeExternal({ baseUrl, model, apiKey });
  if (!settings.baseUrl || !settings.model || !settings.apiKey) throw externalError(t("errors.external.error05"));
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  let reader;
  try {
    const response = await fetchImpl(settings.baseUrl + '/chat/completions', {
      method: 'POST', redirect: 'error', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.apiKey}` },
      body: JSON.stringify({ model: settings.model, messages, stream }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw externalError(t("errors.external.format01", {value1: (response.status)}));
    }
    let text = '';
    const append = value => { if (typeof value === 'string') { text += value; onDelta?.(value); } };
    if (/text\/event-stream/i.test(response.headers.get('content-type') || '')) {
      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '', data = [], done = false, finished = false;
      const event = () => {
        if (!data.length) return;
        const payload = data.join('\n'); data = [];
        if (payload === '[DONE]') { done = true; return; }
        const chunk = JSON.parse(payload);
        if (chunk.error) throw externalError(t("errors.external.error06"));
        const choice = chunk.choices?.[0];
        append(choice?.delta?.content);
        if (choice?.finish_reason) finished = true;
      };
      const line = value => {
        if (!value) event();
        else if (value.startsWith('data:')) data.push(value.slice(5).replace(/^ /, ''));
      };
      while (!done) {
        const part = await reader.read();
        buffer += decoder.decode(part.value, { stream: !part.done });
        let match;
        while ((match = /\r\n|\n|\r(?!$)/.exec(buffer))) {
          line(buffer.slice(0, match.index));
          buffer = buffer.slice(match.index + match[0].length);
          if (done) break;
        }
        if (part.done) { if (buffer) line(buffer.replace(/\r$/, '')); event(); break; }
      }
      if (!done && !finished) throw externalError(t("errors.external.error07"));
    } else {
      const result = await response.json();
      if (result.error || typeof result.choices?.[0]?.message?.content !== 'string') throw externalError(t("errors.external.error08"));
      append(result.choices[0].message.content);
    }
    if (controller.signal.aborted) throw new Error('aborted');
    return { text };
  } catch (error) {
    if (controller.signal.aborted) throw new Error(timedOut ? t("errors.external.text02") : t("errors.external.text03"));
    if (error.name === 'PaperChatExternalError') throw new Error(redactError(error, [apiKey]));
    throw externalError(t("errors.external.error09"));
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
}
