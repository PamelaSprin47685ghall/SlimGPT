// Exact-origin helpers shared by the page hook and the isolated bridge.

/**
 * Origin of a URL, including non-special schemes such as
 * `chrome-extension://id/` and `moz-extension://uuid/` (where some URL
 * implementations report `"null"`). Returns null when unparsable.
 * @param {unknown} url
 * @returns {string|null}
 */
export function originOf(url) {
  try {
    const parsed = new URL(String(url));
    if (parsed.origin && parsed.origin !== 'null') return parsed.origin;
    if (!parsed.host) return null;
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return null;
  }
}

/**
 * True for a bare WebExtension origin (`<browser>-extension://<id>`), no path.
 * @param {unknown} origin
 */
export function isExtensionOrigin(origin) {
  return typeof origin === 'string' && /^[a-z][a-z0-9+.-]*-extension:\/\/[A-Za-z0-9._-]+$/.test(origin);
}

/**
 * Accept a window `message` event only from `expectedSource` at exactly
 * `expectedOrigin`. Both must be provided; an unknown origin never matches.
 * @param {{ source: unknown, origin: unknown }} event
 * @param {unknown} expectedSource
 * @param {string|null|undefined} expectedOrigin
 */
export function isFromExactly(event, expectedSource, expectedOrigin) {
  return Boolean(
    event &&
    expectedSource &&
    typeof expectedOrigin === 'string' &&
    expectedOrigin &&
    expectedOrigin !== 'null' &&
    event.source === expectedSource &&
    event.origin === expectedOrigin,
  );
}
