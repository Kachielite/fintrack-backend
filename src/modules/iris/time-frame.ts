export interface TimeFrame {
  start: Date;
  end: Date;
  label: string;
}

export function parseTimeFrame(message: string): TimeFrame {
  const now = new Date();
  const lc = message.toLowerCase();

  // "past/last N days/weeks/months/years"
  const relMatch = lc.match(/(?:past|last)\s+(\d+)\s+(day|week|month|year)s?/);
  if (relMatch) {
    const n = parseInt(relMatch[1], 10);
    const unit = relMatch[2];
    const start = new Date(now);
    if (unit === 'day') start.setDate(start.getDate() - n);
    else if (unit === 'week') start.setDate(start.getDate() - n * 7);
    else if (unit === 'month') start.setMonth(start.getMonth() - n);
    else start.setFullYear(start.getFullYear() - n);
    start.setHours(0, 0, 0, 0);
    return { start, end: now, label: `the past ${n} ${unit}${n > 1 ? 's' : ''}` };
  }

  if (lc.includes('today')) {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    return { start, end: now, label: 'today' };
  }

  if (lc.includes('yesterday')) {
    const start = new Date(now);
    start.setDate(start.getDate() - 1);
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setHours(23, 59, 59, 999);
    return { start, end, label: 'yesterday' };
  }

  if (lc.includes('this week')) {
    const start = new Date(now);
    // Monday as start of week
    const day = start.getDay();
    const diff = day === 0 ? -6 : 1 - day;
    start.setDate(start.getDate() + diff);
    start.setHours(0, 0, 0, 0);
    return { start, end: now, label: 'this week' };
  }

  if (lc.includes('last week')) {
    const start = new Date(now);
    const day = start.getDay();
    const diff = day === 0 ? -6 : 1 - day;
    start.setDate(start.getDate() + diff - 7);
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(end.getDate() + 6);
    end.setHours(23, 59, 59, 999);
    return { start, end, label: 'last week' };
  }

  if (lc.includes('this month')) {
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    return { start, end: now, label: 'this month' };
  }

  if (lc.includes('last month')) {
    const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const end = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);
    return { start, end, label: 'last month' };
  }

  if (lc.includes('this quarter')) {
    const quarter = Math.floor(now.getMonth() / 3);
    const start = new Date(now.getFullYear(), quarter * 3, 1);
    return { start, end: now, label: 'this quarter' };
  }

  if (lc.includes('last quarter')) {
    const quarter = Math.floor(now.getMonth() / 3);
    const prevQ = quarter === 0 ? 3 : quarter - 1;
    const year = quarter === 0 ? now.getFullYear() - 1 : now.getFullYear();
    const start = new Date(year, prevQ * 3, 1);
    const end = new Date(year, prevQ * 3 + 3, 0, 23, 59, 59, 999);
    return { start, end, label: 'last quarter' };
  }

  if (lc.includes('this year')) {
    const start = new Date(now.getFullYear(), 0, 1);
    return { start, end: now, label: 'this year' };
  }

  if (lc.includes('last year')) {
    const start = new Date(now.getFullYear() - 1, 0, 1);
    const end = new Date(now.getFullYear() - 1, 11, 31, 23, 59, 59, 999);
    return { start, end, label: 'last year' };
  }

  // Default: past 3 months
  const start = new Date(now.getFullYear(), now.getMonth() - 3, 1);
  return { start, end: now, label: 'the past 3 months' };
}
