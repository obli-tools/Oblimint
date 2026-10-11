#!/usr/bin/env bash
# =============================================================================
#  Oblimint — "total conversion" installer
#
#  Turns a fresh Debian / Ubuntu / AlmaLinux / Rocky server into an Oblimint
#  hosting node: Docker, storage layout, ports, firewall, then the panel itself,
#  configured through its first-run wizard API with the answers given here.
#
#    curl -fsSL <url>/install.sh | sudo bash          # interactive
#    sudo bash install.sh --upgrade                   # pull + recreate the panel
#
#  Everything heavy (Docker images/containers AND hosted data) goes to ONE
#  storage location chosen below (e.g. a dedicated /mnt/system volume).
#  XFS mounted with prjquota is strongly recommended: it gives hard disk quotas
#  per hosting account and bounded writable layers for Docker apps.
# =============================================================================
set -Eeuo pipefail

OBLIMINT_IMAGE_REPO="${OBLIMINT_IMAGE_REPO:-meejay/oblimint}"
CONF_DIR=/etc/oblimint
CONF_FILE=$CONF_DIR/install.env
PANEL_NAME=oblimint
PANEL_PORT=8443

# ── output helpers ───────────────────────────────────────────────────────────
if [ -t 1 ]; then B=$'\e[1m'; R=$'\e[31m'; G=$'\e[32m'; Y=$'\e[33m'; C=$'\e[36m'; N=$'\e[0m'; else B= R= G= Y= C= N=; fi
info()  { printf '%s\n' "${C}==>${N} $*"; }
ok()    { printf '%s\n' "${G} ✔${N} $*"; }
warn()  { printf '%s\n' "${Y} ⚠ $*${N}"; }
die()   { printf '%s\n' "${R} ✖ $*${N}" >&2; exit 1; }
trap 'die "Erreur ligne $LINENO : $BASH_COMMAND"' ERR

# Questions are read from the terminal even when the script is piped (curl | bash).
TTY=/dev/tty
[ -r "$TTY" ] || die "Aucun terminal disponible pour poser les questions (lancez le script dans un terminal)."
ask() {            # ask VAR "question" "default"
  local __v="$1" __q="$2" __d="${3:-}" __a
  if [ -n "$__d" ]; then printf '%s' "${B}$__q${N} [$__d] : " >"$TTY"; else printf '%s' "${B}$__q${N} : " >"$TTY"; fi
  IFS= read -r __a <"$TTY" || true
  printf -v "$__v" '%s' "${__a:-$__d}"
}
ask_secret() {     # ask_secret VAR "question"  (empty = generated)
  local __v="$1" __q="$2" __a
  printf '%s' "${B}$__q${N} (vide = généré) : " >"$TTY"
  IFS= read -rs __a <"$TTY" || true; printf '\n' >"$TTY"
  printf -v "$__v" '%s' "$__a"
}
confirm() {        # confirm "question" [default y|n]
  local d="${2:-y}" a hint="[O/n]"; [ "$d" = n ] && hint="[o/N]"
  printf '%s' "${B}$1${N} $hint : " >"$TTY"; IFS= read -r a <"$TTY" || true; a="${a:-$d}"
  [[ "$a" =~ ^[oOyY] ]]
}
gen_password() { tr -dc 'A-Za-z0-9' </dev/urandom | head -c 20 || true; }
json_str() {       # JSON string literal (or null when empty)
  if [ -z "${1:-}" ]; then printf 'null'; return; fi
  local s=${1//\\/\\\\}; s=${s//\"/\\\"}; s=${s//$'\n'/\\n}; s=${s//$'\t'/\\t}
  printf '"%s"' "$s"
}

# ── 0. preconditions ─────────────────────────────────────────────────────────
[ "$(id -u)" -eq 0 ] || die "À lancer en root (sudo)."
[ -r /etc/os-release ] || die "/etc/os-release introuvable."
# shellcheck disable=SC1091
. /etc/os-release
OS_ID="${ID:-}"; OS_VER="${VERSION_ID%%.*}"
case "$OS_ID" in
  debian)              [ "${OS_VER:-0}" -ge 12 ] || die "Debian 12 ou plus récent requis." ; PKG=apt ;;
  ubuntu)              [ "${OS_VER:-0}" -ge 22 ] || die "Ubuntu 22.04 ou plus récent requis."; PKG=apt ;;
  almalinux|rocky|rhel)[ "${OS_VER:-0}" -ge 9 ]  || die "AlmaLinux / Rocky 9 ou plus récent requis."; PKG=dnf ;;
  *) die "Système non pris en charge : ${PRETTY_NAME:-$OS_ID} (Debian 12+, Ubuntu 22.04+, AlmaLinux/Rocky 9+)." ;;
