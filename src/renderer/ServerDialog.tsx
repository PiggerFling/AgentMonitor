import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { AlertCircle, ArrowLeft, Check, CheckCircle2, ChevronRight, CircleDot, Copy, LoaderCircle, RefreshCw, Search, TriangleAlert, X } from 'lucide-react';
import { TRACE_TOOLS } from '../shared/types';
import type { AddServerResult, MonitorBridge, ProbeServerResult, ServerInfo, ServerSetupProgress, ServerSetupStep, SshHostInfo, TraceTool } from '../shared/types';
import { useI18n, type MessageKey } from './i18n';
import { customProbeDirs, defaultTraceDir, filterSshHosts, formatSshArgs, parseSshArgs, traceFormFromOptions, traceFormFromProbe, traceOptionsFromForm, type TraceFormResult, type TraceSourceForm } from './serverForm';
import { TraceSourceFields } from './TraceSourceFields';

type Failure = Extract<AddServerResult, { ok: false }>;
type ProbeOk = Extract<ProbeServerResult, { ok: true }>;
type StepState = ServerSetupProgress['state'];

const STEPS: ServerSetupStep[] = ['probe', 'install', 'save'];
const NVM_COMMANDS = 'curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash\n\\. "$HOME/.nvm/nvm.sh"\nnvm install 22';
const ERROR_KEYS: Record<Failure['code'], MessageKey> = {
  auth: 'servers.errors.auth', 'host-key': 'servers.errors.hostKey', 'host-key-changed': 'servers.errors.hostKeyChanged', unreachable: 'servers.errors.unreachable',
  'unsupported-os': 'servers.errors.unsupportedOs', 'node-missing': 'servers.errors.nodeMissing', 'node-too-old': 'servers.errors.nodeTooOld', 'install-failed': 'servers.errors.installFailed',
  'already-added': 'servers.errors.alreadyAdded', busy: 'servers.errors.busy', 'save-failed': 'servers.errors.saveFailed', failed: 'servers.errors.failed',
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `user@hostName:port` as far as ~/.ssh/config spells it out. */
export function hostHint(host: Pick<SshHostInfo, 'alias' | 'hostName' | 'user' | 'port'>): string {
  return `${host.user ? `${host.user}@` : ''}${host.hostName ?? host.alias}${host.port ? `:${host.port}` : ''}`;
}

/** Single-quotes a value for a POSIX shell command shown to the user. */
function shellQuote(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

function CodeBlock({ code }: { code: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return <div className="servers-code"><pre>{code}</pre><button type="button" className="button button--quiet servers-code__copy" aria-label={t('servers.copyAria')} onClick={() => { void navigator.clipboard?.writeText(code).then(() => setCopied(true), () => undefined); }}>{copied ? <Check size={12} aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}{copied ? t('servers.copied') : t('servers.copy')}</button></div>;
}

function StepList({ steps }: { steps: Partial<Record<ServerSetupStep, StepState>> }) {
  const { t } = useI18n();
  return <ol className="servers-steps" aria-label={t('servers.steps.label')}>{STEPS.map(step => {
    const state = steps[step];
    const icon = state === 'running' ? <LoaderCircle size={13} className="spin" aria-hidden="true" /> : state === 'done' ? <CheckCircle2 size={13} aria-hidden="true" /> : state === 'failed' ? <AlertCircle size={13} aria-hidden="true" /> : <CircleDot size={13} aria-hidden="true" />;
    return <li key={step} className={`servers-steps__item servers-steps__item--${state ?? 'pending'}`}>{icon}<span>{t(`servers.steps.${step}`)}</span><span className="sr-only">{` (${t(`servers.steps.${state ?? 'pending'}`)})`}</span></li>;
  })}</ol>;
}

/** Explains a failed probe or add with the fixes the user can apply; `onRetry(true)` retries trusting the shown host key. */
function SetupFailure({ failure, host, platform, onRetry }: { failure: Failure; host: SshHostInfo; platform?: string; onRetry: (acceptNewHostKey: boolean) => void }) {
  const { t } = useI18n();
  const alias = host.alias;
  const knownHost = host.port && host.port !== 22 ? `[${host.hostName ?? alias}]:${host.port}` : host.hostName ?? alias;
  const strong = failure.code === 'host-key-changed';
  const generic = failure.code === 'failed' || failure.code === 'install-failed' || failure.code === 'save-failed' || failure.code === 'unsupported-os';
  const detail = failure.detail?.trim() || (generic ? failure.message : '');
  let fix: ReactNode = null;
  let retry = true;
  if (failure.code === 'auth') fix = <><p>{t('servers.errors.authFix')}</p><CodeBlock code={`ssh-copy-id ${shellQuote(alias)}`} />{platform === 'darwin' && <><p>{t('servers.errors.authMac')}</p><CodeBlock code="ssh-add --apple-use-keychain ~/.ssh/id_ed25519" /></>}</>;
  else if (failure.code === 'host-key') {
    retry = false;
    fix = <><p>{t('servers.errors.hostKeyFix', { alias })}</p>{failure.fingerprint && <div className="servers-fingerprint"><span>{t('servers.errors.fingerprint')}</span><code>{failure.fingerprint}</code></div>}</>;
  } else if (failure.code === 'host-key-changed') fix = <><p>{t('servers.errors.hostKeyChangedFix')}</p><CodeBlock code={`ssh-keygen -R ${shellQuote(knownHost)}\nssh ${shellQuote(alias)}`} /></>;
  else if (failure.code === 'node-missing' || failure.code === 'node-too-old') fix = <><p>{t('servers.errors.nodeFix', { alias })}</p><CodeBlock code={NVM_COMMANDS} /></>;
  else if (failure.code === 'unreachable') fix = <p>{t('servers.errors.unreachableFix', { alias })}</p>;
  else if (failure.code === 'already-added') retry = false;
  return <div className={`servers-error${strong ? ' servers-error--strong' : ''}`} role="alert">
    <p className="servers-error__title">{strong ? <TriangleAlert size={14} aria-hidden="true" /> : <AlertCircle size={14} aria-hidden="true" />}{t(ERROR_KEYS[failure.code], { alias, version: failure.nodeVersion ?? '?' })}</p>
    {fix}
    {detail && <details className="servers-detail" open={!fix}><summary>{t('servers.errors.detail')}</summary><pre>{detail}</pre></details>}
    {(retry || failure.code === 'host-key') && <div className="servers-actions">
      {failure.code === 'host-key' && <button type="button" className="button button--primary button--small" onClick={() => onRetry(true)}>{t('servers.dialog.trustContinue')}</button>}
      {retry && <button type="button" className="button button--small" onClick={() => onRetry(false)}><RefreshCw size={12} aria-hidden="true" />{t('servers.retry')}</button>}
    </div>}
  </div>;
}

const FOCUSABLE = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], summary, [tabindex]:not([tabindex="-1"])';

/** A modal dialog: keeps focus inside, closes on Escape unless `onClose` is omitted (e.g. while busy). */
export function Modal({ title, onClose, children, footer, wide = false }: { title: ReactNode; onClose?: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const { t } = useI18n();
  const id = useId();
  const panel = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const first = panel.current?.querySelector<HTMLElement>('[data-autofocus]') ?? panel.current;
    first?.focus({ preventScroll: true });
    // On the document so Escape and Tab still work after the focused control unmounts (e.g. when a step finishes).
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      const root = panel.current;
      if (!root) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeRef.current?.();
        return;
      }
      if (event.key !== 'Tab') return;
      const items = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((element) => element.offsetParent !== null);
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (!root.contains(active)) { event.preventDefault(); (event.shiftKey ? last : first).focus(); }
      else if (event.shiftKey && (active === first || active === root)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && active === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      previous?.focus?.({ preventScroll: true });
    };
  }, []);
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose?.(); }}>
    <div ref={panel} className={`modal${wide ? ' modal--wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} tabIndex={-1}>
      <header className="modal__head">
        <h2 id={`${id}-title`}>{title}</h2>
        <button type="button" className="icon-button" aria-label={t('servers.close')} title={t('servers.close')} disabled={!onClose} onClick={onClose}><X size={16} aria-hidden="true" /></button>
      </header>
      <div className="modal__body">{children}</div>
      {footer && <footer className="modal__foot">{footer}</footer>}
    </div>
  </div>;
}

type Probe = { state: 'running' } | { state: 'ok'; result: ProbeOk } | { state: 'failed'; failure: Failure };
type Submit = { state: 'idle' } | { state: 'running'; steps: Partial<Record<ServerSetupStep, StepState>> } | { state: 'failed'; steps: Partial<Record<ServerSetupStep, StepState>>; failure: Failure };

function placeholdersFor(home?: string): Record<TraceTool, string> {
  return Object.fromEntries(TRACE_TOOLS.map((tool) => [tool, defaultTraceDir(tool, home)])) as Record<TraceTool, string>;
}

/** Shared label / ssh args / tools fields of the add and edit forms. */
function ServerFields({ alias, label, onLabel, sshArgs, onSshArgs, form, onForm, validation, placeholders, notes, disabled, labelAutofocus }: {
  alias: string; label: string; onLabel: (value: string) => void; sshArgs: string; onSshArgs: (value: string) => void;
  form: TraceSourceForm; onForm: (form: TraceSourceForm) => void; validation?: TraceFormResult; placeholders: Record<TraceTool, string>;
  notes?: Partial<Record<TraceTool, string>>; disabled: boolean; labelAutofocus?: boolean;
}) {
  const { t } = useI18n();
  const id = useId();
  return <>
    <div className="form-field">
      <label htmlFor={`${id}-label`}>{t('servers.dialog.label')}</label>
      <input id={`${id}-label`} className="text-input" value={label} placeholder={alias} disabled={disabled} onChange={(event) => onLabel(event.target.value)} aria-describedby={`${id}-label-hint`} {...(labelAutofocus ? { 'data-autofocus': true } : {})} />
      <span id={`${id}-label-hint`} className="form-hint">{t('servers.dialog.labelHint')}</span>
    </div>
    <div className="form-field">
      <label htmlFor={`${id}-ssh`}>{t('servers.dialog.sshArgs')}</label>
      <input id={`${id}-ssh`} className="text-input text-input--mono" value={sshArgs} placeholder="-J bastion" spellCheck={false} autoComplete="off" disabled={disabled} onChange={(event) => onSshArgs(event.target.value)} aria-describedby={`${id}-ssh-hint`} />
      <span id={`${id}-ssh-hint`} className="form-hint">{t('servers.dialog.sshArgsHint')}</span>
    </div>
    <div className="form-field">
      <span className="form-field__label">{t('servers.dialog.sources')}</span>
      <span className="form-hint">{t('servers.dialog.sourcesHint')}</span>
      <TraceSourceFields form={form} onChange={onForm} placeholders={placeholders} notes={notes} errors={validation && !validation.ok ? validation.errors : undefined} disabled={disabled} />
    </div>
  </>;
}

/** Adds a host from ~/.ssh/config: pick the host, then review what a probe found and confirm. */
export function AddServerDialog({ bridge, onClose, onAdded }: { bridge: MonitorBridge; onClose: () => void; onAdded: (serverId: string) => void }) {
  const { t } = useI18n();
  const [hosts, setHosts] = useState<SshHostInfo[]>();
  const [hostsLoading, setHostsLoading] = useState(false);
  const [hostsError, setHostsError] = useState<string>();
  const [query, setQuery] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [host, setHost] = useState<SshHostInfo>();
  const [label, setLabel] = useState('');
  const [sshArgs, setSshArgs] = useState('');
  const [form, setForm] = useState<TraceSourceForm>(() => traceFormFromOptions());
  const [touched, setTouched] = useState(false);
  const [validation, setValidation] = useState<TraceFormResult>();
  const [probe, setProbe] = useState<Probe>();
  const [acceptedHostKey, setAcceptedHostKey] = useState(false);
  const [submit, setSubmit] = useState<Submit>({ state: 'idle' });
  const probeRequest = useRef(0);
  const submitAlias = useRef<string | undefined>(undefined);
  const busy = submit.state === 'running';

  const loadHosts = useCallback(async () => {
    setHostsLoading(true);
    setHostsError(undefined);
    try { setHosts(await bridge.listSshHosts()); } catch (error) { setHostsError(errorMessage(error)); } finally { setHostsLoading(false); }
  }, [bridge]);
  useEffect(() => { void loadHosts(); }, [loadHosts]);

  useEffect(() => bridge.onServerSetupProgress((progress) => {
    if (progress.alias !== submitAlias.current) return;
    setSubmit((current) => current.state === 'running' ? { ...current, steps: { ...current.steps, [progress.step]: progress.state } } : current);
  }), [bridge]);

  const runProbe = useCallback(async (target: SshHostInfo, args: string[], acceptNewHostKey: boolean, prefill: boolean) => {
    const request = ++probeRequest.current;
    setProbe({ state: 'running' });
    let result: ProbeServerResult;
    try { result = await bridge.probeServer({ alias: target.alias, ...(args.length ? { sshArgs: args } : {}), ...(acceptNewHostKey ? { acceptNewHostKey: true } : {}) }); } catch (error) { result = { ok: false, code: 'failed', message: errorMessage(error) }; }
    if (request !== probeRequest.current) return;
    if (result.ok) {
      setProbe({ state: 'ok', result });
      if (prefill) setForm(traceFormFromProbe(result.detected, result.present, result.home));
    } else setProbe({ state: 'failed', failure: result });
  }, [bridge]);

  function choose(target: SshHostInfo) {
    setHost(target);
    setLabel('');
    setSshArgs('');
    setForm(traceFormFromOptions());
    setTouched(false);
    setValidation(undefined);
    setAcceptedHostKey(false);
    setSubmit({ state: 'idle' });
    void runProbe(target, [], false, true);
  }

  function back() {
    ++probeRequest.current;
    setHost(undefined);
    setProbe(undefined);
    setSubmit({ state: 'idle' });
  }

  function retryProbe(acceptNewHostKey: boolean) {
    if (!host) return;
    const accept = acceptNewHostKey || acceptedHostKey;
    if (acceptNewHostKey) setAcceptedHostKey(true);
    void runProbe(host, parseSshArgs(sshArgs), accept, !touched);
  }

  async function add(acceptNewHostKey = false) {
    if (!host) return;
    const checked = traceOptionsFromForm(form);
    setValidation(checked);
    if (!checked.ok) return;
    const accept = acceptNewHostKey || acceptedHostKey;
    if (acceptNewHostKey) setAcceptedHostKey(true);
    const args = parseSshArgs(sshArgs);
    submitAlias.current = host.alias;
    setSubmit({ state: 'running', steps: {} });
    let result: AddServerResult;
    try {
      result = await bridge.addServer({ alias: host.alias, ...(label.trim() ? { label: label.trim() } : {}), ...(args.length ? { sshArgs: args } : {}), ...checked.options, ...(accept ? { acceptNewHostKey: true } : {}) });
    } catch (error) { result = { ok: false, code: 'failed', message: errorMessage(error) }; }
    submitAlias.current = undefined;
    if (result.ok) { onAdded(result.serverId); onClose(); return; }
    const failure = result;
    setSubmit((current) => ({ state: 'failed', steps: current.state === 'idle' ? {} : current.steps, failure }));
  }

  const view = useMemo(() => filterSshHosts(hosts ?? [], query, showAll), [hosts, query, showAll]);
  const probeResult = probe?.state === 'ok' ? probe.result : undefined;
  const notes = useMemo(() => {
    if (!probeResult) return {};
    const custom = customProbeDirs(probeResult.detected, probeResult.home);
    return Object.fromEntries(TRACE_TOOLS.map((tool) => [tool, custom[tool] ? t('settings.sources.detected') : probeResult.present.includes(tool) ? undefined : t('settings.sources.noData')]).filter(([, note]) => note)) as Partial<Record<TraceTool, string>>;
  }, [probeResult, t]);

  if (!host) {
    return <Modal key="pick" title={t('servers.dialog.addTitle')} onClose={onClose} wide>
      <p className="modal__lead">{t('servers.dialog.pickHost')}</p>
      <div className="host-search">
        <Search size={14} aria-hidden="true" />
        <input type="search" className="text-input" value={query} placeholder={t('servers.dialog.searchPlaceholder')} aria-label={t('servers.dialog.search')} onChange={(event) => setQuery(event.target.value)} data-autofocus
          onKeyDown={(event) => { if (event.key === 'Enter') { const first = view.hosts.find((item) => !item.serverId); if (first) choose(first); } }} />
        <button type="button" className="icon-button" aria-label={t('servers.dialog.refresh')} title={t('servers.dialog.refresh')} disabled={hostsLoading} onClick={() => void loadHosts()}><RefreshCw size={14} className={hostsLoading ? 'spin' : undefined} aria-hidden="true" /></button>
      </div>
      {hostsError ? <p className="settings-message settings-message--error" role="alert">{t('servers.dialog.hostsFailed', { error: hostsError })}</p>
        : !hosts ? <p className="settings-message"><LoaderCircle size={14} className="spin" aria-hidden="true" />{t('servers.dialog.hostsLoading')}</p>
          : !hosts.length ? <p className="settings-message">{t('servers.dialog.hostsEmpty')}</p>
            : <>
              {view.hosts.length ? <ul className="host-list">{view.hosts.map((item) => <li key={item.alias}>
                <button type="button" className="host-option" disabled={Boolean(item.serverId)} onClick={() => choose(item)}>
                  <span className="host-option__text"><span className="host-option__alias">{item.alias}</span><span className="host-option__hint">{hostHint(item)}</span></span>
                  {item.serverId ? <span className="host-option__added"><Check size={12} aria-hidden="true" />{t('servers.dialog.added')}</span> : <ChevronRight size={15} aria-hidden="true" className="host-option__go" />}
                </button>
              </li>)}</ul> : <p className="settings-message">{query.trim() ? t('servers.dialog.noMatch', { query: query.trim() }) : t('servers.dialog.hostsEmpty')}</p>}
              {view.forgeHosts > 0 && <button type="button" className="link-button" onClick={() => setShowAll((value) => !value)}>{showAll ? t('servers.dialog.hideForge') : t('servers.dialog.showForge', { count: view.hiddenForgeHosts })}</button>}
            </>}
    </Modal>;
  }

  const disabled = busy;
  const failure = submit.state === 'failed' ? submit.failure : undefined;
  return <Modal key="form" title={t('servers.dialog.addTitle')} onClose={busy ? undefined : onClose} wide footer={<>
    <button type="button" className="button button--small" disabled={busy} onClick={back}><ArrowLeft size={13} aria-hidden="true" />{t('servers.dialog.back')}</button>
    <span className="modal__spacer" />
    <button type="button" className="button button--small" disabled={busy} onClick={onClose}>{t('servers.cancel')}</button>
    <button type="button" className="button button--primary button--small" disabled={busy || probe?.state !== 'ok'} onClick={() => void add()}>{busy && <LoaderCircle size={12} className="spin" aria-hidden="true" />}{t('servers.dialog.submit')}</button>
  </>}>
    <div className="probe-card">
      <div className="probe-card__host"><span className="probe-card__alias">{host.alias}</span><span className="probe-card__hint">{hostHint(host)}</span></div>
      {probe?.state === 'running' && <p className="probe-card__status" aria-live="polite"><LoaderCircle size={13} className="spin" aria-hidden="true" />{t('servers.dialog.probing', { alias: host.alias })}</p>}
      {probeResult && <p className="probe-card__status probe-card__status--ok"><CheckCircle2 size={13} aria-hidden="true" /><span>{t('servers.dialog.probeSummary', { os: probeResult.os, arch: probeResult.arch, node: probeResult.nodeVersion })}<span className="probe-card__home"> · {t('servers.dialog.probeHome', { home: probeResult.home })}</span></span>
        <button type="button" className="button button--quiet" disabled={busy} onClick={() => retryProbe(false)}><RefreshCw size={11} aria-hidden="true" />{t('servers.dialog.checkAgain')}</button></p>}
    </div>
    {probe?.state === 'failed' && <SetupFailure failure={probe.failure} host={host} platform={bridge.platform} onRetry={retryProbe} />}
    <ServerFields alias={host.alias} label={label} onLabel={setLabel} sshArgs={sshArgs} onSshArgs={setSshArgs} form={form}
      onForm={(next) => { setForm(next); setTouched(true); if (validation) setValidation(traceOptionsFromForm(next)); }} validation={validation}
      placeholders={placeholdersFor(probeResult?.home)} notes={notes} disabled={disabled} />
    <p className="settings-note">{t('servers.dialog.installNote')}</p>
    {submit.state !== 'idle' && <div className="servers-flow" aria-live="polite"><StepList steps={submit.steps} /></div>}
    {failure && <SetupFailure failure={failure} host={host} platform={bridge.platform} onRetry={(accept) => void add(accept)} />}
  </Modal>;
}

/** Edits a configured server's name, ssh arguments, tools and data directories. */
export function EditServerDialog({ bridge, server, onClose, onSaved }: { bridge: MonitorBridge; server: ServerInfo; onClose: () => void; onSaved: () => void }) {
  const { t } = useI18n();
  const [label, setLabel] = useState(server.label);
  const [sshArgs, setSshArgs] = useState(formatSshArgs(server.sshArgs));
  const [form, setForm] = useState<TraceSourceForm>(() => traceFormFromOptions(server));
  const [validation, setValidation] = useState<TraceFormResult>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  async function save() {
    const checked = traceOptionsFromForm(form);
    setValidation(checked);
    if (!checked.ok) return;
    setSaving(true);
    setError(undefined);
    try {
      // Send every field so the update also covers resets: an empty label, no ssh args, all tools, no custom directories.
      const result = await bridge.updateServer({ id: server.id, label: label.trim(), sshArgs: parseSshArgs(sshArgs), tools: checked.options.tools ?? [...TRACE_TOOLS], traceDirs: checked.options.traceDirs ?? {} });
      if (result.ok) { onSaved(); onClose(); return; }
      setError(result.message);
    } catch (caught) { setError(errorMessage(caught)); }
    setSaving(false);
  }

  return <Modal title={t('servers.dialog.editTitle', { label: server.label })} onClose={saving ? undefined : onClose} wide footer={<>
    <span className="modal__spacer" />
    <button type="button" className="button button--small" disabled={saving} onClick={onClose}>{t('servers.cancel')}</button>
    <button type="button" className="button button--primary button--small" disabled={saving} onClick={() => void save()}>{saving && <LoaderCircle size={12} className="spin" aria-hidden="true" />}{saving ? t('servers.dialog.saving') : t('servers.dialog.save')}</button>
  </>}>
    <div className="probe-card"><div className="probe-card__host"><span className="probe-card__alias">{server.ssh}</span></div></div>
    <ServerFields alias={server.ssh} label={label} onLabel={setLabel} sshArgs={sshArgs} onSshArgs={setSshArgs} form={form}
      onForm={(next) => { setForm(next); if (validation) setValidation(traceOptionsFromForm(next)); }} validation={validation}
      placeholders={placeholdersFor()} disabled={saving} labelAutofocus />
    {!server.managed && <p className="settings-note settings-note--warning">{t('servers.dialog.manualNote')}</p>}
    {error && <p className="settings-message settings-message--error" role="alert">{t('servers.dialog.saveFailed', { error })}</p>}
  </Modal>;
}
