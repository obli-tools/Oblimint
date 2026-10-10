import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Plug, Unplug } from 'lucide-react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { AppSocketClientEvents, AppSocketServerEvents, type AppStackDetail } from '@oblimint/shared';
import { getSocket } from '@/socket/socketClient';
import { useSocketStore } from '@/store/socketStore';
import { Button } from '@/components/common/Button';
import { selectCls } from '@/components/hosting/hostingUi';
import { useCurrentTheme } from '@/hooks/useCurrentTheme';
import { cn } from '@/utils/cn';
import { emitQuiet, emitWithAck } from '../appSocket';
import { appsCodeMessage } from '../appsErrors';

/** Message of a CONSOLE_CLOSED reason (server: idle | replaced | exited | error | disconnected | closed). */
function closedMessage(t: TFunction, reason?: string): string {
  switch (reason) {
    case 'idle': return t('apps.console.reason.idle') || 'Console closed after 30 minutes of inactivity.';
    case 'replaced': return t('apps.console.reason.replaced') || 'Console closed: another console was opened on this service.';
    case 'exited': return t('apps.console.reason.exited') || 'Console closed: the shell exited.';
    case 'error': return t('apps.console.reason.error') || 'Console closed after an error.';
    case 'disconnected': return t('apps.console.disconnected') || 'Connection lost: the console is closed.';
    default: return t('apps.console.closed') || 'Console closed.';
  }
}

type ConsoleState = 'idle' | 'opening' | 'open' | 'closed';

/** CSS colour of a theme token ("r g b" triplet) → rgb(). */
function token(name: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v ? `rgb(${v.split(/\s+/).join(', ')})` : '#000';
}

/**
 * Interactive console (exec sh / bash, TTY) in one service container through
 * Socket.io (apps:console:open|input|resize|close). Shown only when the
 * platform, the tenant policy, the plan and the apps.console capability allow
 * it; the server re-checks and refuses with a code (docs/P4b-PLAN.md §5.9).
 */