esac
[ "$(uname -m)" = x86_64 ] || die "Architecture non prise en charge : $(uname -m) (x86_64 uniquement)."

cat >"$TTY" <<EOF

${B}  ┌──────────────────────────────────────────────────────────────┐
  │   Oblimint — conversion de ce serveur en nœud d'hébergement  │
  └──────────────────────────────────────────────────────────────┘${N}
  Système : ${PRETTY_NAME:-$OS_ID}
  Ce script installe Docker, prépare le stockage, libère les ports web /
  mail / DNS, règle le pare-feu puis installe et configure le panel.
  Il ne touche à rien sans vous le demander.

EOF

# ── upgrade mode ─────────────────────────────────────────────────────────────
run_panel() {      # (re)create the panel container from $CONF_FILE
  # shellcheck disable=SC1090
  . "$CONF_FILE"
  local envs=(-e "OBLIMINT_DATA_DIR=$DATA_DIR" -e "PANEL_TLS=selfsigned" -e "OBLIMINT_IMAGE_TAG=$IMAGE_TAG")
  [ -n "${PDNS_BIND:-}" ] && envs+=(-e "OBLIMINT_PDNS_BIND=$PDNS_BIND")
  [ -n "${EXTRA_ENV:-}" ] && for kv in $EXTRA_ENV; do envs+=(-e "$kv"); done
  # Networks of the previous panel container (platform network 'oblimint' carrying
  # the oblimint-panel alias, account fabrics, mail network…): a plain 'docker run'
  # only joins the default bridge, so they are re-attached below — the panel reaches
  # its PostgreSQL and the edge reaches the panel through them.
  local nets n seen=" "
  nets=$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$PANEL_NAME" 2>/dev/null || true)
  docker network inspect oblimint >/dev/null 2>&1 && nets="oblimint $nets"
  docker rm -f "$PANEL_NAME" >/dev/null 2>&1 || true
  docker run -d --name "$PANEL_NAME" --restart unless-stopped \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -v "$DATA_DIR:$DATA_DIR" \
    -p "$PANEL_PORT:$PANEL_PORT" \
    "${envs[@]}" "$OBLIMINT_IMAGE_REPO:$IMAGE_TAG" >/dev/null
  for n in $nets; do
    case "$n" in bridge|host|none) continue ;; esac
    case "$seen" in *" $n "*) continue ;; esac
    seen="$seen$n "
    docker network connect --alias oblimint-panel "$n" "$PANEL_NAME" >/dev/null 2>&1 \
      || warn "Reconnexion du panel au réseau $n impossible : docker network connect --alias oblimint-panel $n $PANEL_NAME"
  done
}
do_upgrade() {
  [ -r "$CONF_FILE" ] || die "Aucune installation trouvée ($CONF_FILE)."
  # shellcheck disable=SC1090
  . "$CONF_FILE"
  info "Mise à jour du panel ($OBLIMINT_IMAGE_REPO:$IMAGE_TAG)…"
  docker pull "$OBLIMINT_IMAGE_REPO:$IMAGE_TAG"
  run_panel
  ok "Panel recréé. Les images gérées sont mises à jour par le panel lui-même."
  exit 0
}
[ "${1:-}" = "--upgrade" ] && do_upgrade
if docker ps -a --format '{{.Names}}' 2>/dev/null | grep -qx "$PANEL_NAME"; then
  warn "Un conteneur « $PANEL_NAME » existe déjà sur ce serveur."
  [ -r "$CONF_FILE" ] && confirm "Faire une simple mise à jour du panel (recommandé) ?" y && do_upgrade
  confirm "Continuer une NOUVELLE installation malgré tout ?" n || exit 0
fi

# ── 1. packages ──────────────────────────────────────────────────────────────
info "Paquets de base…"
if [ "$PKG" = apt ]; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq curl ca-certificates xfsprogs nftables iproute2 openssl >/dev/null
else
  dnf install -y -q curl ca-certificates xfsprogs nftables iproute openssl >/dev/null
