# Oblimint — images gérées (`images/`)

Images Docker que le panel déploie et pilote (P1 « Cœur immuable », `docs/P1-PLAN.md` §4, §5,
§10–§12, §14). Rien ici n'est construit ni lancé par le serveur Node : le panel tire les images
`meejay/oblimint-*:<OBLIMINT_IMAGE_TAG>` et crée les conteneurs avec les specs de
`server/src/services/docker/specs.ts` (module orchestration).

| Image | Dockerfile | Base | Rôle |
|---|---|---|---|
| `meejay/oblimint-apache-php7.4` … `-apache-php8.4` | `php/Dockerfile` (`ENGINE=apache`) | `php:<v>-fpm-alpine` + Apache 2.4 (Alpine) | site, `.htaccess` |
| `meejay/oblimint-nginx-php8.1` … `-nginx-php8.4` | `php/Dockerfile` (`ENGINE=nginx`) | `php:<v>-fpm-alpine` + nginx (Alpine) | site |
| `meejay/oblimint-nginx-static` | `nginx-static/Dockerfile` | `nginx:1.30.5-alpine` (épinglé) | site statique |
| `meejay/oblimint-edge` | `edge/Dockerfile` | `nginx:1.30.5-alpine` (épinglé) | reverse proxy partagé, TLS, ACME |
| `meejay/oblimint-filesrv` | `filesrv/Dockerfile` | `drakkan/sftpgo:v2.6.6-alpine` (épinglé) | SFTP par compte |
| `meejay/oblimint-hostd` | `../hostd/Dockerfile` | distroless | démon hôte (module hostd) |

Arborescence :

```
images/
  build.sh                 construit / pousse toutes les images
  siteconf/                rendu de configuration en Go (testé par go test), compilé dans chaque base
  common/                  scripts et fichiers partagés des bases de site
    oblimint-entrypoint    PID 1 (sous tini) : rendu → php-fpm + serveur web → supervision
    oblimint-reload        docker exec … oblimint-reload : re-rendu, test, reload gracieux
    lib.sh                 fonctions communes (installé dans /usr/local/lib/oblimint/)
    guard.php              auto_prepend_file : refuse tout script dont le realpath est sous /srv/data
    php.ini                php.ini de production
    placeholder.html       page « Site en attente de première publication » (503)
    ping                   corps de /__oblimint/ping (Apache)
    smoke/                 test de fumée exécuté PENDANT le build (jamais livré)
  php/Dockerfile           bases Apache/nginx + PHP-FPM
  nginx-static/Dockerfile  base statique
  edge/                    nginx.conf, pages d'erreur, entrypoint de l'edge
  filesrv/                 entrypoint SFTPGo + README des hooks
```

## Construire

```sh
images/build.sh                       # tout (sites + edge + filesrv + hostd)
images/build.sh sites                 # les 10 bases de site
images/build.sh apache-php8.3 edge    # sélection
TAG=0.2.0 images/build.sh --push      # tag + push (REPO=meejay par défaut)
```

Variables : `TAG` (défaut `latest`, = `OBLIMINT_IMAGE_TAG` du panel), `REPO` (`meejay`),
`VERSION` (label + `siteconf version`, défaut `$TAG`), `DOCKER` (`docker`). Options `--push`,
`--no-pull`. **BuildKit requis** (`RUN --mount=type=bind` du test de fumée ; défaut depuis
Docker 23). Contexte de build = `images/` pour toutes les images sauf hostd (`hostd/`).

Chaque build de base de site :

1. compile `siteconf` (`golang:1.26-alpine`, `CGO_ENABLED=0`) **après** `go vet` + `go test` ;
2. installe le serveur web, `tini`, `msmtp`, les extensions PHP
   (`mlocati/php-extension-installer:2.12.0`, épinglé par digest) ;
3. exécute `common/smoke/smoke-test.sh` : rendu des configs d'exemple en mode site **et**
   placeholder, `httpd -t` / `nginx -t` / `php-fpm -t`, présence des extensions, gd
   jpeg/webp/freetype, et vérification fonctionnelle de `guard.php`. Un module Apache manquant,
   une directive inconnue ou une extension absente **cassent le build**.

