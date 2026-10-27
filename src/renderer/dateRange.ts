/**
 * Pure date helpers for the run date-range picker: month grids, keyboard moves, HH:MM parsing,
 * draft <-> range conversion and compact labels. Days are local-midnight timestamps.
 */
import { startOfDay, type RunRange } from './runFilter';

export type CustomRunRange = Extract<RunRange, { kind: 'custom' }>;

const MINUTE = 60_000;
export const LAST_MINUTE_OF_DAY = 23 * 60 + 59;

/** Local midnight `days` days after `day` (DST-safe). */
export function addDays(day: number, days: number): number {
  const date = new Date(day);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days).getTime();
}

/** The same day of month `months` months later, clamped to the end of shorter months. */
export function addMonths(day: number, months: number): number {
  const date = new Date(day);
  const first = new Date(date.getFullYear(), date.getMonth() + months, 1);
  const length = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  return new Date(first.getFullYear(), first.getMonth(), Math.min(date.getDate(), length)).getTime();
}

/** Local midnight of the first day of the month containing `day`. */
export function startOfMonth(day: number): number {
  const date = new Date(day);
  return new Date(date.getFullYear(), date.getMonth(), 1).getTime();
}

export function sameMonth(a: number, b: number): boolean {
  const left = new Date(a);
  const right = new Date(b);
  return left.getFullYear() === right.getFullYear() && left.getMonth() === right.getMonth();
}

/** First day of the week: Monday for Chinese, Sunday otherwise. */
export function weekStartFor(locale: string): 0 | 1 {
  return locale.toLowerCase().startsWith('zh') ? 1 : 0;
}

/** Six full weeks (42 days) covering the month of `month`, starting on `weekStart` (0 = Sunday). */
export function monthGrid(month: number, weekStart: 0 | 1): { day: number; inMonth: boolean }[] {
  const first = startOfMonth(month);
  const lead = (new Date(first).getDay() - weekStart + 7) % 7;
  const start = addDays(first, -lead);
  return Array.from({ length: 42 }, (_, index) => {
    const day = addDays(start, index);
    return { day, inMonth: sameMonth(day, first) };
  });
}

/** Weekday headers in display order, e.g. S M T W T F S / 一 二 三 四 五 六 日. */
export function weekdayLabels(locale: string, weekStart: 0 | 1): string[] {
  const format = new Intl.DateTimeFormat(locale, { weekday: 'narrow' });
  // 2023-01-01 was a Sunday.
  return Array.from({ length: 7 }, (_, index) => format.format(new Date(2023, 0, 1 + ((index + weekStart) % 7))));
}

export function clampDay(day: number, min: number | undefined, max: number | undefined): number {
  if (max !== undefined && day > max) return max;
  if (min !== undefined && day < min) return min;
  return day;
}

/** The day a calendar key moves focus to, or `undefined` for keys the grid ignores. */
export function moveDay(day: number, key: string, weekStart: 0 | 1, shift = false): number | undefined {
  switch (key) {
    case 'ArrowLeft': return addDays(day, -1);
    case 'ArrowRight': return addDays(day, 1);
    case 'ArrowUp': return addDays(day, -7);
    case 'ArrowDown': return addDays(day, 7);
    case 'PageUp': return addMonths(day, shift ? -12 : -1);
    case 'PageDown': return addMonths(day, shift ? 12 : 1);
    case 'Home': return addDays(day, -((new Date(day).getDay() - weekStart + 7) % 7));
    case 'End': return addDays(day, 6 - ((new Date(day).getDay() - weekStart + 7) % 7));
    default: return undefined;
  }
}

/** Minutes after midnight for "H:MM" / "HH:MM" (00:00-23:59), or `undefined` when invalid. */
export function parseTime(text: string): number | undefined {
  const match = /^(\d{1,2}):(\d{1,2})$/.exec(text.trim());
  if (!match) return undefined;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return hours < 24 && minutes < 60 ? hours * 60 + minutes : undefined;
}

