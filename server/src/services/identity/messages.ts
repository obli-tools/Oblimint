import { EMAIL_CHANGE_TTL_HOURS, PASSWORD_RESET_TTL_MINUTES } from '@oblimint/shared';
import { escapeHtml } from '../usage/notifications/plugins';

// ─────────────────────────────────────────────────────────────────────────────
// Texts of the identity e-mails and personal notices, in the account's
// language (French when its preferred language is French, English otherwise).
// Pure (messages.test.ts). Links are absolute https URLs built by the caller
// from the CONFIGURED panel host names, never from the request's Host header.
// ─────────────────────────────────────────────────────────────────────────────

export type Lang = 'fr' | 'en';

export function langOf(preferred: string | null | undefined): Lang {
  return typeof preferred === 'string' && preferred.toLowerCase().startsWith('fr') ? 'fr' : 'en';
}

export interface MailContent {
  subject: string;
  text: string;
  html: string;
}

export interface NoticeContent {
  title: string;
  message: string;
}

const SIGN = '— Oblimint';

function html(lines: string[], link?: { url: string; label: string }, footer?: string): string {
  return [
    ...lines.map((l, i) => (i === 0 ? `<h2 style="margin:0 0 12px">${escapeHtml(l)}</h2>` : `<p>${escapeHtml(l)}</p>`)),
    link && /^https:\/\//.test(link.url)
      ? `<p style="margin:24px 0"><a href="${escapeHtml(link.url)}" style="background:#10b981;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600">${escapeHtml(link.label)}</a></p>`
        + `<p style="color:#666;font-size:12px;word-break:break-all">${escapeHtml(link.url)}</p>`
      : '',
    footer ? `<p style="color:#888;font-size:12px">${escapeHtml(footer)}</p>` : '',
    `<p style="color:#999;font-size:12px">${SIGN}</p>`,
  ].filter(Boolean).join('\n');
}

function text(lines: string[], link?: string, footer?: string): string {
  return [...lines, ...(link ? ['', link] : []), ...(footer ? ['', footer] : []), '', SIGN].join('\n');
}

export function passwordResetMail(lang: Lang, username: string, url: string): MailContent {
  if (lang === 'fr') {
    const lines = ['Réinitialisation du mot de passe', `Une réinitialisation du mot de passe du compte « ${username} » a été demandée.`, `Ce lien choisit un nouveau mot de passe. Il est valable ${PASSWORD_RESET_TTL_MINUTES} minutes et ne sert qu’une fois.`];
    const footer = 'Si vous n’êtes pas à l’origine de cette demande, ignorez ce message : votre mot de passe reste inchangé. La double authentification reste demandée à la connexion.';
    return { subject: '[Oblimint] Réinitialisation du mot de passe', text: text(lines, url, footer), html: html(lines, { url, label: 'Choisir un nouveau mot de passe' }, footer) };
  }
  const lines = ['Password reset', `A password reset was requested for the account "${username}".`, `This link sets a new password. It is valid for ${PASSWORD_RESET_TTL_MINUTES} minutes and works once.`];
  const footer = 'If you did not ask for it, ignore this message: your password stays unchanged. Two-factor authentication is still asked at sign-in.';
  return { subject: '[Oblimint] Password reset', text: text(lines, url, footer), html: html(lines, { url, label: 'Choose a new password' }, footer) };
}

export function emailConfirmMail(lang: Lang, username: string, url: string): MailContent {
  if (lang === 'fr') {
    const lines = ['Confirmez votre adresse e-mail', `Cette adresse a été indiquée pour le compte « ${username} ».`, `Ouvrez ce lien pour la confirmer (valable ${EMAIL_CHANGE_TTL_HOURS} heures, une seule fois).`];
    const footer = 'Si vous n’êtes pas à l’origine de cette demande, ignorez ce message : rien ne change.';
    return { subject: '[Oblimint] Confirmez votre adresse e-mail', text: text(lines, url, footer), html: html(lines, { url, label: 'Confirmer cette adresse' }, footer) };
  }
  const lines = ['Confirm your e-mail address', `This address was given for the account "${username}".`, `Open this link to confirm it (valid for ${EMAIL_CHANGE_TTL_HOURS} hours, once).`];
  const footer = 'If you did not ask for it, ignore this message: nothing changes.';
  return { subject: '[Oblimint] Confirm your e-mail address', text: text(lines, url, footer), html: html(lines, { url, label: 'Confirm this address' }, footer) };
}

