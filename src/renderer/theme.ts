import type { MessageKey } from './i18n';

export const THEMES = [
  { id: 'green', labelKey: 'ui.theme.green' },
  { id: 'charcoal', labelKey: 'ui.theme.charcoal' },
  { id: 'light', labelKey: 'ui.theme.light' },
] as const satisfies readonly { id: string; labelKey: MessageKey }[];

export type Theme = typeof THEMES[number]['id'];
const STORAGE_KEY = 'agent-monitor.theme';

function isTheme(value: unknown): value is Theme {
  return THEMES.some(theme => theme.id === value);
}

export function readTheme(): Theme {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return isTheme(stored) ? stored : 'green';
  } catch {
    return 'green';
  }
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme === 'light' ? 'light' : 'dark';
}

export function saveTheme(theme: Theme): void {
  applyTheme(theme);
  try { localStorage.setItem(STORAGE_KEY, theme); } catch { /* Still usable without storage. */ }
}
