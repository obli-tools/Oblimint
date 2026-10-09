import net from 'net';
import type { OpenRelayCheck, OpenRelayTestResult } from '@oblimint/shared';

// ─────────────────────────────────────────────────────────────────────────────
// Open relay self-test (docs/P4-PLAN.md §9.6, MA2) — relayTest.test.ts runs it
// against a local fake SMTP server. SMTP dialogues from the panel to the
// node's PUBLIC address; no message is ever submitted: every dialogue stops
// at RCPT with RSET + QUIT (never DATA).
//
//   unauthRelay      :25   MAIL FROM external → RCPT TO external must be refused
//   senderMismatch   :25   MAIL FROM <one of OUR domains> (spoofed) → RCPT TO
//                          external must be refused too (no trust by sender)
//   submissionNoTls  :587  EHLO before STARTTLS must not offer AUTH
//   submissionNoAuth :587  MAIL / RCPT external without AUTH must be refused
//   relayPort        :2525 (site relay) and :10025 (engine relay input) must
//                          not answer from outside
//
// Verdicts (a check is green only when the refusal is PROVEN):
//   - closed public port: passed (nothing to relay through);
//   - 2xx to the external RCPT: FAILED (open relay);
//   - 5xx to the external RCPT: passed (the plan's criterion);
//   - 4xx anywhere (temporary failure: milter restart, greylisting, rate
//     limit…), a dropped dialogue, a non-220 / non-5xx banner: NOT passed —
//     inconclusive, the detail says so and the test has to be run again;
//   - a 4xx is first RETRIED (every retryDelayMs, within retryWindowMs from
//     the start of the test, shared by every check): a configuration change
//     that restarts Rspamd makes Postfix answer 451 to every session until
//     the milter is back (~30 s seen on the Linux test host), which must not turn an
//     admin's test red;
//   - 5xx at MAIL FROM: passed only where refusing the sender IS the expected
//     protection (submission without AUTH, spoofed local sender on 25); for
//     unauthRelay it is inconclusive (the relay decision was never reached).
// The external sender / recipient are real domains with MX records: the
// example.* domains publish a null MX (RFC 7505) and are refused by sender /
// recipient checks (550 5.7.27) before the relay policy is ever consulted.
// ─────────────────────────────────────────────────────────────────────────────

/** Default external addresses: domains with real MX records (never the null-MX example.* ones). */
export const RELAY_TEST_SENDER = 'relay-test@gmail.com';
export const RELAY_TEST_RECIPIENT = 'relay-test@outlook.com';

export interface RelayTestOptions {
  host: string;
  ports: { smtp: number; submission: number; siteRelay: number; engineRelay: number };
  /** One of our active mail domains (senderMismatch), null = check skipped. */
  localDomain: string | null;
  timeoutMs?: number;
  /** HELO name / external addresses used in the dialogues. */
  helo?: string;
  externalSender?: string;
  externalRecipient?: string;
  now?: () => Date;
  /** 4xx answers are retried within this window from the start of the test (default 45 s; 0 = never). */
  retryWindowMs?: number;
  /** Pause between two attempts of a check answered 4xx (default 5 s). */
  retryDelayMs?: number;
  /** Injectable pause (tests). */
  sleep?: (ms: number) => Promise<void>;
}

/** Outcome of one dialogue; `temporary`: a 4xx answer, worth another attempt. */
interface Attempt {
  passed: boolean;
  detail: string;
  temporary?: boolean;
}

interface Reply {
  code: number;
  lines: string[];
}

class SmtpDialogue {
  private buf = '';
  private waiters: Array<(r: Reply | Error) => void> = [];
  private pending: Reply[] = [];
  private lines: string[] = [];
  private closed: Error | null = null;

  private constructor(private readonly sock: net.Socket) {
    sock.setEncoding('latin1');
    sock.on('data', (d: string) => this.data(d));
    const fail = (err: Error) => {
      this.closed = err;
      for (const w of this.waiters.splice(0)) w(err);
    };
    sock.on('error', (e) => fail(e));
    sock.on('close', () => fail(new Error('connection closed')));
    sock.on('timeout', () => { fail(new Error('timeout')); sock.destroy(); });
  }

