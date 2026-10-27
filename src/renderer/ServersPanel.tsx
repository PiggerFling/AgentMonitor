import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { AlertCircle, Check, CheckCircle2, CircleDot, Copy, LoaderCircle, RefreshCw, Server, TriangleAlert, X } from 'lucide-react';
import type { AddServerResult, MonitorBridge, RemoteHostStatus, ServerSetupProgress, ServerSetupStep, SshHostInfo } from '../shared/types';
import { useI18n, type MessageKey } from './i18n';
import './ServersPanel.css';

type StepState = ServerSetupProgress['state'];
type AddFlow = { kind: 'add'; alias: string; phase: 'confirm' | 'running' | 'done' | 'failed'; steps: Partial<Record<ServerSetupStep, StepState>>; result?: AddServerResult };
type RemoveFlow = { kind: 'remove'; alias: string; id: string; managed: boolean; cleanup: boolean; phase: 'confirm' | 'running' | 'failed' | 'done'; message?: string };
type Flow = AddFlow | RemoveFlow;
type Failure = Extract<AddServerResult, { ok: false }>;

const STEPS: ServerSetupStep[] = ['probe', 'install', 'save'];
const NVM_COMMANDS = 'curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash\n\\. "$HOME/.nvm/nvm.sh"\nnvm install 22';
const ERROR_KEYS: Record<Failure['code'], MessageKey> = {
  auth: 'servers.errors.auth', 'host-key': 'servers.errors.hostKey', 'host-key-changed': 'servers.errors.hostKeyChanged', unreachable: 'servers.errors.unreachable',
  'unsupported-os': 'servers.errors.unsupportedOs', 'node-missing': 'servers.errors.nodeMissing', 'node-too-old': 'servers.errors.nodeTooOld', 'install-failed': 'servers.errors.installFailed',
  'already-added': 'servers.errors.alreadyAdded', busy: 'servers.errors.busy', 'save-failed': 'servers.errors.saveFailed', failed: 'servers.errors.failed',
};

/** `user@hostName:port` as far as ~/.ssh/config spells it out. */
function hostHint(host: SshHostInfo): string {
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

function StepList({ steps }: { steps: AddFlow['steps'] }) {
  const { t } = useI18n();
  return <ol className="servers-steps" aria-label={t('servers.steps.label')}>{STEPS.map(step => {
    const state = steps[step];
    const icon = state === 'running' ? <LoaderCircle size={13} className="spin" aria-hidden="true" /> : state === 'done' ? <CheckCircle2 size={13} aria-hidden="true" /> : state === 'failed' ? <AlertCircle size={13} aria-hidden="true" /> : <CircleDot size={13} aria-hidden="true" />;
    return <li key={step} className={`servers-steps__item servers-steps__item--${state ?? 'pending'}`}>{icon}<span>{t(`servers.steps.${step}`)}</span><span className="sr-only">{` (${t(`servers.steps.${state ?? 'pending'}`)})`}</span></li>;
  })}</ol>;
}

/** Explains a failed add with the fixes the user can apply; `onRetry(true)` retries trusting the shown host key. */
function AddFailure({ failure, host, platform, onRetry, onDismiss }: { failure: Failure; host: SshHostInfo; platform?: string; onRetry: (acceptNewHostKey: boolean) => void; onDismiss: () => void }) {
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
  } else if (failure.code === 'host-key-changed') { retry = false; fix = <><p>{t('servers.errors.hostKeyChangedFix')}</p><CodeBlock code={`ssh-keygen -R ${shellQuote(knownHost)}\nssh ${shellQuote(alias)}`} /></>; }
  else if (failure.code === 'node-missing' || failure.code === 'node-too-old') fix = <><p>{t('servers.errors.nodeFix', { alias })}</p><CodeBlock code={NVM_COMMANDS} /></>;
  else if (failure.code === 'unreachable') fix = <p>{t('servers.errors.unreachableFix', { alias })}</p>;
  else if (failure.code === 'already-added') retry = false;
  return <div className={`servers-error${strong ? ' servers-error--strong' : ''}`} role="alert">
    <p className="servers-error__title">{strong ? <TriangleAlert size={14} aria-hidden="true" /> : <AlertCircle size={14} aria-hidden="true" />}{t(ERROR_KEYS[failure.code], { alias, version: failure.nodeVersion ?? '?' })}</p>
    {fix}
    {detail && <details className="servers-detail" open={!fix}><summary>{t('servers.errors.detail')}</summary><pre>{detail}</pre></details>}
    <div className="servers-actions"><button type="button" className="button button--small" onClick={onDismiss}>{t('servers.dismiss')}</button>{failure.code === 'host-key' && <button type="button" className="button button--primary button--small" onClick={() => onRetry(true)}>{t('servers.errors.trustRetry')}</button>}{retry && <button type="button" className="button button--primary button--small" onClick={() => onRetry(false)}>{t('servers.retry')}</button>}</div>
  </div>;
}

