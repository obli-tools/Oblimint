# fake-cwp — faux serveur CentOS Web Panel (image de TEST uniquement)

> **Test uniquement.** Cette image reproduit, avec des valeurs **synthétiques**, l'implantation du serveur CWP 1.18 de
> production relevée dans `docs/cwp/CWP-MAP.md`, pour valider toute la migration P5 (`docs/P5-PLAN.md`) sur the Linux test host
> **avant** de toucher le vrai serveur (§16). Elle n'est **jamais** construite par `images/build.sh`, jamais tirée ni
> gérée par le panel, jamais publiée. Elle contient des **mots de passe de test connus** (ci-dessous).
> Étiquette de l'image : `oblimint.test-only=true`.

Valeurs : comptes `acct1` … `acct6`, domaines `*.example` / `*.test`, IP publiques `203.0.113.0/24` (la source :
`203.0.113.10`), `192.0.2.0/24` / `198.51.100.0/24` (autres machines), LAN `10.0.0.0/24` / `192.168.1.0/24`. Aucun nom
réel (contrôlé par `check/check-dataset.mjs`).

## Contenu du dossier

| Chemin | Rôle |
|---|---|
| `dataset/dataset.mjs` | **Source unique de vérité** : comptes, domaines, vhosts, zones, bases, mail, DKIM, FTP, crons, certificats, unités systemd, mots de passe de test |
| `dataset/expected-inventory.json` | Ce que la découverte du panel doit trouver (compteurs + faits par cas) — **généré** depuis le jeu de données |
| `build/generate.mjs` + `build/lib/*.mjs` | Générateur : utilisateurs Linux, arborescence (propriétaire / groupe / mode), clés / empreintes / certificats (openssl, htpasswd, ssh-keygen), scripts SQL |
| `build/seed.sh` | Étape de construction : générateur, initialisation MariaDB 10.3 + chargement, contrôles BIND (fatals), `postconf -n` / `doveconf -n` (avertissements) |
| `rootfs/` | Fichiers statiques recopiés des artefacts (`main.cf`, `master.cf`, `dovecot.conf`, `opendkim.conf`, `pure-ftpd.conf`, `proxy.inc`, `my.cnf.d`, `sshd_config`…) |
| `seed/schemas/*.schema.sql` | Schémas `mysqldump --no-data` de la source (`root_cwp`, `postfix`, `postfix_policyd`, `roundcube`, `oauthv2`, `root_cpmigrations`) |
| `bin/fake-cwp-entrypoint` | PID 1 : clés d'hôte SSH, accès root, MariaDB, BIND (+ `nsupdate` au premier démarrage), `sshd -D -e`, arrêt propre |
| `scripts/build.sh`, `scripts/run.sh` | Construction / lancement sur the Linux test host |
| `scripts/verify-readonly.sh` | Preuve de **MG1** : instantanés AVANT / APRÈS, différence attendue **vide** |
| `scripts/mutate-source.sh` | Modifications **volontaires** de la source pour le scénario de resynchronisation (§16 point 6) |
| `e2e/run-migration.mjs` | Scénario de bout en bout contre l'API du panel (Node ≥ 20, sans dépendance) |
| `check/check-dataset.mjs` | Contrôles statiques (exécutables sous Windows) |

## Ce qui est reproduit (correspondance avec CWP-MAP)

