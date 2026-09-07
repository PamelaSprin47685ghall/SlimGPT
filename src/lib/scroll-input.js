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
  // If target itself is the boundary scroller, do not treat it as a nested scroller
  if (node === boundary) return false;
  while (node && node !== boundary) {
    // Cheap checks first: getComputedStyle forces layout, so it must never run
    // on the hot wheel path for nodes that cannot scroll vertically.
    const scrollHeight = node.scrollHeight;
    const clientHeight = node.clientHeight;
    if (
      typeof scrollHeight === 'number' &&
      typeof clientHeight === 'number' &&
      scrollHeight > clientHeight + 1
    ) {
      if (
        node?.classList?.contains?.('table-wrap') &&
        typeof node.scrollWidth === 'number' &&
        typeof node.clientWidth === 'number' &&
        node.scrollWidth > node.clientWidth + 1
      ) {
        return false;
      }
      let scrollable = hasKnownVerticalScrollAffordance(node);
      if (!scrollable) {
        try {
          const style = styleOf(node);
          scrollable = Boolean(style) && /^(auto|scroll|overlay)$/.test(style.overflowY);
        } catch {
          // Ignore uncomputable nodes
        }
      }
      if (scrollable) {
        const remaining = scrollHeight - clientHeight - node.scrollTop;
        if (delta < 0 ? node.scrollTop > 1 : remaining > 1) return true;
      }
    }
    node = node.parentElement;
  }
  return false;
}

// Fast-path allowlist for the scroll containers this app actually renders.
// Matching nodes skip computed-style inspection; dimension + position checks
// above still apply. Anything without these markers falls back to styleOf.
const KNOWN_SCROLLABLE_CLASSES = new Set([
  'table-wrap',
  'message-content',
  'message-text',
  'markdown-body',
  'thought-content',
  'thought-content-wrapper',
  'tool-payload',
  'tool-content',
  'single-message-scroller',
  'conversation-turn-content',
  'overview-list',
]);

function hasKnownVerticalScrollAffordance(node) {
  try {
    // An explicitly clipped inline overflow always wins over the allowlist.
    const inlineOverflowY = node?.style?.overflowY;
    if (inlineOverflowY === 'hidden' || inlineOverflowY === 'visible' || inlineOverflowY === 'clip') return false;
    if (node?.tagName === 'PRE') return true;
    const list = node?.classList;
    if (!list || typeof list.contains !== 'function') return false;
    for (const name of KNOWN_SCROLLABLE_CLASSES) {
      if (list.contains(name)) return true;
    }
  } catch {
    // Ignore uncomputable nodes
  }
  return false;
}
