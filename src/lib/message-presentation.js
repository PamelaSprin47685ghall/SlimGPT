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
  const model = String(value ?? '').trim().replace(/^text-/, '').replace(/-latest$/, '');
  return model.replace(/^gpt-/i, 'GPT-');
}

export function shouldSubmitOnEnter(event, composing = false) {
  // WebKit can report isComposing=false on the Enter that commits IME input.
  return event?.key === 'Enter' && !event.shiftKey && !event.isComposing &&
    event.keyCode !== 229 && !composing;
}
