import { useId } from 'react';
import { TRACE_TOOLS } from '../shared/types';
import type { TraceTool } from '../shared/types';
import { useI18n } from './i18n';
import { TOOL_ENV, TOOL_LABELS, type TraceFormError, type TraceSourceForm } from './serverForm';

/** Tool toggles with a data-directory input each; shared by the local settings and the server form. */
export function TraceSourceFields({ form, onChange, placeholders, notes = {}, errors = {}, disabled = false }: {
  form: TraceSourceForm;
  onChange: (form: TraceSourceForm) => void;
  /** Directory shown when the input is empty, i.e. the default. */
  placeholders: Record<TraceTool, string>;
  /** Extra per-tool hint, e.g. where a prefilled directory came from. */
  notes?: Partial<Record<TraceTool, string>>;
  errors?: Partial<Record<TraceTool | 'tools', TraceFormError>>;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const id = useId();
  return <fieldset className="source-fields" disabled={disabled} aria-describedby={errors.tools ? `${id}-tools-error` : undefined}>
    <legend className="sr-only">{t('settings.sources.toolsLabel')}</legend>
    {TRACE_TOOLS.map((tool) => {
      const error = errors[tool];
      const hintId = `${id}-${tool}-hint`;
      return <div key={tool} className={`source-row${form.tools[tool] ? '' : ' source-row--off'}`}>
        <label className="source-row__tool">
          <input type="checkbox" checked={form.tools[tool]} onChange={(event) => onChange({ ...form, tools: { ...form.tools, [tool]: event.target.checked } })} />
          <span>{TOOL_LABELS[tool]}</span>
        </label>
        <div className="source-row__dir">
          <input
            type="text"
            className={`text-input text-input--mono${error ? ' text-input--invalid' : ''}`}
            value={form.dirs[tool]}
            placeholder={placeholders[tool]}
            spellCheck={false}
            autoComplete="off"
            aria-label={t('settings.sources.dirLabel', { tool: TOOL_LABELS[tool] })}
            aria-invalid={error ? true : undefined}
            aria-describedby={hintId}
            onChange={(event) => onChange({ ...form, dirs: { ...form.dirs, [tool]: event.target.value } })}
          />
          <span id={hintId} className={`source-row__hint${error ? ' source-row__hint--error' : ''}`}>
            {error ? t(`settings.sources.${error}`) : [t('settings.sources.envHint', { env: TOOL_ENV[tool] }), notes[tool]].filter(Boolean).join(' · ')}
          </span>
        </div>
      </div>;
    })}
    {errors.tools && <p id={`${id}-tools-error`} className="form-error" role="alert">{t(`settings.sources.${errors.tools}`)}</p>}
  </fieldset>;
}