  static open(host: string, port: number, timeoutMs: number): Promise<SmtpDialogue> {
    return new Promise((resolve, reject) => {
      const sock = net.connect({ host, port });
      sock.setTimeout(timeoutMs);
      const onErr = (e: Error) => { sock.destroy(); reject(e); };
      sock.once('error', onErr);
      sock.once('timeout', () => onErr(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
      sock.once('connect', () => {
        sock.removeListener('error', onErr);
        sock.removeAllListeners('timeout');
        resolve(new SmtpDialogue(sock));
      });
    });
  }

  private data(d: string): void {
    this.buf += d;
    if (this.buf.length > 65536) { this.sock.destroy(); return; }
    let i: number;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).replace(/\r$/, '');
      this.buf = this.buf.slice(i + 1);
      const m = /^(\d{3})([ -])(.*)$/.exec(line);
      if (!m) continue;
      this.lines.push(m[3]);
      if (m[2] === ' ') {
        const reply = { code: Number(m[1]), lines: this.lines };
        this.lines = [];
        const w = this.waiters.shift();
        if (w) w(reply);
        else this.pending.push(reply);
      }
    }
  }

  reply(): Promise<Reply> {
    const p = this.pending.shift();
    if (p) return Promise.resolve(p);
    if (this.closed) return Promise.reject(this.closed);
    return new Promise((resolve, reject) => this.waiters.push((r) => (r instanceof Error ? reject(r) : resolve(r))));
  }

  async cmd(line: string): Promise<Reply> {
    this.sock.write(`${line}\r\n`);
    return this.reply();
  }

  async close(): Promise<void> {
    try {
      if (!this.closed) {
        this.sock.write('RSET\r\nQUIT\r\n');
      }
    } catch { /* closing anyway */ }
    this.sock.end();
    this.sock.destroy();
  }
}

function closedPort(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  return code === 'ECONNREFUSED' || code === 'ETIMEDOUT' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH' || (err as Error)?.message === 'timeout';
}

function replyText(r: Reply): string {
  return `${r.code} ${r.lines.join(' ')}`.trim().slice(0, 160);
}

function errMsg(err: unknown): string {
  return (err as Error)?.message ?? String(err);
}

/**
 * MAIL FROM `from` + RCPT TO external without authentication: refused?
 * `senderRefusalProves`: a 5xx to MAIL FROM is itself the protection checked
 * (submission without AUTH, spoofed local sender); otherwise inconclusive.
 */
async function relayAttempt(o: Required<Pick<RelayTestOptions, 'host'>> & { port: number; timeoutMs: number; helo: string; from: string; to: string; senderRefusalProves: boolean }): Promise<Attempt> {
  let d: SmtpDialogue;
  try {
    d = await SmtpDialogue.open(o.host, o.port, o.timeoutMs);
  } catch (err) {
    return closedPort(err)
      ? { passed: true, detail: `Port ${o.port} fermé (${errMsg(err)}) : aucun relais possible` }
      : { passed: false, detail: `Port ${o.port} injoignable : ${errMsg(err)}` };
  }
  try {
    const banner = await d.reply();
    if (banner.code >= 500) return { passed: true, detail: `Port ${o.port} : connexion refusée dès la bannière (${replyText(banner)})` };
    if (banner.code !== 220) return { passed: false, temporary: banner.code >= 400, detail: `Port ${o.port} : bannière ${replyText(banner)} — test non concluant, à relancer` };
    let r = await d.cmd(`EHLO ${o.helo}`);
    if (r.code !== 250) r = await d.cmd(`HELO ${o.helo}`);
    r = await d.cmd(`MAIL FROM:<${o.from}>`);
    if (r.code >= 400 && r.code < 500) {
      return { passed: false, temporary: true, detail: `Port ${o.port} : MAIL FROM refusé temporairement (${replyText(r)}) — test non concluant, à relancer` };
    }
    if (r.code >= 500) {
      return o.senderRefusalProves
        ? { passed: true, detail: `Port ${o.port} : expéditeur refusé (${replyText(r)})` }
        : { passed: false, detail: `Port ${o.port} : expéditeur de test <${o.from}> refusé (${replyText(r)}) avant la décision de relais — test non concluant` };
    }
    if (r.code < 200 || r.code >= 300) return { passed: false, detail: `Port ${o.port} : réponse inattendue à MAIL FROM (${replyText(r)}) — test non concluant` };
    r = await d.cmd(`RCPT TO:<${o.to}>`);
    const text = replyText(r);
    if (r.code >= 200 && r.code < 300) return { passed: false, detail: `Port ${o.port} : destinataire externe ACCEPTÉ sans authentification (${text}) — relais ouvert` };
    if (r.code >= 500) return { passed: true, detail: `Port ${o.port} : destinataire externe refusé (${text})` };
    return { passed: false, temporary: r.code >= 400 && r.code < 500, detail: `Port ${o.port} : destinataire externe refusé temporairement (${text}) — test non concluant (un refus 5xx est attendu), à relancer` };
  } catch (err) {
    return { passed: false, detail: `Port ${o.port} : dialogue interrompu par le serveur (${errMsg(err)}) — test non concluant` };
  } finally {
    await d.close();
  }
}