Épinglage : `drakkan/sftpgo`, `nginx`, `mlocati/php-extension-installer` sont épinglés par tag +
digest de manifeste (vérifiés sur Docker Hub le 09/10/2026). Les tags `php:<v>-fpm-alpine` et
`golang:1.26-alpine` suivent les correctifs (pas de digest) : pour un build reproductible,
passer `--build-arg GO_IMAGE=golang:1.26-alpine@sha256:…` et figer `php:<v.x.y>-fpm-alpine<…>`.
`php:7.4-fpm-alpine` (Alpine 3.16) et `php:8.1-fpm-alpine` existent toujours mais ne reçoivent
plus de correctifs : le panel les marque « runtime non maintenu ».

## Contrat d'exécution des bases de site

| Élément | Valeur |
|---|---|
| Port | **8080** (`SITE_CONTAINER_PORT`), IPv4, aucune capacité nécessaire |
| Utilisateur | `User=<uid>:<gid>` du compte (uid quelconque, sans entrée passwd). Défaut de l'image : `65534:65534` (jamais root) |
| Durcissement attendu | `CapDrop ALL`, `no-new-privileges`, `ReadonlyRootfs`, tmpfs `/tmp` et `/run` (`noexec,nosuid,nodev`, **sans** `mode=`/`uid=` restrictif : le tmpfs doit rester `1777`), `PidsLimit`, mémoire sans swap, CPU |
| Montages | `/srv/releases` **ro** (`current` → `<n>`, lien relatif) ; `/srv/data` rw ; `/etc/oblimint/site` ro |
| Env | `OBLIMINT_SITE_CONFIG=/etc/oblimint/site/<primary\|secondary-<id>\|preview>.json` (`SiteRuntimeConfig`) |
| Env de l'image | `OBLIMINT_ENGINE` (`apache\|nginx\|static`), `OBLIMINT_PHP` (`1\|0`), `OBLIMINT_RUN=/run/oblimint`, `HOME=/tmp` |
| Écritures à l'exécution | uniquement `/run/oblimint/*` (configs rendues, pid, mutex Apache, arbre `www/`), `/run/php-fpm.sock`, `/tmp/nginx/*` (temp nginx), `/tmp/sessions` (sessions PHP), `/tmp` (uploads PHP) |
| Logs | accès sur stdout, erreurs sur stderr (Apache, nginx, php-fpm, PHP) |
| Santé | `GET /__oblimint/ping` → `200 ok` (servi par le serveur web, jamais PHP) ; `HEALTHCHECK` Docker via `wget` |
| PID 1 | `tini` → `oblimint-entrypoint` |

### Démarrage (`oblimint-entrypoint`)

1. crée `/run/oblimint/apache`, `/tmp/nginx`, `/tmp/sessions` ;
2. `siteconf render --config $OBLIMINT_SITE_CONFIG --engine $OBLIMINT_ENGINE --out /run/oblimint [--php-fpm]` ;
3. `httpd -t` / `nginx -t` (+ `php-fpm -t`). Si `nginx -t` échoue **avec** les règles nginx
   personnalisées, re-rendu `--no-custom` et démarrage **sans** elles (message sur stderr) ;
4. lance `php-fpm -F` et `httpd -DFOREGROUND` / `nginx -g 'daemon off;'` ;
5. supervise : si l'un meurt, l'autre est arrêté et le conteneur sort en code 1 (Docker
   redémarre) ; `SIGTERM`/`SIGINT` → arrêt gracieux (nginx `QUIT`, httpd `WINCH`, php-fpm
   `QUIT`, `TERM` après 8 s) ; `SIGHUP` → `oblimint-reload`.

Configuration invalide (JSON refusé par `siteconf`) → refus de démarrer (code 1, message).

