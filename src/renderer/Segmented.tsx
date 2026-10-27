/** A row of mutually exclusive options (radio group); arrow keys move the selection. */
export function Segmented<T extends string>({ label, value, options, onChange, small = false }: {
  label: string; value: T; options: { value: T; label: string; title?: string }[]; onChange: (value: T) => void; small?: boolean;
}) {
  return <div className={`segmented${small ? ' segmented--small' : ''}`} role="radiogroup" aria-label={label} onKeyDown={(event) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    const index = options.findIndex((option) => option.value === value);
    const step = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1;
    const next = options[(index + step + options.length) % options.length];
    onChange(next.value);
    (event.currentTarget.querySelector(`[data-value="${CSS.escape(next.value)}"]`) as HTMLElement | null)?.focus();
  }}>
    {options.map((option) => <button key={option.value} type="button" role="radio" data-value={option.value} aria-checked={option.value === value} tabIndex={option.value === value ? 0 : -1} className="segmented__option" title={option.title} aria-label={option.title} onClick={() => onChange(option.value)}>{option.label}</button>)}
  </div>;
}