fi
ok "Paquets installés."

# ── 2. storage: where the heavy data lives ───────────────────────────────────
cat >"$TTY" <<EOF

${B}Stockage${N}
  Tout le « lourd » ira à UN seul endroit : images et conteneurs Docker,
  sites, bases, mails, sauvegardes locales. Systèmes de fichiers montés :

EOF
df -hT -x tmpfs -x devtmpfs -x overlay -x squashfs -x efivarfs 2>/dev/null | sed 's/^/    /' >"$TTY"
echo >"$TTY"
FREE_DISKS=$(lsblk -dpno NAME,TYPE,SIZE,MOUNTPOINT | awk '$2=="disk" && $4==""{print $1" ("$3")"}' | while read -r d rest; do
  if ! lsblk -no MOUNTPOINT "$d" | grep -q . && ! blkid "$d" >/dev/null 2>&1; then echo "$d $rest"; fi; done || true)
if [ -n "$FREE_DISKS" ]; then
  printf '%s\n' "  Disques vierges détectés (formatables en XFS) :" >"$TTY"
  printf '      %s\n' $FREE_DISKS >"$TTY" 2>/dev/null || true
  echo >"$TTY"
fi

STORAGE_ROOT=""
if [ -n "$FREE_DISKS" ] && confirm "Formater un disque vierge en XFS (quotas) pour Oblimint ?" n; then
  ask DEV "Disque à formater (ex. /dev/sdb)" ""
  [ -b "$DEV" ] || die "$DEV n'est pas un périphérique bloc."
  blkid "$DEV" >/dev/null 2>&1 && die "$DEV contient déjà un système de fichiers : refusé."
  ask MNT "Point de montage" "/mnt/system"
  warn "TOUTES les données de $DEV seront effacées."
  ask CONFIRM_DEV "Retapez le nom du disque pour confirmer" ""
  [ "$CONFIRM_DEV" = "$DEV" ] || die "Confirmation incorrecte, rien n'a été fait."
  mkfs.xfs -q -f -m reflink=1 "$DEV"
  mkdir -p "$MNT"
  UUID=$(blkid -s UUID -o value "$DEV")
  grep -q "$UUID" /etc/fstab || echo "UUID=$UUID $MNT xfs defaults,prjquota,noatime 0 2" >>/etc/fstab
  systemctl daemon-reload 2>/dev/null || true
  mount "$MNT"
  STORAGE_ROOT="$MNT"
  ok "$DEV formaté en XFS et monté sur $MNT (prjquota)."
else
  ask STORAGE_ROOT "Dossier de stockage (sur la partition voulue, ex. /mnt/system)" "/srv"
fi
STORAGE_ROOT="${STORAGE_ROOT%/}"; [ -n "$STORAGE_ROOT" ] || STORAGE_ROOT=/
mkdir -p "$STORAGE_ROOT"
DATA_DIR="$STORAGE_ROOT/oblimint"; [ "$STORAGE_ROOT" = / ] && DATA_DIR=/oblimint
DOCKER_ROOT="$STORAGE_ROOT/docker"; [ "$STORAGE_ROOT" = / ] && DOCKER_ROOT=/var/lib/docker

FSTYPE=$(findmnt -no FSTYPE -T "$STORAGE_ROOT")
FSOPTS=$(findmnt -no OPTIONS -T "$STORAGE_ROOT")
FSMNT=$(findmnt -no TARGET -T "$STORAGE_ROOT")
EXTRA_ENV=""
if [ "$FSTYPE" = xfs ] && [[ "$FSOPTS" =~ (prjquota|pquota) ]]; then
  ok "$FSMNT : XFS avec quotas de projet — quotas disque durs disponibles."
elif [ "$FSTYPE" = xfs ]; then
  warn "$FSMNT est en XFS mais SANS l'option prjquota."
  if [ "$FSMNT" = / ]; then
    cat >"$TTY" <<EOF
  Pour la racine, il faut l'option noyau « rootflags=prjquota » puis un redémarrage.
