# syntax=docker/dockerfile:1
# ─────────────────────────────────────────────────────────────────────────────
# meejay/oblimint-filesrv — per-account SFTP server (SFTPGo), see README.md.
#
# Build context: the images/ directory (see images/build.sh):
#   docker build -f filesrv/Dockerfile -t meejay/oblimint-filesrv:latest .
#
# Runtime (module orchestration — fileServerContainerSpec): User=<uid>:<gid>
# of the account, CapDrop ALL, no-new-privileges, ReadonlyRootfs + tmpfs
# /tmp; mounts /srv/files/staging (rw), /srv/files/data (rw),
# /var/lib/sftpgo (rw, host keys); host port → 2022/tcp; env
# OBLIMINT_HOOK_BASE, OBLIMINT_ACCOUNT_ID.
# ─────────────────────────────────────────────────────────────────────────────

# SFTPGo 2.6.x on Alpine, pinned (tag + manifest digest checked on Docker Hub).
ARG SFTPGO_IMAGE=drakkan/sftpgo:v2.6.6-alpine@sha256:1dfde466cd2298c67050ea74798fd8e026f1667e657e0b8b2c68a7753ebe302a

FROM ${SFTPGO_IMAGE}
ARG VERSION=dev

LABEL org.opencontainers.image.title="oblimint-filesrv" \
      org.opencontainers.image.description="Oblimint per-account SFTP server (SFTPGo, external auth via the panel)" \
      org.opencontainers.image.source="https://github.com/obli-tools/Oblimint" \
      org.opencontainers.image.version="${VERSION}"

USER root
COPY filesrv/oblimint-filesrv /usr/local/bin/oblimint-filesrv
RUN set -eux; \
    chmod 0755 /usr/local/bin/oblimint-filesrv; \
    mkdir -p /srv/files/staging /srv/files/data /var/lib/sftpgo; \
    chmod 0755 /srv/files

# Default non-root identity; the panel always sets the account uid:gid.
USER 1000:1000
WORKDIR /srv/files
EXPOSE 2022
ENTRYPOINT ["/usr/local/bin/oblimint-filesrv"]
CMD []
