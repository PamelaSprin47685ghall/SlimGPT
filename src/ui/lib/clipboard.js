// Clipboard write with a textarea fallback (Firefox Android without
// clipboard-write permission, or non-secure test contexts).
export async function copyText(text) {
  const value = String(text ?? '');
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // fall through to the legacy path
  }
  const area = document.createElement('textarea');
  area.value = value;
  area.setAttribute('readonly', '');
  area.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
  document.body.append(area);
  area.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  area.remove();
  if (!ok) throw new Error('copy failed');
  return true;
}

/** Copy and show 已复制/复制失败 on a button for a moment. */
export async function copyWithFeedback(button, text, idleLabel = '复制') {
  let ok = false;
  try { ok = await copyText(text); } catch { ok = false; }
  if (!button?.isConnected) return ok;
  button.textContent = ok ? '已复制' : '复制失败';
  button.classList.toggle('copied', ok);
  clearTimeout(button._copyTimer);
  button._copyTimer = setTimeout(() => {
    button.textContent = idleLabel;
    button.classList.remove('copied');
  }, 2000);
  return ok;
}