EOF
    if confirm "Ajouter rootflags=prjquota au chargeur de démarrage (redémarrage nécessaire ensuite) ?" y; then
      if command -v grubby >/dev/null; then grubby --update-kernel=ALL --args="rootflags=prjquota"
      else sed -i 's/^GRUB_CMDLINE_LINUX="/GRUB_CMDLINE_LINUX="rootflags=prjquota /' /etc/default/grub; update-grub >/dev/null 2>&1 || grub2-mkconfig -o /boot/grub2/grub.cfg >/dev/null; fi
      sed -i -E "s#^([^#][^ ]+[[:space:]]+/[[:space:]]+xfs[[:space:]]+)([^[:space:]]+)#\1\2,prjquota#" /etc/fstab
      ok "Option ajoutée. Redémarrez le serveur puis relancez ce script."; exit 0
    fi
  else
    if confirm "Ajouter prjquota à $FSMNT dans /etc/fstab et le remonter maintenant ?" y; then
      sed -i -E "s#^([^#][^ ]+[[:space:]]+${FSMNT//\//\\/}[[:space:]]+xfs[[:space:]]+)([^[:space:]]+)#\1\2,prjquota#" /etc/fstab
      if umount "$FSMNT" 2>/dev/null && mount "$FSMNT"; then ok "$FSMNT remonté avec prjquota."
      else warn "Impossible de démonter $FSMNT (occupé) : redémarrez le serveur puis relancez ce script."; exit 0; fi
    fi
  fi
else
  warn "$FSMNT est en ${FSTYPE:-inconnu}, pas en XFS : pas de quotas disque durs."
  cat >"$TTY" <<EOF
  Mode dégradé possible : l'usage disque est MESURÉ (alertes) au lieu d'être bloqué,
  et la couche inscriptible des applications Docker n'est pas bornée.
  Pour la production, préférez une partition XFS (option de formatage ci-dessus).
EOF
  confirm "Continuer en mode dégradé ?" n || exit 0
  EXTRA_ENV="OBLIMINT_ALLOW_MEASURED_QUOTA=1 OBLIMINT_ALLOW_UNBOUNDED_APP_ROOTFS=true"
fi
mkdir -p "$DATA_DIR" "$DOCKER_ROOT"
ok "Données Oblimint : $DATA_DIR — Docker : $DOCKER_ROOT"

# ── 3. Docker Engine ─────────────────────────────────────────────────────────
mkdir -p /etc/docker
if command -v docker >/dev/null 2>&1; then
  CUR_ROOT=$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || echo /var/lib/docker)
  ok "Docker déjà installé ($(docker --version | cut -d, -f1)), racine actuelle : $CUR_ROOT"
else
  CUR_ROOT=""
  info "Installation de Docker Engine (dépôt officiel Docker)…"
  curl -fsSL https://get.docker.com | sh >/dev/null
fi
DAEMON_JSON=/etc/docker/daemon.json
if [ -s "$DAEMON_JSON" ] && ! grep -q "\"data-root\": *\"$DOCKER_ROOT\"" "$DAEMON_JSON"; then
  cp "$DAEMON_JSON" "$DAEMON_JSON.bak.$(date +%s)"
  warn "Ancien $DAEMON_JSON sauvegardé (.bak) et remplacé."
fi
cat >"$DAEMON_JSON" <<EOF
{
  "data-root": "$DOCKER_ROOT",
  "storage-driver": "overlay2",
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "3" },
  "live-restore": true
}
EOF
if [ -n "$CUR_ROOT" ] && [ "$CUR_ROOT" != "$DOCKER_ROOT" ] && [ -d "$CUR_ROOT" ] && [ -n "$(ls -A "$CUR_ROOT" 2>/dev/null)" ]; then
  warn "Docker stockait déjà des données dans $CUR_ROOT."
  if confirm "Les déplacer vers $DOCKER_ROOT (arrêt de Docker pendant la copie) ?" y; then
    systemctl stop docker docker.socket 2>/dev/null || true
    cp -a "$CUR_ROOT/." "$DOCKER_ROOT/"
    ok "Copie terminée (l'ancien dossier est conservé, à supprimer à la main plus tard)."
  fi
fi
systemctl enable --now docker >/dev/null 2>&1 || true
systemctl restart docker
docker info >/dev/null 2>&1 || die "Docker ne démarre pas (journalctl -u docker)."
[ "$(docker info --format '{{.DockerRootDir}}')" = "$DOCKER_ROOT" ] || die "Docker n'utilise pas $DOCKER_ROOT."
ok "Docker prêt, données dans $DOCKER_ROOT."

