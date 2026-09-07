/** The raw view never parses an already-serialized payload. */
export function formatRawToolPayload(payload) {
  if (typeof payload === 'string') return payload;
  try {
    return JSON.stringify(payload, null, 2) ?? String(payload);
  } catch {
    return String(payload);
  }
}
