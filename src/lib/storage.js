const INDEX_KEY = 'slimgpt:conversation-index:v1';
const SETTINGS_KEY = 'slimgpt:user-settings:v1';
const MODELS_CACHE_KEY = 'slimgpt:models-cache:v1';

export const THINKING_LEVELS = [
  {
    level: 1,
    id: 'instant',
    slug: 'instant',
    model: 'gpt-5.6',
    effort: 'none',
    label: 'Instant',
    cnLabel: '即时',
    icon: '⚡',
    tip: 'GPT-5.6 极速响应，日常简单问答',
  },
  {
    level: 2,
    id: 'medium',
    slug: 'medium',
    model: 'gpt-5.6',
    effort: 'medium',
    label: 'Medium',
    cnLabel: '标准',
    icon: '✨',
    tip: 'GPT-5.6 标准思考，平衡速度与深度（默认）',
  },
  {
    level: 3,
    id: 'high',
    slug: 'high',
    model: 'gpt-5.6',
    effort: 'high',
    label: 'High',
    cnLabel: '高',
    icon: '🧠',
    tip: 'GPT-5.6 扩展思考，复杂逻辑与多步推理',
  },
  {
    level: 4,
    id: 'extra_high',
    slug: 'extra_high',
    model: 'gpt-5.6',
    effort: 'xhigh',
    label: 'Extra High',
    cnLabel: '超高',
    icon: '🔥',
    tip: 'GPT-5.6 强力思考，高难度任务与深度代码分析',
  },
  {
    level: 5,
    id: 'pro',
    slug: 'pro',
    model: 'gpt-5.6-pro',
    effort: 'max',
    label: 'Pro',
    cnLabel: 'Pro',
    icon: '👑',
    tip: 'GPT-5.6 Sol Pro 专家级计算，最深层学术与代码推理',
  },
];

export const DEFAULT_SETTINGS = {
  thinkingLevel: 2, // 1 to 5 (1: Instant, 2: Medium [default], 3: High, 4: Extra High, 5: Pro)
};

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

export async function loadUserSettings() {
  if (isExtensionStorage()) {
    const value = await chrome.storage.local.get('userSettings');
    return { ...DEFAULT_SETTINGS, ...(value.userSettings || {}) };
  }
  try {
    const stored = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    return { ...DEFAULT_SETTINGS, ...stored };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveUserSettings(settings) {
  const safe = { ...DEFAULT_SETTINGS, ...settings };
  if (isExtensionStorage()) {
    await chrome.storage.local.set({ userSettings: safe });
    return safe;
  }
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(safe));
  return safe;
}

export async function loadCachedModels() {
  if (isExtensionStorage()) {
    const value = await chrome.storage.local.get('cachedModels');
    return Array.isArray(value.cachedModels) && value.cachedModels.length ? value.cachedModels : DEFAULT_MODELS;
  }
  try {
    const stored = JSON.parse(localStorage.getItem(MODELS_CACHE_KEY) || '[]');
    return Array.isArray(stored) && stored.length ? stored : DEFAULT_MODELS;
  } catch {
    return DEFAULT_MODELS;
  }
}

export async function saveCachedModels(models) {
  if (!Array.isArray(models) || !models.length) return;
  if (isExtensionStorage()) {
    await chrome.storage.local.set({ cachedModels: models });
    return;
  }
  localStorage.setItem(MODELS_CACHE_KEY, JSON.stringify(models));
}

function isExtensionStorage() {
  return typeof chrome !== 'undefined' && Boolean(chrome.storage?.local) && location.protocol === 'chrome-extension:';
}
