import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Activity, AlertCircle, ArrowLeft, CheckCircle2, CircleDollarSign, Laptop, LoaderCircle, Palette, Pencil, Plus, Server, Trash2 } from 'lucide-react';
import { TRACE_TOOLS } from '../shared/types';
import type { AppSettings, MonitorBridge, RemoteHostStatus, ServerInfo, TraceTool } from '../shared/types';
import { listModelPrices, PRICING_SOURCES, PRICING_VERIFIED_AT } from '../shared/pricing';
import { version as appVersion } from '../../package.json';
import { formatNumber, formatRelativeTime, formatUsd, LOCALES, useI18n, type Locale, type MessageKey } from './i18n';
import { readTheme, saveTheme, THEMES, type Theme } from './theme';
import type { SettingsSection } from './store';
import { remoteIndicatorState, remoteStatusTitle, type RemoteIndicatorState } from './remoteUi';
import { defaultTraceDir, formatSshArgs, sameTraceForm, TOOL_LABELS, traceFormFromOptions, traceOptionsFromForm, type TraceFormResult, type TraceSourceForm } from './serverForm';
import { TraceSourceFields } from './TraceSourceFields';
import { AddServerDialog, EditServerDialog } from './ServerDialog';
import { Segmented } from './Segmented';
import { NUMBER_FORMATS, useNumberFormat } from './numberFormat';
import './Settings.css';

export type MonitorMode = 'loading' | 'live' | 'offline';

const SECTIONS: { id: SettingsSection; icon: typeof Palette; labelKey: MessageKey }[] = [
  { id: 'general', icon: Palette, labelKey: 'settings.nav.general' },
  { id: 'servers', icon: Server, labelKey: 'settings.nav.servers' },
  { id: 'local', icon: Laptop, labelKey: 'settings.nav.local' },
  { id: 'pricing', icon: CircleDollarSign, labelKey: 'settings.nav.pricing' },
  { id: 'about', icon: Activity, labelKey: 'settings.nav.about' },
];

const DESCRIPTIONS: Record<SettingsSection, MessageKey> = {
  general: 'settings.general.description',
  servers: 'servers.description',
  local: 'settings.local.description',
  pricing: 'settings.pricing.description',
  about: 'settings.about.description',
};

export function settingsShortcut(platform?: string): string {
  return platform === 'darwin' ? '⌘,' : 'Ctrl+,';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface SettingsPageProps {
  bridge?: MonitorBridge;
  section: SettingsSection;
  onSection: (section: SettingsSection) => void;
  onClose: () => void;
  mode: MonitorMode;
  watching: boolean;
  localErrors: string[];
  remotes: RemoteHostStatus[];
  remoteErrors: Record<string, string[]>;
}

/** Full-page settings with a category list on the left; Escape or the back button returns to the dashboard. */
export function SettingsPage({ bridge, section, onSection, onClose, mode, watching, localErrors, remotes, remoteErrors }: SettingsPageProps) {
  const { t } = useI18n();
  const content = useRef<HTMLElement>(null);

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || document.querySelector('[aria-modal="true"]')) return;
      event.preventDefault();
      // The first Escape only leaves a text field, so a stray key press does not drop unsaved edits.
      const target = event.target as HTMLElement | null;
      if (target instanceof HTMLInputElement && target.type !== 'checkbox') { target.blur(); return; }
      onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  useEffect(() => { content.current?.scrollTo?.({ top: 0 }); }, [section]);

  const current = SECTIONS.find((item) => item.id === section) ?? SECTIONS[0];
  return <div className="settings">
    <nav className="settings__nav" aria-label={t('settings.navLabel')}>
      <div className="settings__nav-head">
        <button type="button" className="settings__back" onClick={onClose} title={`${t('settings.back')} (Esc)`}><ArrowLeft size={15} aria-hidden="true" />{t('settings.back')}</button>
      </div>
      <div className="settings__nav-title">{t('settings.title')}</div>
      <ul className="settings__nav-list">
        {SECTIONS.map(({ id, icon: Icon, labelKey }) => <li key={id}>
          <button type="button" className={`sidebar-link${id === section ? ' sidebar-link--active' : ''}`} aria-current={id === section ? 'page' : undefined} onClick={() => onSection(id)}>
            <Icon size={15} aria-hidden="true" />{t(labelKey)}
          </button>
        </li>)}
      </ul>
    </nav>
    <main className="settings__main" ref={content}>
      <header className="settings__topbar"><span className="topbar__section-label">{t('settings.title')}</span><span className="topbar__slash">/</span><span className="topbar__current">{t(current.labelKey)}</span></header>
      <div className="settings__content">
        <header className="settings__header"><h1>{t(current.labelKey)}</h1><p>{t(DESCRIPTIONS[section])}</p></header>
        {section === 'general' && <GeneralSection />}
        {section === 'servers' && (bridge ? <ServersSection bridge={bridge} remotes={remotes} remoteErrors={remoteErrors} /> : <NeedsDesktop />)}
        {section === 'local' && (bridge ? <LocalSection bridge={bridge} /> : <NeedsDesktop />)}
        {section === 'pricing' && <PricingSection />}
        {section === 'about' && <AboutSection bridge={bridge} mode={mode} watching={watching} localErrors={localErrors} remotes={remotes} remoteErrors={remoteErrors} />}
      </div>
    </main>
  </div>;
}