/** EHLO on the submission port before STARTTLS: AUTH must not be offered. */
async function authBeforeTls(host: string, port: number, timeoutMs: number, helo: string): Promise<{ passed: boolean; detail: string }> {
  let d: SmtpDialogue;
  try {
    d = await SmtpDialogue.open(host, port, timeoutMs);
  } catch (err) {
    return closedPort(err)
      ? { passed: true, detail: `Port ${port} fermé (${errMsg(err)})` }
      : { passed: false, detail: `Port ${port} injoignable : ${errMsg(err)}` };
  }
  try {
    const banner = await d.reply();
    if (banner.code !== 220) return { passed: true, detail: `Port ${port} : bannière ${banner.code}` };
    const r = await d.cmd(`EHLO ${helo}`);
    const caps = r.lines.slice(1).map((l) => l.trim().toUpperCase());
    const auth = caps.some((c) => c === 'AUTH' || c.startsWith('AUTH ') || c.startsWith('AUTH='));
    const starttls = caps.includes('STARTTLS');
    if (auth) return { passed: false, detail: `Port ${port} : AUTH proposée sans chiffrement (mots de passe en clair possibles)` };
    return { passed: true, detail: `Port ${port} : AUTH non proposée avant STARTTLS${starttls ? ' (STARTTLS disponible)' : ''}` };
  } catch (err) {
    return { passed: true, detail: `Port ${port} : dialogue interrompu (${errMsg(err)})` };
  } finally {
    await d.close();
  }
}

/** The port must not accept a TCP connection from outside. */
async function unreachable(host: string, port: number, timeoutMs: number): Promise<{ passed: boolean; detail: string }> {
  try {
    const d = await SmtpDialogue.open(host, port, timeoutMs);
    await d.close();
    return { passed: false, detail: `Port ${port} joignable depuis l'adresse publique (il ne doit l'être que depuis les réseaux internes)` };
  } catch (err) {
    return { passed: true, detail: `Port ${port} injoignable de l'extérieur (${errMsg(err)})` };
  }
}

export async function runRelayTest(o: RelayTestOptions): Promise<OpenRelayTestResult> {
  const timeoutMs = o.timeoutMs ?? 10_000;
  const helo = o.helo ?? 'relay-test.oblimint.invalid';
  const from = o.externalSender ?? RELAY_TEST_SENDER;
  const to = o.externalRecipient ?? RELAY_TEST_RECIPIENT;
  const now = o.now ?? (() => new Date());
  const checks: OpenRelayCheck[] = [];
  const retryUntil = Date.now() + Math.max(0, o.retryWindowMs ?? 45_000);
  const retryDelay = Math.max(0, o.retryDelayMs ?? 5_000);
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => { setTimeout(r, ms); }));
  /** One relay dialogue, attempted again while it gets a 4xx and the retry window is open. */
  const attempt = async (a: Parameters<typeof relayAttempt>[0]): Promise<{ passed: boolean; detail: string }> => {
    let r = await relayAttempt(a);
    let tries = 1;
    while (r.temporary && Date.now() + retryDelay < retryUntil) {
      await sleep(retryDelay);
      r = await relayAttempt(a);
      tries += 1;
    }
    const detail = tries > 1 ? `${r.detail} (${tries} essais)` : r.detail;
    return { passed: r.passed, detail };
  };

  checks.push({ id: 'unauthRelay', ...await attempt({ host: o.host, port: o.ports.smtp, timeoutMs, helo, from, to, senderRefusalProves: false }) });
  if (o.localDomain) {
    checks.push({ id: 'senderMismatch', ...await attempt({ host: o.host, port: o.ports.smtp, timeoutMs, helo, from: `postmaster@${o.localDomain}`, to, senderRefusalProves: true }) });
  }
  checks.push({ id: 'submissionNoTls', ...await authBeforeTls(o.host, o.ports.submission, timeoutMs, helo) });
  checks.push({ id: 'submissionNoAuth', ...await attempt({ host: o.host, port: o.ports.submission, timeoutMs, helo, from, to, senderRefusalProves: true }) });
  const site = await unreachable(o.host, o.ports.siteRelay, Math.min(timeoutMs, 5_000));
  const engine = await unreachable(o.host, o.ports.engineRelay, Math.min(timeoutMs, 5_000));
  checks.push({ id: 'relayPort', passed: site.passed && engine.passed, detail: `${site.detail} ; ${engine.detail}` });

  return { ok: checks.every((c) => c.passed), target: o.host, checks, testedAt: now().toISOString() };
}
