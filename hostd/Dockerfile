# Build context: the hostd/ directory (docker build -t meejay/oblimint-hostd hostd)
FROM golang:1.26-alpine AS build
WORKDIR /src
COPY go.mod ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags "-s -w" -o /out/hostd .

# Runtime: Alpine instead of distroless because the XFS project quotas are
# driven through xfs_quota, shipped by `xfsprogs-extra` on Alpine
# (/usr/sbin/xfs_quota, checked on pkgs.alpinelinux.org, branch v3.22).
# P2: the per-account firewall is driven through the `nft` binary (package
# nftables): one table `inet oblimint`, applied atomically with `nft -f -`.
# It needs the host network namespace (network host) and CAP_NET_ADMIN
# (privileged), and the port gateway listens on the host ports itself.
# hostd needs root on the host (ownership, quotas, mounts, firewall):
# no nonroot user. Deployed by the orchestration module privileged, with
# pid/network host and /srv/oblimint bind-mounted with rshared propagation.
# P3: window overlays are mounted by hostd over releases/<n> (propagated to
# the host and, rslave, into the site containers), /proc/<pid>/mountinfo of
# container processes is read for the propagation check (pid host), and the
# typed-path watcher uses inotify (fs.inotify.max_user_watches raised through
# /proc/sys, writable because privileged). Standard library only: no package.
FROM alpine:3.22
RUN apk add --no-cache xfsprogs-extra nftables
COPY --from=build /out/hostd /usr/local/bin/hostd
ENV OBLIMINT_ROOT=/srv/oblimint \
    OBLIMINT_HOSTD_SOCKET=/srv/oblimint/run/hostd.sock
ENTRYPOINT ["/usr/local/bin/hostd"]
