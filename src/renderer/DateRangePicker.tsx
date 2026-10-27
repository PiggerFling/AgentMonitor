import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, RefObject } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react';
import { useI18n, type MessageKey } from './i18n';
import { useDialogFocus } from './useDialogFocus';
import { DEFAULT_RUN_RANGE, RUN_RANGE_PRESETS, startOfDay, type RunRange, type RunRangePreset } from './runFilter';
import {
  addMonths, clampDay, draftFromRange, formatRangeFull, formatRangeShort, LAST_MINUTE_OF_DAY, formatTime,
  monthGrid, moveDay, parseTime, rangeFromDraft, sameMonth, startOfMonth, weekdayLabels, weekStartFor, type RangeDraft,
} from './dateRange';
import './DateRangePicker.css';

const POPOVER_WIDTH = 284;
const MARGIN = 8;

/** Short trigger text and the full tooltip for a range. */
export function useRangeLabels(range: RunRange): { short: string; full: string } {
  const { t, locale } = useI18n();
  if (range.kind !== 'custom') return { short: t(`app.sidebar.range.${range.kind}.short`), full: t(`app.sidebar.range.${range.kind}.title`) };
  const nowLabel = t('app.sidebar.range.now');
  return { short: formatRangeShort(range, locale, Date.now(), nowLabel), full: formatRangeFull(range, locale, nowLabel) };
}

/** Compact button showing the current run time range; opens a popover with presets and a calendar. */
export function DateRangePicker({ value, onChange }: { value: RunRange; onChange: (range: RunRange) => void }) {
  const { t } = useI18n();
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const id = useId();
  const { short, full } = useRangeLabels(value);
  return <>
    <button ref={trigger} type="button" className="range-trigger" title={full} aria-label={`${t('app.sidebar.range.label')}: ${full}`}
      aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen((current) => !current)}>
      <span className="range-trigger__value">{short}</span>
      <ChevronDown size={12} aria-hidden="true" />
    </button>
    {open && createPortal(<RangePopover id={id} anchor={trigger} value={value}
      onChange={(range) => { onChange(range); setOpen(false); }} onClose={() => setOpen(false)} />, document.body)}
  </>;
}

