const timeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const sameYearDateFormatter = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  weekday: 'short',
});

const olderYearDateFormatter = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  weekday: 'short',
});

const fullDateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

export function parseTimestamp(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return null;
    const ms = value < 10_000_000_000 ? value * 1000 : value;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    // Pure numeric string (e.g. "1788856200" or "1788856200000")
    if (/^\d+(\.\d+)?$/.test(trimmed)) {
      const num = Number(trimmed);
      if (!Number.isFinite(num) || num <= 0) return null;
      const ms = num < 10_000_000_000 ? num * 1000 : num;
      const date = new Date(ms);
      return Number.isNaN(date.getTime()) ? null : date;
    }
    // ISO-8601 or RFC2822 string
    const parsed = Date.parse(trimmed);
    if (!Number.isNaN(parsed) && parsed > 0) {
      return new Date(parsed);
    }
  }
  return null;
}

export function formatSidebarTime(value, now = new Date()) {
  const date = parseTimestamp(value);
  if (!date) return '';

  const diffMs = now.getTime() - date.getTime();
  // Relative if < 1 hour
  if (diffMs >= 0 && diffMs < 60_000) {
    return '刚刚';
  }
  if (diffMs >= 60_000 && diffMs < 3_600_000) {
    const minutes = Math.max(1, Math.floor(diffMs / 60_000));
    return `${minutes}分钟前`;
  }

  // Same calendar day -> HH:mm
  const isSameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();

  if (isSameDay) {
    return timeFormatter.format(date);
  }
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const isYesterday =
    date.getFullYear() === yesterday.getFullYear() &&
    date.getMonth() === yesterday.getMonth() &&
    date.getDate() === yesterday.getDate();
  if (isYesterday) {
    return '昨天';
  }

  // Older: month/day/weekday (with year if different year)
  const isSameYear = date.getFullYear() === now.getFullYear();
  return isSameYear
    ? sameYearDateFormatter.format(date)
    : olderYearDateFormatter.format(date);
}

export function fullSidebarDateTime(value) {
  const date = parseTimestamp(value);
  if (!date) return '';
  return fullDateTimeFormatter.format(date);
}

export function groupConversations(conversations = [], now = new Date(), pinnedIds = []) {
  const pinnedSet = new Set(Array.isArray(pinnedIds) ? pinnedIds : []);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfYesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).getTime();
  const startOf7Days = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6).getTime();

  const pinnedGroup = { key: 'pinned', label: '置顶', items: [] };
  const groups = [
    { key: 'today', label: '今天', items: [] },
    { key: 'yesterday', label: '昨天', items: [] },
    { key: 'week', label: '近7天', items: [] },
    { key: 'earlier', label: '更早', items: [] },
  ];

  for (const item of conversations) {
    if (pinnedSet.has(item?.id)) {
      pinnedGroup.items.push(item);
      continue;
    }
    const rawTime = item?.update_time ?? item?.updatedAt ?? item?.create_time ?? item?.createdAt;
    const date = parseTimestamp(rawTime);
    if (!date) {
      groups[3].items.push(item);
      continue;
    }
    const time = date.getTime();
    if (time >= startOfToday) {
      groups[0].items.push(item);
    } else if (time >= startOfYesterday) {
      groups[1].items.push(item);
    } else if (time >= startOf7Days) {
      groups[2].items.push(item);
    } else {
      groups[3].items.push(item);
    }
  }

  const result = [];
  if (pinnedGroup.items.length > 0) {
    result.push(pinnedGroup);
  }
  for (const group of groups) {
    if (group.items.length > 0) {
      result.push(group);
    }
  }
  return result;
}

