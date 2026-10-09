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
# hostd needs root on the host (ownership, quotas, later mounts / firewall):
# no nonroot user. Deployed by the orchestration module privileged, with
# pid/network host and /srv/oblimint bind-mounted with rshared propagation.
FROM alpine:3.22
RUN apk add --no-cache xfsprogs-extra
COPY --from=build /out/hostd /usr/local/bin/hostd
ENV OBLIMINT_ROOT=/srv/oblimint \
    OBLIMINT_HOSTD_SOCKET=/srv/oblimint/run/hostd.sock
ENTRYPOINT ["/usr/local/bin/hostd"]
