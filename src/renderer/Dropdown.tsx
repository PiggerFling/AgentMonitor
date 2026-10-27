import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { useI18n } from './i18n';

export interface DropdownOption {
  value: string;
  label: string;
  description?: string;
}

export function Dropdown({ label, value, options, onChange, placeholder, wide = false }: {
  label: string;
  value: string;
  options: DropdownOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  wide?: boolean;
}) {
  const { t } = useI18n();
  const shownPlaceholder = placeholder ?? t('ui.dropdown.select');
  const id = useId();
  const wrapper = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const search = useRef({ text: '', time: 0 });
  const [open, setOpen] = useState(false);
  const [activeValue, setActiveValue] = useState<string>();
  const selected = options.find(option => option.value === value);
  const activeIndex = Math.max(0, options.findIndex(option => option.value === activeValue));
  const active = options[activeIndex];

  function show(last = false) {
    if (!options.length) return;
    search.current = { text: '', time: 0 };
    setActiveValue(selected?.value ?? options[last ? options.length - 1 : 0].value);
    setOpen(true);
  }
  function close(restoreFocus = false) {
    setOpen(false);
    if (restoreFocus) trigger.current?.focus();
  }
  function choose(option: DropdownOption) {
    onChange(option.value);
    close(true);
  }

  useLayoutEffect(() => {
    if (open) menu.current?.focus({ preventScroll: true });
  }, [open]);
  useEffect(() => {
    if (open && active) document.getElementById(`${id}-option-${activeIndex}`)?.scrollIntoView({ block: 'nearest' });
  }, [open, active?.value, activeIndex, id]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!wrapper.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);

  function onMenuKey(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') { event.preventDefault(); close(true); return; }
    if (event.key === 'Tab') { close(); return; }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (active) choose(active);
      return;
    }
    let index = activeIndex;
    if (event.key === 'ArrowDown') index = (index + 1) % options.length;
    else if (event.key === 'ArrowUp') index = (index - 1 + options.length) % options.length;
    else if (event.key === 'Home') index = 0;
    else if (event.key === 'End') index = options.length - 1;
    else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const now = Date.now();
      const text = (now - search.current.time < 750 ? search.current.text : '') + event.key.toLowerCase();
      search.current = { text, time: now };
      const match = options.findIndex(option => option.label.toLowerCase().startsWith(text));
      if (match >= 0) setActiveValue(options[match].value);
      event.preventDefault();
      return;
    } else return;
    event.preventDefault();
    if (options[index]) setActiveValue(options[index].value);
  }

  return (
    <div className={`dropdown${wide ? ' dropdown--wide' : ''}`} ref={wrapper}
      onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false); }}>
      <button ref={trigger} type="button" className="dropdown__trigger" aria-label={`${label}: ${selected?.label ?? shownPlaceholder}`}
        aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? `${id}-menu` : undefined}
        disabled={!options.length} onClick={() => open ? close() : show()}
        onKeyDown={event => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); show(event.key === 'ArrowUp'); }
        }}>
        <span className="dropdown__label">{label}</span>
        <span className="dropdown__value">{selected?.label ?? shownPlaceholder}</span>
        <ChevronDown size={13} aria-hidden="true" />
      </button>
      {open && <div ref={menu} id={`${id}-menu`} className="dropdown__menu" role="listbox" aria-label={label}
        tabIndex={-1} aria-activedescendant={active ? `${id}-option-${activeIndex}` : undefined} onKeyDown={onMenuKey}>
        {options.map((option, index) => <div key={option.value} id={`${id}-option-${index}`} role="option"
          aria-selected={option.value === value} data-active={index === activeIndex} className="dropdown__option"
          onPointerMove={() => setActiveValue(option.value)} onMouseDown={event => event.preventDefault()} onClick={() => choose(option)}>
          <div><span className="dropdown__option-label">{option.label}</span>
            {option.description && <span className="dropdown__option-description">{option.description}</span>}</div>
          <span className="dropdown__check">{option.value === value && <Check size={14} aria-hidden="true" />}</span>
        </div>)}
      </div>}
    </div>
  );
}