**Mode placeholder** : si le docroot (`/srv/releases/current[/<docroot>]`) n'existe pas, toute
requête reçoit `503` + `Retry-After: 30` avec `placeholder.html` (« Site en attente de première
publication »). PHP n'est jamais sollicité ; php-fpm tourne quand même, si bien que la première
publication n'a besoin que d'un `oblimint-reload`. Marqueur : `/run/oblimint/placeholder`.

### Rechargement (`docker exec <conteneur> oblimint-reload`)

Appelé par le panel après chaque bascule de release et chaque changement de configuration :
verrou (`/run/oblimint/reload.lock`), sauvegarde des fichiers rendus, re-rendu + tests (même
repli `--no-custom`), puis `httpd -k graceful` / `nginx -s reload` et, seulement si ce
rechargement a réussi, `kill -USR2` du maître php-fpm (ré-exécution gracieuse : opcache et cache
realpath vidés, pool relu). Succès : code 0 et `reloaded mode=site|placeholder` sur stdout.
Échec du rendu, des tests ou du rechargement du serveur web : fichiers précédents restaurés, aucun
processus signalé (serveur web et php-fpm restent sur la même configuration), code ≠ 0. Échec du
seul signal php-fpm : les nouveaux fichiers restent (le serveur web les applique déjà), php-fpm
garde son pool précédent jusqu'à son prochain redémarrage, message sur stderr, code ≠ 0.

### Chemins de données : PHP n'y est **jamais** exécuté

Dans la release, `<chemin>` est un lien vers `/srv/data/<chemin>`. Trois couches indépendantes :

