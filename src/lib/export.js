const ROLE_LABELS = {
  user: '你',
  assistant: 'ChatGPT',
  system: 'System',
  tool: 'Tool',
};
import { extractSourcesList, getOrderedMessageSources, safeReferenceUrl } from './content-references.js';
const filenameEncoder = new TextEncoder();

function heading(value) {
  return String(value ?? '').replace(/[\r\n\u2028\u2029\u0000-\u001f]+/g, ' ').trim()
    .replace(/[\\`*_\[\]<>]/g, '\\$&');
}

function sanitizeSourceTitle(value) {
  const raw = String(value ?? '').replace(/[\r\n\u2028\u2029\u0000-\u001f]+/g, ' ').trim();
  return raw.slice(0, 200).trim();
}

export function hasExportableMessage(message) {
  return Boolean(message && !message.pending && (
    String(message.text ?? '').trim() || String(message.thought ?? '').trim() ||
    message.tool || message.error || message.unrecognized ||
    /^(?:failed|error|cancelled|canceled|interrupted|incomplete|aborted|stopped)$/.test(message.status || '')
  ));
}

function fencedPayload(payload) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2) ?? '';
  let length = 3;
  for (const match of text.matchAll(/`+/g)) length = Math.max(length, match[0].length + 1);
  const fence = '`'.repeat(length);
  return `${fence}${typeof payload === 'string' ? 'text' : 'json'}\n${text}\n${fence}`;
}

function messageSection(message, level = 2, options = {}) {
  if (!hasExportableMessage(message)) return null;
  const tool = message.tool;
  const includeTools = options.includeTools !== false;
  const includeThought = options.includeThought !== false;
  if (tool && !includeTools) return null;
  const label = tool
    ? `${tool.kind === 'tool-call' ? '工具调用' : '工具结果'} · ${heading(tool.name || message.name || 'Tool')}`
    : heading(message.name || ROLE_LABELS[message.role] || message.role || '消息');
  const parts = [];
  if (message.role === 'assistant' && message.model) {
    parts.push(`> 模型：${heading(message.model)}`);
  }
  const rawTime = message.createTime ?? message.create_time ?? message.timestamp;
  if (rawTime != null && rawTime !== '') {
    const date = typeof rawTime === 'number'
      ? new Date(rawTime < 10_000_000_000 ? rawTime * 1000 : rawTime)
      : new Date(rawTime);
    if (!Number.isNaN(date.getTime())) {
      parts.push(`> 时间：${date.toISOString()}`);
    }
  }
  if ((message.siblingCount || 0) > 1) {
    const branchIndex = typeof message.siblingIndex === 'number' ? message.siblingIndex + 1 : 1;
    parts.push(`> 分支：第 ${branchIndex} / ${message.siblingCount} 个分支`);
  }
  if (message.error || /^(?:failed|error)$/.test(message.status || '')) parts.push('> 生成异常。');
  else if (/^(?:cancelled|canceled|interrupted|incomplete|aborted|stopped)$/.test(message.status || '')) parts.push('> 此项生成已中断或未完成。');
  if (message.cacheRedacted) parts.push('> 此项来自本地缓存，其中的凭据字段已省略。');
  if (includeThought && typeof message.thought === 'string' && message.thought.trim()) {
    parts.push(`${'#'.repeat(level + 1)} 思考过程\n\n${message.thought}`);
  }
  if (tool) {
    const callIds = [...new Set([tool.callId, tool.toolCallId, ...(tool.callIds || [])].filter(Boolean))];
    if (callIds.length) parts.push(`调用标识：${callIds.map(heading).join('、')}`);
    parts.push(fencedPayload(tool.payload));
  } else if (typeof message.text === 'string' && message.text.trim()) {
    // Leading indentation and trailing two-space line breaks are content.
    parts.push(message.text);
  }
  if (message.unrecognized) parts.push(`> 尚未展开的内容类型：${heading(message.contentType || 'unknown')}。`);
  if (parts.length === 0) return null;
  return `${'#'.repeat(level)} ${label}\n\n${parts.join('\n\n')}`;
}

