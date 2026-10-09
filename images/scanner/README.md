# `meejay/oblimint-scanner` — scanner partagé des changements (P3, module scanners)

Conteneur `oblimint-scanner` (`docs/P3-PLAN.md` §4.2, §9, invariants M10, M12, A6) : **clamd** et
**freshclam** (image officielle ClamAV), **YARA** (paquet Alpine, règles compilées par `yarac` au
build) et **scand** (Go, bibliothèque standard seule, `scand/`), l'API HTTP que le panel appelle.
Le panel garde ses **heuristiques** (toujours actives, `server/src/services/scan/heuristics.ts`) et
**envoie** le contenu des fichiers : le scanner ne monte jamais d'arbre de tenant.

```
images/scanner/
  Dockerfile              build : scand (gofmt + go vet + go test) → image ClamAV + yara + tini
  scand/                  service HTTP (Go, go.mod propre, testé au build et en local)
  rules/oblimint-php.yar  NOS règles YARA (34 règles publiques, voir plus bas)
  tests/run-tests.sh      test de fumée des règles (échantillons encodés en base64)
  tests/scand-clamd-smoke.sh  test d'intégration scand + clamd (EICAR par zINSTREAM, au build)
  tests/samples/*.b64     échantillons positifs / bénins (jamais décodés dans le dépôt)
  tests/expected.txt      règles attendues par échantillon (« - » : aucune règle Oblimint_*)
  tests/eicar.b64         chaîne de test EICAR (test de fumée ClamAV)
```

## Construire

```sh
images/build.sh scanner                       # contexte images/, Dockerfile images/scanner/Dockerfile
docker build -f scanner/Dockerfile \
  --build-arg PMF_COMMIT=<commit 40 hex> --build-arg PMF_SHA256=<sha256 de l'archive GitHub> \
  -t meejay/oblimint-scanner:latest images/   # + règles php-malware-finder (LGPL, vendues dans l'image)
```

Arguments : `CLAMAV_IMAGE` (défaut `clamav/clamav:1.4.3`, **digest à épingler sur the Linux test host** :
`docker buildx imagetools inspect clamav/clamav:1.4.3`), `GO_IMAGE` (`golang:1.26-alpine`),
`PMF_COMMIT` + `PMF_SHA256` (optionnels : archive épinglée par commit **et** somme de contrôle,
seul `data/` est copié avec la licence), `CLAMAV_SMOKE` (1 : clamd, lancé par scand sur les
signatures de l'image recopiées comme au premier démarrage, doit détecter EICAR via `POST /v1/scan` ;
≈ 1 Gio de RAM pendant le build).

