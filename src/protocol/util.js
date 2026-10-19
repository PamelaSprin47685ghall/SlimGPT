// Small pure helpers shared by the protocol modules. No DOM, no globals.

/** @param {unknown} value @returns {value is Record<string, any>} */
export const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** @param {unknown} value @returns {string} */
export const str = (value) => (typeof value === 'string' ? value : '');

/** First non-empty string among the arguments, else ''. */
export function firstString(...values) {
  for (const value of values) if (typeof value === 'string' && value) return value;
  return '';
}

/** @param {unknown} value @returns {number|null} */
export const finiteOrNull = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/** JSON-safe deep copy that never throws (cycles/BigInt become null). */
export function safeClone(value) {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return null;
  }
}

/** JSON.stringify that never throws. */
export function safeStringify(value, space = 2) {
  try {
    const text = JSON.stringify(value, null, space);
    return typeof text === 'string' ? text : '';
  } catch {
    return '';
  }
}

/** Parse JSON text, returning `fallback` instead of throwing. */
export function safeJsonParse(text, fallback = undefined) {
  if (typeof text !== 'string') return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/** Only absolute http(s) URLs supplied by the server are kept. */
export function safeHttpUrl(value) {
  if (typeof value !== 'string' || !value) return null;
  const trimmed = value.trim();
  if (!/^https?:\/\//i.test(trimmed)) return null;
  try {
    const url = new URL(trimmed);
    return url.protocol === 'http:' || url.protocol === 'https:' ? trimmed : null;
  } catch {
    return null;
  }
}
