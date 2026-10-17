import { Router, type Request, type Response } from 'express';
import { Readable } from 'stream';
import { z, type ZodTypeAny } from 'zod';
import { APP_PROFILES, SITE_BASE_IDS } from '@oblimint/shared';
import { serverVersion } from '../../utils/version';
import { AppError } from '../../middleware/errorHandler';
import { keyApi, type SiteArea } from './keyApi';
import { apiKeyAuth, apiKeyAuthLimiter, apiKeyLimiter } from './middleware';
import type { ApiKeyContext } from './apiKeys.service';
import { siteUpdateSchema } from '../../validators/hosting.schema';
import { parseBody } from '../docker/parseBody';

// ─────────────────────────────────────────────────────────────────────────────
// MCP server of the panel (Model Context Protocol, Streamable HTTP transport,
// stateless): POST /mcp with JSON-RPC 2.0, `Authorization: Bearer obk_…`.
// The tools are the key API (keyApi.ts): same scopes, same site restriction,
// same checks as /api/v1. Answers are JSON (no SSE stream; GET → 405).
//
//   claude mcp add --transport http oblimint https://<panel>/mcp \
//     --header "Authorization: Bearer obk_…"
// ─────────────────────────────────────────────────────────────────────────────

export const MCP_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;
const MAX_TEXT_RESULT = 200_000;

