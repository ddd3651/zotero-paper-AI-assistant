import { readFileSync } from 'node:fs';
const data = JSON.parse(readFileSync(new URL('../addon/ui-text.json', import.meta.url), 'utf8'));
export function t(key, values = {}) {
  const template = key.split('.').reduce((value, part) => value?.[part], data);
  if (typeof template !== 'string') throw new Error('Missing interface text: ' + key);
  return template.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (match, name) =>
    Object.hasOwn(values, name) ? String(values[name]) : match);
}
