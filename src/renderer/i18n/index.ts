import { create } from 'zustand';
import { en, type Messages } from './en';
import { zhCN } from './zh-CN';

export const LOCALES = [
  { id: 'en', label: 'English' },
  { id: 'zh-CN', label: '简体中文' },
] as const;

export type Locale = typeof LOCALES[number]['id'];
const STORAGE_KEY = 'agent-monitor.locale';
const DICTIONARIES: Record<Locale, Messages> = { en, 'zh-CN': zhCN };

/** Dotted paths to every message; a plural entry ({ one?, other }) is a single key. */
type Paths<T, P extends string = ''> = {
  [K in keyof T & string]: T[K] extends string | { other: string } ? `${P}${K}` : Paths<T[K], `${P}${K}.`>
}[keyof T & string];
export type MessageKey = Paths<Messages>;
export type MessageParams = Record<string, string | number>;

function isLocale(value: unknown): value is Locale {
  return LOCALES.some(locale => locale.id === value);
}

export function detectLocale(): Locale {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (isLocale(stored)) return stored;
  } catch { /* Fall through to the browser language. */ }
  return typeof navigator !== 'undefined' && navigator.language?.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
}

export const useLocaleStore = create<{ locale: Locale; setLocale: (locale: Locale) => void }>((set) => ({
  locale: 'en',
  setLocale: (locale) => {
    applyLocale(locale);
    try { localStorage.setItem(STORAGE_KEY, locale); } catch { /* Still usable without storage. */ }
    set({ locale });
  },
}));

export function applyLocale(locale: Locale): void {
  if (typeof document !== 'undefined') document.documentElement.lang = locale;
  useLocaleStore.setState({ locale });
}

export function currentLocale(): Locale {
  return useLocaleStore.getState().locale;
}

function lookup(messages: Messages, key: string): unknown {
  return key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], messages);
}

/**
 * Translates a key for the current locale, falling back to English. `{name}` placeholders are filled
 * from `params`; plural entries pick a form from `params.count` with Intl.PluralRules.
 */
export function t(key: MessageKey, params?: MessageParams, locale: Locale = currentLocale()): string {
  let entry = lookup(DICTIONARIES[locale], key) ?? lookup(en, key);
  if (entry && typeof entry === 'object') {
    const forms = entry as Record<string, string>;
    const category = new Intl.PluralRules(locale).select(Number(params?.count ?? 0));
    entry = forms[category] ?? forms.other;
  }
  const text = typeof entry === 'string' ? entry : key;
  return params ? text.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match)) : text;
}

/** Re-renders the calling component when the locale changes; use its `t` in every component that shows text. */
export function useI18n() {
  const locale = useLocaleStore(state => state.locale);
  const setLocale = useLocaleStore(state => state.setLocale);
  return { locale, setLocale, t: (key: MessageKey, params?: MessageParams) => t(key, params, locale) };
}

export function formatNumber(value: number, options?: Intl.NumberFormatOptions, locale: Locale = currentLocale()): string {
  return new Intl.NumberFormat(locale, options).format(value);
}

/** US-dollar amounts (all pricing is in USD) formatted for the current locale. */
export function formatUsd(value: number, options?: Intl.NumberFormatOptions, locale: Locale = currentLocale()): string {
  return formatNumber(value, { style: 'currency', currency: 'USD', currencyDisplay: 'narrowSymbol', ...options }, locale);
}

/** Short relative time such as "5s ago" / "5秒前"; under five seconds reads as "just now". */
export function formatRelativeTime(timestamp: number | undefined, now = Date.now(), locale: Locale = currentLocale()): string {
  if (!timestamp) return t('common.time.unknown', undefined, locale);
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
  if (seconds < 5) return t('common.time.justNow', undefined, locale);
  if (seconds < 60) return t('common.time.secondsAgo', { count: seconds }, locale);
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return t('common.time.minutesAgo', { count: minutes }, locale);
  return t('common.time.hoursAgo', { count: Math.round(minutes / 60) }, locale);
}
