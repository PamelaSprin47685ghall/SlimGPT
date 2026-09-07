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
  for (let index = 0; index < (selection?.rangeCount || 0); index += 1) {
    ranges.push(selection.getRangeAt(index).cloneRange());
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
    if (!document.execCommand('copy')) throw new Error('复制失败，请手动选择并复制');
  } finally {
    textarea.remove();
    if (active?.isConnected) {
      active.focus?.({ preventScroll: true });
      if (inputSelection) active.setSelectionRange?.(...inputSelection);
    }
    if (selection && ranges.length) {
      selection.removeAllRanges();
      for (const range of ranges) selection.addRange(range);
    }
  }
}
