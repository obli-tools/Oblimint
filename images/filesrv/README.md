# `meejay/oblimint-filesrv` — serveur SFTP par compte (SFTPGo)

Base : `drakkan/sftpgo:v2.6.6-alpine` épinglée par digest
(`sha256:1dfde466cd2298c67050ea74798fd8e026f1667e657e0b8b2c68a7753ebe302a`, vérifié sur Docker
Hub le 09/10/2026 ; 2.6.6 est la dernière 2.6.x publiée, une branche 2.7.x existe). Formats des
hooks : documentation SFTPGo « External Authentication » et « Custom Actions »
(docs.sftpgo.com/latest), consultée le 09/10/2026.

## Exécution

| Élément | Valeur |
|---|---|
| Utilisateur | `uid:gid` du compte (quelconque, sans entrée passwd) ; fichiers créés au bon propriétaire |
| Durcissement | `CapDrop ALL`, `no-new-privileges`, `ReadonlyRootfs`, tmpfs `/tmp` |
| Montages | `/srv/files/staging` (rw), `/srv/files/data` (rw), `/var/lib/sftpgo` (rw : clés d'hôte `id_rsa`, `id_ecdsa`, `id_ed25519` générées au 1er démarrage puis conservées) |
| Port | `2022/tcp` (SFTP). P1 / `OBLIMINT_PORT_GATEWAY=off` : publié sur le port hôte du compte. P2 (défaut) : **rien n'est publié**, la passerelle hostd écoute le port du compte et relaie vers `<IP du conteneur>:2022` |
| Env | `OBLIMINT_HOOK_BASE=http://oblimint-panel:8081/internal/filesrv/<accountId>/<token>`, `OBLIMINT_ACCOUNT_ID=<accountId>` ; `OBLIMINT_PROXY_PROTOCOL=1` derrière la passerelle (P2) ; optionnel `SFTPGO_LOG_LEVEL` (`info`) |

L'entrypoint (`oblimint-filesrv`) valide les variables (id numérique, URL sans caractère
spécial contenant `/<accountId>/`), écrit `/tmp/oblimint-filesrv/sftpgo.json` (0600) puis
`exec sftpgo serve --config-dir /var/lib/sftpgo --config-file /tmp/oblimint-filesrv/sftpgo.json`.

Configuration rendue (clés SFTPGo 2.6) :

- `sftpd.bindings = [{port: 2022}]`, `password_authentication: true`,
  `keyboard_interactive_authentication: false`, `max_auth_tries: 4`, commandes SSH limitées à
  `md5sum, sha1sum, sha256sum, cd, pwd` (pas de `scp` : les clients récents passent par SFTP) ;
- `ftpd`, `webdavd`, `httpd` (admin web, client web, API REST) : `bindings = [{port: 0}]` →
  désactivés ; `telemetry.bind_port = 0` ;
- `data_provider.driver = "memory"`, `name = ""` (aucun utilisateur stocké, aucun dump),
  `create_default_admin: false`, `external_auth_hook = $OBLIMINT_HOOK_BASE/auth`,
  `external_auth_scope = 3` (mot de passe + clé publique) ;
- `common.upload_mode = 1` (**envois atomiques**) et `temp_path = ""` : voir « Envois atomiques »
  ci-dessous ;
- `common.actions = {execute_on: [pre-upload, upload, delete, rename, mkdir, rmdir], execute_sync: [],
  hook: $OBLIMINT_HOOK_BASE/event}` (asynchrone, sauf `pre-upload` toujours synchrone) ;
- `common.defender` activé (driver mémoire, ban 30 min, seuil 15, invalid 2 / valid 1 /
  limite 3), `idle_timeout: 15`, `max_per_host_connections: 20`, `setstat_mode: 1` (les
  chmod/chown/mtime des clients sont ignorés sans erreur **à condition que la permission soit
  accordée** : SFTPGo 2.6 vérifie la permission avant `setstat_mode` — le panel accorde donc `chmod`
  (no-op) pour que `sftp put -r` d'OpenSSH, qui termine chaque dossier par un setstat, n'affiche
  plus « remote setstat … Permission denied » ; `chown` reste refusé) ;
- logs sur stdout (`SFTPGO_LOG_FILE_PATH=""`).

## Derrière la passerelle hostd (P2, `OBLIMINT_PROXY_PROTOCOL=1`)

Avec la passerelle de ports (`OBLIMINT_PORT_GATEWAY`, défaut), le conteneur ne publie aucun port :
hostd écoute le port SFTP du compte (IPv4 + IPv6), applique la liste blanche et les bans à
l'acceptation, démarre le serveur à la connexion (mode à la demande) et relaie vers
`<IP du conteneur sur le réseau du compte>:2022` en écrivant d'abord un en-tête **PROXY v2**.
L'entrypoint rend alors :