function NeedsDesktop() {
  const { t } = useI18n();
  return <p className="settings-message">{t('settings.needsDesktop')}</p>;
}

function SettingRow({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <div className="setting-row"><div className="setting-row__text"><span className="setting-row__label">{label}</span>{hint && <span className="setting-row__hint">{hint}</span>}</div><div className="setting-row__control">{children}</div></div>;
}

function GeneralSection() {
  const { t, locale, setLocale } = useI18n();
  const [theme, setTheme] = useState<Theme>(readTheme);
  const { format, setFormat } = useNumberFormat();
  return <section className="settings-card">
    <SettingRow label={t('settings.general.theme')} hint={t('settings.general.themeHint')}>
      <Segmented label={t('settings.general.theme')} value={theme} options={THEMES.map((option) => ({ value: option.id, label: t(option.labelKey) }))} onChange={(next) => { setTheme(next); saveTheme(next); }} />
    </SettingRow>
    <SettingRow label={t('settings.general.language')} hint={t('settings.general.languageHint')}>
      <Segmented<Locale> label={t('settings.general.language')} value={locale} options={LOCALES.map((option) => ({ value: option.id, label: option.label }))} onChange={setLocale} />
    </SettingRow>
    <SettingRow label={t('ui.numberFormat.label')} hint={t('settings.general.numberFormatHint')}>
      <Segmented label={t('ui.numberFormat.label')} value={format} options={NUMBER_FORMATS.map((option) => ({ value: option.id, label: t(option.labelKey) }))} onChange={setFormat} />
    </SettingRow>
  </section>;
}

type DotState = RemoteIndicatorState | 'unknown';

function serverState(remote: RemoteHostStatus | undefined, errors: readonly string[]): DotState {
  return remote ? remoteIndicatorState(remote, errors) : 'unknown';
}

function toolsSummary(server: ServerInfo, allTools: string): string {
  return !server.tools || server.tools.length === TRACE_TOOLS.length ? allTools : server.tools.map((tool) => TOOL_LABELS[tool]).join(', ');
}

type Removal = { server: ServerInfo; cleanup: boolean; phase: 'confirm' | 'running' | 'failed' | 'done'; message?: string };

function ServersSection({ bridge, remotes, remoteErrors }: { bridge: MonitorBridge; remotes: RemoteHostStatus[]; remoteErrors: Record<string, string[]> }) {
  const { t } = useI18n();
  const [servers, setServers] = useState<ServerInfo[]>();
  const [loadError, setLoadError] = useState<string>();
  const [dialog, setDialog] = useState<{ kind: 'add' } | { kind: 'edit'; server: ServerInfo }>();
  const [removal, setRemoval] = useState<Removal>();
  const remoteIds = remotes.map((remote) => remote.id).join('\n');

  const load = useCallback(async () => {
    try { setServers(await bridge.listServers()); setLoadError(undefined); } catch (error) { setLoadError(errorMessage(error)); }
  }, [bridge]);
  // Reload when the set of servers the monitor reports changes (added or removed elsewhere).
  useEffect(() => { void load(); }, [load, remoteIds]);

  async function remove(target: Removal) {
    setRemoval({ ...target, phase: 'running' });
    let next: Removal;
    try {
      const result = await bridge.removeServer({ id: target.server.id, cleanup: target.server.managed && target.cleanup });
      next = result.ok
        ? { ...target, phase: 'done', message: result.cleanupError ? t('servers.removeCleanupFailed', { label: target.server.label, error: result.cleanupError }) : undefined }
        : { ...target, phase: 'failed', message: t('servers.removeFailed', { error: result.message }) };
    } catch (error) { next = { ...target, phase: 'failed', message: t('servers.removeFailed', { error: errorMessage(error) }) }; }
    setRemoval(next.phase === 'done' && !next.message ? undefined : next);
    void load();
  }

  function renderRemoval(server: ServerInfo) {
    if (removal?.server.id !== server.id) return null;
    if (removal.phase === 'done' || removal.phase === 'failed') {
      return <div className="servers-flow" role="alert"><p className="servers-error__title"><AlertCircle size={14} aria-hidden="true" />{removal.message}</p><div className="servers-actions"><button type="button" className="button button--small" onClick={() => setRemoval(undefined)}>{t('servers.dismiss')}</button></div></div>;
    }
    const running = removal.phase === 'running';
    return <div className="servers-flow" role="group" aria-label={t('servers.confirmRemove.title', { label: server.label })}>
      <p className="servers-flow__title">{t('servers.confirmRemove.title', { label: server.label })}</p>
      <p>{t('servers.confirmRemove.body')}</p>
      {server.managed && <label className="servers-check"><input type="checkbox" checked={removal.cleanup} disabled={running} onChange={(event) => setRemoval({ ...removal, cleanup: event.target.checked })} />{t('servers.confirmRemove.cleanup')}</label>}
      <div className="servers-actions">
        <button type="button" className="button button--small" disabled={running} onClick={() => setRemoval(undefined)}>{t('servers.cancel')}</button>
        <button type="button" className="button button--danger button--small" disabled={running} onClick={() => void remove(removal)}>{running && <LoaderCircle size={12} className="spin" aria-hidden="true" />}{t('servers.confirmRemove.confirm')}</button>
      </div>
    </div>;
  }

  return <>
    <div className="settings-toolbar"><button type="button" className="button button--primary button--small" onClick={() => setDialog({ kind: 'add' })}><Plus size={13} aria-hidden="true" />{t('servers.addServer')}</button></div>
    {loadError ? <p className="settings-message settings-message--error" role="alert">{t('servers.loadFailed', { error: loadError })}</p>
      : !servers ? <p className="settings-message"><LoaderCircle size={14} className="spin" aria-hidden="true" />{t('servers.loading')}</p>
        : !servers.length ? <p className="settings-message">{t('servers.empty')}</p>
          : <ul className="server-list">{servers.map((server) => {
            const remote = remotes.find((item) => item.id === server.id);
            const errors = remoteErrors[server.id] ?? [];
            const state = serverState(remote, errors);
            const stateLabel = t(remote ? `servers.state.${remote.state}` : 'servers.state.unknown');
            const detail = remote?.state === 'error' ? remote.error ?? errors[0]?.slice(remote.label.length + 3) : errors[0]?.slice((remote?.label.length ?? 0) + 3);
            const args = formatSshArgs(server.sshArgs);
            return <li key={server.id} className={`server-row server-row--${state}`}>
              <div className="server-row__main">
                <span className={`status-dot status-dot--${state}`} aria-hidden="true" title={remote ? remoteStatusTitle(remote, errors) : undefined} />
                <div className="server-row__text">
                  <span className="server-row__label">{server.label}{!server.managed && <span className="server-row__tag" title={t('servers.manualTitle')}>{t('servers.manual')}</span>}</span>
                  <span className="server-row__meta"><code>ssh {server.ssh}{args ? ` ${args}` : ''}</code><span>{toolsSummary(server, t('servers.allTools'))}</span></span>
                </div>
                <span className="server-row__state">{stateLabel}</span>
                <button type="button" className="icon-button" aria-label={t('servers.editAria', { label: server.label })} title={t('servers.edit')} disabled={removal?.server.id === server.id} onClick={() => setDialog({ kind: 'edit', server })}><Pencil size={14} aria-hidden="true" /></button>
                <button type="button" className="icon-button icon-button--danger" aria-label={t('servers.removeAria', { label: server.label })} title={t('servers.remove')} disabled={removal?.phase === 'running'} onClick={() => setRemoval({ server, cleanup: server.managed, phase: 'confirm' })}><Trash2 size={14} aria-hidden="true" /></button>
              </div>
              {(detail || (remote && remote.state !== 'connected' && remote.lastConnectedAt)) && <p className={`server-row__detail${remote?.state === 'error' ? ' server-row__detail--error' : ''}`}>
                {[detail, remote && remote.state !== 'connected' && remote.lastConnectedAt ? t('servers.lastConnected', { time: formatRelativeTime(remote.lastConnectedAt) }) : undefined].filter(Boolean).join(' · ')}
              </p>}
              {renderRemoval(server)}
            </li>;
          })}</ul>}
    {dialog?.kind === 'add' && <AddServerDialog bridge={bridge} onClose={() => setDialog(undefined)} onAdded={() => void load()} />}
    {dialog?.kind === 'edit' && <EditServerDialog bridge={bridge} server={dialog.server} onClose={() => setDialog(undefined)} onSaved={() => void load()} />}
  </>;
}

const LOCAL_PLACEHOLDERS = Object.fromEntries(TRACE_TOOLS.map((tool) => [tool, defaultTraceDir(tool)])) as Record<TraceTool, string>;

function LocalSection({ bridge }: { bridge: MonitorBridge }) {
  const { t } = useI18n();
  const [saved, setSaved] = useState<AppSettings>();
  const [form, setForm] = useState<TraceSourceForm>();
  const [loadError, setLoadError] = useState<string>();
  const [validation, setValidation] = useState<TraceFormResult>();
  const [status, setStatus] = useState<{ kind: 'saving' } | { kind: 'saved' } | { kind: 'error'; message: string }>();

  useEffect(() => {
    let cancelled = false;
    bridge.getSettings().then((settings) => {
      if (cancelled) return;
      setSaved(settings);
      setForm(traceFormFromOptions(settings.local));
    }, (error) => { if (!cancelled) setLoadError(errorMessage(error)); });
    return () => { cancelled = true; };
  }, [bridge]);

  if (loadError) return <p className="settings-message settings-message--error" role="alert">{t('settings.local.loadFailed', { error: loadError })}</p>;
  if (!saved || !form) return <p className="settings-message"><LoaderCircle size={14} className="spin" aria-hidden="true" />{t('settings.local.loading')}</p>;

  const baseline = traceFormFromOptions(saved.local);
  const dirty = !sameTraceForm(form, baseline);
  const defaults = traceFormFromOptions();
  const saving = status?.kind === 'saving';

  function change(next: TraceSourceForm) {
    setForm(next);
    if (status?.kind !== 'saving') setStatus(undefined);
    if (validation) setValidation(traceOptionsFromForm(next));
  }

  async function save() {
    if (!form || !saved) return;
    const checked = traceOptionsFromForm(form);
    setValidation(checked);
    if (!checked.ok) return;
    setStatus({ kind: 'saving' });
    try {
      const result = await bridge.updateSettings({ ...saved, local: checked.options });
      if (result.ok) {
        setSaved(result.settings);
        setForm(traceFormFromOptions(result.settings.local));
        setValidation(undefined);
        setStatus({ kind: 'saved' });
      } else setStatus({ kind: 'error', message: result.message });
    } catch (error) { setStatus({ kind: 'error', message: errorMessage(error) }); }
  }

  return <section className="settings-card settings-card--padded">
    <TraceSourceFields form={form} onChange={change} placeholders={LOCAL_PLACEHOLDERS} errors={validation && !validation.ok ? validation.errors : undefined} disabled={saving} />
    <div className="settings-actions">
      {status?.kind === 'saved' && <span className="settings-status settings-status--ok" role="status"><CheckCircle2 size={13} aria-hidden="true" />{t('settings.local.saved')}</span>}
      {status?.kind === 'error' && <span className="settings-status settings-status--error" role="alert"><AlertCircle size={13} aria-hidden="true" />{t('settings.local.saveFailed', { error: status.message })}</span>}
      <span className="modal__spacer" />
      <button type="button" className="button button--small" disabled={saving || sameTraceForm(form, defaults)} onClick={() => change(defaults)}>{t('settings.local.reset')}</button>
      <button type="button" className="button button--small" disabled={saving || !dirty} onClick={() => { change(baseline); setValidation(undefined); }}>{t('settings.local.discard')}</button>
      <button type="button" className="button button--primary button--small" disabled={saving || !dirty} onClick={() => void save()}>{saving && <LoaderCircle size={12} className="spin" aria-hidden="true" />}{saving ? t('settings.local.saving') : t('settings.local.save')}</button>
    </div>
  </section>;
}

const VENDOR_LABELS: Record<string, string> = { openai: 'OpenAI', anthropic: 'Anthropic', xai: 'xAI' };

function PricingSection() {
  const { t, locale } = useI18n();
  const usd = (value: number | undefined) => value === undefined ? '—' : formatUsd(value, { minimumFractionDigits: 2, maximumFractionDigits: 3 });
  const prices = listModelPrices();
  const verified = new Date(`${PRICING_VERIFIED_AT}T00:00:00`).toLocaleDateString(locale, { year: 'numeric', month: 'long', day: 'numeric' });
  return <>
    <section className="settings-card">
      <table className="pricing-table">
        <caption className="sr-only">{t('settings.pricing.perMillion')}</caption>
        <thead><tr>
          <th scope="col">{t('settings.pricing.model')}</th>
          <th scope="col">{t('settings.pricing.vendor')}</th>
          <th scope="col" className="num">{t('settings.pricing.input')}</th>
          <th scope="col" className="num">{t('settings.pricing.cachedInput')}</th>
          <th scope="col" className="num">{t('settings.pricing.cacheWrite')}</th>
          <th scope="col" className="num">{t('settings.pricing.output')}</th>
        </tr></thead>
        <tbody>{prices.map((price) => {
          const notes = [
            price.write1h !== undefined ? t('settings.pricing.cacheWrite1h', { price: usd(price.write1h) }) : undefined,
            price.threshold && price.long ? t('settings.pricing.longContext', { threshold: formatNumber(price.threshold), input: usd(price.long.input), output: usd(price.long.output) }) : undefined,
          ].filter(Boolean);
          return <tr key={price.model}>
            <th scope="row"><code>{price.model}</code>{notes.map((note) => <span key={note} className="pricing-table__note">{note}</span>)}</th>
            <td>{VENDOR_LABELS[price.vendor] ?? price.vendor}</td>
            <td className="num">{usd(price.input)}</td>
            <td className="num">{usd(price.read)}</td>
            <td className="num">{usd(price.write)}</td>
            <td className="num">{usd(price.output)}</td>
          </tr>;
        })}</tbody>
      </table>
    </section>
    <p className="settings-note">{t('settings.pricing.perMillion')} · {t('settings.pricing.verified', { date: verified })} {t('settings.pricing.unknownModels')}</p>
    <div className="settings-links"><span>{t('settings.pricing.sources')}</span><ul>{PRICING_SOURCES.map((source) => <li key={source}><code>{source}</code></li>)}</ul></div>
  </>;
}

function AboutSection({ bridge, mode, watching, localErrors, remotes, remoteErrors }: { bridge?: MonitorBridge; mode: MonitorMode; watching: boolean; localErrors: string[]; remotes: RemoteHostStatus[]; remoteErrors: Record<string, string[]> }) {
  const { t } = useI18n();
  const localState: DotState = mode !== 'live' ? (mode === 'loading' ? 'connecting' : 'error') : localErrors.length ? 'warning' : watching ? 'connected' : 'unknown';
  const localLabel = mode === 'offline' ? t('settings.about.offline') : mode === 'loading' ? t('settings.about.connecting') : watching ? t('settings.about.watching') : t('settings.about.paused');
  const connected = remotes.filter((remote) => remote.state === 'connected').length;
  return <>
    <section className="settings-card">
      <SettingRow label={t('settings.about.localWatcher')} hint={localErrors.length ? t('settings.about.issues', { count: localErrors.length }) : mode === 'live' ? t('settings.about.noIssues') : undefined}>
        <span className="status-line"><span className={`status-dot status-dot--${localState}`} aria-hidden="true" />{localLabel}</span>
      </SettingRow>
      {localErrors.length > 0 && <ul className="issue-list">{localErrors.map((error, index) => <li key={`${index}-${error}`}><AlertCircle size={13} aria-hidden="true" /><span>{error}</span></li>)}</ul>}
      <SettingRow label={t('settings.about.servers')}>
        <span className="status-line">{remotes.length ? t('settings.about.serversConnected', { connected, total: remotes.length }) : t('settings.about.noServers')}</span>
      </SettingRow>
      {remotes.length > 0 && <ul className="issue-list issue-list--plain">{remotes.map((remote) => {
        const errors = remoteErrors[remote.id] ?? [];
        return <li key={remote.id}><span className={`status-dot status-dot--${remoteIndicatorState(remote, errors)}`} aria-hidden="true" /><span>{remoteStatusTitle(remote, errors).split('\n').join(' · ')}</span></li>;
      })}</ul>}
    </section>
    <section className="settings-card">
      <SettingRow label={t('settings.about.version')}><span className="status-line"><code>Agent Monitor {appVersion}</code></span></SettingRow>
      {bridge?.platform && <SettingRow label={t('settings.about.platform')}><span className="status-line"><code>{bridge.platform}</code></span></SettingRow>}
      <SettingRow label={t('settings.about.shortcut')}><kbd className="kbd">{settingsShortcut(bridge?.platform)}</kbd></SettingRow>
    </section>
  </>;
}