# ── 4. SELinux (AlmaLinux / Rocky) ───────────────────────────────────────────
if command -v getenforce >/dev/null 2>&1 && [ "$(getenforce)" = Enforcing ]; then
  warn "SELinux est en mode Enforcing : les montages des conteneurs d'Oblimint ne sont pas encore étiquetés pour SELinux."
  if confirm "Passer SELinux en mode Permissive (recommandé pour Oblimint aujourd'hui) ?" y; then
    setenforce 0 || true
    sed -i 's/^SELINUX=enforcing/SELINUX=permissive/' /etc/selinux/config
    ok "SELinux en mode Permissive."
  fi
fi

# ── 5. ports used by the platform ────────────────────────────────────────────
info "Vérification des ports…"
port_owner() { ss -Hltnup "( sport = :$1 )" 2>/dev/null | grep -oP 'users:\(\("\K[^"]+' | head -1; }
for svc in apache2 httpd nginx lighttpd caddy postfix exim4 sendmail dovecot named bind9 dnsmasq pure-ftpd vsftpd; do
  if systemctl is-active --quiet "$svc" 2>/dev/null; then
    warn "Le service « $svc » tourne et occupe des ports dont Oblimint a besoin."
    if confirm "Arrêter et désactiver « $svc » ?" y; then systemctl disable --now "$svc" >/dev/null 2>&1 || true; ok "$svc arrêté."; fi
  fi
done
for p in 80 443 $PANEL_PORT 25 465 587 110 143 993 995 4190; do
  o=$(port_owner "$p" || true)
  [ -n "$o" ] && [ "$o" != docker-proxy ] && warn "Port $p encore occupé par « $o » : le service correspondant d'Oblimint ne pourra pas démarrer."
done
PDNS_BIND=""
DNS53=$(ss -Hlnu '( sport = :53 )' 2>/dev/null | awk '{print $4}' | sort -u | tr '\n' ' ')
if [ -n "$DNS53" ]; then
  if echo "$DNS53" | grep -qvE '127\.0\.0\.5[34]'; then
    warn "Le port 53 est utilisé ($DNS53) par autre chose que le résolveur local."
  else
    info "Le résolveur local (systemd-resolved) occupe 127.0.0.53:53 : le DNS d'Oblimint écoutera sur les IP publiques."
  fi
fi

# ── 6. questions ─────────────────────────────────────────────────────────────
DEF_V4=$(ip -4 route get 1.1.1.1 2>/dev/null | grep -oP 'src \K[0-9.]+' || true)
PUB_V4=$(curl -4 -fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)
DEF_V6=$(ip -6 route get 2606:4700:4700::1111 2>/dev/null | grep -oP 'src \K[0-9a-f:]+' || true)
[ -n "$PUB_V4" ] || PUB_V4="$DEF_V4"

cat >"$TTY" <<EOF

${B}Configuration du panel${N}
EOF
ask PANEL_HOST  "Nom d'hôte du panel (FQDN, ex. panel.mondomaine.fr)" "$(hostname -f 2>/dev/null || hostname)"
PARENT_DOMAIN="${PANEL_HOST#*.}"
ask IPV4        "IPv4 publique du serveur" "$PUB_V4"
ask IPV6        "IPv6 publique (vide si aucune)" "$DEF_V6"
ask NS1         "Serveur de noms 1" "ns1.$PARENT_DOMAIN"
ask NS2         "Serveur de noms 2" "ns2.$PARENT_DOMAIN"
ask ACME_EMAIL  "E-mail Let's Encrypt (avis d'expiration)" "admin@$PARENT_DOMAIN"
ask PREVIEW_DOM "Domaine de prévisualisation (distinct du panel, vide = aucun)" ""
cat >"$TTY" <<EOF
  Moteur mail :
    1) Postfix + Dovecot + Rspamd  (standard, identique à CWP, le plus éprouvé)
    2) Stalwart                     (tout-en-un moderne, plus léger)
    3) Aucun                        (mail hébergé ailleurs : le panel gère seulement les DNS)