export function buildConversationMarkdown(title, messages = [], options = {}) {
  const safeTitle = heading(title) || 'ChatGPT Conversation';
  const sections = [`# ${safeTitle}`];
  if (options.historyComplete === false) sections.push('> 历史尚未同步完整；此文件仅包含当前已取得的内容，不是完整会话。');
  for (const message of messages) {
    const section = messageSection(message, 2, options);
    if (section) sections.push(section);
  }
  const unresolved = (options.unresolved || []).filter((group) => group.replies?.some(hasExportableMessage));
  if (unresolved.length) {
    sections.push('## 协议关联未还原\n\n> 以下消息已取得，但 SlimGPT 尚未还原其所属问答。这是解析或同步缺陷，不是一类独立回答，也不应视为上一问题的回答。');
    for (let i = 0; i < unresolved.length; i += 1) {
      sections.push(`### 待修复的关联组 ${i + 1}`);
      for (const message of unresolved[i].replies) {
        const section = messageSection(message, 4, options);
        if (section) sections.push(section);
      }
    }
  }

  const allMessages = [...messages];
  for (const group of unresolved) {
    if (Array.isArray(group?.replies)) allMessages.push(...group.replies);
  }
  const messagesWithSources = [];
  for (const msg of allMessages) {
    const orderedSources = getOrderedMessageSources(msg);
    if (orderedSources.length) messagesWithSources.push({ message: msg, sources: orderedSources });
  }
  if (messagesWithSources.length) {
    const formatList = (srcs) => srcs.map((item, index) => {
      const num = index + 1;
      const safeUrl = safeReferenceUrl(item.url) || item.url;
      const title = sanitizeSourceTitle(item.title);
      const label = title ? `${title} — ${safeUrl}` : safeUrl;
      return `[${num}] ${label}`;
    }).join('\n');

    if (messagesWithSources.length === 1) {
      sections.push(`## 参考来源\n\n${formatList(messagesWithSources[0].sources)}`);
    } else {
      const sourceSections = ['## 参考来源'];
      for (let i = 0; i < messagesWithSources.length; i += 1) {
        const { message: msg, sources: srcs } = messagesWithSources[i];
        const msgLabel = msg.name || ROLE_LABELS[msg.role] || msg.role || '消息';
        sourceSections.push(`### ${heading(msgLabel)}（第 ${i + 1} 项）\n\n${formatList(srcs)}`);
      }
      sections.push(sourceSections.join('\n\n'));
    }
  }

  const footerLines = [];
  footerLines.push(`导出时间: ${new Date().toISOString()}`);
  if (options.conversationId) footerLines.push(`会话标识: ${options.conversationId}`);
  if (options.model) footerLines.push(`模型: ${options.model}`);
  if (options.createTime) footerLines.push(`创建时间: ${options.createTime}`);
  if (options.updateTime) footerLines.push(`更新时间: ${options.updateTime}`);
  if (options.historyComplete === false) {
    footerLines.push('历史状态: 局部不完整（历史尚未同步完整）');
  }
  const footer = [
    '---',
    ...footerLines,
    '---',
  ].join('\n');
  sections.push(footer);

  return `${sections.join('\n\n')}\n`;
}

export function buildTurnMarkdown(turn, options = {}) {
  if (!turn) return '';
  const messages = [turn.user, ...(turn.replies || [])].filter(Boolean);
  const sections = [];
  for (const message of messages) {
    const section = messageSection(message, 2, options);
    if (section) sections.push(section);
  }
  return sections.join('\n\n');
}

export function markdownFilename(title) {
  let base = String(title || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .trim();
  // Keep the UTF-8 basename comfortably below filesystem byte limits and
  // never cut an emoji/surrogate pair in half.
  let bytes = 0;
  base = [...base].filter((character) => {
    bytes += filenameEncoder.encode(character).length;
    return bytes <= 220;
  }).join('');
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(base)) base = `_${base}`;
  base = base.replace(/[. ]+$/g, '');
  return `${base || 'slimgpt-conversation'}.md`;
}

export function downloadConversationMarkdown(title, messages = [], options = {}) {
  if (!messages || !messages.length) {
    const hasUnresolved = (options.unresolved || []).some((group) => group.replies?.some(hasExportableMessage));
    if (!hasUnresolved) {
      throw new Error('没有可导出的对话内容');
    }
  }
  const content = buildConversationMarkdown(title, messages, options);
  const filename = markdownFilename(title);
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = 'none';
  try {
    document.body.appendChild(anchor);
    anchor.click();
  } finally {
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return { content, filename };
}
