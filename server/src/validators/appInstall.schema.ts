import { z } from 'zod';
import { APP_INSTALL_ADMIN_USER_RE, APP_INSTALL_APPS, APP_INSTALL_LOCALE_RE, isSiteBaseId, type SiteBaseId } from '@oblimint/shared';
import { siteCreateSchema } from './hosting.schema';

// POST /api/app-installs, POST /api/v1/apps/install, MCP install_app. Nothing here becomes a shell
// string: the values reach WP-CLI as single argv elements, whose names (--admin_user=…) cannot be overridden.
const noControl = (s: string) => !/[\u0000-\u001f\u007f]/.test(s);

export const appInstallStartSchema = z.object({
  accountId: z.number().int().positive(),
  app: z.enum(APP_INSTALL_APPS),
  name: siteCreateSchema.shape.name,
  slug: siteCreateSchema.shape.slug,
  base: z.string().refine((v): v is SiteBaseId => isSiteBaseId(v), 'Unknown site base').optional(),
  publishMode: siteCreateSchema.shape.publishMode,
  publishDebounceSec: siteCreateSchema.shape.publishDebounceSec,
  title: z.string().trim().min(1).max(120).refine(noControl, 'No control character').optional(),
  adminUser: z.string().regex(APP_INSTALL_ADMIN_USER_RE, 'Letters, digits, ., _ and -; not starting with . or -'),
  adminEmail: z.string().trim().email().max(200),
  locale: z.string().regex(APP_INSTALL_LOCALE_RE, 'A WordPress locale such as en_US or fr_FR').optional(),
  previewFirst: z.boolean().optional(),
}).strict();

export type AppInstallStartBody = z.infer<typeof appInstallStartSchema>;
