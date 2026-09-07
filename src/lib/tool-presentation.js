import { formatRawToolPayload } from './tool-payload.js';

export function createToolFormatterLoader(importer = () => import('./tool-format.js')) {
  let pending = null;
  return () => {
    if (!pending) pending = Promise.resolve().then(importer).catch((error) => {
      pending = null;
      throw error;
    });
    return pending;
  };
}

export const loadToolFormatter = createToolFormatterLoader();

export function presentToolPayload(payload, { formatter = null, raw = false } = {}) {
  if (formatter && !raw) {
    try {
      const text = formatter.formatToolPayloadAsToml(payload);
      return { format: 'TOML', text, html: formatter.highlightToml(text), failed: false };
    } catch {
      // Formatting is optional presentation. Failure must never take down a
      // conversation or replace its payload with an empty/error-only bubble.
      return { format: 'RAW', text: formatRawToolPayload(payload), html: '', failed: true };
    }
  }
  return { format: 'RAW', text: formatRawToolPayload(payload), html: '', failed: false };
}

export function extractToolCallIds(tool, message = null) {
  const ids = [
    tool?.callId,
    tool?.toolCallId,
    ...(tool?.callIds || []),
    message?.callId,
    message?.toolCallId,
    ...(message?.callIds || []),
  ].filter((id) => typeof id === 'string' && id.trim());
  return [...new Set(ids)];
}