1. **Serveur web**
   - Apache : `<Directory "/srv/data">` et, par chemin, `<Directory "/srv/releases/current/<p>">`
     (`AllowOverride None` : un `.htaccess` déposé n'est jamais lu) + `<DirectoryMatch
     "^/srv/releases/[^/]+/<p>(/|$)">` (`Options -ExecCGI`, `SetHandler None`, `.php|.phar|
     .phtml|.pht|.php[0-9]|.phps` → `Require all denied`). Le handler php-fpm est posé par
     `<FilesMatch "\.php$"><If "-f … && %{REQUEST_FILENAME} !~ m#^/srv/(data/|releases/[^/]+/(<p>…))#">`.
   - nginx : `location ^~ <basePath><p>/ { location ~* \.(php[0-9]?|phar|phtml|pht|phps)(/|$) { return 403; } }`,
     sans aucun `fastcgi_pass` dans le bloc (le `^~` coupe la recherche des regex).
   - Chemin hors du docroot (ex. `storage` de Laravel) : non joignable par URL, pas de location.
   - Portée : ces règles visent l'emplacement **normal** du chemin de données. Un lien
     symbolique de la release qui pointe vers `/srv/data` (ex. Laravel `public/storage ->
     ../storage/app/public`, conservé par le module releases) rend la donnée joignable sous une
     autre URL : Apache `<Directory>` et les `location` nginx comparent le chemin **non résolu**.
     Apache : à chaque rendu (démarrage et `oblimint-reload`, donc après chaque bascule de release),
     `siteconf` parcourt l'arbre servi (docroot, liens de dossiers internes à la release suivis,
     bornes 1 000 000 entrées / 1 024 liens, avertissement au-delà), résout chaque lien dans
     l'espace de noms du conteneur (lien pendant résolu lexicalement : la cible peut être créée plus
     tard par PHP) et émet pour chaque lien atteignant `/srv/data` un `<Directory>` identique à
     celui d'un chemin de données (`AllowOverride None` : un `.htaccess` écrit par PHP n'est jamais
     lu, `SetHandler None`, refus PHP, liste blanche `typed` du chemin visé ; cible contenant un
     chemin `typed` → tout refusé) et l'ajoute à l'exclusion php-fpm. Un fichier `.htaccess` de la
     release (y compris au-dessus du docroot) qui est lui-même un lien vers `/srv/data` → `AllowOverride
     None` sur son dossier. Octets hors liste blanche dans un nom → joker `?` (jamais écrit brut).
     nginx ne lit aucun fichier par dossier ; pour PHP, `guard.php` (realpath) reste la barrière.
     Limite connue : un `.user.ini` de la release qui serait un lien vers `/srv/data` reste lu par
     php-fpm (réglages `PHP_INI_PERDIR` seulement ; `open_basedir` et `auto_prepend_file` sont
     `php_admin_value`, non modifiables).
2. **php-fpm** : `security.limit_extensions = .php`, `php_admin_value[open_basedir] =
   /srv/releases/:/srv/data/:/tmp/:/opt/oblimint/`, `php_admin_value[auto_prepend_file] =
   /opt/oblimint/guard.php` (non modifiables par `ini_set` ni `.user.ini`).
3. **`guard.php`** : `realpath($_SERVER['SCRIPT_FILENAME'])` sous `/srv/data/` → `403` + `exit` ;
   chemin non résolu → refus aussi (échec fermé).

`typed` : seules les extensions listées sont servies (Apache `Require all denied` + `FilesMatch`
des extensions accordées ; nginx `location ~* \.(ext…)$ {}` puis `return 403`). Bases nginx PHP :
hors chemins de données, `location ~* \.(php[0-9]|phar|phtml|pht|phps)(/|$) { return 403; }` (après
la location PHP) : jamais de source divulguée, comme le `FilesMatch` Apache. Une extension de
type PHP n'est jamais acceptée dans la liste (refus de `siteconf`). Liste vide = rien n'est servi.

### basePath (sous-site)

`basePath ≠ '/'` : le docroot est servi sous ce préfixe (l'edge transmet le préfixe tel quel).
Apache : `Alias "/blog" "<docroot>"`. nginx : `root /run/oblimint/www` où
`/run/oblimint/www/blog` est un lien vers le docroot (évite les pièges `alias` + `try_files`) ;
hors préfixe → 404. L'application doit connaître son chemin de base (ex. `RewriteBase /blog/`).

### Règles nginx personnalisées (`customNginx`, bases nginx seulement)

Écrites telles quelles dans `/run/oblimint/custom.conf`, incluses dans le bloc `server`
**après** le ping, les fichiers cachés et les chemins de données, **avant** la location
applicative et la regex PHP (une regex perso passe donc devant `\.php$`). Contrôles de
`siteconf` avant inclusion : ≤ 64 Kio, UTF-8, aucun caractère de contrôle, accolades
équilibrées (hors guillemets et commentaires, jamais de `}` qui fermerait le `server`),
instructions terminées, pas d'`include` ni de `load_module`. Si la règle définit
`location <basePath>` (ou `location /`), la location par défaut correspondante est omise (pas
de doublon). Toute règle refusée (par `siteconf` ou par `nginx -t`) est **ignorée** et le site
démarre sans elle (message sur stderr) — jamais de boucle de crash. Bases Apache : ignorées
(utiliser `.htaccess`).

### PHP

- Extensions : gd (jpeg, webp, freetype), intl, mysqli, pdo_mysql, pdo_pgsql, zip, opcache, exif,
  bcmath, soap, xml, mbstring, curl (vérifiées au build).
- `php.ini` : `expose_php Off`, `display_errors Off`, `log_errors` → stderr, `date.timezone UTC`,
  sessions `/tmp/sessions` (`use_strict_mode`, `cookie_httponly`), `upload_tmp_dir`/`sys_temp_dir`
  `/tmp`, opcache (`validate_timestamps=1`, `revalidate_freq=2` : filet de sécurité, le reload
  vide le cache), `sendmail_path = "/usr/bin/msmtp -t"`.
- Réglages du site (pool) : `memory_limit`, `upload_max_filesize`, `post_max_size`,
  `max_execution_time` (`php_value` : l'application peut les relever elle-même) ;
  `request_terminate_timeout` et timeouts web = `max_execution_time + 30 s`.
- Mail : msmtp sans compte tant que le relais (P4) n'existe pas → `mail()` renvoie `false`
  proprement.
- `disable_functions` vide (compatibilité CMS) : la frontière est le conteneur (code en lecture
  seule, aucune capacité, réseau du compte).
- nginx : `SCRIPT_FILENAME`/`DOCUMENT_ROOT` = `$realpath_root…` (chaque requête voit une release
  cohérente pendant une bascule) ; `HTTPS=on` et `SERVER_PORT=443` si `X-Forwarded-Proto: https`.
  Apache : `SetEnvIf X-Forwarded-Proto ^https$ HTTPS=on`, `mod_remoteip` (IP client réelle).

## `siteconf` (`images/siteconf/`, Go, stdlib seule)

```
siteconf render --config <file> --engine apache|nginx|static --out /run/oblimint [--php-fpm] [--no-custom]
siteconf check  --config <file>
siteconf version
```

Écrit (atomiquement : fichier temporaire + rename) `httpd.conf` ou `nginx.conf` + `custom.conf`,
`php-fpm.conf` (`--php-fpm`), le marqueur `placeholder`, l'arbre `www/` (basePath nginx). Code 0
succès (`mode=site|placeholder` sur stdout), 1 config invalide / échec d'écriture (rien
n'est écrit si la config est invalide), 2 usage. Avertissements sur stderr.

Validation stricte **avant** tout gabarit (rien n'est « nettoyé » puis émis) : `version = 1`,
ids > 0, `role ∈ primary|secondary|preview`, `base` du catalogue, `docroot =
/srv/releases/current[/<rel>]` avec `<rel>` déjà normalisé selon `normalizeRelPath` (shared),
`basePath` et `servedPrefixes` `^/([A-Za-z0-9._@+-]+/)*$` sans segment `.`/`..`, chemins de
données normalisés, uniques, sans chevauchement, ne contenant pas le docroot, politique connue,
extensions `^[a-z0-9]{1,10}$` sans doublon ni variante PHP, plages PHP (mémoire 16–16384 Mo,
upload/post 1–10240 Mo, exécution 1–86400 s), `healthcheckPath` `^/[\x21-\x7e]{0,254}$`. Les
gabarits (`text/template`) ne reçoivent que des constantes, des entiers et des chaînes revérifiées
par des fonctions de quotation qui **échouent** au lieu d'échapper (`aq`, `ns`, `joinExt`,
`pathRegex`). Base d'un autre moteur que l'image (bascule en cours) : rendu pour l'image +
avertissement. Champs JSON inconnus ignorés (`version` protège les ruptures).

**Contrat partagé avec le panel** : une config refusée ici empêche le conteneur de démarrer
(boucle de redémarrage, `oblimint-reload` en échec). Le panel doit donc refuser en amont, avec les
mêmes bornes : au plus 64 chemins de données, 128 extensions par chemin, 64 `servedPrefixes`,
extensions `^[a-z0-9]{1,10}$` hors `php[0-9]?|phar|phtml|pht|phps` (constantes de
`siteconf/config.go` : `maxDataPaths`, `maxExtensions`, `maxPrefixes`, `phpLikeExtRE`).

Tests : `cd images/siteconf && go vet ./... && go test ./...` — goldens (`testdata/golden/`,
régénérés par `go test -run TestGolden -update`, à relire) pour Apache / nginx / statique /
php-fpm / placeholder / basePath / chemins typés / règles perso, tables de validation,
tentatives d'injection (retours ligne, guillemets, `;`, `}`, `#`, regex) dans chemins, préfixes
et extensions, règles nginx perso hostiles, CLI et écriture.

