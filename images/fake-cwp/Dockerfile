# syntax=docker/dockerfile:1
# ─────────────────────────────────────────────────────────────────────────────
# oblimint-fake-cwp:test — TEST ONLY. A synthetic CentOS Web Panel 1.18 server
# (Rocky Linux 8, MariaDB 10.3, BIND 9.11, Postfix / Dovecot / OpenDKIM /
# Pure-FTPd files, nginx + Apache + Varnish vhosts, Maildir++, crons,
# certificates) reproducing the layout of the production source mapped in
# docs/cwp/CWP-MAP.md, to validate the P5 migration end to end on the Linux test host
# BEFORE touching the real server (docs/P5-PLAN.md §16).
#
# NEVER built by images/build.sh, never pulled / managed by the panel, never
# shipped. Known test passwords inside (README.md).
#
# Build context: images/fake-cwp (scripts/build.sh):
#   docker build -t oblimint-fake-cwp:test images/fake-cwp
#
# Base: pin the tag / digest on the build host (the Linux test host):
#   docker buildx imagetools inspect rockylinux/rockylinux:8.10
# ─────────────────────────────────────────────────────────────────────────────

ARG ROCKY_IMAGE=rockylinux/rockylinux:8.10

FROM ${ROCKY_IMAGE}

LABEL org.opencontainers.image.title="oblimint-fake-cwp" \
      org.opencontainers.image.description="TEST ONLY: synthetic CentOS Web Panel 1.18 source server for the Oblimint P5 migration scenario (never shipped)" \
      org.opencontainers.image.source="https://github.com/obli-tools/Oblimint" \
      oblimint.test-only="true"

# - mariadb:10.3 = the stream of the source (CWP-MAP §1); nodejs:18 = the source's Node (and the generator);
# - EPEL (+ PowerTools for its dependencies): opendkim, pure-ftpd;
# - nginx is installed for its layout only (never started); Apache (cwp-httpd), Varnish, PHP are files / stubs;
# - discovery (P6) reads the versions of rsync, mysqldump, mysql, named-checkzone, postconf, doveconf / dovecot
#   (`command -v` + version flag, template sys.toolVersions): never rpm, so /var/lib/rpm is compared by MG1 too;
# - postfix-mysql is optional (only `postconf -n` must answer).
RUN set -eux; \
    dnf -y install dnf-plugins-core epel-release; \
    dnf config-manager --set-enabled powertools; \
    dnf -y module enable mariadb:10.3 nodejs:18; \
    dnf -y install --setopt=install_weak_deps=False \
        openssh-server openssh-clients \
        mariadb-server mariadb \
        bind bind-utils \
        rsync \
        postfix dovecot dovecot-mysql dovecot-pigeonhole \
        opendkim pure-ftpd \
        cronie openssl procps-ng iproute sudo hostname findutils diffutils gzip tar which \
        httpd-tools nginx nodejs; \
    dnf -y install --setopt=install_weak_deps=False --setopt=strict=0 postfix-mysql || true; \
    dnf clean all; \
    rm -rf /var/cache/dnf

COPY dataset/ /opt/fake-cwp/dataset/
COPY build/ /opt/fake-cwp/build/
COPY rootfs/ /opt/fake-cwp/rootfs/
COPY seed/ /opt/fake-cwp/seed/
COPY bin/fake-cwp-entrypoint /usr/local/sbin/fake-cwp-entrypoint

# Users, files, keys, hashes, certificates, MariaDB data, BIND checks (build/seed.sh).
RUN set -eux; \
    sed -i 's/\r$//' /usr/local/sbin/fake-cwp-entrypoint /opt/fake-cwp/build/seed.sh; \
    chmod 0755 /usr/local/sbin/fake-cwp-entrypoint /opt/fake-cwp/build/seed.sh; \
    sh /opt/fake-cwp/build/seed.sh

EXPOSE 22
STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/local/sbin/fake-cwp-entrypoint"]