| CWP-MAP | Reproduit par |
|---|---|
| §1 version / implantation | `version.php` (`$webpanel_version = "1.18"`), `/usr/local/cwp/.conf/` (`web_servers.conf`, `vhosts-ssl.json`, `config_ssl.json`, `mysql_user_prefix.conf`, `.cwp_pro.conf` = 1, `php_conf/`, `php-fpm_conf/`, `mysql_manager/`), templates `…/web_servers/vhosts/{nginx,apache,varnish}/` (dont `backbone`, `ws_proxy_agent`, `proxy_websocket`, `epsilon_example`), Rocky 8, MariaDB 10.3 (flux `mariadb:10.3`), BIND 9.11, Node 18 |
| §2 revendeurs | colonne `reseller` vide partout, marqueurs vides `~/.conf/reseller/*` (acct1, acct2) |
| §3 paquets | `default` (limites réelles) et `UNLIMITED` (`-1` / `999999`), `user.package` = id en texte |
| §4 comptes | 6 lignes `root_cwp.user`, uid 1001–1006, groupe privé, home 0711, `public_html` `<u>:nobody` 0750, `$6$` dans `/etc/shadow`, `/bin/bash` pour acct1 ; hors CWP : `svcnode` (services Node depuis le home d'acct2), `admin2` (interactif, `authorized_keys`), `ghost` (home `/`) ; fichiers d'acct2 appartenant à `svcnode` |
| §5 domaines | principal / addon (dont un chemin libre) / 2 parked à vhost nginx propre et **sans** vhost Apache / sous-domaines (chemins standard, `/home/u/<sub>`, `/home/u/<sub>/public`, imbriqué dans `public_html`, aberrant `/home/acct5/home/acct6/files`, label pointé `a.b`, un sous-domaine sur un addon, un FQDN en double principal / sous-domaine) |
| §6 pile web / PHP | vhosts nginx `<fqdn>.conf` + `.ssl.conf` (format de l'échantillon, sous-serveurs `webmail.` / `mail.` / `cpanel.`), Apache `…/conf.d/vhosts/`, Varnish `/etc/varnish/conf.d/vhosts/`, un vhost `.disabled`, JSON `~/.conf/webservers/<fqdn>.conf` (normal, proxy `custom-ip`, piège « JSON dit 7.2 mais vhost suPHP »), `/usr/local/etc/suphp.conf`, `/opt/alt/php{56,72,73,74,81,83}` (binaires **factices**), pools `/opt/alt/php-fpm{56,74,81,83}/usr/etc/php-fpm.d/users/<u>.conf`, `.htaccess` `AddHandler` (racine php56, sous-dossier php74), `php.ini` / `.user.ini`, `~/.conf/.addons_wp` |
| §7 bases | 10 bases clientes InnoDB / MyISAM / MEMORY, latin1 / utf8 / utf8mb4, une table latin1 contenant de l'UTF-8 (double encodage), triggers et vues avec DEFINER `@localhost` / `@%` (+ un DEFINER `root` étranger), utilisateurs à empreinte dans `Password` **et** `plugin` + `authentication_string`, utilisateur nu `<compte>`, hôtes distants `10.0.0.%` / `192.168.1.%` / `%`, empreintes différentes selon l'hôte, utilisateur et base orphelins, droits `mysql.db` échappés `acct1\_%`, un droit SELECT seul, un droit « ALL sauf ALTER / routines », `character_set_server = latin1`, `sql_mode` de la source |
| §8 messagerie | lignes `postfix.domain / mailbox / alias / quota2`, `{SHA512-CRYPT}` générées au build + un `$1$` nu, maildirs Maildir++ `<uid compte>:mail` 0700 (`.Sent`, `.Spam`, `.Trash`, `.Drafts`, `maildirfolder`, `dovecot-uidlist` avec UIDVALIDITY, messages RFC 5322 avec `S=` / `W=`, `sieve/roundcube.sieve` + lien `dovecot.sieve`), alias externes, multi-cibles, catch-all, maps SQL Postfix / Dovecot, `postconf -n` / `doveconf -n` répondent (démons **arrêtés**) |
| §8 DKIM | `/etc/opendkim.conf`, `KeyTable`, `SigningTable`, `userkeys/<d>/default.private` + `default.txt` générés au build (2048 bits, un 1024 bits, une clé sans domaine mail), enregistrement `default._domainkey` publié dans les zones avec la vraie clé publique |
| §9 DNS | `/etc/named.conf` (zones déclarées en ligne), zones au format libre CWP, une zone réécrite par BIND (format canonique), `ns3` / `ns4`, une zone **dynamique** (`allow-update { key "cwp-updater"; }`, clé `/etc/named/keys/cwp-updater.key`) avec **journal `.jnl`** et fichier `.db` **en retard**, un `.db` orphelin, une copie `.restore`, A étrangère, CAA, SRV, AAAA, HINFO, TTL variés ; `named` tourne (AXFR autorisé depuis 127.0.0.1) |
| §10 FTP / cron / SSL | `pure-ftpd.conf`, `pureftpd.passwd` 18 champs (bcrypt `$2a$10$`, chroot `/./` sur un home et un `public_html`, un utilisateur MD5) ; `/var/spool/cron/{acct1,acct3,root}` (+ copie `~/cron`) avec `/usr/local/bin/php`, `/opt/alt/php73/usr/bin/php`, redirection dans le docroot, `@reboot`, ligne commentée, intervalle d'une minute ; certificats `/etc/pki/tls/certs/<fqdn>.cert|.bundle` + `private/<fqdn>.key` signés par une AC de test jetable (valide, expiré, auto-signé, ECC, SAN `www.`), `hostname.bundle / .key / .pem` |
| §11 hors CWP | unités `/etc/systemd/system/*.service` (2 apps Node sous `svcnode` dans `/home/acct2/node/*`, une API Node du compte proxifiée en `127.0.0.1:3001`, un bot Python, un agent de supervision ; `Environment=SECRET=…` pour prouver la rédaction), dépôt `.git`, `package.json` hors docroot, crons root, domlogs |

### Couverture des cas (cas → où il vit)

| Cas | Domaine / objet | Fichiers |
|---|---|---|
| suPHP défaut 8.3 | `alpha.example`, `gamma.test`, `m.delta.test`… | vhost Apache sans `SetHandler` |
| `.htaccess` racine → PHP 5.6 (suPHP) | `epsilon.example` | `/home/acct3/public_html/.htaccess` |
| `.htaccess` de sous-dossier → 7.4 (runtime secondaire) | `alpha.example/legacy` | `/home/acct1/public_html/legacy/.htaccess` |
| Apache `SetHandler` php-fpm56 / php-fpm74 | `delta.test` / `beta.example` | `/usr/local/apache/conf.d/vhosts/<fqdn>.conf` |
| nginx `fastcgi_pass` php-fpm81 (Laravel, `…/public`) | `app.alpha.example` | `/etc/nginx/conf.d/vhosts/app.alpha.example*.conf`, `/home/acct1/app` |
| JSON `php-fpm_ver` trompeur | `alpha.example` (JSON 72, effectif 8.3) | `/home/acct1/.conf/webservers/alpha.example.conf` |
| Proxy LAN / public HTTPS / websocket / JSON `custom-ip` / service local 127.0.0.1:3001 / parked en proxy | `nas.gamma.test`, `cloud.gamma.test`, `ws.gamma.test`, `cam.gamma.test`, `api.alpha.example`, `gamma-alias.test` | vhosts nginx seuls |
| Varnish (backend personnalisé) | `shop.gamma.test` | `/etc/varnish/conf.d/vhosts/shop.gamma.test.conf` |
| Vhost désactivé | `old.example` | `*.conf.disabled` |
| Template nginx personnalisé | `legacy.epsilon.example` (`epsilon_example`) | `…/web_servers/vhosts/nginx/epsilon_example.tpl` |
| Parked à vhost propre (site) | `alpha-alias.example` | vhost nginx seul |
| Docroot imbriqué / non standard / aberrant / label pointé / sous-domaine d'addon / doublon | `blog.alpha.example` / `api.alpha.example` / `files.theta.test` / `a.b.alpha.example` / `m.delta.test` / `acct4.srvdomain.test` | `root_cwp.subdomains` |
| **Pièges MG10** | `theta.test` | `public_html/.htaccess`, `public_html/.htaccess-link`, `~/php.ini` → `/etc/shadow` ; docroot `link.theta.test` = lien vers `/etc` ; `info@alpha.example/evil-link` → `/etc/shadow` |
| Compte suspendu | `acct4` | `/usr/local/cwp/users/suspended/acct4/`, `/usr/local/apache/conf.d/suspended_accounts/acct4.conf` |
| WordPress (même `wp-config.php`) | `alpha.example` (utf8mb4), `epsilon.example` (latin1, PHP 5.6, `legacy.php` en `mysql_*`) | `wp-config.php`, `wp-includes/version.php`, `wp-content/uploads/2024/01/*.jpg`, `index.php` qui interroge la base |
| Double encodage latin1 | `acct3_wp.wp_options.blogname` | `dataset.mjs` (littéraux hexadécimaux) |
| Zone dynamique + journal | `srvdomain.test` (`dyn-added`, `_acme-challenge` présents **seulement** dans le `.jnl`) | `/opt/fake-cwp/generated/nsupdate.txt` (rejoué une fois) |

### Comptages attendus (découverte)

Calculés depuis le jeu de données (`dataset/expected-inventory.json`, `counts.hard` = égalité exigée par `e2e`) :

| Élément | Nombre | Élément | Nombre |
|---|---|---|---|
| comptes / suspendus / paquets | 6 / 1 / 2 | bases clientes (dont 1 orpheline) | 10 |
| FQDN uniques | 24 (25 lignes `root_cwp`) | domaines mail / boîtes / alias | 5 / 7 / 3 |
| principaux / addons / parked / sous-domaines | 6 / 3 / 2 / 13 (+1 ligne doublon) | clés DKIM | 6 |
| domaines proxy | 6 | utilisateurs FTP virtuels | 5 |
| certificats | 6 (+ `hostname.*`) | | |

Compteurs « souples » (convention de comptage de la découverte, affichés sans échec) : zones 15 (14 déclarées + 1
orpheline ; la copie `.restore` n'est pas une zone), utilisateurs MySQL 17 lignes (utilisateur, hôte) / 14 noms
(root / postfix / roundcube exclus), crons 11 (7 lignes utilisateurs dont 1 commentée + 4 root ; la copie `~/cron`
n'est pas comptée deux fois), hors CWP ≥ 24 éléments (`outsideMin`).

Faits par cas vérifiés par `e2e` : version / gestionnaire / source PHP par FQDN, docroot, `serving`, cible proxy,
surcharges `.htaccess`, zone dynamique lue journal appliqué, schéma d'empreinte par boîte, bits DKIM, schéma FTP et
chroot, certificats expiré / auto-signé / ECC, comptes suspendus, utilisateurs MySQL distants / orphelins, absence de
tout secret (mots de passe, `{SHA512-CRYPT}`, `$6$`, `$2a$`, clés privées, `must-never-be-read`, `must-be-redacted`).

## Mots de passe de test (connus, test uniquement)

| Usage | Identifiant | Mot de passe |
|---|---|---|
| MariaDB root (`/root/.my.cnf`) | `root` | `FakeCwp-root-2026` |
| MariaDB Postfix / Roundcube | `postfix` / `roundcube` | `FakeCwp-postfix-2026` / `FakeCwp-roundcube-2026` |
| Linux (`$6$`, jamais lus par le panel) | `acct1` … `acct6`, `svcnode`, `admin2` | `FakeCwp-<utilisateur>-linux` (ex. `FakeCwp-acct1-linux`) ; `ghost` sans mot de passe |
| MySQL utilisateur nu | `acct1`, `acct2`, `acct3`, `acct5`, `acct6` @localhost | même mot de passe que le compte Linux (`FakeCwp-acct1-linux`…) |
| MySQL | `acct1_wp` | `acct1_wp-Db-2026` |
| MySQL | `acct1_app`@localhost (plugin) / `acct1_app`@`10.0.0.%` | `acct1_app-Db-2026` / `acct1_app-Remote-2026` (empreintes différentes) |
| MySQL | `acct1_ro` (SELECT seul) | `acct1_ro-Db-2026` |
| MySQL | `acct2_shop`@localhost (plugin) et @`192.168.1.%` | `acct2_shop-Db-2026` |
| MySQL | `acct3_wp` (ALL sauf ALTER) | `acct3_wp-Db-2026` |
| MySQL | `acct3_crm`@localhost et @`%` | `acct3_crm-Db-2026` |
| MySQL | `acct5_data` / `acct6_site` | `acct5_data-Db-2026` / `acct6_site-Db-2026` |
| MySQL (orphelin) | `oldclient_user` | `oldclient-Db-2026` |
| IMAP / POP (`{SHA512-CRYPT}`) | `contact@alpha.example` | `Mail-contact-alpha-2026` (INBOX UIDVALIDITY 1700000001) |
| IMAP | `info@alpha.example` | `Mail-info-alpha-2026` |
| IMAP (boîte inactive) | `old@alpha.example` | `Mail-old-alpha-2026` |
| IMAP | `sales@beta.example` | `Mail-sales-beta-2026` |
| IMAP | `admin@epsilon.example` | `Mail-admin-epsilon-2026` |
| IMAP (compte suspendu) | `user@acct4.srvdomain.test` | `Mail-user-acct4-2026` |
| IMAP (`$1$` nu) | `legacy@iota.example` | `Mail-legacy-iota-2026` |
| FTP virtuel (bcrypt `$2a$`) | `ftp1@alpha.example`, `ftp2@alpha.example`, `dev@gamma.test`, `web@epsilon.example` | `Ftp-ftp1-alpha-2026`, `Ftp-ftp2-alpha-2026`, `Ftp-dev-gamma-2026`, `Ftp-web-epsilon-2026` |
| FTP virtuel (MD5, non adoptable) | `legacy@iota.example` | `Ftp-legacy-iota-2026` |

Toutes les valeurs viennent de `dataset/dataset.mjs` (le contrôle statique vérifie que ce tableau les cite toutes).

## Procédure the Linux test host

Prérequis : Docker (BuildKit), Node ≥ 20 sur l'hôte pour `check` / `e2e`, un panel Oblimint P5 en marche.

```sh
# 0. contrôles statiques (aussi lancés par build.sh)
node images/fake-cwp/check/check-dataset.mjs

# 1. construction (épingler le digest de la base : docker buildx imagetools inspect rockylinux/rockylinux:8.10)
sh images/fake-cwp/scripts/build.sh                       # ROCKY_IMAGE=rockylinux/rockylinux:8.10@sha256:… pour épingler

# 2. lancement : clé ~/.ssh/fake-cwp_ed25519 créée si absente, port 2222, empreintes d'hôte affichées
sh images/fake-cwp/scripts/run.sh
docker logs oblimint-fake-cwp                             # « dynamic zone srvdomain.test updated… », « ready »

# 3. instantané AVANT (pose aussi le marqueur « plus récent que »)
sh images/fake-cwp/scripts/verify-readonly.sh snapshot before

# 4. scénario (découverte → plan → exécutions initiales → contrôles) ; panel en TLS auto-signé :
NODE_TLS_REJECT_UNAUTHORIZED=0 \
PANEL_URL=https://<panel> ADMIN_USER=<admin plateforme sans TOTP> ADMIN_PASSWORD=… \
SOURCE_HOST=<adresse joignable DEPUIS le conteneur du panel> SOURCE_PORT=2222 \
SSH_KEY_FILE=~/.ssh/fake-cwp_ed25519 EXPECTED_FINGERPRINT='SHA256:…(ed25519, affichée par run.sh)' \
node images/fake-cwp/e2e/run-migration.mjs                # --accounts acct1,acct3 · --skip-runs

# 5. instantané APRÈS + comparaison : la différence doit être VIDE (MG1)
sh images/fake-cwp/scripts/verify-readonly.sh snapshot after
sh images/fake-cwp/scripts/verify-readonly.sh compare

# 6. reprise : redémarrer le conteneur du panel pendant la copie de fichiers d'une exécution, vérifier la reprise
# 7. resynchronisation (casse volontairement l'égalité AVANT / APRÈS : refaire des instantanés ensuite)
sh images/fake-cwp/scripts/mutate-source.sh               # puis une exécution « resync » d'acct1
# 8. nettoyage
docker rm -f oblimint-fake-cwp
```

**Déclarer la source dans le panel** (si l'on n'utilise pas `e2e`) : Administration → Migration CWP → Sources : hôte
= adresse que **le conteneur du panel** atteint (pas `localhost` : l'IP LAN de the Linux test host, ou la passerelle du réseau
Docker du panel, par ex. `172.17.0.1`, ou bien `docker network connect <réseau du panel> oblimint-fake-cwp` puis hôte
`oblimint-fake-cwp` port `22`), port `2222`, utilisateur `root`, authentification par clé (contenu de
`~/.ssh/fake-cwp_ed25519`), sans sudo. « Tester » affiche l'empreinte présentée : la comparer à celle de `run.sh`
avant de l'épingler. `ROOT_PASSWORD=…` au lancement permet aussi l'authentification par mot de passe.

`e2e` épingle l'empreinte présentée **seulement** si elle est égale à `EXPECTED_FINGERPRINT` (ou avec
`--trust-presented-key`), applique les choix de staff attendus (`planAdjustments`, **une** entrée par compte car le
`PUT …/accounts/:username` remplace le choix du compte ; générés depuis le jeu par `build/lib/facts.mjs`) :
`link.theta.test` ignoré (docroot = lien → `docrootMissing` bloquant) ; proxys LAN d'acct2 avec `proxyAllowPrivate`
+ vérification `force` (sinon `proxyPrivateTarget` / `proxyDomainUnverified` bloquants) ; `cloud.gamma.test` ignoré
(cible en plage de documentation → `proxyTargetRefused`, bloquant quels que soient les drapeaux) ; adoption demandée
pour l'utilisateur FTP MD5 d'acct6 (`ftpHashUnsupported`, rien d'adopté). Test de non-régression côté planificateur :
`server/src/services/migration/plan/fakeCwpAdjustments.test.ts`. Le scénario exige qu'aucun compte sélectionné ne soit bloqué, lance les
exécutions initiales, puis affiche les contrôles manuels (aperçu WordPress, connexion MySQL / IMAP avec les anciens
mots de passe, DKIM, proxy, cron, suspension, SFTP). Sortie 1 si un contrôle **dur** échoue ; les contrôles souples
(`~`) sont informatifs.

Avant le plan, `e2e` autorise les cibles de proxy externes pour le tenant Default (politique d'applications,
`PUT /api/apps/policy/tenants/1`, PX2 : plan ∧ tenant) — sinon chaque compte qui a un proxy CWP est bloqué
(`proxyExternalNotAllowed`, raison `tenantPolicy`). Si la plateforme n'a pas d'IPv4 publique, passer `TARGET_IPV4=…`
(sinon `zoneTargetIpMissing`, bloquant pour les comptes qui ont une zone).

## Limites (voulues)

- Pas de systemd en PID 1 : les unités de `/etc/systemd/system` ne sont que des fichiers ; Node / Python ne tournent pas.
- Postfix, Dovecot, OpenDKIM, Pure-FTPd, nginx, Apache (cwp-httpd), Varnish, cron, cwpsrv, Roundcube **ne tournent
  pas** : seuls leurs fichiers et CLIs (`postconf -n`, `doveconf -n`) existent. Apache et Varnish ne sont même pas
  installés (fichiers seulement) ; nginx l'est pour son arborescence et `rpm -q`.
- Les binaires PHP (`/usr/local/bin/php`, `/opt/alt/php*/usr/bin/php*`, `php-fpm`) sont des **scripts factices**
  (`-v` répond la version) ; aucun RPM CWP (`cwpsrv`, `cwp-httpd`, `cwp-suphp`) : la version CWP vient de `version.php`.
- Seuls `sshd`, MariaDB et `named` tournent. Les tables MEMORY sont vides après le premier démarrage (normal).
- Les IP de la source (`203.0.113.10`, `10.99.0.2`) ne sont posées sur `lo` qu'avec `--cap-add NET_ADMIN` (`run.sh`).
- Format de `mysql_user_prefix.conf` non relevé sur la source (supposé : un préfixe par ligne) ; suffixe `.disabled`
  supposé `<fqdn>.conf.disabled` ; fichiers de templates Apache à plat (`all_methods.tpl`).

## À vérifier au premier build sur the Linux test host

1. Tag / digest de `rockylinux/rockylinux:8.10` (l'épingler ensuite via `ROCKY_IMAGE=…@sha256:…`).
2. Dépôts : `epel-release` + `powertools` ; noms EPEL `opendkim`, `pure-ftpd` ; `dovecot-pigeonhole` / `dovecot-mysql`
   (AppStream) ; `postfix-mysql` facultatif.
3. Flux de modules : `mariadb:10.3` (MariaDB **10.3.x** attendue : `mysql -e 'SELECT VERSION()'`), `nodejs:18`.
4. `mysql_install_db --rpm` et `/usr/libexec/mysqld` (chemins RHEL 8) ; `CREATE USER … IDENTIFIED VIA
   mysql_native_password USING '*HEX'` accepté par 10.3 (colonnes `plugin` / `authentication_string` remplies).
5. BIND 9.11 : `named-checkconf`, `named-checkzone` de chaque zone (fatals au build) ; `nsupdate -k` avec le fichier de
   clé au format `named.conf` ; présence de `/var/named/srvdomain.test.db.jnl` ; **`named-checkzone -j -D -o -
   srvdomain.test /var/named/srvdomain.test.db`** contient `dyn-added` alors que le fichier `.db` ne le contient pas ;
   `dig AXFR srvdomain.test @127.0.0.1` idem ; après 20 minutes, le `.db` est toujours en retard (named ne peut plus
   écrire dans `/var/named` 0750).
6. `postconf -n` et `doveconf -n` répondent (avertissements au build sinon) ; `sshd` avec `UsePAM no` accepte la clé
   **de root sans `ROOT_PASSWORD`** (`run.sh` avec `AUTHORIZED_KEY` seul ; `getent shadow root` → `*`, pas `!locked`,
   sinon sshd refuse tout : « User root not allowed because account is locked »).
7. `chpasswd -c SHA512`, `htpasswd -nbBC 10` (httpd-tools), `openssl ca -startdate/-enddate`, `req -addext` (OpenSSL 1.1.1).
8. `verify-readonly.sh` : deux instantanés consécutifs **sans** scénario donnent déjà une différence vide, y compris
   quand on exécute entre les deux les commandes de lecture que lance le panel en root (au minimum
   `docker exec oblimint-fake-cwp rpm -q nginx`, `postconf -n`, `doveconf -n`, `mysqldump` d'une base) ; sinon
   compléter la liste d'exclusions en la justifiant.

## Contrôles locaux (Windows compris)

```sh
node images/fake-cwp/check/check-dataset.mjs                  # cohérence + valeurs synthétiques + `set -eu` / `bash -n`
node images/fake-cwp/check/check-dataset.mjs --write-expected # après une modification du jeu de données (relire le diff)
node images/fake-cwp/build/generate.mjs summary               # arborescence générée (secrets factices)
```
