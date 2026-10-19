export function safeFileName(title, extension = 'md') {
  const base = String(title || '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'SlimGPT';
  return `${base}.${extension}`;
}

/**
 * Save text as a file via Blob + <a download>. No chrome.downloads (no extra
 * permission). The anchor carries `external` so Framework7's global click
 * handler (which preventDefault()s every other <a> click) leaves it alone.
 * Returns false when the browser did not start the download (click
 * prevented, Blob/URL unavailable); the caller then falls back.
 * @returns {boolean}
 */
export function downloadText(text, fileName, mime = 'text/markdown;charset=utf-8', doc = globalThis.document) {
  let url = '';
  try {
    url = URL.createObjectURL(new Blob([text], { type: mime }));
    const link = doc.createElement('a');
    link.href = url;
    link.download = fileName;
    link.rel = 'noopener';
    link.className = 'external';
    link.style.display = 'none';
    doc.body.append(link);
    const event = new MouseEvent('click', { bubbles: true, cancelable: true, view: doc.defaultView ?? null });
    const started = link.dispatchEvent(event);
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
    return started;
  } catch {
    if (url) try { URL.revokeObjectURL(url); } catch { /* ignore */ }
    return false;
  }
}
