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

const ERROR_CODE_MAP = {
  composer_input_unsupported: '当前模型暂不支持此类输入',
  'composer-input-unsupported': '当前模型暂不支持此类输入',
  rate_limit: '请求过于频繁，请稍后再试',
  rate_limit_exceeded: '请求过于频繁，请稍后再试',
  insufficient_quota: '额度已用尽或账户受限',
  quota_exceeded: '额度已用尽或账户受限',
  auth_error: '身份认证已过期，请重新登录',
  unauthorized: '身份认证已过期，请重新登录',
  forbidden: '访问受限或没有权限',
  network_error: '网络连接异常，请检查网络后重试',
  network: '网络连接异常，请检查网络后重试',
  timeout: '请求超时，请稍后重试',
  server_error: '服务器开小差了，请稍后重试',
  internal_error: '服务器内部错误，请稍后重试',
  content_policy_violation: '输入内容可能触及安全策略',
  conversation_not_found: '会话不存在或已被删除',
  model_unavailable: '当前模型暂时不可用，请切换模型',
  usage_cap_exceeded: '当前额度已用尽，请稍后再试',
  token_expired: '登录令牌已过期，请重新登录',
  session_expired: '会话已过期，请重新登录',
  cf_details: 'Cloudflare 安全验证拦截，请在官方网页重试',
};

const NUMERIC_HTTP_STATUS_MAP = {
  401: '身份认证已过期，请重新登录',
  403: '访问受限或没有权限',
  429: '请求过于频繁，请稍后再试',
  500: '服务器内部错误，请稍后重试',
  503: '服务器暂时不可用，请稍后重试',
};

export function matchNumericErrorCode(text) {
  if (!text) return '';
  const str = String(text);
  const match = str.match(/\b(401|403|429|500|503)\b/);
  if (match && NUMERIC_HTTP_STATUS_MAP[match[1]]) {
    return NUMERIC_HTTP_STATUS_MAP[match[1]];
  }
  return '';
}

export function isDuplicateErrorDetail(summary, detail) {
  if (!summary || !detail) return false;
  const clean = (s) => String(s).toLowerCase().replace(/[\s\r\n\t.,;:!?'"“”‘’，。！？；：、_—\-]+/g, '').trim();
  const sClean = clean(summary);
  const dClean = clean(detail);
  return Boolean(sClean && dClean && sClean === dClean);
}

export function calculateReadingMinutes(text) {
  if (!text || typeof text !== 'string') return 0;
  const str = text.trim();
  if (!str) return 0;
  // CJK characters match
  const cjkChars = (str.match(/[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
  // Non-CJK words match
  const nonCjkText = str.replace(/[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]/g, ' ');
  const words = (nonCjkText.match(/\b[a-zA-Z0-9_-]+\b/g) || []).length;
  const cjkMinutes = cjkChars / 400;
  const wordMinutes = words / 200;
  const total = cjkMinutes + wordMinutes;
  return Math.ceil(total);
}

export function formatReadingTime(text) {
  const mins = calculateReadingMinutes(text);
  return mins > 0 ? `约 ${mins} 分钟` : '';
}

export function formatMessageTimestamp(rawTime) {
  if (rawTime == null || rawTime === '') return { time: '', full: '' };
  const date = typeof rawTime === 'number'
    ? new Date(rawTime < 10_000_000_000 ? rawTime * 1000 : rawTime)
    : new Date(rawTime);
  if (Number.isNaN(date.getTime())) return { time: '', full: '' };
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const time = `${hours}:${minutes}`;
  const full = date.toLocaleString('zh-CN', { hour12: false });
  return { time, full };
}

export function humanizeError(codeOrError) {
  if (!codeOrError) return '';
  let code = '';
  let detail = '';
  if (typeof codeOrError === 'string') {
    code = codeOrError.trim();
    detail = code;
  } else if (typeof codeOrError === 'object') {
    code = String(codeOrError.code || codeOrError.status || codeOrError.name || '').trim();
    detail = String(codeOrError.message || codeOrError.detail || codeOrError.error || '').trim();
    if (!code && detail) code = detail;
  }

  const normalizedKey = code.toLowerCase().replace(/[\s-]+/g, '_');
  if (ERROR_CODE_MAP[normalizedKey]) {
    return ERROR_CODE_MAP[normalizedKey];
  }
  if (ERROR_CODE_MAP[code]) {
    return ERROR_CODE_MAP[code];
  }

  for (const [key, msg] of Object.entries(ERROR_CODE_MAP)) {
    if (normalizedKey.includes(key)) {
      return msg;
    }
  }

  const numericMatch = matchNumericErrorCode(code) || matchNumericErrorCode(detail);
  if (numericMatch) return numericMatch;

  return detail || code || '消息生成失败或被官方界面中断';
}