/** Sent to the CURRENT address when a change to another one is requested. */
export function emailChangeRequestedMail(lang: Lang, username: string, newEmail: string): MailContent {
  if (lang === 'fr') {
    const lines = ['Changement d’adresse e-mail demandé', `Un changement de l’adresse e-mail du compte « ${username} » vers ${newEmail} a été demandé.`, 'Il ne prend effet qu’une fois confirmé depuis la nouvelle adresse.'];
    const footer = 'Si vous n’êtes pas à l’origine de cette demande, changez votre mot de passe et prévenez votre administrateur.';
    return { subject: '[Oblimint] Changement d’adresse e-mail demandé', text: text(lines, undefined, footer), html: html(lines, undefined, footer) };
  }
  const lines = ['E-mail change requested', `A change of the e-mail address of the account "${username}" to ${newEmail} was requested.`, 'It only takes effect once confirmed from the new address.'];
  const footer = 'If you did not ask for it, change your password and tell your administrator.';
  return { subject: '[Oblimint] E-mail change requested', text: text(lines, undefined, footer), html: html(lines, undefined, footer) };
}

export function emailChangedNotice(lang: Lang, newEmail: string | null): NoticeContent {
  if (lang === 'fr') {
    return newEmail
      ? { title: 'Adresse e-mail changée', message: `L’adresse e-mail de votre compte est maintenant ${newEmail}.` }
      : { title: 'Adresse e-mail retirée', message: 'Votre compte n’a plus d’adresse e-mail : la réinitialisation du mot de passe par e-mail n’est plus possible.' };
  }
  return newEmail
    ? { title: 'E-mail address changed', message: `The e-mail address of your account is now ${newEmail}.` }
    : { title: 'E-mail address removed', message: 'Your account has no e-mail address any more: password reset by e-mail is no longer possible.' };
}

export function passwordResetNotice(lang: Lang): NoticeContent {
  return lang === 'fr'
    ? { title: 'Mot de passe réinitialisé', message: 'Le mot de passe de votre compte a été réinitialisé par le lien envoyé par e-mail. Toutes les sessions ouvertes ont été fermées. Si ce n’était pas vous, prévenez votre administrateur.' }
    : { title: 'Password reset', message: 'The password of your account was reset through the e-mailed link. Every open session was closed. If it was not you, tell your administrator.' };
}

export function recoveryCodeUsedNotice(lang: Lang, remaining: number): NoticeContent {
  if (lang === 'fr') {
    const left = remaining === 0 ? 'Il ne vous reste aucun code : générez-en de nouveaux.' : `Il vous reste ${remaining} code${remaining > 1 ? 's' : ''}.`;
    return { title: 'Code de secours utilisé', message: `Une connexion a utilisé un code de secours de double authentification. ${left} Si ce n’était pas vous, changez votre mot de passe et générez de nouveaux codes.` };
  }
  const left = remaining === 0 ? 'You have no code left: generate new ones.' : `You have ${remaining} code${remaining > 1 ? 's' : ''} left.`;
  return { title: 'Recovery code used', message: `A sign-in used a two-factor recovery code. ${left} If it was not you, change your password and generate new codes.` };
}

/** E-mail form of a personal notice. */
export function noticeMail(lang: Lang, n: NoticeContent, link?: { url: string } | null): MailContent {
  const lines = [n.title, n.message];
  const label = lang === 'fr' ? 'Ouvrir le panel' : 'Open the panel';
  return { subject: `[Oblimint] ${n.title}`, text: text(lines, link?.url), html: html(lines, link ? { url: link.url, label } : undefined) };
}
