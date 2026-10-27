import { useState } from 'react';
import { Dropdown } from './Dropdown';
import { useI18n } from './i18n';
import { readTheme, saveTheme, THEMES, type Theme } from './theme';

export function ThemeSelector() {
  const [theme, setTheme] = useState(readTheme);
  const { t } = useI18n();
  return <Dropdown label={t('ui.theme.label')} value={theme} options={THEMES.map(option => ({ value: option.id, label: t(option.labelKey) }))}
    onChange={value => {
      const next = value as Theme;
      setTheme(next);
      saveTheme(next);
    }} />;
}