export function AppConsoleTab({ stack }: { stack: AppStackDetail }) {
  const { t } = useTranslation();
  const theme = useCurrentTheme();
  const socketStatus = useSocketStore((s) => s.status);
  const running = stack.services.filter((s) => s.state === 'running');
  const [service, setService] = useState(running[0]?.name ?? '');
  const [state, setState] = useState<ConsoleState>('idle');
  const [message, setMessage] = useState<string | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const sessionRef = useRef<string | null>(null);

  // The running list changes with APP_UPDATED (deploy finished, wake-on-request, start from elsewhere):
  // keep the selected service in sync, otherwise the select shows a service the state does not hold
  // and 'Open a console' stays disabled. An open console keeps its service (the server closes it).
  const runningKey = running.map((s) => s.name).join('\n');
  useEffect(() => {
    if (state === 'open' || state === 'opening') return;
    const names = runningKey ? runningKey.split('\n') : [];
    if (!names.includes(service)) setService(names[0] ?? '');
  }, [runningKey, service, state]);

  // Terminal instance (recreated with the theme).
  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: '"JetBrains Mono", ui-monospace, monospace',
      fontSize: 13,
      scrollback: 5000,
      theme: { background: token('--c-bg-primary'), foreground: token('--c-text-primary'), cursor: token('--c-accent'), selectionBackground: 'rgba(224, 58, 58, 0.3)' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    try { fit.fit(); } catch { /* hidden */ }
    termRef.current = term;
    fitRef.current = fit;
    const input = term.onData((data) => {
      if (sessionRef.current) emitQuiet(AppSocketClientEvents.CONSOLE_INPUT, { sessionId: sessionRef.current, data });
    });
    const resize = term.onResize(({ cols, rows }) => {
      if (sessionRef.current) emitQuiet(AppSocketClientEvents.CONSOLE_RESIZE, { sessionId: sessionRef.current, cols, rows });
    });
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => { try { fit.fit(); } catch { /* detached */ } }) : null;
    ro?.observe(el);
    return () => {
      ro?.disconnect();
      input.dispose();
      resize.dispose();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [theme]);

  // Server → terminal.
  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;
    const onData = (p: { sessionId: string; data: string }) => {
      if (p?.sessionId && p.sessionId === sessionRef.current) termRef.current?.write(p.data);
    };
    const onClosed = (p: { sessionId: string; reason?: string }) => {
      if (!p?.sessionId || p.sessionId !== sessionRef.current) return;
      sessionRef.current = null;
      setState('closed');
      setMessage(closedMessage(t, p.reason));
      termRef.current?.write(`\r\n\x1b[90m— ${t('apps.console.sessionClosed') || 'session closed'} —\x1b[0m\r\n`);
    };
    socket.on(AppSocketServerEvents.CONSOLE_DATA, onData);
    socket.on(AppSocketServerEvents.CONSOLE_CLOSED, onClosed);
    return () => {
      socket.off(AppSocketServerEvents.CONSOLE_DATA, onData);
      socket.off(AppSocketServerEvents.CONSOLE_CLOSED, onClosed);
    };
  }, [socketStatus, t]);

  // A lost socket ends the session (the server closes it on disconnect).
  useEffect(() => {
    if (socketStatus !== 'connected' && sessionRef.current) {
      sessionRef.current = null;
      setState('closed');
      setMessage(t('apps.console.disconnected') || 'Connection lost: the console is closed.');
    }
  }, [socketStatus, t]);

  // Close on unmount.
  useEffect(() => () => {
    if (sessionRef.current) emitQuiet(AppSocketClientEvents.CONSOLE_CLOSE, { sessionId: sessionRef.current });
    sessionRef.current = null;
  }, []);

  const refusal = (code?: string): string => {
    switch (code) {
      case 'containerNotRunning':
      case 'consoleDisabled': return t('apps.errors.consoleDisabled') || 'The console is not available for this application.';
      case 'serviceNotFound': return t('apps.errors.serviceNotFound') || 'This service does not exist in the application.';
      case 'accountSuspended': return t('apps.errors.accountSuspended') || 'The hosting account is suspended.';
      case 'notRunning': return t('apps.console.notRunning') || 'The container is not running.';
      case 'forbidden':
      case 'unauthorized': return t('apps.console.forbidden') || 'You are not allowed to open a console here.';
      // validation / notFound / backendUnavailable / unknown: translated when known, never the raw code.
      default: return appsCodeMessage(t, code === 'validation' ? null : code, t('apps.console.failed') || 'The console could not be opened.');
    }
  };

  const open = async () => {
    const term = termRef.current;
    if (!term || !service) return;
    try { fitRef.current?.fit(); } catch { /* ignore */ }
    term.reset();
    setState('opening');
    setMessage(null);
    try {
      const ack = await emitWithAck<{ ok: boolean; sessionId?: string; code?: string; error?: string }>(
        AppSocketClientEvents.CONSOLE_OPEN, { stackId: stack.id, service, cols: term.cols, rows: term.rows }, 15_000,
      );
      if (!ack.ok || !ack.sessionId) {
        setState('idle');
        setMessage(refusal(ack.code));
        return;
      }
      sessionRef.current = ack.sessionId;
      setState('open');
      term.focus();
    } catch {
      setState('idle');
      setMessage(t('apps.console.noSocket') || 'Real-time connection unavailable: reload the page.');
    }
  };

  const close = () => {
    if (sessionRef.current) emitQuiet(AppSocketClientEvents.CONSOLE_CLOSE, { sessionId: sessionRef.current });
    sessionRef.current = null;
    setState('closed');
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label={t('apps.effective.service') || 'Service'}
          value={service}
          disabled={state === 'open' || state === 'opening'}
          onChange={(e) => setService(e.target.value)}
          className={cn(selectCls, 'w-full bg-bg-secondary font-mono sm:w-56')}
        >
          {running.length === 0 && <option value="">{t('apps.console.noRunning') || 'No running service'}</option>}
          {running.map((s) => <option key={s.name} value={s.name}>{s.name}</option>)}
        </select>
        {state === 'open'
          ? <Button size="sm" variant="secondary" onClick={close}><Unplug size={14} className="mr-1.5" />{t('apps.console.close') || 'Disconnect'}</Button>
          : <Button size="sm" loading={state === 'opening'} disabled={!service || socketStatus !== 'connected'} onClick={() => { void open(); }}><Plug size={14} className="mr-1.5" />{t('apps.console.open') || 'Open a console'}</Button>}
        <span className="text-xs text-text-muted">{t('apps.console.hint') || 'Shell of the container, with the user of the image. Closed after 30 min of inactivity. Every opening is logged.'}</span>
      </div>
      {message && <p className="text-xs text-amber-400">{message}</p>}
      <div className="overflow-hidden rounded-xl bg-bg-primary p-2">
        <div ref={hostRef} className="h-[60vh] min-h-64 w-full" />
      </div>
    </div>
  );
}
