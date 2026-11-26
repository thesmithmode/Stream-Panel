const moscowOffsetMs = 3 * 60 * 60 * 1000;
export const calendarDayMs = 24 * 60 * 60 * 1000;

export type CalendarDay = { day: string; count: number };

/** Stream history uses Moscow time (UTC+3). The range is inclusive at the start only. */
export function calendarRange(value: string, unit: 'month' | 'day'): { from: number; to: number } | undefined {
  const pattern = unit === 'month' ? /^\d{4}-\d{2}$/ : /^\d{4}-\d{2}-\d{2}$/;
  if (!pattern.test(value) || value.slice(0, 4) < '1900') return;
  const date = unit === 'month' ? value + '-01' : value;
  const start = Date.parse(date + 'T00:00:00Z');
  if (!Number.isFinite(start) || new Date(start).toISOString().slice(0, 10) !== date) return;
  const end = new Date(start);
  if (unit === 'month') end.setUTCMonth(end.getUTCMonth() + 1);
  else end.setUTCDate(end.getUTCDate() + 1);
  return { from: start - moscowOffsetMs, to: end.getTime() - moscowOffsetMs };
}

export function moscowDay(at: number): string {
  return new Date(at + moscowOffsetMs).toISOString().slice(0, 10);
}

export function shiftCalendarMonth(month: string, direction: -1 | 1): string | undefined {
  const range = calendarRange(month, 'month');
  if (!range) return;
  const date = new Date(range.from + moscowOffsetMs);
  date.setUTCMonth(date.getUTCMonth() + direction);
  const next = date.toISOString().slice(0, 7);
  return calendarRange(next, 'month') ? next : undefined;
}
