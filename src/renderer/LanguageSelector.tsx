import { Dropdown } from './Dropdown';
import { LOCALES, useI18n, type Locale } from './i18n';

export function LanguageSelector() {
  const { locale, setLocale, t } = useI18n();
  return <Dropdown label={t('common.language')} value={locale} options={LOCALES.map(option => ({ value: option.id, label: option.label }))}
    onChange={value => setLocale(value as Locale)} />;
}