function RangePopover({ id, anchor, value, onChange, onClose }: {
  id: string;
  anchor: RefObject<HTMLButtonElement | null>;
  value: RunRange;
  onChange: (range: RunRange) => void;
  onClose: () => void;
}) {
  const { t, locale } = useI18n();
  const panel = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<CSSProperties>({ visibility: 'hidden' });
  const [now] = useState(() => Date.now());
  const today = startOfDay(now);
  const [draft, setDraft] = useState<RangeDraft>(() => draftFromRange(value, now));
  // Preset drafts carry the preset's times; picking a day then starts from whole days unless a time was typed.
  const timesTouched = useRef(value.kind === 'custom');
  const [pending, setPending] = useState(false);
  const [hoverDay, setHoverDay] = useState<number>();
  const [focusDay, setFocusDay] = useState(() => draft.startDay);
  const [view, setView] = useState(() => startOfMonth(value.kind === 'custom' ? draft.startDay : today));
  const focusGrid = useRef(false);
  const weekStart = weekStartFor(locale);
  const grid = useMemo(() => monthGrid(view, weekStart), [view, weekStart]);
  const weekdays = useMemo(() => weekdayLabels(locale, weekStart), [locale, weekStart]);
  const monthLabel = new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'long' }).format(view);
  const dayLabel = new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
  const shortDate = new Intl.DateTimeFormat(locale, { month: 'numeric', day: 'numeric' });
  const result = rangeFromDraft(draft, now);
  const problem = 'problem' in result ? result.problem : undefined;

  useDialogFocus(panel, onClose);

  useLayoutEffect(() => {
    const place = () => {
      const rect = anchor.current?.getBoundingClientRect();
      if (!rect) return;
      const top = rect.bottom + 6;
      const left = Math.max(MARGIN, Math.min(rect.right - POPOVER_WIDTH, window.innerWidth - POPOVER_WIDTH - MARGIN));
      setPosition({ top, left, width: POPOVER_WIDTH, maxHeight: Math.max(160, window.innerHeight - top - MARGIN) });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [anchor]);

  useEffect(() => {
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!panel.current?.contains(target) && !anchor.current?.contains(target)) onClose();
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [anchor, onClose]);

  useEffect(() => {
    if (!focusGrid.current) return;
    focusGrid.current = false;
    panel.current?.querySelector<HTMLElement>(`[data-day="${focusDay}"]`)?.focus();
  }, [focusDay, view]);

  function update(patch: Partial<RangeDraft>) {
    setDraft((current) => ({ ...current, ...patch }));
  }

  function moveFocus(day: number, keepFocus: boolean) {
    const next = clampDay(day, undefined, today);
    focusGrid.current = keepFocus;
    setFocusDay(next);
    if (!sameMonth(next, view)) setView(startOfMonth(next));
  }

  function changeMonth(step: number) {
    const nextView = addMonths(view, step);
    if (nextView > today) return;
    setView(nextView);
    setFocusDay(clampDay(addMonths(focusDay, step), undefined, today));
  }

  function pickDay(day: number) {
    setFocusDay(day);
    if (!pending) {
      update(timesTouched.current ? { startDay: day, endDay: day } : { startDay: day, endDay: day, startTime: '00:00', endTime: formatTime(LAST_MINUTE_OF_DAY) });
      setPending(true);
      return;
    }
    update({ startDay: Math.min(draft.startDay, day), endDay: Math.max(draft.startDay, day), endNow: false });
    setPending(false);
    setHoverDay(undefined);
  }

  function onGridKey(event: ReactKeyboardEvent<HTMLDivElement>) {
    const next = moveDay(focusDay, event.key, weekStart, event.shiftKey);
    if (next === undefined) return;
    event.preventDefault();
    moveFocus(next, true);
  }

  const lo = draft.startDay;
  const hi = pending && hoverDay !== undefined ? hoverDay : draft.endNow && !pending ? today : draft.endDay;
  const [from, to] = lo <= hi ? [lo, hi] : [hi, lo];
  const weeks = Array.from({ length: 6 }, (_, row) => grid.slice(row * 7, row * 7 + 7));
  const title = (kind: RunRangePreset): MessageKey => `app.sidebar.range.${kind}.title`;

  return <div ref={panel} id={id} className="range-picker" role="dialog" aria-label={t('app.sidebar.range.dialog')} style={position} tabIndex={-1}>
    <div className="range-picker__presets" role="group" aria-label={t('app.sidebar.range.presets')}>
      {RUN_RANGE_PRESETS.map((kind) => <button key={kind} type="button" className="range-picker__preset" aria-pressed={value.kind === kind}
        data-autofocus={value.kind === kind ? true : undefined} title={t(title(kind))} onClick={() => onChange({ kind })}>
        {t(`app.sidebar.range.${kind}.preset`)}
      </button>)}
    </div>

    <div className="range-picker__month">
      <button type="button" className="range-picker__nav" aria-label={t('app.sidebar.range.previousMonth')} title={t('app.sidebar.range.previousMonth')} onClick={() => changeMonth(-1)}><ChevronLeft size={14} aria-hidden="true" /></button>
      <span className="range-picker__month-label" aria-live="polite">{monthLabel}</span>
      <button type="button" className="range-picker__nav" aria-label={t('app.sidebar.range.nextMonth')} title={t('app.sidebar.range.nextMonth')} disabled={sameMonth(view, today)} onClick={() => changeMonth(1)}><ChevronRight size={14} aria-hidden="true" /></button>
    </div>
    <div className="range-picker__grid" role="grid" aria-label={monthLabel} aria-multiselectable="true" onKeyDown={onGridKey} onPointerLeave={() => setHoverDay(undefined)}>
      <div className="range-picker__row" role="row">
        {weekdays.map((label, index) => <span key={index} className="range-picker__weekday" role="columnheader">{label}</span>)}
      </div>
      {weeks.map((week) => <div key={week[0].day} className="range-picker__row" role="row">
        {week.map(({ day, inMonth }) => {
          const future = day > today;
          const inRange = day >= from && day <= to;
          const classes = ['range-picker__day'];
          if (!inMonth) classes.push('range-picker__day--outside');
          if (inRange) classes.push('range-picker__day--in-range');
          if (day === from) classes.push('range-picker__day--start');
          if (day === to) classes.push('range-picker__day--end');
          if (day === today) classes.push('range-picker__day--today');
          return <button key={day} type="button" role="gridcell" data-day={day} className={classes.join(' ')} disabled={future}
            tabIndex={day === focusDay ? 0 : -1} data-autofocus={value.kind === 'custom' && day === focusDay ? true : undefined} aria-selected={inRange} aria-current={day === today ? 'date' : undefined}
            aria-label={dayLabel.format(day)} onFocus={() => setFocusDay(day)}
            onPointerEnter={() => { if (pending && !future) setHoverDay(day); }} onClick={() => pickDay(day)}>
            {new Date(day).getDate()}
          </button>;
        })}
      </div>)}
    </div>

    <div className="range-picker__times">
      <span className="range-picker__time-label">{t('app.sidebar.range.start')}</span>
      <span className="range-picker__date">{shortDate.format(draft.startDay)}</span>
      <TimeField label={t('app.sidebar.range.start')} value={draft.startTime} invalid={problem === 'startTime' || problem === 'future'}
        onChange={(startTime) => { timesTouched.current = true; update({ startTime }); }} />
      <span />
      <span className="range-picker__time-label">{t('app.sidebar.range.end')}</span>
      <span className="range-picker__date">{draft.endNow ? t('app.sidebar.range.today.short') : shortDate.format(draft.endDay)}</span>
      <TimeField label={t('app.sidebar.range.end')} value={draft.endNow ? formatTime(new Date(now).getHours() * 60 + new Date(now).getMinutes()) : draft.endTime}
        disabled={draft.endNow} invalid={problem === 'endTime' || problem === 'order'}
        onChange={(endTime) => { timesTouched.current = true; update({ endTime }); }} />
      <button type="button" role="switch" aria-checked={draft.endNow} className="range-picker__now" title={t('app.sidebar.range.endNow')}
        onClick={() => { update({ endNow: !draft.endNow, endDay: draft.endNow ? Math.max(draft.endDay, draft.startDay) : draft.endDay }); setPending(false); }}>
        <span className="range-picker__switch" aria-hidden="true" />{t('app.sidebar.range.now')}
      </button>
    </div>
    <div className="range-picker__problem" role="status">{problem ? t(`app.sidebar.range.problem.${problem}`) : ''}</div>

    <div className="range-picker__footer">
      <button type="button" className="range-picker__button" onClick={() => onChange(DEFAULT_RUN_RANGE)}>{t('app.sidebar.range.reset')}</button>
      <button type="button" className="range-picker__button range-picker__button--primary" disabled={!!problem}
        onClick={() => { if ('range' in result) onChange(result.range); }}>{t('app.sidebar.range.apply')}</button>
    </div>
  </div>;
}

/** HH:MM entry as two small numeric fields; arrow keys step, two typed digits move on to the minutes. */
function TimeField({ label, value, onChange, disabled = false, invalid = false }: {
  label: string; value: string; onChange: (value: string) => void; disabled?: boolean; invalid?: boolean;
}) {
  const { t } = useI18n();
  const minutesInput = useRef<HTMLInputElement>(null);
  const [hours = '', minutes = ''] = value.split(':');
  const parsed = parseTime(value);

  function step(part: 'hours' | 'minutes', delta: number) {
    const base = parsed ?? 0;
    const next = part === 'hours'
      ? ((Math.floor(base / 60) + delta + 24) % 24) * 60 + (base % 60)
      : Math.floor(base / 60) * 60 + ((base % 60) + delta + 60) % 60;
    onChange(formatTime(next));
  }
  const onKey = (part: 'hours' | 'minutes') => (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      step(part, event.key === 'ArrowUp' ? 1 : -1);
    }
  };
  const pad = (text: string) => (text.length === 1 ? `0${text}` : text);

  return <span className={`time-field${invalid ? ' time-field--invalid' : ''}${disabled ? ' time-field--disabled' : ''}`} role="group" aria-label={label}>
    <input type="text" inputMode="numeric" maxLength={2} value={hours} disabled={disabled} aria-label={`${label} ${t('app.sidebar.range.hours')}`} aria-invalid={invalid}
      onChange={(event) => {
        const digits = event.target.value.replace(/\D/g, '').slice(0, 2);
        onChange(`${digits}:${minutes}`);
        if (digits.length === 2) minutesInput.current?.focus();
      }}
      onBlur={(event) => onChange(`${pad(event.target.value)}:${minutes}`)} onKeyDown={onKey('hours')} onFocus={(event) => event.target.select()} />
    <span className="time-field__colon" aria-hidden="true">:</span>
    <input ref={minutesInput} type="text" inputMode="numeric" maxLength={2} value={minutes} disabled={disabled} aria-label={`${label} ${t('app.sidebar.range.minutes')}`} aria-invalid={invalid}
      onChange={(event) => onChange(`${hours}:${event.target.value.replace(/\D/g, '').slice(0, 2)}`)}
      onBlur={(event) => onChange(`${hours}:${pad(event.target.value)}`)} onKeyDown={onKey('minutes')} onFocus={(event) => event.target.select()} />
  </span>;
}