interface ToolDef {
  name: string;
  title: string;
  description: string;
  /** JSON Schema of the arguments (tools/list). */
  inputSchema: Record<string, unknown>;
  /** Validation of the arguments. */
  args: ZodTypeAny;
  readOnly?: boolean;
  destructive?: boolean;
  run(ctx: ApiKeyContext, req: Request, args: any): Promise<unknown>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

const siteId = { type: 'integer', description: 'Site id (see list_sites).' };
const area = { type: 'string', enum: ['staging', 'data'], description: 'staging (default) = the code of the site, published as releases; data = the files the site writes (uploads, caches), live immediately.' };
const relPath = (d: string) => ({ type: 'string', description: d });
const obj = (properties: Record<string, unknown>, required: string[]) => ({ type: 'object', properties, required, additionalProperties: false });

const zSite = z.number().int().positive();
const zArea = z.enum(['staging', 'data']).optional();
const zPath = z.string().max(4096);
const publishMode = { type: 'string', enum: ['auto', 'manual', 'approval'], description: 'auto: every staging change goes live a few seconds later; manual: only on publish; approval: a human approves in the panel.' };
const zPublishMode = z.enum(['auto', 'manual', 'approval']);
const siteUpdateArgs = siteUpdateSchema.pick({ name: true, docroot: true, publishMode: true, publishDebounceSec: true, healthcheckPath: true, php: true });

const TOOLS: ToolDef[] = [
  {
    name: 'whoami', title: 'Key and account', readOnly: true,
    description: 'The API key in use: its scopes, its site scope and the hosting account it works on.',
    inputSchema: obj({}, []), args: z.object({}).passthrough(),
    run: (ctx) => keyApi.me(ctx),
  },
  {
    name: 'get_guide', title: 'Guide', readOnly: true,
    description: 'The guide of this API (Markdown): how Oblimint works (staging, releases, publish modes), rights, every tool, how to develop on a live site and roll back. Read it before a first change.',
    inputSchema: obj({ lang: { type: 'string', enum: ['en', 'fr'], description: 'Language (default en).' } }, []),
    args: z.object({ lang: z.enum(['en', 'fr']).optional() }),
    run: (_ctx, req, a) => keyApi.guide(req, a.lang ?? 'en'),
  },
  {
    name: 'list_sites', title: 'List sites', readOnly: true,
    description: 'Sites this key can work on (id, slug, domains, status, live release).',
    inputSchema: obj({}, []), args: z.object({}).passthrough(),
    run: (ctx) => keyApi.listSites(ctx),
  },
  {
    name: 'get_site', title: 'Site details', readOnly: true,
    description: 'One site of the key.', inputSchema: obj({ site_id: siteId }, ['site_id']),
    args: z.object({ site_id: zSite }),
    run: (ctx, _r, a) => keyApi.getSite(ctx, a.site_id),
  },
  {
    name: 'create_site', title: 'Create a site',
    description: 'Creates a site in the account (scope sites.create). The new site joins this key\'s sites. Upload its code with write_file / upload, then publish. A domain is attached from the panel.',
    inputSchema: obj({
      name: { type: 'string', description: 'Display name.' },
      slug: { type: 'string', description: 'Lower-case letters, digits and dashes (1-40): folder name /staging/<slug>.' },
      base: { type: 'string', enum: [...SITE_BASE_IDS], description: 'Runtime: apache-php8.x (.htaccess), nginx-php8.x, nginx-static.' },
      app_profile: { type: 'string', enum: APP_PROFILES.map((p) => p.id), description: 'Optional application profile (docroot, data paths).' },
      docroot: relPath('Optional document root inside the code (e.g. "public").'),
      publish_mode: publishMode,
    }, ['name', 'slug', 'base']),
    args: z.object({ name: z.string(), slug: z.string(), base: z.string(), app_profile: z.string().optional(), docroot: z.string().optional(), publish_mode: zPublishMode.optional() }),
    run: (ctx, req, a) => keyApi.createSite(ctx, req, {
      name: a.name, slug: a.slug, base: a.base, ...(a.app_profile ? { appProfile: a.app_profile } : {}), ...(a.docroot !== undefined ? { docroot: a.docroot } : {}),
      ...(a.publish_mode ? { publishMode: a.publish_mode } : {}),
    } as never),
  },
  {
    name: 'update_site', title: 'Change site settings',
    description: 'Changes settings of a site (scope sites.manage). Switch publish_mode to "manual" before developing on a live site so nothing goes live until publish; put it back afterwards if the human wants.',
    inputSchema: obj({
      site_id: siteId,
      name: { type: 'string', description: 'Display name.' },
      docroot: relPath('Document root inside the code ("" = root, e.g. "public"). Files outside it are published but never served.'),
      publish_mode: publishMode,
      publish_debounce_sec: { type: 'integer', minimum: 5, maximum: 3600, description: 'auto mode: seconds of quiet after the last write before publishing.' },
      healthcheck_path: { type: 'string', description: 'Path checked after a publish (e.g. "/").' },
      php: {
        type: 'object', additionalProperties: false, description: 'PHP limits, within the account plan.',
        properties: { memoryLimitMb: { type: 'integer' }, uploadMaxFilesizeMb: { type: 'integer' }, postMaxSizeMb: { type: 'integer' }, maxExecutionTime: { type: 'integer' } },
      },
    }, ['site_id']),
    args: z.object({
      site_id: zSite, name: z.string().optional(), docroot: z.string().optional(), publish_mode: zPublishMode.optional(),
      publish_debounce_sec: z.number().int().optional(), healthcheck_path: z.string().optional(),
      php: z.object({ memoryLimitMb: z.number().int().optional(), uploadMaxFilesizeMb: z.number().int().optional(), postMaxSizeMb: z.number().int().optional(), maxExecutionTime: z.number().int().optional() }).strict().optional(),
    }),
    // Same validation as PATCH /api/v1/sites/:id (normalized docroot, debounce bounds…).
    run: (ctx, req, a) => keyApi.updateSite(ctx, req, a.site_id, parseBody(siteUpdateArgs, {
      ...(a.name !== undefined ? { name: a.name } : {}), ...(a.docroot !== undefined ? { docroot: a.docroot } : {}),
      ...(a.publish_mode ? { publishMode: a.publish_mode } : {}), ...(a.publish_debounce_sec !== undefined ? { publishDebounceSec: a.publish_debounce_sec } : {}),
      ...(a.healthcheck_path !== undefined ? { healthcheckPath: a.healthcheck_path } : {}), ...(a.php ? { php: a.php } : {}),
    })),
  },
  {
    name: 'list_files', title: 'List a folder', readOnly: true,
    description: 'Entries of a folder of the site (scope files.read). Paths are relative to the site area root ("/" by default).',
    inputSchema: obj({ site_id: siteId, path: relPath('Folder, e.g. "/" or "/wp-content/themes".'), area }, ['site_id']),
    args: z.object({ site_id: zSite, path: zPath.optional(), area: zArea }),
    run: (ctx, _r, a) => keyApi.listFiles(ctx, a.site_id, (a.area ?? 'staging') as SiteArea, a.path ?? '/'),
  },
  {
    name: 'read_file', title: 'Read a text file', readOnly: true,
    description: 'Content of a text file (≤ 2 MB; binary files are reported, not returned). Scope files.read.',
    inputSchema: obj({ site_id: siteId, path: relPath('File path, e.g. "/index.php".'), area }, ['site_id', 'path']),
    args: z.object({ site_id: zSite, path: zPath, area: zArea }),
    run: async (ctx, _r, a) => {
      const t = await keyApi.readText(ctx, a.site_id, (a.area ?? 'staging') as SiteArea, a.path);
      if (t.content === null) return { path: t.path, size: t.size, binary: t.binary, tooLarge: t.tooLarge, content: null };
      return t.content;
    },
  },
  {
    name: 'write_file', title: 'Write a file',
    description: 'Creates or replaces a file (≤ 8 MB, scope files.write). Folders are created as needed. Text in `content`, or binary in `content_base64`. Code goes to staging: publish to put it live.',
    inputSchema: obj({
      site_id: siteId, path: relPath('File path, e.g. "/index.php".'), content: { type: 'string', description: 'UTF-8 text.' },
      content_base64: { type: 'string', description: 'Binary content, base64.' }, overwrite: { type: 'boolean', description: 'Replace an existing file (default true).' }, area,
    }, ['site_id', 'path']),
    args: z.object({ site_id: zSite, path: zPath, content: z.string().optional(), content_base64: z.string().optional(), overwrite: z.boolean().optional(), area: zArea }),
    run: async (ctx, _r, a) => {
      if ((a.content === undefined) === (a.content_base64 === undefined)) throw new AppError(400, 'Give content or content_base64', 'validation');
      const buf = a.content !== undefined ? Buffer.from(a.content, 'utf8') : Buffer.from(a.content_base64, 'base64');
      const ar = (a.area ?? 'staging') as SiteArea;
      await ensureParents(ctx, a.site_id, ar, a.path);
      const p = await keyApi.putFile(ctx, a.site_id, ar, a.path, buf.length, Readable.from([buf]), a.overwrite !== false);
      return { path: p, bytes: buf.length };
    },
  },
  {
    name: 'make_directory', title: 'Create a folder',
    description: 'Creates a folder (and its missing parents). Scope files.write.',
    inputSchema: obj({ site_id: siteId, path: relPath('Folder path.'), area }, ['site_id', 'path']),
    args: z.object({ site_id: zSite, path: zPath, area: zArea }),
    run: async (ctx, _r, a) => {
      const ar = (a.area ?? 'staging') as SiteArea;
      await ensureParents(ctx, a.site_id, ar, `${a.path.replace(/\/+$/, '')}/x`);
      return { path: a.path };
    },
  },
  {
    name: 'delete_paths', title: 'Delete files or folders', destructive: true,
    description: 'Deletes files or whole folders (scope files.write). Cannot be undone in staging until the next publish; the live release is not affected.',
    inputSchema: obj({ site_id: siteId, paths: { type: 'array', items: { type: 'string' }, description: 'Paths to delete.' }, area }, ['site_id', 'paths']),
    args: z.object({ site_id: zSite, paths: z.array(zPath).min(1).max(1000), area: zArea }),
    run: (ctx, _r, a) => keyApi.remove(ctx, a.site_id, (a.area ?? 'staging') as SiteArea, a.paths),
  },
  {
    name: 'move_path', title: 'Move or rename',
    description: 'Moves / renames a file or folder (scope files.write).',
    inputSchema: obj({ site_id: siteId, from: relPath('Source.'), to: relPath('Destination (full path).'), overwrite: { type: 'boolean' }, area }, ['site_id', 'from', 'to']),
    args: z.object({ site_id: zSite, from: zPath, to: zPath, overwrite: z.boolean().optional(), area: zArea }),
    run: (ctx, _r, a) => keyApi.move(ctx, a.site_id, (a.area ?? 'staging') as SiteArea, [{ from: a.from, to: a.to }], a.overwrite === true),
  },
  {
    name: 'copy_path', title: 'Copy',
    description: 'Copies a file or a folder to a new path (scope files.write).',
    inputSchema: obj({ site_id: siteId, from: relPath('Source.'), to: relPath('Destination (must not exist).'), area }, ['site_id', 'from', 'to']),
    args: z.object({ site_id: zSite, from: zPath, to: zPath, area: zArea }),
    run: (ctx, _r, a) => keyApi.move(ctx, a.site_id, (a.area ?? 'staging') as SiteArea, [{ from: a.from, to: a.to }], false, true),
  },
  {
    name: 'extract_archive', title: 'Extract an archive',
    description: 'Extracts a .zip / .tar / .tar.gz already in the site into a folder (default: its own folder). Existing files are kept unless overwrite. Scope files.write.',
    inputSchema: obj({ site_id: siteId, path: relPath('Archive path.'), to: relPath('Target folder.'), overwrite: { type: 'boolean' }, area }, ['site_id', 'path']),
    args: z.object({ site_id: zSite, path: zPath, to: zPath.optional(), overwrite: z.boolean().optional(), area: zArea }),
    run: (ctx, _r, a) => keyApi.extract(ctx, a.site_id, (a.area ?? 'staging') as SiteArea, a.path, a.to, a.overwrite === true),
  },
  {
    name: 'staging_changes', title: 'Unpublished changes', readOnly: true,
    description: 'What changed in the code (staging) since the live release: the files a publish would ship. Scope files.read.',
    inputSchema: obj({ site_id: siteId }, ['site_id']), args: z.object({ site_id: zSite }),
    run: (ctx, _r, a) => keyApi.stagingStatus(ctx, a.site_id),
  },
  {
    name: 'publish', title: 'Publish the site',
    description: 'Publishes the code (staging) as a new release and puts it live (scope releases.publish). The previous release stays available for rollback.',
    inputSchema: obj({ site_id: siteId, message: { type: 'string', description: 'Release note.' } }, ['site_id']),
    args: z.object({ site_id: zSite, message: z.string().max(500).optional() }),
    run: (ctx, req, a) => keyApi.publish(ctx, req, a.site_id, a.message ?? null),
  },
  {
    name: 'list_releases', title: 'Releases', readOnly: true,
    description: 'Releases of the site, newest first (number, status, date, trigger).',
    inputSchema: obj({ site_id: siteId, limit: { type: 'integer', minimum: 1, maximum: 100 } }, ['site_id']),
    args: z.object({ site_id: zSite, limit: z.number().int().min(1).max(100).optional() }),
    run: (ctx, _r, a) => keyApi.releases(ctx, a.site_id, a.limit ?? 20, 0),
  },
  {
    name: 'rollback', title: 'Roll back', destructive: true,
    description: 'Puts a previous release live again (scope releases.publish). release_id comes from list_releases.',
    inputSchema: obj({ site_id: siteId, release_id: { type: 'integer' } }, ['site_id', 'release_id']),
    args: z.object({ site_id: zSite, release_id: z.number().int().positive() }),
    run: async (ctx, req, a) => { await keyApi.rollback(ctx, req, a.site_id, a.release_id); return { rolledBack: true }; },
  },
  {
    name: 'list_parent_domains', title: 'Domains for subdomains', readOnly: true,
    description: 'Domains of the account under which add_subdomain can create a subdomain (scope domains.subdomain). A verified parent gives an immediately verified subdomain (HTTPS certificate issued automatically).',
    inputSchema: obj({}, []), args: z.object({}).passthrough(),
    run: (ctx) => keyApi.parentDomains(ctx),
  },
  {
    name: 'list_subdomains', title: 'My subdomains', readOnly: true,
    description: 'Subdomains this key created, with the site they serve.',
    inputSchema: obj({}, []), args: z.object({}).passthrough(),
    run: (ctx) => keyApi.subdomains(ctx),
  },
  {
    name: 'add_subdomain', title: 'Attach a subdomain',
    description: 'Creates a subdomain of a domain ALREADY in the account (e.g. "blog.example.com" under "example.com") and routes it to one of the sites of the key (scope domains.subdomain). Its DNS records go into the parent zone; HTTPS follows automatically. A new root domain cannot be added here (ask a human to add it in the panel).',
    inputSchema: obj({ site_id: siteId, name: { type: 'string', description: 'Full name, e.g. "blog.example.com".' } }, ['site_id', 'name']),
    args: z.object({ site_id: zSite, name: z.string().min(4).max(253) }),
    run: (ctx, req, a) => keyApi.addSubdomain(ctx, req, a.site_id, a.name),
  },
  {
    name: 'remove_subdomain', title: 'Remove a subdomain', destructive: true,
    description: 'Removes a subdomain THIS key created (list_subdomains). Other domains are never touched.',
    inputSchema: obj({ name: { type: 'string', description: 'Full name of the subdomain.' } }, ['name']),
    args: z.object({ name: z.string().min(4).max(253) }),
    run: async (ctx, req, a) => { await keyApi.removeSubdomain(ctx, req, a.name); return { deleted: true }; },
  },
  {
    name: 'read_logs', title: 'Read logs', readOnly: true,
    description: 'Recent log lines of the site (scope logs.read): access, error (web server / PHP) or app.',
    inputSchema: obj({ site_id: siteId, source: { type: 'string', enum: ['access', 'error', 'app'] }, query: { type: 'string', description: 'Text filter.' }, limit: { type: 'integer', minimum: 1, maximum: 2000 } }, ['site_id']),
    args: z.object({ site_id: zSite, source: z.enum(['access', 'error', 'app']).optional(), query: z.string().max(200).optional(), limit: z.number().int().min(1).max(2000).optional() }),
    run: (ctx, _r, a) => keyApi.logs(ctx, a.site_id, { source: a.source ?? 'error', q: a.query ?? null, limit: a.limit ?? 200 }),
  },
];

/** mkdir -p of the parents of `path` (existing folders are fine). */
async function ensureParents(ctx: ApiKeyContext, siteId: number, area: SiteArea, path: string): Promise<void> {
  const segs = path.split('/').filter(Boolean).slice(0, -1);
  let cur = '';
  for (const s of segs) {
    cur += `/${s}`;
    try {
      await keyApi.mkdir(ctx, siteId, area, cur);
    } catch (err) {
      if (!(err instanceof AppError) || err.code !== 'fileExists') throw err;
    }
  }
}

const INSTRUCTIONS = [
  'Oblimint hosting panel. This key works on ONE hosting account and only on the sites list_sites returns.',
  'A site has two file areas: "staging" (its code, never live as is) and "data" (files the site itself writes, live).',
  'Workflow: write / upload code into staging, check staging_changes, then publish to create a release and put it live.',
  'The live code is read-only: every change goes through staging and publish; rollback restores a previous release.',
  'A site in publish mode "auto" puts every staging change live a few seconds later: on a live site, switch it to "manual" (update_site) before developing.',
  'Call get_guide for the full guide (rights, tools, how to develop on a live site and roll back).',
].join(' ');

type JsonRpcId = string | number | null;
interface RpcMessage { jsonrpc?: string; id?: JsonRpcId; method?: string; params?: Record<string, unknown> }

const rpcError = (id: JsonRpcId, code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } });

