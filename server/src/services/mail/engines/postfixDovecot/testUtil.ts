import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { MailDesiredState } from '../../driver';
import type { RenderContext } from './render';

// Test fixtures of the engine-postfix module (no I/O beyond temp dirs).

export const HASH_A = '{SHA512-CRYPT}$6$rounds=5000$saltsaltsalt$Yb7Q1m2bQ7lK1nN5yH8Fz3m3w0q0pQhLr2b3m0eYh0L6C3Y0aQ9hXj8fN0aZ9p2Q3r4s5t6u7v8w9x0y1z2A3B';
export const HASH_B = '{MD5-CRYPT}$1$cwpsalt1$Ab0Cd1Ef2Gh3Ij4Kl5Mn6.';
export const HASH_APP = '{SHA512-CRYPT}$6$rounds=5000$appsalt$Qx1Wy2Ez3Rt4Yu5Io6Pa7Sd8Fg9Hj0Kl1Zx2Cv3Bn4Mm5Nn6Bb7Vv8Cc9Xx0Zz1Aa2Ss3Dd4Ff5Gg6Hh7Jj8Kk9Ll0Pp';

let rsaPem: string | null = null;
let edPem: string | null = null;
export function rsaKey(): string {
  if (!rsaPem) rsaPem = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  return rsaPem;
}
export function edKey(): string {
  if (!edPem) edPem = crypto.generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  return edPem;
}

export const CTX: RenderContext = {
  now: new Date('2026-10-09T12:00:00Z'),
  mailSubnets: ['172.20.0.0/16'],
  mailGateways: ['172.20.0.1'],
  hostCertsDir: '/srv/oblimint/mail/certs',
};

/** A realistic desired state: two domains (one inactive), mailboxes, alias, forwarding, autoresponder, catch-all. */
export function baseState(): MailDesiredState {
  return {
    generatedAt: '2026-10-09T12:00:00Z',
    settings: {
      hostname: 'mail.oblimint.test',
      maxMessageSizeMb: 50,
      spamTagScore: 6,
      spamRejectScore: 15,
      greylisting: false,
      clamav: true,
      clamdAddress: 'oblimint-scanner:3310',
    },
    domains: [
      { id: 1, accountId: 10, name: 'exemple.fr', active: true, catchAll: null, maxMessageSizeMb: 25 },
      { id: 2, accountId: 10, name: 'pending.fr', active: false, catchAll: null, maxMessageSizeMb: 50 },
    ],
    mailboxes: [
      box(101, 'contact', 'exemple.fr', { quotaMb: 1024, sendPerHour: 200 }),
      box(102, 'jean', 'exemple.fr', { passwordHash: HASH_B, passwordScheme: 'MD5-CRYPT', forward: { targets: ['jean@gmail.com'], keepCopy: true } }),
      box(103, 'compta', 'exemple.fr', { forward: { targets: ['expert@cabinet.fr'], keepCopy: false } }),
      box(104, 'vacances', 'exemple.fr', {
        autoresponder: { subject: 'Absent', body: 'Je suis absent.\nRetour lundi.', startsAt: '2026-10-01T08:00:00Z', endsAt: '2026-10-20T18:30:00Z', intervalDays: 3 },
      }),
      box(201, 'info', 'pending.fr', { loginEnabled: false }),
    ],
    aliases: [
      { id: 1, accountId: 10, domainId: 1, address: 'info@exemple.fr', targets: ['contact@exemple.fr'] },
      { id: 2, accountId: 10, domainId: 1, address: 'equipe@exemple.fr', targets: ['contact@exemple.fr', 'jean@exemple.fr'] },
    ],
    appPasswords: [
      { id: 1, mailboxId: 101, address: 'contact@exemple.fr', passwordHash: HASH_APP, expiresAt: '2026-10-09T20:00:00Z', purpose: 'webmail', allowNets: ['172.20.0.0/16'] },
    ],
    dkim: [
      { domain: 'exemple.fr', selector: 'om202610', algorithm: 'rsa-2048', privateKeyPem: rsaKey(), signing: true },
      { domain: 'exemple.fr', selector: 'om202611', algorithm: 'rsa-2048', privateKeyPem: rsaKey(), signing: false },
    ],
    tls: [
      { names: ['mail.oblimint.test'], certPath: '/srv/oblimint/mail/certs/mail.oblimint.test/fullchain.pem', keyPath: '/srv/oblimint/mail/certs/mail.oblimint.test/privkey.pem', isDefault: true },
      { names: ['mail.exemple.fr', 'autoconfig.exemple.fr'], certPath: '/srv/oblimint/mail/certs/mail.exemple.fr/fullchain.pem', keyPath: '/srv/oblimint/mail/certs/mail.exemple.fr/privkey.pem', isDefault: false },
    ],
    relay: { relayHost: 'oblimint-mail-relay', relayAddresses: ['172.20.0.7'] },
  };
}

export function box(id: number, local: string, domain: string, over: Partial<MailDesiredState['mailboxes'][number]> = {}): MailDesiredState['mailboxes'][number] {
  return {
    id,
    accountId: 10,
    domainId: domain === 'exemple.fr' ? 1 : 2,
    address: `${local}@${domain}`,
    localPart: local,
    domain,
    displayName: null,
    passwordHash: HASH_A,
    passwordScheme: 'SHA512-CRYPT',
    quotaMb: null,
    loginEnabled: true,
    sendEnabled: true,
    receiveEnabled: true,
    sendPerHour: null,
    forward: null,
    autoresponder: null,
    ...over,
  };
}

/** Non-comment lines of a generated file. */
export function lines(content: string | undefined): string[] {
  return String(content ?? '').split('\n').filter((l) => l && !l.startsWith('#'));
}

export function tempDir(t: { after: (fn: () => void) => void }, prefix = 'oblimint-mailpd-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