## Edge (`meejay/oblimint-edge`)

- Maître nginx root, workers `nginx` ; conteneur `CapDrop ALL` + `CapAdd CHOWN,
  NET_BIND_SERVICE, SETGID, SETUID`, `no-new-privileges`, racine RO, tmpfs `/var/cache/nginx`,
  `/run`, `/tmp`. Ports 80/443 (IPv4 + IPv6 : `listen [::]:…` comme les vhosts générés).
- `/etc/nginx/nginx.conf` : `pid /run/nginx.pid`, temp sous `/var/cache/nginx`,
  `server_tokens off`, `resolver 127.0.0.11 valid=10s ipv6=off`, `map $http_upgrade
  $connection_upgrade`, log JSON `oblimint_json` sur stdout (`time, host, remote_addr, method,
  uri, status, bytes, request_time, upstream, upstream_status, user_agent`), TLS 1.2/1.3
  (Mozilla intermediate), `ssl_session_cache shared:oblimint_ssl:10m` (même zone que les vhosts),
  `include /etc/nginx/oblimint/conf.d/*.conf`.
- Serveurs par défaut : 80 → `/.well-known/acme-challenge/` (racine `/var/www/acme`), ping
  `/__oblimint/ping` (boucle locale seulement), sinon 404 ; 443 → certificat auto-signé généré au
  démarrage dans `/run/oblimint-edge/` (EC P-256), 404.
