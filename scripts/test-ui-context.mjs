import vm from 'node:vm';
import { readFileSync } from 'node:fs';
export function createUIContext(globals = {}, text) {
  const scope = vm.createContext(globals);
  vm.runInContext(readFileSync(new URL('../addon/ui-text.js', import.meta.url), 'utf8'), scope);
  const data = text ?? JSON.parse(readFileSync(new URL('../addon/ui-text.json', import.meta.url), 'utf8'));
  vm.runInContext('PaperChatText.configure(' + JSON.stringify(data) + ')', scope);
  return scope;
}