EOF
ask MAIL_CHOICE "Choix" "1"
case "$MAIL_CHOICE" in 2) MAIL_ENGINE=stalwart ;; 3) MAIL_ENGINE=external ;; *) MAIL_ENGINE=postfix-dovecot ;; esac
ask ADMIN_USER  "Identifiant de l'administrateur" "admin"
ask ADMIN_EMAIL "E-mail de l'administrateur" "$ACME_EMAIL"
ask_secret ADMIN_PASS "Mot de passe administrateur (12 caractères min.)"
[ -n "$ADMIN_PASS" ] || ADMIN_PASS=$(gen_password)
[ ${#ADMIN_PASS} -ge 12 ] || die "Mot de passe trop court (12 caractères minimum)."
ask IMAGE_TAG   "Canal des images (latest = stable, dev = développement)" "latest"
OBL_URL=""; OBL_KEY=""
if confirm "Connecter le SSO Obligate maintenant ?" n; then
  ask OBL_URL "URL d'Obligate" ""
  ask_secret OBL_KEY "Clé d'API Obligate de cette application"
fi
[ -n "$IPV4" ] && PDNS_BIND="$IPV4"
[ -n "$IPV6" ] && PDNS_BIND="${PDNS_BIND:+$PDNS_BIND,}$IPV6"
# Only bind PowerDNS explicitly when the local resolver holds 127.0.0.53.
[ -z "$DNS53" ] && PDNS_BIND=""

# ── 7. firewall ──────────────────────────────────────────────────────────────
TCP_PORTS="80 443 $PANEL_PORT 53 25 465 587 110 143 993 995 4190"
if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q "Status: active"; then
  for p in $TCP_PORTS; do ufw allow "$p/tcp" >/dev/null; done
  ufw allow 53/udp >/dev/null; ufw allow 30000:32767/tcp >/dev/null
  ok "Pare-feu ufw : ports ouverts."
elif command -v firewall-cmd >/dev/null && firewall-cmd --state >/dev/null 2>&1; then
  for p in $TCP_PORTS; do firewall-cmd -q --permanent --add-port="$p/tcp"; done
  firewall-cmd -q --permanent --add-port=53/udp --add-port=30000-32767/tcp
  firewall-cmd -q --reload
  ok "Pare-feu firewalld : ports ouverts."
else
  info "Aucun pare-feu actif détecté (ufw / firewalld) : rien à ouvrir."
fi

# ── 8. panel container ───────────────────────────────────────────────────────
mkdir -p "$CONF_DIR"; chmod 700 "$CONF_DIR"
umask 077
cat >"$CONF_FILE" <<EOF
# Oblimint installation — written by install.sh $(date -u +%FT%TZ)
IMAGE_TAG=$IMAGE_TAG
DATA_DIR=$DATA_DIR
DOCKER_ROOT=$DOCKER_ROOT
PDNS_BIND=$PDNS_BIND
EXTRA_ENV="$EXTRA_ENV"
EOF
info "Téléchargement du panel ($OBLIMINT_IMAGE_REPO:$IMAGE_TAG)…"
docker pull -q "$OBLIMINT_IMAGE_REPO:$IMAGE_TAG" >/dev/null
run_panel
BASE="https://127.0.0.1:$PANEL_PORT"
info "Démarrage du panel…"
for _ in $(seq 1 90); do curl -ksf "$BASE/health" >/dev/null 2>&1 && break; sleep 2; done
curl -ksf "$BASE/health" >/dev/null || die "Le panel ne répond pas (docker logs $PANEL_NAME)."
TOKEN=$(docker logs "$PANEL_NAME" 2>&1 | grep -oE '^\|[[:space:]]+[A-Za-z0-9_-]{30,}[[:space:]]+\|$' | tail -1 | tr -d '| ' || true)
[ -n "$TOKEN" ] || die "Jeton de configuration introuvable dans les logs (le panel est-il déjà configuré ?)."
H=(-H "Content-Type: application/json" -H "X-Setup-Token: $TOKEN")
curl -ksf "${H[@]}" -X POST "$BASE/api/setup/auth" -d "{\"token\":$(json_str "$TOKEN")}" >/dev/null || die "Jeton refusé par le panel."

info "Contrôles de l'hôte par le panel…"
CHECKS=$(curl -ksf "${H[@]}" "$BASE/api/setup/checks")
echo "$CHECKS" | grep -oE '"id":"[a-z_0-9]+","labelKey":"[^"]*","status":"(ok|warn|fail)","detail":"[^"]*"' \
  | sed -E 's/"id":"([^"]+)".*"status":"([^"]+)","detail":"([^"]*)"/    [\2] \1 : \3/' >"$TTY" || true
if echo "$CHECKS" | grep -q '"status":"fail"'; then
  warn "Au moins un contrôle est en échec (voir ci-dessus)."
  confirm "Continuer quand même ?" n || exit 1
fi

OBLIGATE_JSON=null
[ -n "$OBL_URL" ] && OBLIGATE_JSON="{\"url\":$(json_str "$OBL_URL"),\"apiKey\":$(json_str "$OBL_KEY")}"
NS_JSON="[$(json_str "$NS1")$( [ -n "$NS2" ] && printf ',%s' "$(json_str "$NS2")")]"
PAYLOAD=$(cat <<EOF
{"panelHostname":$(json_str "$PANEL_HOST"),"publicIpv4":$(json_str "$IPV4"),"publicIpv6":$(json_str "$IPV6"),
 "nameservers":$NS_JSON,"acmeEmail":$(json_str "$ACME_EMAIL"),"mailEngine":$(json_str "$MAIL_ENGINE"),
 "previewDomain":$(json_str "$PREVIEW_DOM"),
 "admin":{"username":$(json_str "$ADMIN_USER"),"password":$(json_str "$ADMIN_PASS"),"email":$(json_str "$ADMIN_EMAIL")},
 "obligate":$OBLIGATE_JSON}
EOF
)
info "Configuration de la plateforme (base de données, edge, hostd, DNS, mail)…"
curl -ksf "${H[@]}" -X POST "$BASE/api/setup/apply" -d "$PAYLOAD" >/dev/null || die "Le panel a refusé la configuration (vérifiez les valeurs saisies)."
LAST=""
for _ in $(seq 1 600); do
  P=$(curl -ksf "${H[@]}" "$BASE/api/setup/progress" 2>/dev/null || true)
  [ -z "$P" ] && break   # the panel is restarting in normal mode
  CUR=$(echo "$P" | grep -oE '"id":"[a-z_0-9]+","labelKey":"[^"]*","status":"(running|done|error|skipped)"' | sed -E 's/"id":"([^"]+)".*"status":"([^"]+)"/\1:\2/' | tr '\n' ' ')
  [ "$CUR" != "$LAST" ] && { printf '    %s\n' "$CUR" >"$TTY"; LAST="$CUR"; }
  echo "$P" | grep -q '"error":"' && die "Échec de la configuration : $(echo "$P" | grep -oE '"error":"[^"]*"')"
  echo "$P" | grep -q '"done":true' && break
  sleep 2
done
info "Redémarrage du panel en mode normal…"
for _ in $(seq 1 120); do curl -ksf "$BASE/health" 2>/dev/null | grep -q '"mode":"normal"' && break; sleep 2; done
curl -ksf "$BASE/health" 2>/dev/null | grep -q '"mode":"normal"' || die "Le panel n'est pas revenu en mode normal (docker logs $PANEL_NAME)."

CRED=/root/oblimint-credentials.txt
cat >"$CRED" <<EOF
Oblimint — $(date)
Panel        : https://$PANEL_HOST  (en attendant le DNS : https://$IPV4:$PANEL_PORT)
Identifiant  : $ADMIN_USER
Mot de passe : $ADMIN_PASS
Données      : $DATA_DIR
Docker       : $DOCKER_ROOT
Mise à jour  : sudo bash install.sh --upgrade
EOF
chmod 600 "$CRED"

cat >"$TTY" <<EOF

${G}${B}  Oblimint est installé.${N}

  Panel        : ${B}https://$IPV4:$PANEL_PORT${N}  (certificat auto-signé)
                 puis ${B}https://$PANEL_HOST${N} une fois le DNS en place
  Identifiant  : $ADMIN_USER   — mot de passe dans $CRED (lisible par root seulement)

  À faire chez votre registrar / DNS :
    • $PANEL_HOST            A     $IPV4
    • $NS1 / $NS2   A     $IPV4   (enregistrements « glue » si ces NS servent vos domaines)
    • Reverse DNS (PTR) de $IPV4 vers le nom du serveur mail, si le mail est hébergé ici

  Activez la double authentification à la première connexion.

EOF