Le build échoue si : `gofmt` / `go vet` / `go test` de scand échouent, `yarac` refuse les règles,
moins de 25 règles publiques, un échantillon positif ne déclenche pas sa règle ou un échantillon
bénin déclenche une règle `Oblimint_*`, scand ne détecte pas l'échantillon d'auto-test par HTTP
(clé correcte), accepte une mauvaise clé ou abîme une meta UTF-8 (« … »), clamd lancé par scand avec
le `clamd.conf` qu'il produit ne démarre pas ou ne détecte pas EICAR par `zINSTREAM`
(`tests/scand-clamd-smoke.sh` : toujours sur une base d'une signature, et sur les signatures de
l'image si `CLAMAV_SMOKE=1`), ou l'uid 954 est déjà pris dans l'image de base.

## Contrat d'exécution

| Élément | Valeur |
|---|---|
| Utilisateur | `954:954` (`scand`) : clamd, freshclam et scand tournent **sans privilège dès le départ** (pas de `User` clamd ni de changement d'utilisateur) ⇒ `CapDrop ALL`, aucune capacité ajoutée |
| Réseau | `oblimint` (panel) seulement, **aucun port publié** ; scand écoute `:8080` ; freshclam sort vers `database.clamav.net` |
| Racine | lecture seule ; écritures : `/var/lib/clamav` (bind de `/srv/oblimint/scanner/clamav`, propriétaire 954, 0700), `/tmp` (tmpfs : un fichier temporaire par analyse en cours), `/run` (tmpfs : `clamd.conf`, `freshclam.conf`, socket clamd 0600) |
| Mémoire | 1,5 Gio avec ClamAV (signatures ≈ 1 Gio résidentes, rechargement **non concurrent**, `TestDatabases no`), 256 Mio sans ; tmpfs compris |
| PID 1 | `tini` → `scand`, qui supervise `clamd --foreground` (redémarrage avec délai croissant) |
| Santé | `scand -healthcheck` → `GET /healthz` (sans clé, aucune information) |

Variables (posées par le panel, `server/src/services/scan/scannerSpec.ts`) :

| Variable | Défaut | Rôle |
|---|---|---|
| `SCAND_KEY` | — (obligatoire, ≥ 16) | clé partagée, en-tête `X-Oblimint-Scanner-Key`, comparaison à temps constant |
| `SCAND_CLAMAV` | `1` | clamd + freshclam |
| `SCAND_YARA` | `1` | YARA |
| `FRESHCLAM_CHECKS` | `12` | mises à jour par jour (1 … 24) |
| `SCAND_MAX_FILE_MB` | `32` | plus gros fichier accepté (413 au-delà) ; `MaxFileSize` / `StreamMaxLength` de clamd = +1 Mo |
| `SCAND_CONCURRENCY` | `4` | analyses simultanées (= `MaxThreads` de clamd) |

### API (`scand/server.go`)

- `POST /v1/scan?name=<chemin>` (corps = octets du fichier) → `{"clamav":{"status":"ok|found|error|disabled","signature"?},"yara":{"matches":[{"rule","tags","meta"}],"error"?,"disabled"?}}`.
  ClamAV par `zINSTREAM` sur le socket local (blocs de 64 Kio préfixés de leur longueur sur 4
  octets gros-boutiens, bloc vide final) ; YARA par `yara -C -g -m -w -a 30` sur un fichier
  temporaire du tmpfs, délai 30 s (+5 s puis kill). `name` n'est qu'informatif (journal) ;
  les erreurs des moteurs sont résumées (`"error":"yara failed"`), jamais le texte brut (A6).
- `GET /v1/status` → version de scand ; ClamAV : version du moteur, version et date de `daily`
  (réponse `VERSION` de clamd), date de la dernière mise à jour ; YARA : version, version des
  règles et nombre de règles (`rules.json` écrit au build).
- `POST /v1/update` → `freshclam` immédiat puis `RELOAD` de clamd si quelque chose a changé ;
  502 en cas d'échec.

### Mises à jour des signatures

scand lance lui-même `freshclam` **en mode ponctuel** toutes les `24 h / FRESHCLAM_CHECKS` (et à
la demande), sous un verrou unique, puis `RELOAD` : pas de démon freshclam en parallèle d'un
freshclam manuel (verrou du dossier de signatures). Premier démarrage : les signatures de l'image
sont copiées dans le volume (vide) pour que clamd démarre tout de suite ; sans signatures, le
téléchargement est lancé immédiatement et clamd redémarre ensuite.

## Règles YARA (`rules/oblimint-php.yar`)

Nos propres règles, dans l'esprit de php-malware-finder ; `meta.score` = points de risque donnés
par le panel (`critical` à partir de 60). La règle privée `OblimintPhpFile` (`<?php` / `<?=`)
restreint les règles PHP aux fichiers PHP.

| Règle | Points | Détecte |
|---|---|---|
| `Oblimint_Php_Eval_Decoder` | 70 | `eval(` d’un décodeur (`base64_decode`, `gzinflate`, `str_rot13`, `strrev`, `hex2bin`…) |
| `Oblimint_Php_Assert_Decoder` | 70 | `assert(` d'un décodeur |
| `Oblimint_Php_Request_Eval` | 90 | `eval` / `assert` de `$_GET/$_POST/$_REQUEST/$_COOKIE/$_SERVER` |
| `Oblimint_Php_Remote_Eval` | 80 | `eval(` de `file_get_contents` / `curl_exec`… |
| `Oblimint_Php_Preg_Replace_E` | 70 | `preg_replace` avec `/e` (délimiteurs `/ # ~ @ !`) |
| `Oblimint_Php_Create_Function_Decoder` | 60 | `create_function` d'un décodeur |
| `Oblimint_Php_Request_Shell` | 80 | `system/exec/passthru/shell_exec/popen/proc_open` ou backticks sur une entrée de requête (en position de code uniquement : les exemples Markdown `` `$_POST['x']` `` des docblocks — cœur WordPress — ne déclenchent pas) |
| `Oblimint_Php_Request_Include` | 70 | `include/require` d'une entrée de requête |
| `Oblimint_Php_Request_Callable` | 70 | `$_GET['f'](…)`, `call_user_func($_POST…)`, `array_map($_REQUEST…)` |
| `Oblimint_Php_Reverse_Shell` | 80 | socket sortante + `/bin/sh` |
| `Oblimint_Php_Decoder_Chain` | 50 | `gzinflate(base64_decode(`… |
| `Oblimint_Php_Long_Base64_Literal` | 50 | `base64_decode('…` ≥ 1 500 caractères |
| `Oblimint_Php_Hex_Escapes` | 40 | ≥ 30 `\xNN` / `\NNN` consécutifs |
| `Oblimint_Php_Chr_Chain` | 40 | ≥ 10 `chr(n) .` |
| `Oblimint_Php_Encoded_Globals` | 50 | `${"\x47LOBALS"}`, `$GLOBALS['x'][n](` |
| `Oblimint_Php_Obfuscated_Identifiers` | 50 | > 10 identifiants `$O0O0O0…` |
| `Oblimint_Php_Rot13_Exec` | 40 | `str_rot13('…')` + exécution dynamique |
| `Oblimint_Php_Packed_Js_In_Php` | 40 | JavaScript empaqueté / encodé émis par PHP |
| `Oblimint_Php_Write_Decoded_File` | 50 | écriture de données décodées dans un fichier |
| `Oblimint_Php_Shell_Hygiene` | 30 | préambule de webshell (`set_time_limit(0)`, `ignore_user_abort`, erreurs masquées) + entrée de requête |
| `Oblimint_Webshell_C99` | 90 | marqueurs c99 |
| `Oblimint_Webshell_R57` | 90 | marqueurs r57 |
| `Oblimint_Webshell_B374k` | 90 | marqueurs b374k |
| `Oblimint_Webshell_WSO` | 90 | marqueurs WSO |
| `Oblimint_Webshell_FilesMan` | 70 | marqueur `FilesMan` dans un fichier PHP |
| `Oblimint_Webshell_Weevely` | 90 | agent weevely (`$kh` / `$kf`) |
| `Oblimint_Webshell_Generic_Ui` | 60 | ≥ 3 libellés d'interface de webshell + entrée de requête |
| `Oblimint_Php_Tiny_Uploader` | 50 | petit formulaire d'envoi vers un nom choisi par le client |
| `Oblimint_Php_Copy_Uploader` | 60 | écrit une charge de la requête vers un chemin de la requête |
| `Oblimint_Php_Spam_Mailer` | 60 | `mail($_POST…)`, kits de mailers connus |
| `Oblimint_Php_Seo_Cloaking` | 40 | contenu distant servi aux robots des moteurs |
| `Oblimint_Php_Spam_Link_Injector` | 40 | liens cachés + mots de spam |
| `Oblimint_Php_In_Image` | 80 | JPEG / PNG / GIF contenant `<?php` |
| `Oblimint_Htaccess_Php_Handler` | 60 | `.htaccess` qui fait exécuter des images / textes comme PHP |

Ajouter une règle : l'écrire dans `rules/oblimint-php.yar` (avec `meta.score` et
`meta.description`), ajouter un échantillon positif encodé dans `tests/samples/` et sa ligne dans
`tests/expected.txt`. Les règles php-malware-finder (si `PMF_COMMIT`) gardent leurs noms ;
le panel leur applique les points du plan (`ObfuscatedPhp` 60, `DodgyPhp` 40, `DangerousPhp` 30,
`SuspiciousEncoding` 30, `DodgyStrings` 30, autres 30).

## Vérifié sur le poste de développement (Windows, sans Docker)

- scand : `gofmt -l`, `go vet` (Windows et `GOOS=linux`), `go test` — protocole `INSTREAM`
  contre un faux clamd TCP (OK, FOUND, découpage en blocs, limite de taille, clamd absent),
  `VERSION` / `PING` / `RELOAD`, analyse de la sortie de `yara -g -m` (échappements, tags),
  exécution du CLI yara simulé (correspondances, échec, délai), authentification à temps
  constant, 413, erreurs des moteurs résumées, statut, mise à jour (codes de sortie de freshclam),
  rendu des configurations, amorçage des signatures.
- Règles : un vérificateur local approximatif (structure, chaînes non référencées, syntaxe des
  expressions, fonctionnalités absentes de YARA, émulation des conditions) passe sur tous les
  échantillons. **Ce n'est pas `yarac`** : la compilation réelle a lieu au build.

## À vérifier sur the Linux test host (`docs/P3-PLAN.md` §16, point 7)

1. Build : `images/build.sh scanner` (image de base Alpine, paquets `yara` / `tini`, `yarac`
   accepte les règles, tests de fumée, uid 954 libre) ; épingler le digest de `clamav/clamav`.
2. Avec `PMF_COMMIT` : compilation des règles php-malware-finder (module `hash` de yara).
3. Déploiement (Nœuds → scanner) : `docker inspect` = utilisateur 954, `CapDrop ALL`, racine RO,
   réseau `oblimint` seul, aucun port ; clamd démarre sous le profil seccomp des tenants ;
   `/srv/oblimint/scanner/clamav` 954:954 0700.
4. Mémoire réelle de clamd (signatures complètes) sous 1,5 Gio, y compris pendant un `RELOAD`
   et un `freshclam` ; journal de clamd visible dans `docker logs` (pas de `LogFile` : clamd au premier plan écrit sur
   sa sortie, relayée par scand ; `LogFile /dev/stderr` est refusé par clamd, lien symbolique).
5. `POST /api/system/scanner/test` : EICAR détecté par ClamAV, échantillon détecté par YARA.
6. Publication d'un webshell ⇒ release bloquée (`awaiting_approval`), dérogation staff ⇒ publiée
   et auditée ; scanner arrêté ⇒ publication analysée par les heuristiques, `scannerUnavailable`.
7. `POST /api/system/scanner/update` : freshclam réel puis `RELOAD` ; planification par
   `FRESHCLAM_CHECKS`.
