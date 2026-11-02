import { capacityFromMetadata } from './reading.mjs';
// Capacity hints are optional. Never infer a provider's limit from a model name.
export function reportedContextWindow(value) {
  const n = capacityFromMetadata(value);
  return Number.isSafeInteger(n) && n >= 4096 && n <= 2000000 ? n : null;
}

export function contextFailure(error) {
  if (error?.contextOverflow === true) return { overflow: true, capacity: error.contextCapacity || null };
  const text = String(error?.message || error || '');
  const overflow = /context[_ -]?(?:length|window)[_ -]?exceeded|maximum context length|context window.{0,40}(?:exceed|limit|full)|(?:ran out of|not enough) room.{0,80}context|prompt (?:is )?too long|input.{0,40}exceeds.{0,30}(?:context|token)|上下文.{0,12}(?:超出|超限|超过)/i.test(text);
  if (!overflow) return { overflow: false, capacity: null };
  const match = text.match(/(?:maximum context length|context window|context[_ ](?:length|window)|max(?:imum)?[_ ](?:input[_ ])?tokens)[^\d\n]{0,40}([\d,]{4,})/i);
  const n = match ? Number(match[1].replaceAll(',', '')) : null;
  return { overflow: true, capacity: Number.isSafeInteger(n) && n >= 4096 && n <= 2000000 ? n : null };
}

export function effectiveContextBudget(requested, capacity) {
  if (!capacity || capacity >= requested.contextWindow) return { ...requested };
  const window = Math.max(4096, capacity);
  return { ...requested, contextWindow: window,
    outputReserve: Math.min(requested.outputReserve, Math.max(256, Math.floor(window * 0.2))),
    summaryTokens: Math.min(requested.summaryTokens, Math.max(256, Math.floor(window * 0.1))),
    recentTokens: Math.min(requested.recentTokens, Math.max(256, Math.floor(window * 0.2))) };
}