export function formatTime(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

function minuteOfDay(time: number): number {
  const date = new Date(time);
  return date.getHours() * 60 + date.getMinutes();
}

/** What the picker edits: a start day and time, and an end day and time or "now". */
export interface RangeDraft {
  startDay: number;
  startTime: string;
  endDay: number;
  endTime: string;
  endNow: boolean;
}

/** The editable form of a range; presets start a draft that ends now. */
export function draftFromRange(range: RunRange, now: number): RangeDraft {
  const today = startOfDay(now);
  if (range.kind === 'custom') {
    const end = range.end === 'now' ? undefined : range.end;
    return {
      startDay: startOfDay(range.start),
      startTime: formatTime(minuteOfDay(range.start)),
      endDay: end === undefined ? today : startOfDay(end),
      endTime: formatTime(end === undefined ? LAST_MINUTE_OF_DAY : minuteOfDay(end)),
      endNow: end === undefined,
    };
  }
  const start = range.kind === 'day' ? now - 24 * 60 * MINUTE : today;
  return { startDay: startOfDay(start), startTime: formatTime(range.kind === 'day' ? minuteOfDay(start) : 0), endDay: today, endTime: formatTime(LAST_MINUTE_OF_DAY), endNow: true };
}

export type DraftProblem = 'startTime' | 'endTime' | 'future' | 'order';

/**
 * The custom range a draft describes, or the reason it can't be applied. A fixed end covers its whole
 * minute (so 23:59 includes the end of that day).
 */
export function rangeFromDraft(draft: RangeDraft, now: number): { range: CustomRunRange } | { problem: DraftProblem } {
  const startMinutes = parseTime(draft.startTime);
  if (startMinutes === undefined) return { problem: 'startTime' };
  const start = draft.startDay + startMinutes * MINUTE;
  if (start > now) return { problem: 'future' };
  if (draft.endNow) return { range: { kind: 'custom', start, end: 'now' } };
  const endMinutes = parseTime(draft.endTime);
  if (endMinutes === undefined) return { problem: 'endTime' };
  const end = draft.endDay + endMinutes * MINUTE + MINUTE - 1;
  if (end <= start) return { problem: 'order' };
  return { range: { kind: 'custom', start, end } };
}

function dateFormat(locale: string, withYear: boolean) {
  return new Intl.DateTimeFormat(locale, withYear ? { year: 'numeric', month: 'numeric', day: 'numeric' } : { month: 'numeric', day: 'numeric' });
}

function timeFormat(locale: string) {
  return new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
}

/**
 * Compact label for a custom range, e.g. "10/20 09:00 – Now" or "10/20 – 10/27". Times are left out when
 * the range covers whole days; the year only appears for ranges outside the current year.
 */
export function formatRangeShort(range: CustomRunRange, locale: string, now: number, nowLabel: string): string {
  const end = range.end === 'now' ? undefined : range.end;
  const year = new Date(now).getFullYear();
  const withYear = new Date(range.start).getFullYear() !== year || (end !== undefined && new Date(end).getFullYear() !== year);
  const dates = dateFormat(locale, withYear);
  const times = timeFormat(locale);
  const wholeDays = minuteOfDay(range.start) === 0 && (end === undefined || minuteOfDay(end) === LAST_MINUTE_OF_DAY);
  const startText = wholeDays ? dates.format(range.start) : `${dates.format(range.start)} ${times.format(range.start)}`;
  if (end === undefined) return `${startText} – ${nowLabel}`;
  const sameDay = startOfDay(end) === startOfDay(range.start);
  if (wholeDays) return sameDay ? startText : `${startText} – ${dates.format(end)}`;
  return `${startText} – ${sameDay ? times.format(end) : `${dates.format(end)} ${times.format(end)}`}`;
}

/** Full label with years and times, for tooltips. */
export function formatRangeFull(range: CustomRunRange, locale: string, nowLabel: string): string {
  const format = new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  return `${format.format(range.start)} – ${range.end === 'now' ? nowLabel : format.format(range.end)}`;
}
