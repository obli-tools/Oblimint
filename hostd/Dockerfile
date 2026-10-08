# Build context: the hostd/ directory (docker build -t meejay/oblimint-hostd hostd)
FROM golang:1.26-alpine AS build
WORKDIR /src
COPY go.mod ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags "-s -w" -o /out/hostd .

# hostd needs root on the host (mounts, quotas, firewall): no nonroot user here.
FROM gcr.io/distroless/static-debian12
COPY --from=build /out/hostd /usr/local/bin/hostd
ENV OBLIMINT_HOSTD_SOCKET=/srv/oblimint/run/hostd.sock
ENTRYPOINT ["/usr/local/bin/hostd"]