export function filterConversations(conversations = [], query = '', limit = 100, pinnedIds = []) {
  const rawNeedle = String(query || '').trim();
  const needle = rawNeedle.toLocaleLowerCase();
  if (!needle) {
    const visible = conversations.slice(0, limit);
    return { needle: '', total: conversations.length, visible, isCapped: conversations.length > limit, queryTokens: [] };
  }
  const rawTokens = needle.split(/\s+/).filter(Boolean);
  let filterPinnedOnly = false;
  const textTokens = [];
  for (const token of rawTokens) {
    if (token === 'is:pinned') {
      filterPinnedOnly = true;
    } else {
      textTokens.push(token);
    }
  }
  const pinnedSet = new Set(Array.isArray(pinnedIds) ? pinnedIds : []);
  const matched = conversations.filter((item) => {
    if (filterPinnedOnly && !pinnedSet.has(item?.id)) {
      return false;
    }
    if (textTokens.length === 0) {
      return true;
    }
    const title = String(item?.title || '').toLocaleLowerCase();
    const snippet = String(item?.last || '').toLocaleLowerCase();
    const body = String(item?.searchText || '').toLocaleLowerCase();
    const combined = `${title} ${snippet} ${body}`;
    return textTokens.every((token) => combined.includes(token));
  });
  const visible = matched.slice(0, limit);
  return {
    needle,
    total: matched.length,
    visible,
    isCapped: matched.length > limit,
    queryTokens: textTokens,
    filterPinnedOnly,
  };
}

export function highlightTitle(title = '', query = '') {
  const text = String(title || '');
  const needle = String(query || '').trim();
  if (!needle || !text) {
    return [{ text, mark: false }];
  }
  const rawTokens = needle.split(/\s+/).filter(Boolean);
  const tokens = rawTokens.filter((token) => token.toLocaleLowerCase() !== 'is:pinned');
  if (!tokens.length) {
    return [{ text, mark: false }];
  }
  const escaped = tokens.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const regex = new RegExp(`(${escaped})`, 'gi');
  const parts = text.split(regex);
  const lowerTokens = tokens.map((t) => t.toLocaleLowerCase());
  return parts.filter(Boolean).map((part) => ({
    text: part,
    mark: lowerTokens.includes(part.toLocaleLowerCase()),
  }));
}

export function isContentHit(item, query = '') {
  const needle = String(query || '').trim().toLocaleLowerCase();
  if (!needle || !item?.searchText) return false;
  const rawTokens = needle.split(/\s+/).filter(Boolean);
  const tokens = rawTokens.filter((token) => token !== 'is:pinned');
  if (!tokens.length) return false;
  const body = String(item.searchText).toLocaleLowerCase();
  return tokens.some((token) => body.includes(token));
}

export function buildTruncationLabel(total, visibleCount) {
  const safeTotal = typeof total === 'number' && Number.isFinite(total) && total >= 0 ? total : 0;
  const safeVisible = typeof visibleCount === 'number' && Number.isFinite(visibleCount) && visibleCount >= 0 ? visibleCount : 0;
  if (safeTotal <= 0) return '共 0 个会话';
  if (safeVisible < safeTotal) {
    return `共 ${safeTotal} 个会话 · 显示前 ${safeVisible} 个`;
  }
  return `共 ${safeTotal} 个会话`;
}

const PINNED_STORAGE_KEY = 'slimgpt:pinned-conversations';

export function getPinnedIds(storage = (typeof window !== 'undefined' ? window.localStorage : null)) {
  if (!storage) return [];
  try {
    const raw = storage.getItem(PINNED_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id) => typeof id === 'string' && id.trim().length > 0);
  } catch {
    return [];
  }
}

export function savePinnedIds(ids, storage = (typeof window !== 'undefined' ? window.localStorage : null)) {
  if (!storage) return;
  try {
    const valid = Array.isArray(ids)
      ? ids.filter((id) => typeof id === 'string' && id.trim().length > 0)
      : [];
    storage.setItem(PINNED_STORAGE_KEY, JSON.stringify(valid));
  } catch {
    // Ignore storage errors (quota, private mode)
  }
}

export function togglePinnedId(id, storage = (typeof window !== 'undefined' ? window.localStorage : null)) {
  if (!id || typeof id !== 'string' || !storage) return [];
  const current = getPinnedIds(storage);
  const exists = current.includes(id);
  const next = exists ? current.filter((x) => x !== id) : [...current, id];
  savePinnedIds(next, storage);
  return next;
}