- Pages d'erreur : `/usr/share/oblimint/errors/{404,502,503,suspended}.html` (FR + EN), servies
  sous le préfixe interne `/__oblimint_edge/` (`ERROR_PAGES_PREFIX` du module edge).
- Montages (ro) : `/etc/nginx/oblimint/conf.d`, `/etc/nginx/oblimint/certs/<nom>/{fullchain,privkey}.pem`,
  `/var/www/acme`. Rechargement : `docker exec oblimint-edge nginx -t` puis `nginx -s reload`.
- Sans `CAP_DAC_OVERRIDE`, le maître root ne lit que ce que les permissions Unix lui
  accordent : `privkey.pem` doit appartenir à root (0600) ; les jetons ACME et leurs dossiers
  doivent être lisibles par tous (les workers `nginx` les servent).

## Serveur de fichiers (`meejay/oblimint-filesrv`)

Voir [`filesrv/README.md`](filesrv/README.md) : configuration SFTPGo, variables, formats exacts
des hooks d'authentification et d'actions.

## Capacités et privilèges par image

| Image | User | Capacités | Racine | tmpfs | Ports |
|---|---|---|---|---|---|
| bases de site | uid:gid du compte | aucune (`CapDrop ALL`) | RO | `/tmp`, `/run` | 8080 (non publié) |
| filesrv | uid:gid du compte | aucune | RO | `/tmp` | 2022 → port hôte du compte |
| edge | root (workers `nginx`) | `CHOWN`, `NET_BIND_SERVICE`, `SETGID`, `SETUID` | RO | `/var/cache/nginx`, `/run`, `/tmp` | 80, 443 publiés |
| hostd | root, privilégié | (module hostd) | — | — | socket unix |

## Ce qui n'a PAS été vérifié (poste Windows, sans Docker ni Linux)

Aucune image n'a été construite ni lancée. Non vérifié : existence réelle des modules Apache
Alpine listés (`mod_remoteip`, `mod_version`, `mod_access_compat`… — le test de fumée du build
le dira), `realip` dans le nginx d'Alpine, comportement réel d'Apache (`<If>` dans `FilesMatch`,
ordre de fusion `Directory`/`DirectoryMatch`/`FilesMatch`, `Header … expr=`), nginx, php-fpm
(USR2 sans démon, `-t` hors root), msmtp sans configuration, tini, SFTPGo (clés de configuration,
`--config-file`, format des hooks), l'edge (IPv6 désactivé dans le conteneur, CHOWN des dossiers
temporaires). Seuls `siteconf` (go test) et la logique des scripts (harnais dash avec faux
binaires, hors dépôt) ont été exécutés.

## Plan de test manuel (VM Debian/Alma avec Docker)

