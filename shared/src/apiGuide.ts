// ─────────────────────────────────────────────────────────────────────────────
// Guide of the access-key API and MCP server, for the humans who create a key
// and the AI agents they hand it to ("give this file to Claude Code"). Shown
// on the account's Access keys tab (copy / download as .md), served by
// GET /api/v1/guide and the get_guide MCP tool. Keep it in step with
// routes/v1.routes.ts and services/apiKeys/mcp.ts. No host name of a real
// platform: the panel origin is passed in.
// ─────────────────────────────────────────────────────────────────────────────

export type ApiGuideLang = 'en' | 'fr';

export const API_GUIDE_LANGS: readonly ApiGuideLang[] = ['en', 'fr'];

/** The guide as Markdown, with `panel` (e.g. https://panel.example.com) in the commands. */
export function apiKeyGuide(lang: ApiGuideLang, panel: string): string {
  return lang === 'fr' ? fr(panel) : en(panel);
}

const en = (panel: string) => `# Oblimint — API and AI agent guide

This guide is for a **script**, a **CI** or an **AI agent** (Claude Code…) that was given an **Oblimint access key** (\`obk_…\`). Hand it to your agent as is: it explains how to connect, how the panel works and how to develop, publish and roll back cleanly.

A key works on **one hosting account only**, and only on the sites and with the rights chosen when it was created.

---

## 1. Connecting

### Option A — MCP (recommended for Claude Code)

\`\`\`bash
claude mcp add --transport http oblimint ${panel}/mcp \\
  --header "Authorization: Bearer obk_XXXXXXXX"
\`\`\`

Replace the key with yours. Then check with the **\`whoami\`** tool: it shows the key, its rights (*scopes*), its site scope and the account. The **\`get_guide\`** tool returns this guide.

### Option B — REST API

Base: \`${panel}/api/v1\`, header \`Authorization: Bearer obk_…\`.

\`\`\`bash
curl -H "Authorization: Bearer $OBK" ${panel}/api/v1/me
curl -H "Authorization: Bearer $OBK" ${panel}/api/v1/sites
\`\`\`

JSON answers \`{ "success": true, "data": … }\`. On error: \`{ "success": false, "error": "…", "code": "…" }\`. This guide is also served by \`GET /api/v1/guide?lang=en\` (Markdown).

> **Never put the key in a site file, a commit or a log.** Keep it in an environment variable (\`OBK\`). If it leaks, revoke it from the panel (Access keys tab of the account).

---

## 2. How Oblimint works (important)

Oblimint is **immutable-code** hosting: the live code is **never changed in place**.

| Area | What | Live? |
|---|---|---|
| **staging** (\`area: "staging"\`, default) | The source code of the site, the one you write | No, until it is published |
| **release** | Frozen snapshot of staging, created by a **publish** | Yes: the "current" release is served, **read-only** |
| **data** (\`area: "data"\`) | Files the site writes itself (uploads, cache, sessions) | Yes, immediately, but **PHP never runs there** |

Consequences:

1. **Write to staging, then publish.** Publishing creates a new release and puts it live; the previous ones stay available for a \`rollback\`.
2. **Publish mode of the site** (\`publishMode\` field of \`get_site\`):
   - \`auto\` (default for a new site): staging changes are published **automatically** a few seconds after the last write. **Every batch of files therefore goes live.**
   - \`manual\`: nothing goes live until you call **\`publish\`**.
   - \`approval\`: publishing waits for a **human's approval** in the panel. Tell them.
3. **There is no staging preview**: what is not published cannot be visited. To test before the real site goes live, use a development site (see §5).
4. A PHP file put in \`data\` will **never** run: code goes to \`staging\`.
5. Paths are **relative to the site area**: \`/index.php\`, \`/wp-content/themes/x/style.css\`. You cannot leave the site (\`..\` is refused).
6. **Document root (\`docroot\`)**: the staging subfolder the web server serves (e.g. \`public\` for Laravel, empty = root). Everything **outside** the document root (e.g. \`/config/secrets.php\` when the root is \`public\`) is published with the code but **never served**: sensitive configuration files belong there.
7. **Symbolic links** are shown but never followed nor created.

---

## 3. Key rights (scopes)

| Scope | What it allows |
|---|---|
| \`files.read\` | List and read files (staging and data), see unpublished changes |
| \`files.write\` | Write, create folders, move, copy, delete, extract archives, upload large files |
| \`releases.publish\` | Publish staging (go live) and roll back |
| \`sites.manage\` | Change site settings: name, document root, publish mode, auto-publish delay, health-check path, PHP settings |
| \`sites.create\` | Create sites in the account (they join the key automatically) |
| \`domains.subdomain\` | Attach to the sites **subdomains** of a domain **already in** the account, remove the ones the key created |
| \`logs.read\` | Read access, error (web server / PHP) and application logs |

Never possible with a key: deleting a site, adding a **new root domain**, managing databases, FTP / mail accounts, users, or touching another account.

A key never has more rights than the human who created it: if they lose a right, so does the key. A site outside the key's scope answers **"not found"** (as if it did not exist). A missing right answers **\`keyScope\`**. Do not work around it: ask the human to widen the key.

---

## 4. MCP tools

| Tool | Purpose | Scope |
|---|---|---|
| \`whoami\` | The key, its rights, the account | — |
| \`get_guide\` | This guide (\`lang\`: \`en\` or \`fr\`) | — |
| \`list_sites\` / \`get_site\` | Sites of the key (id, slug, domains, status, document root, publish mode, live release) | — |
| \`create_site\` | Create a site: \`name\`, \`slug\` (a-z, 0-9, -), \`base\`, \`app_profile?\`, \`docroot?\`, \`publish_mode?\` | \`sites.create\` |
| \`update_site\` | Change a site: \`name?\`, \`docroot?\`, \`publish_mode?\`, \`publish_debounce_sec?\`, \`healthcheck_path?\`, \`php?\` | \`sites.manage\` |
| \`list_files\` | List a folder (\`path\`, \`area\`) | \`files.read\` |
| \`read_file\` | Read a text file (≤ 2 MB) | \`files.read\` |
| \`write_file\` | Write a file (≤ 8 MB): \`content\` (text) or \`content_base64\`; creates the parent folders | \`files.write\` |
| \`make_directory\` | Create a folder (and its parents) | \`files.write\` |
| \`move_path\` / \`copy_path\` | Move, rename, copy (within the same site and area) | \`files.write\` |
| \`delete_paths\` | Delete files / folders | \`files.write\` |
| \`extract_archive\` | Extract a \`.zip\` / \`.tar\` / \`.tar.gz\` already in the site | \`files.write\` |
| \`staging_changes\` | What changed since the live release (what \`publish\` would ship) | \`files.read\` |
| \`publish\` | Publish (new live release), \`message?\` | \`releases.publish\` |
| \`list_releases\` | Release history, newest first (\`limit\`) | — |
| \`rollback\` | Back to a release (\`release_id\`) | \`releases.publish\` |
| \`list_parent_domains\` | Account domains a subdomain can be created under | \`domains.subdomain\` |
| \`add_subdomain\` | Create \`xxx.existing-domain.tld\` and route it to a site | \`domains.subdomain\` |
| \`list_subdomains\` / \`remove_subdomain\` | Subdomains of the key (only the ones it created can be removed) | \`domains.subdomain\` |
| \`read_logs\` | \`error\` (default), \`access\` or \`app\` logs; \`query\` filter, \`limit\` (≤ 2000) | \`logs.read\` |

**Bases (\`base\`)**: \`apache-php7.4\`, \`apache-php8.1\` … \`apache-php8.4\` (\`.htaccess\` supported), \`nginx-php8.1\` … \`nginx-php8.4\`, \`nginx-static\` (plain HTML/JS/CSS).
**Profiles (\`app_profile\`)**: \`wordpress\`, \`joomla\`, \`drupal\`, \`prestashop\`, \`laravel\` (document root \`public\`), \`generic-php\`, \`static\`. A profile sets the document root and declares the data folders (e.g. \`wp-content/uploads\`).
**PHP settings (\`php\`)**: \`{ memoryLimitMb, uploadMaxFilesizeMb, postMaxSizeMb, maxExecutionTime }\`, within the limits of the account's plan.

---

## 5. Developing directly on Oblimint

The idea: the agent develops on the platform, puts things live **only once the work is done**, tests, and rolls back if something breaks. Always start with \`whoami\` then \`get_site\` to know your rights and the site's \`publishMode\`.

**Keep the reference source code in your local working folder** (ideally a git repository) and push it to Oblimint: it is faster for large changes, and you can send it identically to two sites.

### Method A — twin development site (recommended for a live site)

Lets you **see and test** the work before touching the real site. Rights: \`sites.create\`, \`files.write\`, \`releases.publish\`, \`domains.subdomain\`, \`logs.read\`.

1. \`create_site\`: same \`base\` and \`app_profile\` as the production site, slug \`<slug>-dev\`, \`publish_mode: "auto"\`.
2. Copy the current production code into it (from your local folder, or \`read_file\` on the production site then \`write_file\` on the dev site; for many files, an archive + \`extract_archive\`).
3. \`list_parent_domains\` then \`add_subdomain\`: \`dev.example.com\` → the dev site. The HTTPS certificate follows within a minute or two.
4. Develop: \`write_file\` → the automatic publish follows a few seconds later → test \`https://dev.example.com/\` → \`read_logs\` on errors. Repeat as needed.
5. When ready, apply **the same files** to the production site's staging, check with \`staging_changes\`, then \`publish\` with a clear \`message\` (if production is \`auto\`, it goes live by itself: send the whole batch at once).
6. Test production. If anything breaks: \`list_releases\` then \`rollback\` to the previous release, and fix it on the dev site.
7. At the end, ask the human whether to keep the dev site (a key cannot delete a site); remove the subdomain with \`remove_subdomain\` if needed.

> The dev site shares neither the production \`data\` files (uploads) nor its database, and a key does not manage databases. If the app needs a development database, ask the human. **Never run destructive tests against the production database.**

### Method B — directly on the site, with manual publishing

Simpler, but nothing is visible before going live: you test after publishing, with the rollback ready. Rights: \`sites.manage\`, \`files.write\`, \`releases.publish\`, \`logs.read\`.

1. \`get_site\` → note the current \`publishMode\`. If it is \`auto\`, **switch the site to manual first**: \`update_site { "site_id": 12, "publish_mode": "manual" }\`. Otherwise every write goes live a few seconds later.
2. Develop in staging (\`write_file\`, \`extract_archive\`…). The live site does not change.
3. \`staging_changes\` → check the list (no forgotten archive, test file or secret).
4. \`publish\` with a clear \`message\`. Note the number of the previous release (\`list_releases\`).
5. Test the live site and \`read_logs\` (\`source: "error"\`).
6. If it breaks: \`rollback\` to the previous release, fix in staging and start again at step 3.
7. Restore the original \`publishMode\` if the human wants it (\`update_site { "publish_mode": "auto" }\`).

### Fixing a production bug

1. \`read_logs\` (\`source: "error"\`, \`limit: 200\`) to understand.
2. \`read_file\` → fix → \`write_file\` to staging.
3. \`staging_changes\` → \`publish\` with a clear \`message\`.
4. Test again; if it breaks: \`list_releases\` then \`rollback\`.

### Deploying a new site on a subdomain

1. \`create_site\`: \`{ "name": "Landing", "slug": "landing", "base": "nginx-static" }\` → note the \`id\`.
2. \`write_file\` for each file (\`/index.html\`, \`/assets/app.css\`…), or an archive + \`extract_archive\`.
3. \`staging_changes\`, then \`publish\` (in \`auto\` it happens by itself).
4. \`list_parent_domains\` → pick a **verified** domain, then \`add_subdomain\`: \`{ "site_id": 12, "name": "landing.example.com" }\`.
5. DNS and the HTTPS certificate follow automatically. Test \`https://landing.example.com/\`.

### PHP apps and large batches of files

- Many or heavy files: **build an archive** (\`.zip\` or \`.tar.gz\`), upload it (REST, see §6), then **\`extract_archive\`** in staging. Delete the archive afterwards (\`delete_paths\`) so it is not published.
- No command is run for you (\`composer install\`, \`npm run build\`…): upload the result (e.g. \`vendor/\`, built files).
- Laravel: \`create_site\` with \`app_profile: "laravel"\` (document root \`public\`).
- Secrets (API keys, passwords): **never** in the document root. Put them outside the served folder, or ask the human to declare them in the site's environment variables (Variables tab of the panel).

---

## 6. REST API — reference

Every route is under \`/api/v1\`, with \`Authorization: Bearer obk_…\`. Files: \`?area=staging\` (default) or \`?area=data\` (or \`area\` in the JSON body).

| Method | Route | Body / parameters | Scope |
|---|---|---|---|
| GET | \`/me\` | | — |
| GET | \`/guide\` | \`?lang=en\` or \`fr\`: this guide as Markdown | — |
| GET | \`/sites\` · \`/sites/:id\` | | — |
| POST | \`/sites\` | \`{ name, slug, base, appProfile?, docroot?, basePath?, publishMode?, publishDebounceSec?, healthcheckPath?, applyProfileDataPaths? }\` | \`sites.create\` |
| PATCH | \`/sites/:id\` | \`{ name?, docroot?, publishMode?, publishDebounceSec? (5-3600), healthcheckPath?, php? }\` | \`sites.manage\` |
| GET | \`/sites/:id/files?path=/dir\` | listing | \`files.read\` |
| GET | \`/sites/:id/files/text?path=/f\` | text content (≤ 2 MB) | \`files.read\` |
| GET | \`/sites/:id/files/content?path=/f\` | raw file (Range supported) | \`files.read\` |
| PUT | \`/sites/:id/files/content?path=/f&overwrite=1\` | **raw body**, \`Content-Type: application/octet-stream\`, ≤ 8 MB | \`files.write\` |
| POST | \`/sites/:id/uploads\` | \`{ path, size, overwrite? }\` → session \`{ id, chunkSize, count }\` (files > 8 MB) | \`files.write\` |
| PUT | \`/uploads/:uploadId/:index\` | raw chunk number \`index\` (exactly \`chunkSize\` bytes, the last one shorter) | \`files.write\` |
| POST | \`/sites/:id/files/mkdir\` | \`{ path }\` | \`files.write\` |
| POST | \`/sites/:id/files/delete\` | \`{ paths: [] }\` (≤ 1000) | \`files.write\` |
| POST | \`/sites/:id/files/move\` · \`/copy\` | \`{ items: [{ from, to }], overwrite? }\` | \`files.write\` |
| POST | \`/sites/:id/files/extract\` | \`{ path, to?, overwrite? }\` | \`files.write\` |
| GET | \`/sites/:id/staging\` | unpublished changes | \`files.read\` |
| POST | \`/sites/:id/publish\` | \`{ message? }\` (≤ 500 characters) | \`releases.publish\` |
| GET | \`/sites/:id/releases\` | \`?limit=&offset=\` | — |
| POST | \`/sites/:id/releases/:releaseId/rollback\` | | \`releases.publish\` |
| GET | \`/sites/:id/logs\` | \`?source=error\\|access\\|app&q=&limit=&since=&until=&status=\` | \`logs.read\` |
| GET | \`/domains\` · \`/subdomains\` | possible parent domains · subdomains of the key | \`domains.subdomain\` |
| POST | \`/sites/:id/subdomains\` | \`{ name: "blog.example.com" }\` | \`domains.subdomain\` |
| DELETE | \`/subdomains/:name\` | | \`domains.subdomain\` |

Switch a site to manual publishing:

\`\`\`bash
curl -X PATCH -H "Authorization: Bearer $OBK" -H "Content-Type: application/json" \\
  -d '{"publishMode":"manual"}' ${panel}/api/v1/sites/12
\`\`\`

Upload an archive then extract it:

\`\`\`bash
curl -X PUT -H "Authorization: Bearer $OBK" -H "Content-Type: application/octet-stream" \\
  --data-binary @site.zip "${panel}/api/v1/sites/12/files/content?path=/site.zip&overwrite=1"
curl -X POST -H "Authorization: Bearer $OBK" -H "Content-Type: application/json" \\
  -d '{"path":"/site.zip"}' ${panel}/api/v1/sites/12/files/extract
\`\`\`

Archive over 8 MB: \`POST /sites/12/uploads\` \`{ "path": "/site.zip", "size": <bytes> }\`, then send each \`chunkSize\`-byte chunk with \`PUT /uploads/<id>/<index>\` (0, 1, 2…, several in parallel is fine). The answer to the last one contains \`"done": true\`.

---

## 7. Limits and common errors

| Limit | Value |
|---|---|
| \`write_file\` / PUT content | 8 MB per file (above: upload sessions) |
| \`read_file\` | 2 MB, text only |
| Requests | 1,200 / min per key |
| Invalid keys | 20 attempts / 15 min per IP address |
| Disk quota | the account plan's |

| Code | Meaning | What to do |
|---|---|---|
| \`invalidKey\` (401) | Invalid, expired or revoked key, or source address not allowed | Ask for a new key |
| \`rateLimited\` (429) | Too many requests | Slow down, retry a bit later |
| \`keyScope\` (403) | The key lacks the right | Ask the human to add it |
| \`notFound\` (404) | Site outside the key's scope, or missing path | Check with \`list_sites\` / \`list_files\` |
| \`fileForbidden\` (403) | Folder that cannot be changed (area root, the site's own \`data\` folder) | Write in a subfolder |
| \`fileExists\` (409) | The file already exists | \`overwrite: true\` if intended |
| \`quotaExceeded\` / \`uploadsBlocked\` (507) | Disk quota exceeded | Free some space, tell the human |
| \`notASubdomain\` (400) | The name is not under a domain of the account | \`list_parent_domains\`; a new domain is added in the panel |
| \`slugTaken\` (409) | Slug already used | Pick another one |
| \`publishInProgress\` / \`noChanges\` (409) | Publish already running / nothing to publish | Wait / check \`staging_changes\` |
| \`hostdOutdated\` (503) | The server's file service is older than the panel | Tell the human (an update to apply in the panel), then retry |

---

## 8. Good manners

- **Say what you are about to do** before a deletion, a publish or a rollback, especially on a live site.
- **Check before publishing** (\`staging_changes\`) and **test afterwards** (site URL, \`read_logs\`).
- **Small consistent batches**: one publish = one understandable change, with a \`message\`.
- **Do not delete what you did not create** without an explicit request.
- **Leave settings as you found them** (publish mode…) unless the human agrees.
- Everything you do is **recorded in the panel's audit log**, under the human who created the key and with the key's name.
`;

