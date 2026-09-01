const ROLE_LABELS = {
  user: '你',
  assistant: 'ChatGPT',
  system: 'System',
  tool: 'Tool',
};

export function buildConversationMarkdown(title, messages = []) {
  const safeTitle = String(title || '').trim() || 'ChatGPT Conversation';
  const sections = [`# ${safeTitle}`];

  for (const message of messages) {
    const text = String(message?.text || '').trim();
    if (!text) continue;
    const role = String(message?.role || 'message');
    const label = message?.name || ROLE_LABELS[role] || role;
    sections.push(`## ${label}\n\n${text}`);
  }

  return `${sections.join('\n\n')}\n`;
}

export function markdownFilename(title) {
  const base = String(title || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .trim()
    .slice(0, 120);
  return `${base || 'slimgpt-conversation'}.md`;
}

export function downloadConversationMarkdown(title, messages = []) {
  const content = buildConversationMarkdown(title, messages);
  const filename = markdownFilename(title);
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return { content, filename };
}
