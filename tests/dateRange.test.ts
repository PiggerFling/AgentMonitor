import assert from 'node:assert/strict';
import test from 'node:test';
import {
  addDays, addMonths, clampDay, draftFromRange, formatRangeFull, formatRangeShort, monthGrid, moveDay, parseTime,
  rangeFromDraft, weekdayLabels, weekStartFor, formatTime,
} from '../src/renderer/dateRange';

const day = (month: number, date: number, year = 2026) => new Date(year, month - 1, date).getTime();
const at = (month: number, date: number, hours: number, minutes = 0) => new Date(2026, month - 1, date, hours, minutes).getTime();
const now = at(10, 28, 15, 30);

test('month grids cover six weeks starting on the locale week start', () => {
  const sunday = monthGrid(day(10, 15), 0);
  assert.equal(sunday.length, 42);
  assert.equal(sunday[0].day, day(9, 27)); // October 2026 starts on a Thursday.
  assert.equal(sunday.filter((cell) => cell.inMonth).length, 31);
  assert.equal(monthGrid(day(10, 15), 1)[0].day, day(9, 28));
  assert.equal(weekStartFor('zh-CN'), 1);
  assert.equal(weekStartFor('en'), 0);
  assert.deepEqual(weekdayLabels('en', 0), ['S', 'M', 'T', 'W', 'T', 'F', 'S']);
  assert.equal(weekdayLabels('zh-CN', 1)[0], '一');
});

test('day arithmetic and keyboard moves', () => {
  assert.equal(addDays(day(10, 31), 1), day(11, 1));
  assert.equal(addMonths(day(3, 31), -1), day(2, 28));
  assert.equal(addMonths(day(12, 15), 1), day(1, 15, 2027));
  assert.equal(moveDay(day(10, 28), 'ArrowLeft', 0), day(10, 27));
  assert.equal(moveDay(day(10, 28), 'ArrowDown', 0), day(11, 4));
  assert.equal(moveDay(day(10, 28), 'PageUp', 0), day(9, 28));
  assert.equal(moveDay(day(10, 28), 'PageDown', 0, true), day(10, 28, 2027));
  assert.equal(moveDay(day(10, 28), 'Home', 1), day(10, 26)); // Wednesday -> Monday
  assert.equal(moveDay(day(10, 28), 'End', 0), day(10, 31)); // -> Saturday
  assert.equal(moveDay(day(10, 28), 'Enter', 0), undefined);
  assert.equal(clampDay(day(11, 2), undefined, day(10, 28)), day(10, 28));
  assert.equal(clampDay(day(9, 1), day(9, 5), undefined), day(9, 5));
});

test('HH:MM parsing', () => {
  assert.equal(parseTime('09:05'), 545);
  assert.equal(parseTime('9:5'), 545);
  assert.equal(parseTime('23:59'), 1439);
  assert.equal(parseTime('24:00'), undefined);
  assert.equal(parseTime('12:60'), undefined);
  assert.equal(parseTime(':30'), undefined);
  assert.equal(formatTime(545), '09:05');
});

test('drafts convert to custom ranges and back', () => {
  const draft = { startDay: day(10, 20), startTime: '09:00', endDay: day(10, 27), endTime: '23:59', endNow: false };
  const result = rangeFromDraft(draft, now);
  assert.ok('range' in result);
  assert.deepEqual(result.range, { kind: 'custom', start: at(10, 20, 9), end: at(10, 27, 23, 59) + 59_999 });
  assert.deepEqual(draftFromRange(result.range, now), draft);
  assert.deepEqual(rangeFromDraft({ ...draft, endNow: true }, now), { range: { kind: 'custom', start: at(10, 20, 9), end: 'now' } });
  assert.deepEqual(rangeFromDraft({ ...draft, startTime: '9:' }, now), { problem: 'startTime' });
  assert.deepEqual(rangeFromDraft({ ...draft, endTime: '' }, now), { problem: 'endTime' });
  assert.deepEqual(rangeFromDraft({ ...draft, startDay: day(10, 28), startTime: '16:00', endNow: true }, now), { problem: 'future' });
  assert.deepEqual(rangeFromDraft({ ...draft, endDay: day(10, 20), endTime: '08:00' }, now), { problem: 'order' });
  assert.deepEqual(draftFromRange({ kind: 'today' }, now), { startDay: day(10, 28), startTime: '00:00', endDay: day(10, 28), endTime: '23:59', endNow: true });
  assert.deepEqual(draftFromRange({ kind: 'day' }, now), { startDay: day(10, 27), startTime: '15:30', endDay: day(10, 28), endTime: '23:59', endNow: true });
});

test('compact and full range labels', () => {
  const wholeDays = { kind: 'custom' as const, start: day(10, 20), end: at(10, 27, 23, 59) + 59_999 };
  assert.equal(formatRangeShort(wholeDays, 'en', now, 'Now'), '10/20 – 10/27');
  assert.equal(formatRangeShort(wholeDays, 'zh-CN', now, '现在'), '10/20 – 10/27');
  assert.equal(formatRangeShort({ kind: 'custom', start: at(10, 20, 9), end: 'now' }, 'zh-CN', now, '现在'), '10/20 09:00 – 现在');
  assert.equal(formatRangeShort({ kind: 'custom', start: day(10, 20), end: 'now' }, 'en', now, 'Now'), '10/20 – Now');
  assert.equal(formatRangeShort({ kind: 'custom', start: at(10, 20, 9), end: at(10, 20, 17) }, 'en', now, 'Now'), '10/20 09:00 – 17:00');
  assert.equal(formatRangeShort({ kind: 'custom', start: day(10, 20), end: at(10, 20, 23, 59) }, 'en', now, 'Now'), '10/20');
  assert.equal(formatRangeShort({ kind: 'custom', start: day(12, 30, 2025), end: 'now' }, 'en', now, 'Now'), '12/30/2025 – Now');
  assert.match(formatRangeFull(wholeDays, 'en', 'Now'), /Oct 20, 2026.*00:00 – Oct 27, 2026.*23:59/);
});