/** Topbar "Servers" button with a popover to add ssh-config hosts as managed servers and remove them. Renders nothing without the desktop bridge. */
export function ServersControl({ remotes }: { remotes?: RemoteHostStatus[] }) {
  const bridge: MonitorBridge | undefined = typeof window !== 'undefined' ? window.agentMonitor : undefined;
  return bridge?.listSshHosts ? <ServersPopover bridge={bridge} remotes={remotes} /> : null;
}

function ServersPopover({ bridge, remotes }: { bridge: MonitorBridge; remotes?: RemoteHostStatus[] }) {
  const { t } = useI18n();
  const id = useId();
  const wrapper = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [hosts, setHosts] = useState<SshHostInfo[]>();
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string>();
  const [flow, setFlow] = useState<Flow>();
  const flowAlias = useRef<string | undefined>(undefined);
  flowAlias.current = flow?.kind === 'add' && flow.phase === 'running' ? flow.alias : undefined;
  const busy = flow?.phase === 'running';

  const refresh = useCallback(async () => {
    setLoading(true);
    setLoadError(undefined);
    try { setHosts(await bridge.listSshHosts()); } catch (error) { setLoadError(error instanceof Error ? error.message : String(error)); } finally { setLoading(false); }
  }, [bridge]);

  useEffect(() => bridge.onServerSetupProgress(progress => {
    if (progress.alias !== flowAlias.current) return;
    setFlow(current => current?.kind === 'add' && current.alias === progress.alias && current.phase === 'running' ? { ...current, steps: { ...current.steps, [progress.step]: progress.state } } : current);
  }), [bridge]);
  useEffect(() => { if (open) void refresh(); }, [open, refresh]);
  useLayoutEffect(() => { if (open) panel.current?.focus({ preventScroll: true }); }, [open]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!wrapper.current?.contains(event.target as Node)) setOpen(false); };
    // On the document, not the panel, so Escape still works after the focused button unmounts (e.g. when a step starts).
    const escape = (event: globalThis.KeyboardEvent) => { if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); close(); } };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [open]);

  function close() { setOpen(false); trigger.current?.focus(); }

  async function add(alias: string, acceptNewHostKey: boolean) {
    flowAlias.current = alias;
    panel.current?.focus({ preventScroll: true });
    setFlow({ kind: 'add', alias, phase: 'running', steps: {} });
    let result: AddServerResult;
    try { result = await bridge.addServer({ alias, acceptNewHostKey: acceptNewHostKey || undefined }); } catch (error) { result = { ok: false, code: 'failed', message: error instanceof Error ? error.message : String(error) }; }
    setFlow(current => current?.kind === 'add' && current.alias === alias ? { ...current, phase: result.ok ? 'done' : 'failed', result } : current);
    if (result.ok) void refresh();
  }

  async function remove(target: RemoveFlow) {
    setFlow({ ...target, phase: 'running' });
    let next: RemoveFlow;
    try {
      const result = await bridge.removeServer({ id: target.id, cleanup: target.managed && target.cleanup });
      next = result.ok ? { ...target, phase: 'done', message: result.cleanupError ? t('servers.removeCleanupFailed', { alias: target.alias, error: result.cleanupError }) : undefined } : { ...target, phase: 'failed', message: t('servers.removeFailed', { error: result.message }) };
    } catch (error) { next = { ...target, phase: 'failed', message: t('servers.removeFailed', { error: error instanceof Error ? error.message : String(error) }) }; }
    setFlow(current => current?.kind === 'remove' && current.id === target.id ? (next.phase === 'done' && !next.message ? undefined : next) : current);
    void refresh();
  }

  function renderFlow(host: SshHostInfo) {
    if (!flow || flow.alias !== host.alias) return null;
    if (flow.kind === 'remove') {
      if (flow.phase === 'done' || flow.phase === 'failed') return <div className="servers-flow" role="alert"><p className="servers-error__title"><AlertCircle size={14} aria-hidden="true" />{flow.message}</p><div className="servers-actions"><button type="button" className="button button--small" onClick={() => setFlow(undefined)}>{t('servers.dismiss')}</button></div></div>;
      return <div className="servers-flow" role="group" aria-labelledby={`${id}-remove-title`}><p id={`${id}-remove-title`} className="servers-flow__title">{t('servers.confirmRemove.title', { alias: host.alias })}</p><p>{t('servers.confirmRemove.body')}</p>{flow.managed && <label className="servers-check"><input type="checkbox" checked={flow.cleanup} disabled={busy} onChange={event => setFlow({ ...flow, cleanup: event.target.checked })} />{t('servers.confirmRemove.cleanup')}</label>}<div className="servers-actions"><button type="button" className="button button--small" disabled={busy} onClick={() => setFlow(undefined)}>{t('servers.cancel')}</button><button type="button" className="button button--danger button--small" disabled={busy} onClick={() => void remove(flow)}>{busy && <LoaderCircle size={12} className="spin" aria-hidden="true" />}{t('servers.confirmRemove.confirm')}</button></div></div>;
    }
    if (flow.phase === 'confirm') return <div className="servers-flow" role="group" aria-labelledby={`${id}-add-title`}><p id={`${id}-add-title`} className="servers-flow__title">{t('servers.confirmAdd.title', { alias: host.alias })}</p><p>{t('servers.confirmAdd.intro')}</p><ul className="servers-flow__list"><li>{t('servers.confirmAdd.connect')}</li><li>{t('servers.confirmAdd.dir')}</li><li>{t('servers.confirmAdd.upload')}</li></ul><p className="servers-flow__note">{t('servers.confirmAdd.nothingRuns')}</p><div className="servers-actions"><button type="button" className="button button--small" onClick={() => setFlow(undefined)}>{t('servers.cancel')}</button><button type="button" className="button button--primary button--small" onClick={() => void add(host.alias, false)}>{t('servers.confirmAdd.confirm')}</button></div></div>;
    return <div className="servers-flow" aria-live="polite"><StepList steps={flow.steps} />
      {flow.phase === 'done' && <><p className="servers-flow__ok"><CheckCircle2 size={14} aria-hidden="true" />{t('servers.addedOk', { alias: host.alias })}</p><div className="servers-actions"><button type="button" className="button button--small" onClick={() => setFlow(undefined)}>{t('servers.dismiss')}</button></div></>}
      {flow.phase === 'failed' && flow.result && !flow.result.ok && <AddFailure failure={flow.result} host={host} platform={bridge.platform} onRetry={accept => void add(host.alias, accept)} onDismiss={() => setFlow(undefined)} />}
    </div>;
  }

  function renderRow(host: SshHostInfo) {
    const status = host.serverId ? remotes?.find(remote => remote.id === host.serverId) : undefined;
    const state = !host.serverId ? 'not-added' : status?.state ?? 'added';
    const stateLabel = t(state === 'not-added' ? 'servers.state.notAdded' : state === 'added' ? 'servers.state.added' : `servers.state.${state}`);
    const flowHere = flow?.alias === host.alias;
    return <li key={host.alias} className={`servers-row servers-row--${state}`}>
      <div className="servers-row__main">
        <span className="servers-row__dot" aria-hidden="true" />
        <div className="servers-row__text"><span className="servers-row__alias">{host.alias}{host.serverId && !host.managed && <span className="servers-row__tag">{t('servers.manual')}</span>}</span><span className="servers-row__hint">{hostHint(host)}</span></div>
        <span className="servers-row__state">{stateLabel}</span>
        {!host.serverId && !(flowHere && flow?.kind === 'add' && flow.phase !== 'done') && <button type="button" className="button button--small" disabled={busy} aria-label={t('servers.addAria', { alias: host.alias })} onClick={() => setFlow({ kind: 'add', alias: host.alias, phase: 'confirm', steps: {} })}>{t('servers.add')}</button>}
        {host.serverId && !(flowHere && flow?.kind === 'remove' && flow.phase !== 'done') && !(flowHere && flow?.kind === 'add') && <button type="button" className="button button--quiet" disabled={busy} aria-label={t('servers.removeAria', { alias: host.alias })} onClick={() => setFlow({ kind: 'remove', alias: host.alias, id: host.serverId!, managed: !!host.managed, cleanup: !!host.managed, phase: 'confirm' })}>{t('servers.remove')}</button>}
      </div>
      {state === 'error' && status?.error && <p className="servers-row__error">{status.error}</p>}
      {renderFlow(host)}
    </li>;
  }

  return <div className="servers" ref={wrapper}>
    <button ref={trigger} type="button" className="dropdown__trigger servers__trigger" aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? `${id}-panel` : undefined} onClick={() => open ? close() : setOpen(true)}>
      <Server size={13} aria-hidden="true" /><span className="dropdown__value">{t('servers.button')}</span>{busy && <LoaderCircle size={12} className="spin servers__busy" aria-hidden="true" />}
    </button>
    {open && <div ref={panel} id={`${id}-panel`} className="servers__panel" role="dialog" aria-labelledby={`${id}-title`} tabIndex={-1}>
      <div className="servers__head">
        <div><h2 id={`${id}-title`}>{t('servers.title')}</h2><span>{hosts && hosts.length > 0 ? `${t('servers.subtitle')} · ${t('servers.hostCount', { count: hosts.length })}` : t('servers.subtitle')}</span></div>
        <button type="button" className="button button--quiet servers__icon" aria-label={t('servers.refresh')} title={t('servers.refresh')} disabled={loading} onClick={() => void refresh()}><RefreshCw size={13} className={loading ? 'spin' : undefined} aria-hidden="true" /></button>
        <button type="button" className="button button--quiet servers__icon" aria-label={t('servers.close')} title={t('servers.close')} onClick={close}><X size={13} aria-hidden="true" /></button>
      </div>
      {loadError ? <p className="servers__message servers__message--error" role="alert">{t('servers.loadFailed', { error: loadError })}</p>
        : !hosts ? <p className="servers__message">{t('servers.loading')}</p>
          : hosts.length === 0 ? <p className="servers__message">{t('servers.empty')}</p>
            : <ul className="servers__list">{hosts.map(renderRow)}</ul>}
    </div>}
  </div>;
}
