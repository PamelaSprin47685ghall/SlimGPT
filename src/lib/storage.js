const INDEX_KEY = 'slimgpt:conversation-index:v1';

export async function loadConversationIndex() {
  if (isExtensionStorage()) {
    const value = await chrome.storage.local.get('conversationIndex');
    return Array.isArray(value.conversationIndex) ? value.conversationIndex : [];
  }
  try {
    return JSON.parse(localStorage.getItem(INDEX_KEY) || '[]');
  } catch {
    return [];
  }
}

export async function saveConversationIndex(items) {
  const limited = items.slice(0, 500);
  if (isExtensionStorage()) {
    await chrome.storage.local.set({ conversationIndex: limited });
    return;
  }
  localStorage.setItem(INDEX_KEY, JSON.stringify(limited));
}

function isExtensionStorage() {
  return typeof chrome !== 'undefined' && Boolean(chrome.storage?.local) && location.protocol === 'chrome-extension:';
}
