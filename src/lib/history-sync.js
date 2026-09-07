/** Display only classified failures, never raw server bodies or credential URLs. */
export function historySyncMessage(state, transactionError = null) {
  if (transactionError) return '历史分页缺失或不一致，未替换已取得的内容。';
  if (state?.state !== 'error') return '';
  if (state.status === 401 || state.status === 403) return '无法读取完整历史；请在官方页面确认登录或完成验证后重试。';
  if (state.status === 429 || state.code === 'backoff') {
    const milliseconds = typeof state.retryAfterMs === 'number' && Number.isFinite(state.retryAfterMs) ? state.retryAfterMs : 0;
    const seconds = Math.max(1, Math.ceil(milliseconds / 1000));
    return `历史读取暂受限；请在约 ${seconds} 秒后重试，已有内容保持不变。`;
  }
  if (state.code === 'timeout') return '读取完整历史超时，已有内容保持不变。';
  if (state.code === 'invalid-history') return '历史响应不完整或格式异常，未将局部窗口当作完整会话。';
  if (state.code === 'not-ready') return '完整历史读取尚未就绪；请先确认官方页面已登录。';
  return '完整历史同步失败，已有内容保持不变。';
}