```sh
# 0. Construire
images/build.sh apache-php8.3 nginx-php8.3 nginx-static edge filesrv

# 1. Arborescence d'un faux site (uid 20001)
R=/srv/test-site; sudo mkdir -p $R/releases/1/wp-content $R/data/wp-content/uploads $R/runtime
echo '<?php echo "release ok";' | sudo tee $R/releases/1/index.php
echo '<?php file_put_contents(__DIR__."/x.php","<?php echo 1;"); echo "WROTE";' | sudo tee $R/releases/1/write.php
sudo ln -s /srv/data/wp-content/uploads $R/releases/1/wp-content/uploads
sudo chown -R 20001:20001 $R/data
cp images/siteconf/testdata/wordpress.json /tmp/primary.json && sudo cp /tmp/primary.json $R/runtime/

# 2. Conteneur durci (placeholder d'abord : pas encore de `current`)
docker run -d --name t1 --user 20001:20001 --cap-drop ALL --security-opt no-new-privileges \
  --read-only --tmpfs /tmp:rw,noexec,nosuid,nodev --tmpfs /run:rw,noexec,nosuid,nodev \
  -v $R/releases:/srv/releases:ro -v $R/data:/srv/data -v $R/runtime:/etc/oblimint/site:ro \
  -e OBLIMINT_SITE_CONFIG=/etc/oblimint/site/primary.json -p 127.0.0.1:18080:8080 \
  meejay/oblimint-apache-php8.3:latest
curl -si localhost:18080/ | head -5              # 503 + Retry-After, page d'attente
curl -s  localhost:18080/__oblimint/ping          # ok
docker inspect -f '{{.State.Health.Status}}' t1   # healthy (après ~30 s)

# 3. Première publication + reload
sudo ln -s 1 $R/releases/current && docker exec t1 oblimint-reload   # reloaded mode=site
curl -s localhost:18080/                          # release ok

# 4. Immuabilité : PHP ne peut pas écrire dans la release
curl -s localhost:18080/write.php                 # warning/erreur, PAS "WROTE"
ls $R/releases/1/x.php                            # n'existe pas

# 5. Un .php dans un chemin de données n'est jamais exécuté
echo '<?php echo "PWNED";' | sudo -u '#20001' tee $R/data/wp-content/uploads/shell.php
curl -si localhost:18080/wp-content/uploads/shell.php | head -1   # 403, jamais "PWNED"
printf 'SetHandler "proxy:unix:/run/php-fpm.sock|fcgi://localhost"\n' | sudo -u '#20001' tee $R/data/wp-content/uploads/.htaccess
curl -s localhost:18080/wp-content/uploads/shell.php              # toujours 403 (AllowOverride None)
# guard : forcer l'exécution via php-fpm directement
docker exec t1 sh -c 'SCRIPT_FILENAME=/srv/releases/current/wp-content/uploads/shell.php \
  REQUEST_METHOD=GET cgi-fcgi -bind -connect /run/php-fpm.sock' 2>/dev/null || true   # (si cgi-fcgi dispo) 403

# 6. Rechargement : changer memory_limit dans primary.json → oblimint-reload → phpinfo le montre ;
#    JSON invalide → oblimint-reload code ≠ 0, le site continue de répondre.
# 7. Mêmes étapes 2–5 avec nginx-php8.3 (+ customNginx valide, puis invalide :
#    le site démarre sans, message dans `docker logs`), et nginx-static (un .php → 403).
# 8. basePath /blog/ (laravel-blog.json) : /blog/ servi, / → 404, /blog/media/x.php → 403.
# 9. Arrêt : docker stop t1 → arrêt < 10 s, code 0 ; kill du maître php-fpm → conteneur redémarre.
# 10. Edge : docker run --cap-drop ALL --cap-add CHOWN --cap-add NET_BIND_SERVICE --cap-add SETGID \
#     --cap-add SETUID --security-opt no-new-privileges --read-only --tmpfs /var/cache/nginx \
#     --tmpfs /run --tmpfs /tmp -p 80:80 -p 443:443 -v …conf.d:/etc/nginx/oblimint/conf.d:ro … \
#     meejay/oblimint-edge ; curl -si http://IP/ → 404 page ; curl -ski https://IP/ → 404 ;
#     docker exec oblimint-edge nginx -t && nginx -s reload ; logs JSON sur stdout.
# 11. filesrv : voir filesrv/README.md (plan de test des hooks).
```