function textResult(value: unknown, isError = false) {
  let text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  if (text.length > MAX_TEXT_RESULT) text = `${text.slice(0, MAX_TEXT_RESULT)}\n… (cut at ${MAX_TEXT_RESULT} characters)`;
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}

export function toolList() {
  return TOOLS.map((t) => ({
    name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema,
    annotations: { title: t.title, readOnlyHint: t.readOnly === true, destructiveHint: t.destructive === true, openWorldHint: false },
  }));
}

/** One JSON-RPC message → its answer (null for a notification). */
export async function handleRpc(ctx: ApiKeyContext, req: Request, msg: RpcMessage): Promise<unknown | null> {
  const id = msg.id ?? null;
  const isNotification = msg.id === undefined;
  if (msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return isNotification ? null : rpcError(id, -32600, 'Invalid request');
  switch (msg.method) {
    case 'initialize': {
      const asked = typeof msg.params?.protocolVersion === 'string' ? msg.params.protocolVersion : '';
      const protocolVersion = (MCP_PROTOCOL_VERSIONS as readonly string[]).includes(asked) ? asked : MCP_PROTOCOL_VERSIONS[0];
      return {
        jsonrpc: '2.0', id,
        result: { protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'oblimint', title: 'Oblimint', version: serverVersion }, instructions: INSTRUCTIONS },
      };
    }
    case 'ping':
      return { jsonrpc: '2.0', id, result: {} };
    case 'tools/list':
      return { jsonrpc: '2.0', id, result: { tools: toolList() } };
    case 'tools/call': {
      const name = msg.params?.name;
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) return rpcError(id, -32602, `Unknown tool: ${String(name)}`);
      const parsed = tool.args.safeParse(msg.params?.arguments ?? {});
      if (!parsed.success) return { jsonrpc: '2.0', id, result: textResult(`Invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`, true) };
      try {
        return { jsonrpc: '2.0', id, result: textResult(await tool.run(ctx, req, parsed.data)) };
      } catch (err) {
        // Tool errors go back to the model (it can react); infrastructure details stay out (A6).
        const e = err instanceof AppError ? err : null;
        const message = e && e.statusCode < 500 ? `${e.message}${e.code ? ` (${e.code})` : ''}` : 'Internal error: try again later';
        return { jsonrpc: '2.0', id, result: textResult(message, true) };
      }
    }
    default:
      if (isNotification) return null; // notifications/initialized, notifications/cancelled…
      return rpcError(id, -32601, `Method not found: ${msg.method}`);
  }
}

export const mcpRouter = Router();
mcpRouter.use(apiKeyAuthLimiter, apiKeyAuth, apiKeyLimiter);

mcpRouter.post('/', async (req: Request, res: Response) => {
  const ctx = req.apiKey!;
  const body = req.body as RpcMessage | RpcMessage[] | undefined;
  if (!body || typeof body !== 'object') { res.status(400).json(rpcError(null, -32700, 'Parse error')); return; }
  const batch = Array.isArray(body);
  const answers = (await Promise.all((batch ? body : [body]).map((m) => handleRpc(ctx, req, m)))).filter((a) => a !== null);
  if (!answers.length) { res.status(202).end(); return; }
  res.json(batch ? answers : answers[0]);
});

// Stateless server: no server-initiated stream, no session to delete.
mcpRouter.get('/', (_req, res) => { res.setHeader('Allow', 'POST'); res.status(405).json(rpcError(null, -32000, 'Method not allowed: POST JSON-RPC messages')); });
mcpRouter.delete('/', (_req, res) => { res.setHeader('Allow', 'POST'); res.status(405).end(); });
