import { maskSecrets } from './canonical';

// ─────────────────────────────────────────────────────────────────────────────
// What a pending action will execute, in French words (spec §3.1
// describe()): the decider approves THIS text, built on the server from the
// very parameters the handler runs with — never a bare label behind which
// the requester could put anything. Helpers `short`, `change`, `fields` are
// ported from Obliance approvalDescribe.ts (English there, French here like
// every server-rendered notification). Values shortened, secrets masked.
// Every catalogue action has its verb (describe.test.ts).
// ─────────────────────────────────────────────────────────────────────────────

/** A value, short and readable (« texte », 12, oui / non, [a, b], {…}). */
export function short(v: unknown, max = 80): string {
  let s: string;
  if (v === null || v === undefined) s = 'aucun';
  else if (typeof v === 'boolean') s = v ? 'oui' : 'non';
  else if (typeof v === 'number') s = String(v);
  else if (typeof v === 'string') s = `« ${v} »`;
  else if (Array.isArray(v)) s = `[${v.map((x) => short(x, 40)).join(', ')}]`;
  else {
    try { s = JSON.stringify(maskSecrets(v)); } catch { s = '{…}'; }
  }
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** « champ : a → b » for a changed field, null when unchanged. */
export function change(label: string, before: unknown, after: unknown): string | null {
  if (JSON.stringify(before ?? null) === JSON.stringify(after ?? null)) return null;
  return `${label} : ${short(before)} → ${short(after)}`;
}

/** « k=v, k2=v2 » of an object's fields (secret-named masked). */
export function fields(obj: unknown, max = 300): string {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return short(obj, max);
  const parts = Object.entries(maskSecrets(obj) as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${short(v, 60)}`);
  const s = parts.join(', ');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** French verb phrase of every catalogue action. */
export const ACTION_VERBS_FR: Readonly<Record<string, string>> = {
  'site.delete': 'Supprimer le site',
  'site.stop': 'Arrêter le site',
  'site.publish_mode_change': 'Changer le mode de publication du site',
  'site.data_path_remove': 'Retirer un chemin de données du site',
  'site.runtime_remove': 'Retirer un runtime du site',
  'site.env_write': 'Modifier les variables d’environnement du site',
  'account.suspend': 'Suspendre le compte d’hébergement',
  'account.delete': 'Supprimer le compte d’hébergement',
  'account.client_users': 'Modifier les utilisateurs clients du compte',
  'account.sftp_credentials': 'Changer les accès SFTP du compte',
  'release.publish': 'Publier une release',
  'release.publish_override_rollback': 'Publier une release en passant outre le retour arrière',
  'release.rollback': 'Revenir à une release précédente',
  'release.approve_override_scan': 'Approuver une release bloquée par l’analyse',
  'release.restore_to_staging': 'Restaurer une release dans le staging',
  'window.reject_db_restore': 'Rejeter une fenêtre de modification en restaurant la base',
  'backup.restore': 'Restaurer une sauvegarde',
  'backup.disable': 'Désactiver les sauvegardes du compte',
  'snapshot.restore': 'Restaurer un instantané de base de données',
  'snapshot.delete': 'Supprimer un instantané de base de données',
  'files.delete': 'Supprimer des fichiers',
  'files.write': 'Écrire des fichiers',
  'db.instance_drop': 'Supprimer l’instance de base de données',
  'db.external_access': 'Ouvrir l’accès externe à l’instance de base de données',
  'db.drop': 'Supprimer la base de données',
  'db.import': 'Importer un fichier SQL dans la base',
  'db.user_password_reset': 'Réinitialiser le mot de passe d’un utilisateur de base',
  'db.user_delete': 'Supprimer un utilisateur de base',
  'db.user_grants': 'Modifier les droits d’un utilisateur de base',
  'db.query_write': 'Exécuter une requête SQL en écriture',
  'db.ddl': 'Supprimer ou vider un objet de la base',
  'db.rows_write': 'Modifier des lignes de la base',
  'db.dump': 'Exporter la base de données',
  'domain.delete': 'Supprimer le domaine',
  'domain.route_change': 'Changer la route d’un domaine',
  'subdomain.remove': 'Retirer un sous-domaine',
  'dns.zone_delete': 'Supprimer la zone DNS',
  'dns.zone_reset': 'Réinitialiser la zone DNS',
  'dns.template_apply': 'Appliquer un modèle à la zone DNS',
  'dns.record_write': 'Modifier un enregistrement DNS',
  'mail.dns_fix': 'Corriger les enregistrements DNS du mail',
  'proxy.host_delete': 'Supprimer un hôte du proxy',
  'firewall.mode_change': 'Changer le mode du pare-feu du compte',
  'firewall.rules_write': 'Modifier les règles du pare-feu du compte',
  'mail.domain_delete': 'Supprimer le domaine mail',
  'mail.mailbox_delete': 'Supprimer la boîte mail',
  'mail.mailbox_password': 'Changer le mot de passe de la boîte mail',
  'mail.dkim_rotate': 'Renouveler la clé DKIM',
  'cron.write': 'Créer ou modifier une tâche planifiée',
  'cron.delete': 'Supprimer une tâche planifiée',
  'cron.run': 'Lancer une tâche planifiée',
  'preview.db_clone': 'Créer un aperçu avec une copie de la base',
  'preview.share_link_with_db': 'Partager un lien public vers un aperçu avec copie de la base',
  'apikey.create': 'Créer une clé d’accès',
  'apikey.widen': 'Élargir les droits d’une clé d’accès',
  'connector.authorize': 'Autoriser un connecteur',
  'apikey.revoke': 'Révoquer une clé d’accès',
  'connector.rotate': 'Renouveler le secret d’un connecteur',
  'restrictions.manage': 'Modifier la matrice des actions protégées',
  'user.create': 'Créer un utilisateur',
  'user.update': 'Modifier un utilisateur',
  'user.delete': 'Supprimer un utilisateur',
  'user.password_reset': 'Réinitialiser le mot de passe d’un utilisateur',
  'user.2fa_reset': 'Réinitialiser la double authentification d’un utilisateur',
  'user.tenants_set': 'Changer les espaces d’un utilisateur',
  'platform.tenant_delete': 'Supprimer un espace (revendeur)',
  'platform.permission_sets': 'Modifier les jeux de permissions',
  'platform.hosting_settings': 'Modifier les réglages d’hébergement de la plateforme',
  'platform.app_config': 'Modifier la configuration de la plateforme',
  'platform.key_security': 'Modifier la sécurité IP des clés d’accès',
  'platform.ban_lift': 'Lever un bannissement plateforme',
  'platform.update_apply': 'Appliquer une mise à jour de la plateforme',
  'platform.migration_cutover': 'Basculer (ou annuler la bascule) d’une migration',
  'platform.backup_destinations': 'Modifier les destinations de sauvegarde',
};

/** Parameter names that name the object of the action, in order of preference. */
const OBJECT_KEYS = ['name', 'database', 'username', 'domain', 'hostname', 'path', 'paths', 'address', 'mailbox', 'slug', 'title'];

export interface DescribeContext {
  /** « compte acme », « site Boutique (compte acme) ». */
  where?: string | null;
}

/** French description of an action (verb, object, where, other parameters). */
export function describeAction(action: string, params: Record<string, unknown>, ctx: DescribeContext = {}): string {
  const verb = ACTION_VERBS_FR[action] ?? `Action ${action}`;
  const p = (maskSecrets(params ?? {}) ?? {}) as Record<string, unknown>;
  const objKey = OBJECT_KEYS.find((k) => p[k] !== undefined && p[k] !== null && p[k] !== '');
  const parts = [verb];
  if (objKey) parts.push(short(p[objKey], 120));
  if (ctx.where) parts.push(`(${ctx.where})`);
  const rest = Object.fromEntries(Object.entries(p).filter(([k]) => k !== objKey));
  const extra = Object.keys(rest).length ? fields(rest) : '';
  const text = extra ? `${parts.join(' ')} — ${extra}` : parts.join(' ');
  return text.slice(0, 4000);
}

/** One line per restriction entry (« sensible », « restreint (seulement : comptes 3) »). */
function entryText(e: unknown): string {
  if (!e) return 'aucun';
  const x = e as { level?: string; via?: string; scope?: { mode?: string; accountIds?: unknown[]; siteIds?: unknown[] } };
  const level = x.level === 'restricted' ? 'approbation' : x.level === 'sensitive' ? '2FA' : 'aucun';
  const via = x.via === 'keys' ? ', clés seulement' : x.via === 'panel' ? ', panel seulement' : '';
  const mode = x.scope?.mode;
  if (!mode || mode === 'all') return `${level}${via}`;
  const ps: string[] = [];
  if (x.scope?.accountIds?.length) ps.push(`comptes ${x.scope.accountIds.join(', ')}`);
  if (x.scope?.siteIds?.length) ps.push(`sites ${x.scope.siteIds.join(', ')}`);
  return `${level}${via} (${mode === 'include' ? 'seulement' : 'tous sauf'} : ${ps.join(' ; ') || 'rien'})`;
}

export function describeRestrictionChanges(changes: Array<{ key: string; from: unknown; to: unknown }>): string {
  const lines = changes.map((c) => `${c.key} : ${entryText(c.from)} → ${entryText(c.to)}`);
  const s = `Modifier la matrice des actions protégées (${changes.length} changement${changes.length > 1 ? 's' : ''}) — ${lines.join(' ; ')}`;
  return s.slice(0, 4000);
}
