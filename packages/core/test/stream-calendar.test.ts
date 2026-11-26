import test from 'node:test';
import assert from 'node:assert/strict';
import { calendarRange, moscowDay, shiftCalendarMonth } from '../src/stream-calendar.js';

test('Moscow calendar day and month share inclusive start and exclusive end boundaries', () => {
  const february = calendarRange('2024-02', 'month')!;
  assert.equal(february.from, Date.parse('2024-01-31T21:00:00Z'));
  assert.equal(february.to, Date.parse('2024-02-29T21:00:00Z'));
  const leapDay = calendarRange('2024-02-29', 'day')!;
  assert.equal(leapDay.from, Date.parse('2024-02-28T21:00:00Z'));
  assert.equal(leapDay.to, february.to);
  assert.equal(moscowDay(leapDay.to - 1), '2024-02-29');
  assert.equal(moscowDay(leapDay.to), '2024-03-01');
});

test('month navigation crosses years and rejects calendar dates outside the supported range', () => {
  assert.equal(shiftCalendarMonth('2024-12', 1), '2025-01');
  assert.equal(shiftCalendarMonth('2025-01', -1), '2024-12');
  assert.equal(shiftCalendarMonth('1900-01', -1), undefined);
  assert.equal(shiftCalendarMonth('9999-12', 1), undefined);
  assert.equal(shiftCalendarMonth('2025-13', 1), undefined);
  assert.equal(calendarRange('2025-2', 'month'), undefined);
  assert.equal(calendarRange('2025-02-29', 'day'), undefined);
  assert.equal(calendarRange('2025-00-01', 'day'), undefined);
});