- `common.proxy_protocol = 2` : en-tête **obligatoire** pour la source autorisée ;
- `common.proxy_allowed = ["<passerelle par défaut du conteneur>"]` : la seule source dont l'en-tête
  est lu est l'adresse côté hôte du pont du compte (lue dans `/proc/net/route`), c'est-à-dire
  l'adresse d'où hostd se connecte : aucun autre pair ne peut forger l'adresse d'un client
  (**R-PROXY** fermé). Sans passerelle détectable, le conteneur refuse de démarrer.
  **Attention** : pour une source hors `proxy_allowed`, SFTPGo applique la politique go-proxyproto
  `REJECT`, qui refuse une connexion **portant** un en-tête mais accepte une connexion **sans**
  en-tête (avec l'adresse du pair). Un conteneur de site du même réseau qui joindrait `:2022`
  directement est donc arrêté par hostd : règle nftables `forward` qui jette tout flux relayé vers
  un backend de passerelle en mode PROXY (seul hostd, depuis l'espace réseau de l'hôte, l'atteint) ;
- `common.defender` **reste actif** (il voit l'IP réelle via l'en-tête) : même sans la règle
  ci-dessus, un pair direct ne pourrait pas deviner les mots de passe sans limite. Les
  bannissements du panel (nftables + contrôle à l'acceptation de la passerelle, alimentés par le
  hook d'authentification qui reçoit l'**IP réelle**) s'y ajoutent.

Sans la variable (ou `=0`) : comportement P1 (`proxy_protocol: 0`), defender actif dans les deux cas.

## Hook d'authentification — `POST $OBLIMINT_HOOK_BASE/auth`

Requête (JSON, `Content-Type: application/json`) envoyée par SFTPGo à chaque connexion :

```json
{
  "username": "client1",
  "ip": "203.0.113.7",
  "protocol": "SSH",
  "password": "…",               // non vide pour une authentification par mot de passe
  "public_key": "ssh-ed25519 AAAA…",  // non vide pour une authentification par clé (format authorized_keys)
  "keyboard_interactive": "",     // non utilisé ici (scope 3)
  "tls_cert": "",                 // non utilisé ici
  "user": { … }                   // omis si l'utilisateur n'existe pas encore dans le fournisseur
}
```

Réponse attendue :

- **succès** : HTTP **200** + objet utilisateur SFTPGo (ajouté/mis à jour dans le fournisseur
  mémoire). Forme renvoyée par le panel (`server/src/internal/internalServer.ts`,
  `sftpgoUser()`) :

  ```json
  {
    "status": 1,
    "username": "client1",
    "home_dir": "/srv/files",
    "uid": 0,
    "gid": 0,
    "max_sessions": 10,
    "permissions": {
      "/": ["list", "download", "chmod"],
      "/staging": ["list", "download", "upload", "overwrite", "delete", "rename", "create_dirs", "chmod", "chtimes"],
      "/data": ["list", "download", "upload", "overwrite", "delete", "rename", "create_dirs", "chmod", "chtimes"]
    },
    "filters": { "denied_protocols": ["FTP", "DAV", "HTTP"] }
  }
  ```

  `uid`/`gid` = 0 : SFTPGo n'essaie pas de changer de propriétaire, les fichiers sont créés par
  le processus (uid du compte). Jamais `create_symlinks` ni `chown` (`chmod` accordé mais sans effet : `setstat_mode: 1`). `username` doit être
  celui de la requête.
- **refus** : tout statut ≠ 200 (le panel répond `401` corps vide), ou un utilisateur au
  `username` vide.

## Envois atomiques

Sans eux, SFTPGo écrit directement dans le fichier final de `staging/` : une publication
(automatique à l'échéance du debounce ou du plafond de 10 min, ou manuelle) lancée pendant un
transfert figerait un fichier tronqué dans une release immuable. Avec `upload_mode: 1` :

- le fichier est écrit sous `.sftpgo-upload.<id>.<nom>` **dans le même dossier** que sa cible
  (`temp_path` vide : même système de fichiers, donc un simple `rename` à la fin, aussi pour
  `/data` ; un `temp_path` sur le tmpfs `/tmp` ferait une copie lente en RAM) ;
- il ne prend son vrai nom qu'une fois le transfert terminé ; un transfert interrompu (client
  parti, conteneur arrêté par l'expiration on-demand ou recréé) supprime le fichier temporaire ;
  l'ancienne version reste en place jusqu'au renommage ;
- les noms `.sftpgo-upload.*` sont exclus du commit (`info/exclude` du dépôt, module releases) :
  un fichier en cours n'entre jamais dans une release ;
- la reprise d'un envoi interrompu (`resume`) n'est pas possible dans ce mode (le client
  recommence le fichier) — compromis assumé.

Un **lot** d'envois reste non atomique fichier par fichier : c'est le hook `pre-upload` qui
permet au panel de savoir qu'un transfert est ouvert et de retenir la publication automatique
(besoin du module releases : suivi des transferts ouverts par site, échéance repoussée et
plafond non appliqué tant qu'un transfert est ouvert, publication refusée ou différée).

## Hook d'actions — `POST $OBLIMINT_HOOK_BASE/event`

`pre-upload` est **synchrone** : SFTPGo attend la réponse et **refuse l'envoi** si le statut
n'est pas 200 (le panel répond 200 immédiatement ; panel injoignable ⇒ envois refusés, ce qui
évite de publier un transfert que le panel n'a pas vu commencer). Les autres actions sont
envoyées de façon **asynchrone** après `upload` (fin de transfert, réussie ou non : voir
`status`), `delete`, `rename`, `mkdir`, `rmdir` (un appel par action ; un statut ≠ 200 est
seulement journalisé par SFTPGo) :

```json
{
  "action": "upload",
  "username": "client1",
  "path": "/srv/files/staging/monsite/wp-config.php",
  "target_path": "",                          // rename : chemin de destination
  "virtual_path": "/staging/monsite/wp-config.php",
  "virtual_target_path": "",                  // rename : chemin virtuel de destination
  "ssh_cmd": "",
  "file_size": 3120,
  "elapsed": 12,                              // ms
  "fs_provider": 0,                           // 0 = disque local
  "bucket": "", "endpoint": "",
  "status": 1,                                // 1 ok, 2 erreur, 3 quota dépassé
  "protocol": "SFTP",
  "ip": "203.0.113.7",
  "session_id": "…",
  "open_flags": 0,
  "role": "",
  "timestamp": 1760000000000000000,           // horodatage (ns)
  "metadata": {}
}
```

`pre-upload` a la même forme (`action: "pre-upload"`, `file_size` = taille actuelle du fichier
écrasé, 0 sinon). Le panel n'utilise que `action`, `virtual_path` / `virtual_target_path` (repli : `path` /
`target_path` relatifs à `/srv/files`) pour déclencher la publication automatique du site
concerné (`/staging/<slug>/…`).

## Points d'attention (à vérifier sur VM)

- **Format de `public_key`** : SFTPGo envoie la clé au format `authorized_keys`, éventuellement
  suivie d'un retour ligne et sans commentaire : la comparaison côté panel doit porter sur
  `type + base64` (ou l'empreinte SHA256), espaces finaux ignorés.
- **IP vue par le defender** (P1 / passerelle désactivée seulement ; derrière la passerelle, l'IP vient de l'en-tête PROXY) : avec le proxy userland de Docker (`docker-proxy`, utilisé pour
  IPv6 et pour les connexions locales), toutes les connexions peuvent sembler venir de la
  passerelle du réseau → un bannissement toucherait tout le monde. Avec le DNAT iptables (IPv4
  par défaut), l'IP source réelle est conservée. À contrôler sur la VM (`docker logs` affiche
  l'IP de chaque connexion).
- **Jeton dans les logs** : l'URL des hooks (qui contient le jeton HMAC) n'est écrite que dans
  le fichier de configuration (tmpfs, 0600) ; SFTPGo peut toutefois l'afficher dans un message
  d'erreur d'exécution de hook (logs du conteneur, visibles des seuls admins).
- Les clés `score_no_auth`, `max_per_host_connections`, `setstat_mode`, `temp_path` existent en
  2.6 d'après la documentation ; une clé inconnue serait ignorée (viper), pas fatale.
- **Envois atomiques** : vérifier le nom du fichier temporaire (`.sftpgo-upload.<id>.<nom>` dans
  le dossier cible, d'après le code 2.6), qu'un `kill` du client en cours d'envoi ne laisse ni
  fichier tronqué ni temporaire, et que `pre-upload` arrive bien avant le premier octet avec une
  réponse 200 (sinon l'envoi est refusé).

## Plan de test (VM)

```sh
docker run -d --name f1 --user 20001:20001 --cap-drop ALL --security-opt no-new-privileges \
  --read-only --tmpfs /tmp:rw,noexec,nosuid,nodev -p 32001:2022 \
  -v /srv/t/staging:/srv/files/staging -v /srv/t/data:/srv/files/data -v /srv/t/filesrv:/var/lib/sftpgo \
  -e OBLIMINT_HOOK_BASE=http://<panel>:8081/internal/filesrv/1/<token> -e OBLIMINT_ACCOUNT_ID=1 \
  meejay/oblimint-filesrv
docker logs f1                      # SFTP sur 2022, clés générées dans /srv/t/filesrv (uid 20001)
sftp -P 32001 client1@localhost     # mot de passe → requête /auth reçue par le panel ; ls / → staging, data
put index.php staging/monsite/      # requête /event action=upload, fichier possédé par 20001
ln -s / x                           # refusé (pas de create_symlinks)
# 15 mauvais mots de passe → IP bannie 30 min (defender)
# curl http://<ip conteneur>:8080   → rien n'écoute (httpd désactivé)
```
