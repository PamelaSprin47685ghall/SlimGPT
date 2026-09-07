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

export function filterConversations(conversations = [], query = '', limit = 100) {
  const needle = String(query || '').trim().toLocaleLowerCase();
  if (!needle) {
    const visible = conversations.slice(0, limit);
    return { needle: '', total: conversations.length, visible, isCapped: conversations.length > limit };
  }
  const tokens = needle.split(/\s+/).filter(Boolean);
  const matched = conversations.filter((item) => {
    const title = String(item?.title || '').toLocaleLowerCase();
    const snippet = String(item?.last || '').toLocaleLowerCase();
    const combined = `${title} ${snippet}`;
    return tokens.every((token) => combined.includes(token));
  });
  const visible = matched.slice(0, limit);
  return {
    needle,
    total: matched.length,
    visible,
    isCapped: matched.length > limit,
  };
}
