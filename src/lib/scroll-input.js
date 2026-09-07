export function wheelDeltaPixels(event, viewportHeight, lineHeight = 20) {
  if (!event || event.defaultPrevented || event.ctrlKey || event.metaKey || event.shiftKey) return 0;
  const x = Number(event?.deltaX || 0);
  const y = Number(event?.deltaY || 0);
  if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > Math.abs(y)) return 0;
  const scale = event.deltaMode === 1 ? lineHeight : event.deltaMode === 2 ? Math.max(1, viewportHeight) : 1;
  return y * scale;
}

export function nestedScrollerCanConsume(target, boundary, delta, styleOf = globalThis.getComputedStyle) {
  if (!delta || !target || !boundary || typeof styleOf !== 'function') return false;
  let node = target.nodeType === 1 ? target : target?.parentElement;
  while (node && node !== boundary) {
    try {
      const style = styleOf(node);
      if (style && node.scrollHeight > node.clientHeight + 1 && /^(auto|scroll|overlay)$/.test(style.overflowY)) {
        const remaining = node.scrollHeight - node.clientHeight - node.scrollTop;
        if (delta < 0 ? node.scrollTop > 1 : remaining > 1) return true;
      }
    } catch {
      // Ignore uncomputable nodes
    }
    node = node.parentElement;
  }
  return false;
}
