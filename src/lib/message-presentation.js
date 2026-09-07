const TERMINAL_STATUSES = new Set([
  'finished_successfully', 'finished', 'completed', 'failed', 'error',
  'cancelled', 'canceled', 'interrupted', 'incomplete', 'stopped', 'aborted',
]);

export function isTerminalMessage(message) {
  return message?.endTurn === true || message?.end_turn === true ||
    TERMINAL_STATUSES.has(String(message?.status || '').toLowerCase()) ||
    /^finished(?:_|$)/i.test(String(message?.status || ''));
}

export function isMessageStreaming(message) {
  return Boolean(message?.live && !message?.error && !isTerminalMessage(message));
}

export function formatModelLabel(value) {
  // Display the observed model, not an assumed product/version mapping.
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  if (raw === 'Web' || raw === 'Mobile') return '';

  // Custom GPT / Gizmo: g-xxxx or gizmo-xxxx slug
  const gizmoMatch = raw.match(/^(?:g-|gizmo-)([a-zA-Z0-9_-]+)/);
  if (gizmoMatch) {
    const name = gizmoMatch[1].replace(/^[a-z0-9]{8,}-/i, '').replace(/[-_]+/g, ' ').trim();
    return name ? `GPT · ${name}` : 'Custom GPT';
  }

  let model = raw.replace(/^text-/, '').replace(/-latest$/, '');
  // o1 / o3 variants
  if (/^o[13](?:-mini|-preview|-pro)?(?:-\d{4}-\d{2}-\d{2})?$/i.test(model)) {
    return model.toLowerCase();
  }

  return model.replace(/^gpt-/i, 'GPT-');
}

export function shouldSubmitOnEnter(event, composing = false) {
  // WebKit can report isComposing=false on the Enter that commits IME input.
  const isComp = typeof composing === 'function'
    ? composing()
    : Boolean(composing?.isComposing ?? composing);
  // altKey (Option on macOS) requests a newline, never a submit.
  return event?.key === 'Enter' && !event.shiftKey && !event.altKey && !event.isComposing &&
    event.keyCode !== 229 && !isComp;
}

export function createImeTracker() {
  let composing = false;
  let justComposed = false;

  return {
    get isComposing() {
      return composing || justComposed;
    },
    onCompositionStart() {
      composing = true;
      justComposed = false;
    },
    onCompositionEnd() {
      composing = false;
      justComposed = true;
      queueMicrotask(() => {
        justComposed = false;
      });
    },
    onKeyup(event) {
      if (event?.key === 'Enter' || event?.keyCode === 13 || event?.keyCode === 229) {
        justComposed = false;
      }
    },
    reset() {
      composing = false;
      justComposed = false;
    },
  };
}