const fr = (panel: string) => `# Oblimint — Guide de l'API et des agents IA

Ce guide s'adresse à un **script**, une **CI** ou un **agent IA** (Claude Code…) qui a reçu une **clé d'accès Oblimint** (\`obk_…\`). Donne-le tel quel à ton agent : il y trouvera comment se connecter, comment le panel fonctionne et comment développer, publier et revenir en arrière proprement.

Une clé travaille sur **un seul compte d'hébergement**, et seulement sur les sites et avec les droits choisis à sa création.

---

## 1. Se connecter

### Option A — MCP (recommandée pour Claude Code)

\`\`\`bash
claude mcp add --transport http oblimint ${panel}/mcp \\
  --header "Authorization: Bearer obk_XXXXXXXX"
\`\`\`

Remplace la clé par la tienne. Vérifie ensuite avec l'outil **\`whoami\`** : il affiche la clé, ses droits (*scopes*), son périmètre de sites et le compte. L'outil **\`get_guide\`** renvoie ce guide.

### Option B — API REST

Base : \`${panel}/api/v1\`, en-tête \`Authorization: Bearer obk_…\`.

\`\`\`bash
curl -H "Authorization: Bearer $OBK" ${panel}/api/v1/me
curl -H "Authorization: Bearer $OBK" ${panel}/api/v1/sites
\`\`\`

Réponses JSON \`{ "success": true, "data": … }\`. En cas d'erreur : \`{ "success": false, "error": "…", "code": "…" }\`. Ce guide est aussi servi par \`GET /api/v1/guide?lang=fr\` (Markdown).

> **Ne mets jamais la clé dans un fichier du site, un commit ou un log.** Garde-la dans une variable d'environnement (\`OBK\`). Si elle fuit, révoque-la depuis le panel (onglet Clés d'accès du compte).

---

## 2. Comprendre Oblimint (important)

Oblimint est un hébergement à **code immuable** : le code en ligne n'est **jamais modifié sur place**.

| Zone | Quoi | En ligne ? |
|---|---|---|
| **staging** (\`area: "staging"\`, par défaut) | Le code source du site, celui que tu écris | Non, tant qu'il n'est pas publié |
| **release** | Instantané figé du staging, créé par une **publication** | Oui : la release « courante » est servie, en **lecture seule** |
| **data** (\`area: "data"\`) | Fichiers écrits par le site lui-même (uploads, cache, sessions) | Oui, immédiatement, mais **PHP n'y est jamais exécuté** |

Conséquences :

1. **On écrit dans staging, puis on publie.** Publier crée une nouvelle release et la met en ligne ; les précédentes restent disponibles pour un retour arrière (\`rollback\`).
2. **Mode de publication du site** (champ \`publishMode\` de \`get_site\`) :
   - \`auto\` (valeur par défaut d'un nouveau site) : les changements de staging sont publiés **automatiquement** quelques secondes après la dernière écriture. **Chaque lot de fichiers part donc en ligne.**
   - \`manual\` : rien ne part en ligne tant que tu n'appelles pas **\`publish\`**.
   - \`approval\` : la publication attend la **validation d'un humain** dans le panel. Préviens-le.
3. **Il n'y a pas d'aperçu du staging** : ce qui n'est pas publié ne peut pas être visité. Pour tester avant la mise en ligne du vrai site, utilise un site de développement (voir §5).
4. Un fichier PHP posé dans \`data\` ne s'exécutera **jamais** : le code va dans \`staging\`.
5. Les chemins sont **relatifs à la zone du site** : \`/index.php\`, \`/wp-content/themes/x/style.css\`. Impossible de sortir du site (\`..\` est refusé).
6. **Racine web (\`docroot\`)** : le sous-dossier du staging servi par le serveur web (ex. \`public\` pour Laravel, vide = racine). Tout ce qui est **hors** de la racine web (ex. \`/config/secrets.php\` quand la racine est \`public\`) est publié avec le code mais **jamais servi** : c'est là que vont les fichiers de configuration sensibles.
7. Les **liens symboliques** sont affichés mais jamais suivis ni créés.

---

## 3. Droits de la clé (scopes)

| Scope | Ce que ça permet |
|---|---|
| \`files.read\` | Lister et lire les fichiers (staging et data), voir les changements non publiés |
| \`files.write\` | Écrire, créer des dossiers, déplacer, copier, supprimer, extraire des archives, envoyer de gros fichiers |
| \`releases.publish\` | Publier le staging (mise en ligne) et revenir à une release précédente |
| \`sites.manage\` | Modifier les réglages des sites : nom, racine web, mode de publication, délai de publication auto, chemin de contrôle de santé, réglages PHP |
| \`sites.create\` | Créer des sites dans le compte (ils rejoignent automatiquement la clé) |
| \`domains.subdomain\` | Rattacher aux sites des **sous-domaines** d'un domaine **déjà présent** sur le compte, retirer ceux créés par la clé |
| \`logs.read\` | Lire les journaux d'accès, d'erreurs (serveur web / PHP) et applicatifs |

Jamais possible avec une clé : supprimer un site, ajouter un **nouveau domaine racine**, gérer les bases de données, les comptes FTP / mail, les utilisateurs, ou toucher à un autre compte.

Une clé n'a jamais plus de droits que l'humain qui l'a créée : s'il perd un droit, la clé le perd aussi. Un site hors du périmètre répond **« not found »** (comme s'il n'existait pas). Un droit manquant répond **\`keyScope\`**. Ne contourne pas : demande à l'humain d'élargir la clé.

---

## 4. Outils MCP

| Outil | Rôle | Scope |
|---|---|---|
| \`whoami\` | La clé, ses droits, le compte | — |
| \`get_guide\` | Ce guide (\`lang\`: \`fr\` ou \`en\`) | — |
| \`list_sites\` / \`get_site\` | Sites de la clé (id, slug, domaines, statut, racine web, mode de publication, release en ligne) | — |
| \`create_site\` | Créer un site : \`name\`, \`slug\` (a-z, 0-9, -), \`base\`, \`app_profile?\`, \`docroot?\`, \`publish_mode?\` | \`sites.create\` |
| \`update_site\` | Modifier un site : \`name?\`, \`docroot?\`, \`publish_mode?\`, \`publish_debounce_sec?\`, \`healthcheck_path?\`, \`php?\` | \`sites.manage\` |
| \`list_files\` | Lister un dossier (\`path\`, \`area\`) | \`files.read\` |
| \`read_file\` | Lire un fichier texte (≤ 2 Mo) | \`files.read\` |
| \`write_file\` | Écrire un fichier (≤ 8 Mo) : \`content\` (texte) ou \`content_base64\` ; crée les dossiers parents | \`files.write\` |
| \`make_directory\` | Créer un dossier (et ses parents) | \`files.write\` |
| \`move_path\` / \`copy_path\` | Déplacer, renommer, copier (dans le même site et la même zone) | \`files.write\` |
| \`delete_paths\` | Supprimer fichiers / dossiers | \`files.write\` |
| \`extract_archive\` | Extraire un \`.zip\` / \`.tar\` / \`.tar.gz\` déjà présent dans le site | \`files.write\` |
| \`staging_changes\` | Ce qui a changé depuis la release en ligne (ce que \`publish\` enverrait) | \`files.read\` |
| \`publish\` | Publier (nouvelle release en ligne), \`message?\` | \`releases.publish\` |
| \`list_releases\` | Historique des releases, la plus récente en premier (\`limit\`) | — |
| \`rollback\` | Retour à une release (\`release_id\`) | \`releases.publish\` |
| \`list_parent_domains\` | Domaines du compte sous lesquels créer un sous-domaine | \`domains.subdomain\` |
| \`add_subdomain\` | Créer \`xxx.domaine-existant.tld\` et le router vers un site | \`domains.subdomain\` |
| \`list_subdomains\` / \`remove_subdomain\` | Sous-domaines de la clé (seuls ceux qu'elle a créés peuvent être retirés) | \`domains.subdomain\` |
| \`read_logs\` | Journaux \`error\` (par défaut), \`access\` ou \`app\` ; filtre \`query\`, \`limit\` (≤ 2000) | \`logs.read\` |

**Bases (\`base\`)** : \`apache-php7.4\`, \`apache-php8.1\` … \`apache-php8.4\` (\`.htaccess\` supporté), \`nginx-php8.1\` … \`nginx-php8.4\`, \`nginx-static\` (HTML/JS/CSS pur).
**Profils (\`app_profile\`)** : \`wordpress\`, \`joomla\`, \`drupal\`, \`prestashop\`, \`laravel\` (racine web \`public\`), \`generic-php\`, \`static\`. Un profil règle la racine web et déclare les dossiers de données (ex. \`wp-content/uploads\`).
**Réglages PHP (\`php\`)** : \`{ memoryLimitMb, uploadMaxFilesizeMb, postMaxSizeMb, maxExecutionTime }\`, dans les limites du plan du compte.

---

## 5. Développer directement sur Oblimint

L'idée : l'agent développe sur la plateforme, ne met en ligne **qu'une fois le travail terminé**, teste, et revient en arrière si quelque chose casse. Commence toujours par \`whoami\` puis \`get_site\` pour connaître tes droits et le \`publishMode\` du site.

**Garde le code source de référence dans ton dossier de travail local** (idéalement un dépôt git) et pousse-le sur Oblimint : c'est plus rapide pour les gros changements, et tu peux l'envoyer à l'identique sur deux sites.

### Méthode A — site de développement jumeau (recommandée pour un site en ligne)

Permet de **voir et tester** le travail avant de toucher au vrai site. Droits : \`sites.create\`, \`files.write\`, \`releases.publish\`, \`domains.subdomain\`, \`logs.read\`.

1. \`create_site\` : même \`base\` et même \`app_profile\` que le site de production, slug \`<slug>-dev\`, \`publish_mode: "auto"\`.
2. Copie le code actuel de la production dans ce site (depuis ton dossier local, ou \`read_file\` sur le site de production puis \`write_file\` sur le site de dev ; pour beaucoup de fichiers, une archive + \`extract_archive\`).
3. \`list_parent_domains\` puis \`add_subdomain\` : \`dev.exemple.com\` → le site de dev. Le certificat HTTPS suit en une à deux minutes.
4. Développe : \`write_file\` → la publication automatique part après quelques secondes → teste \`https://dev.exemple.com/\` → \`read_logs\` en cas d'erreur. Recommence autant que nécessaire.
5. Quand c'est prêt, applique **les mêmes fichiers** au staging du site de production, vérifie avec \`staging_changes\`, puis \`publish\` avec un \`message\` clair (si la production est en \`auto\`, elle part toute seule : envoie tout le lot d'un coup).
6. Teste la production. En cas de problème : \`list_releases\` puis \`rollback\` vers la release précédente, et corrige sur le site de dev.
7. À la fin, demande à l'humain s'il veut garder le site de dev (une clé ne peut pas supprimer de site) ; retire le sous-domaine avec \`remove_subdomain\` si besoin.

> Le site de dev ne partage ni les fichiers \`data\` (uploads) ni la base de données de la production, et une clé ne gère pas les bases. Si l'appli a besoin d'une base de dev, demande-la à l'humain. **Ne fais jamais de tests destructifs sur la base de production.**

### Méthode B — directement sur le site, en publication manuelle

Plus simple, mais rien n'est visible avant la mise en ligne : on teste après la publication, avec le retour arrière prêt. Droits : \`sites.manage\`, \`files.write\`, \`releases.publish\`, \`logs.read\`.

1. \`get_site\` → note le \`publishMode\` actuel. S'il vaut \`auto\`, **passe le site en manuel d'abord** : \`update_site { "site_id": 12, "publish_mode": "manual" }\`. Sinon chaque écriture part en ligne quelques secondes plus tard.
2. Développe dans le staging (\`write_file\`, \`extract_archive\`…). Le site en ligne ne bouge pas.
3. \`staging_changes\` → contrôle la liste (pas d'archive, de fichier de test ou de secret oublié).
4. \`publish\` avec un \`message\` clair. Note le numéro de la release précédente (\`list_releases\`).
5. Teste le site en ligne et \`read_logs\` (\`source: "error"\`).
6. Si ça casse : \`rollback\` vers la release précédente, puis corrige dans le staging et recommence à l'étape 3.
7. Remets le \`publishMode\` d'origine si l'humain le souhaite (\`update_site { "publish_mode": "auto" }\`).

### Corriger un bug en production

1. \`read_logs\` (\`source: "error"\`, \`limit: 200\`) pour comprendre.
2. \`read_file\` → corriger → \`write_file\` dans le staging.
3. \`staging_changes\` → \`publish\` avec un \`message\` clair.
4. Re-tester ; si ça casse : \`list_releases\` puis \`rollback\`.

### Déployer un nouveau site sur un sous-domaine

1. \`create_site\` : \`{ "name": "Landing", "slug": "landing", "base": "nginx-static" }\` → note l'\`id\`.
2. \`write_file\` pour chaque fichier (\`/index.html\`, \`/assets/app.css\`…), ou une archive + \`extract_archive\`.
3. \`staging_changes\`, puis \`publish\` (en \`auto\`, c'est fait tout seul).
4. \`list_parent_domains\` → choisis un domaine **vérifié**, puis \`add_subdomain\` : \`{ "site_id": 12, "name": "landing.exemple.com" }\`.
5. Le DNS et le certificat HTTPS suivent automatiquement. Teste \`https://landing.exemple.com/\`.

### Applications PHP et gros lots de fichiers

- Beaucoup de fichiers ou des fichiers lourds : **construis une archive** (\`.zip\` ou \`.tar.gz\`), envoie-la (REST, voir §6), puis **\`extract_archive\`** dans le staging. Supprime l'archive ensuite (\`delete_paths\`) pour ne pas la publier.
- Aucune commande n'est lancée pour toi (\`composer install\`, \`npm run build\`…) : envoie le résultat (ex. \`vendor/\`, fichiers compilés).
- Laravel : \`create_site\` avec \`app_profile: "laravel"\` (racine web \`public\`).
- Les secrets (clés d'API, mots de passe) : **jamais** dans la racine web. Mets-les hors du dossier servi, ou demande à l'humain de les déclarer dans les variables d'environnement du site (onglet Variables du panel).

---

## 6. API REST — référence

Toutes les routes sont sous \`/api/v1\`, avec \`Authorization: Bearer obk_…\`. Fichiers : \`?area=staging\` (défaut) ou \`?area=data\` (ou \`area\` dans le corps JSON).

| Méthode | Route | Corps / paramètres | Scope |
|---|---|---|---|
| GET | \`/me\` | | — |
| GET | \`/guide\` | \`?lang=fr\` ou \`en\` : ce guide en Markdown | — |
| GET | \`/sites\` · \`/sites/:id\` | | — |
| POST | \`/sites\` | \`{ name, slug, base, appProfile?, docroot?, basePath?, publishMode?, publishDebounceSec?, healthcheckPath?, applyProfileDataPaths? }\` | \`sites.create\` |
| PATCH | \`/sites/:id\` | \`{ name?, docroot?, publishMode?, publishDebounceSec? (5-3600), healthcheckPath?, php? }\` | \`sites.manage\` |
| GET | \`/sites/:id/files?path=/dir\` | liste | \`files.read\` |
| GET | \`/sites/:id/files/text?path=/f\` | contenu texte (≤ 2 Mo) | \`files.read\` |
| GET | \`/sites/:id/files/content?path=/f\` | fichier brut (Range supporté) | \`files.read\` |
| PUT | \`/sites/:id/files/content?path=/f&overwrite=1\` | **corps brut**, \`Content-Type: application/octet-stream\`, ≤ 8 Mo | \`files.write\` |
| POST | \`/sites/:id/uploads\` | \`{ path, size, overwrite? }\` → session \`{ id, chunkSize, count }\` (fichiers > 8 Mo) | \`files.write\` |
| PUT | \`/uploads/:uploadId/:index\` | morceau brut n° \`index\` (taille exacte \`chunkSize\`, le dernier plus court) | \`files.write\` |
| POST | \`/sites/:id/files/mkdir\` | \`{ path }\` | \`files.write\` |
| POST | \`/sites/:id/files/delete\` | \`{ paths: [] }\` (≤ 1000) | \`files.write\` |
| POST | \`/sites/:id/files/move\` · \`/copy\` | \`{ items: [{ from, to }], overwrite? }\` | \`files.write\` |
| POST | \`/sites/:id/files/extract\` | \`{ path, to?, overwrite? }\` | \`files.write\` |
| GET | \`/sites/:id/staging\` | changements non publiés | \`files.read\` |
| POST | \`/sites/:id/publish\` | \`{ message? }\` (≤ 500 caractères) | \`releases.publish\` |
| GET | \`/sites/:id/releases\` | \`?limit=&offset=\` | — |
| POST | \`/sites/:id/releases/:releaseId/rollback\` | | \`releases.publish\` |
| GET | \`/sites/:id/logs\` | \`?source=error\\|access\\|app&q=&limit=&since=&until=&status=\` | \`logs.read\` |
| GET | \`/domains\` · \`/subdomains\` | domaines parents possibles · sous-domaines de la clé | \`domains.subdomain\` |
| POST | \`/sites/:id/subdomains\` | \`{ name: "blog.exemple.com" }\` | \`domains.subdomain\` |
| DELETE | \`/subdomains/:name\` | | \`domains.subdomain\` |

Passer un site en publication manuelle :

\`\`\`bash
curl -X PATCH -H "Authorization: Bearer $OBK" -H "Content-Type: application/json" \\
  -d '{"publishMode":"manual"}' ${panel}/api/v1/sites/12
\`\`\`

Envoyer une archive puis l'extraire :

\`\`\`bash
curl -X PUT -H "Authorization: Bearer $OBK" -H "Content-Type: application/octet-stream" \\
  --data-binary @site.zip "${panel}/api/v1/sites/12/files/content?path=/site.zip&overwrite=1"
curl -X POST -H "Authorization: Bearer $OBK" -H "Content-Type: application/json" \\
  -d '{"path":"/site.zip"}' ${panel}/api/v1/sites/12/files/extract
\`\`\`

Archive de plus de 8 Mo : \`POST /sites/12/uploads\` \`{ "path": "/site.zip", "size": <octets> }\`, puis envoie chaque morceau de \`chunkSize\` octets avec \`PUT /uploads/<id>/<index>\` (0, 1, 2…, plusieurs en parallèle possible). La réponse du dernier contient \`"done": true\`.

---

## 7. Limites et erreurs courantes

| Limite | Valeur |
|---|---|
| \`write_file\` / PUT content | 8 Mo par fichier (au-delà : sessions d'upload) |
| \`read_file\` | 2 Mo, texte uniquement |
| Requêtes | 1 200 / min par clé |
| Clés invalides | 20 essais / 15 min par adresse IP |
| Quota disque | celui du plan du compte |

| Code | Sens | Que faire |
|---|---|---|
| \`invalidKey\` (401) | Clé invalide, expirée, révoquée, ou adresse IP non autorisée | Demander une nouvelle clé |
| \`rateLimited\` (429) | Trop de requêtes | Ralentir, réessayer un peu plus tard |
| \`keyScope\` (403) | Droit manquant sur la clé | Demander à l'humain d'ajouter le droit |
| \`notFound\` (404) | Site hors du périmètre, ou chemin inexistant | Vérifier avec \`list_sites\` / \`list_files\` |
| \`fileForbidden\` (403) | Dossier non modifiable (racine de la zone, dossier \`data\` du site lui-même) | Écrire dans un sous-dossier |
| \`fileExists\` (409) | Le fichier existe déjà | \`overwrite: true\` si c'est voulu |
| \`quotaExceeded\` / \`uploadsBlocked\` (507) | Quota disque dépassé | Faire de la place, prévenir l'humain |
| \`notASubdomain\` (400) | Le nom n'est pas sous un domaine du compte | \`list_parent_domains\` ; un nouveau domaine se crée dans le panel |
| \`slugTaken\` (409) | Slug déjà utilisé | En choisir un autre |
| \`publishInProgress\` / \`noChanges\` (409) | Publication en cours / rien à publier | Attendre / vérifier \`staging_changes\` |
| \`hostdOutdated\` (503) | Le service de fichiers du serveur est plus ancien que le panel | Prévenir l'humain (mise à jour à appliquer dans le panel), puis réessayer |

---

## 8. Bonnes manières

- **Annonce ce que tu vas faire** avant une suppression, une publication ou un retour arrière, surtout sur un site déjà en ligne.
- **Vérifie avant de publier** (\`staging_changes\`) et **teste après** (URL du site, \`read_logs\`).
- **Petits lots cohérents** : une publication = un changement compréhensible, avec un \`message\`.
- **Ne supprime pas ce que tu n'as pas créé** sans demande explicite.
- **Laisse les réglages comme tu les as trouvés** (mode de publication…) sauf accord de l'humain.
- Tout ce que tu fais est **inscrit au journal d'audit** du panel, au nom de l'humain qui a créé la clé et avec le nom de la clé.
`;
