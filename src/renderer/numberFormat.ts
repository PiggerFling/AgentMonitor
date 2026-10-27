import { create } from 'zustand';
import { formatNumber, useLocaleStore, type Locale, type MessageKey } from './i18n';

/** How token counts are shown: `compact` (97.6M) or `full` grouped digits (97,574,015). */
export type NumberFormat = 'compact' | 'full';

export const NUMBER_FORMATS = [
  { id: 'compact', labelKey: 'ui.numberFormat.compact', shortKey: 'ui.numberFormat.compactShort' },
  { id: 'full', labelKey: 'ui.numberFormat.full', shortKey: 'ui.numberFormat.fullShort' },
] as const satisfies readonly { id: NumberFormat; labelKey: MessageKey; shortKey: MessageKey }[];

const STORAGE_KEY = 'agent-monitor.numberFormat';
const UNITS = [
  { size: 1e9, suffix: 'B' },
  { size: 1e6, suffix: 'M' },
  { size: 1e3, suffix: 'K' },
];

/**
 * Formats a count. Compact uses K / M / B with at most one decimal from 1,000 up (the same in every
 * language, never 万 / 亿) and leaves smaller values as they are; full prints grouped digits.
 */
export function formatCount(value: number, format: NumberFormat, locale?: Locale): string {
  if (!Number.isFinite(value)) return formatNumber(value, undefined, locale);
  const magnitude = Math.abs(value);
  if (magnitude < 1000) return formatNumber(value, { maximumFractionDigits: 1 }, locale);
  if (format === 'full') return formatNumber(Math.round(value), undefined, locale);
  // Pick the unit after rounding so 999,960 reads as 1M rather than 1000K.
  for (let index = UNITS.length - 1; index >= 0; index -= 1) {
    const { size, suffix } = UNITS[index];
    const scaled = Math.round(magnitude / size * 10) / 10;
    if (scaled < 1000 || index === 0) return `${value < 0 ? '-' : ''}${formatNumber(scaled, { maximumFractionDigits: 1 }, locale)}${suffix}`;
  }
  return formatNumber(value, undefined, locale);
}

/** Exact grouped digits, for hover titles next to a compact value. */
export function formatExactCount(value: number, locale?: Locale): string {
  return formatNumber(Math.round(value), undefined, locale);
}

function isNumberFormat(value: unknown): value is NumberFormat {
  return NUMBER_FORMATS.some((option) => option.id === value);
}

export function readNumberFormat(storage: Pick<Storage, 'getItem'> | undefined = globalThis.localStorage): NumberFormat {
  try {
    const stored = storage?.getItem(STORAGE_KEY);
    return isNumberFormat(stored) ? stored : 'compact';
  } catch {
    return 'compact';
  }
}

export const useNumberFormatStore = create<{ format: NumberFormat; setFormat: (format: NumberFormat) => void }>((set) => ({
  format: typeof window === 'undefined' ? 'compact' : readNumberFormat(),
  setFormat: (format) => {
    try { localStorage.setItem(STORAGE_KEY, format); } catch { /* Still usable without storage. */ }
    set({ format });
  },
}));

/**
 * The global number format plus formatters bound to it and the current locale. `title` gives the exact
 * value for a hover title while compact numbers are shown, and nothing when the shown value is exact.
 */
export function useNumberFormat() {
  const format = useNumberFormatStore((state) => state.format);
  const setFormat = useNumberFormatStore((state) => state.setFormat);
  const locale = useLocaleStore((state) => state.locale);
  return {
    format,
    setFormat,
    count: (value: number) => formatCount(value, format, locale),
    title: (value: number) => format === 'compact' && Math.abs(value) >= 1000 ? formatExactCount(value, locale) : undefined,
  };
}
