import { gitea } from './gitea';
import { grafana } from './grafana';
import { n8n } from './n8n';
import { nextcloud } from './nextcloud';
import { obliTemplates } from './obli';
import { redis } from './redis';
import type { BuiltinTemplate } from './types';
import { uptimeKuma } from './uptimeKuma';
import { vaultwarden } from './vaultwarden';
import { wordpress } from './wordpress';

export type { BuiltinTemplate } from './types';

/** Built-in catalog (docs/P4b-PLAN.md §5.4), in display order. */
export const BUILTIN_TEMPLATES: readonly BuiltinTemplate[] = [
  wordpress, nextcloud, gitea, vaultwarden, uptimeKuma, grafana, n8n, redis, ...obliTemplates,
];
