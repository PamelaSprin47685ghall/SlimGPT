/** Copy exact text, falling back when iframe clipboard permissions reject. */
export async function copyText(value, environment = globalThis) {
  const text = String(value ?? '');
  try {
    if (environment.navigator?.clipboard?.writeText) {
      await environment.navigator.clipboard.writeText(text);
      return;
    }
  } catch {
    // The API can exist while permission is denied in an embedded extension.
  }

  const document = environment.document;
  if (!document?.body || typeof document.execCommand !== 'function') {
    throw new Error('无法访问剪贴板，请手动选择并复制');
  }
  const active = document.activeElement;
  const selection = document.getSelection?.();
  const ranges = [];
  if (selection && typeof selection.getRangeAt === 'function') {
    for (let index = 0; index < (selection.rangeCount || 0); index += 1) {
      try {
        ranges.push(selection.getRangeAt(index).cloneRange());
      } catch {}
    }
  }
  const inputSelection = active && typeof active.selectionStart === 'number'
    ? [active.selectionStart, active.selectionEnd, active.selectionDirection]
    : null;
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.readOnly = true;
  textarea.style.cssText = 'position:fixed;left:-10000px;top:0;opacity:0;pointer-events:none';
  textarea.setAttribute('aria-hidden', 'true');
  document.body.appendChild(textarea);
  try {
    textarea.focus({ preventScroll: true });
    textarea.select();
    let success = false;
    try {
      success = Boolean(document.execCommand('copy'));
    } catch {
      success = false;
    }
    if (!success) throw new Error('复制失败，请手动选择并复制');
  } finally {
    try { textarea.remove?.(); } catch { try { textarea.parentNode?.removeChild(textarea); } catch {} }
    if (active?.isConnected && typeof active.focus === 'function') {
      try {
        active.focus({ preventScroll: true });
      } catch {
        try { active.focus(); } catch {}
      }
      if (inputSelection && typeof active.setSelectionRange === 'function') {
        try {
          active.setSelectionRange(...inputSelection);
        } catch {}
      }
    }
    if (selection && ranges.length && typeof selection.removeAllRanges === 'function') {
      try {
        selection.removeAllRanges();
        for (const range of ranges) selection.addRange(range);
      } catch {}
    }
  }
}
