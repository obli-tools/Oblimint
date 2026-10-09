// Command hostd is the Oblimint host agent. It exposes a small HTTP API on a
// unix socket that only the panel server talks to (docs/P1-PLAN.md §4, §7).
//
// Environment:
//
//	OBLIMINT_ROOT          hosting root (default /srv/oblimint)
//	OBLIMINT_HOSTD_SOCKET  API socket (default <root>/run/hostd.sock, mode 0660)
//	OBLIMINT_ALLOW_MEASURED_QUOTA  1 = without XFS project quotas, accept disk
//	                       limits that are only measured (default: refused)
package main

import (
	"context"
	_ "embed"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path"
	"strings"
	"syscall"
	"time"
)

//go:embed VERSION
var embeddedVersion string

// version can be overridden at build time with -ldflags "-X main.version=...".
var version = strings.TrimSpace(embeddedVersion)

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stderr, nil))
	slog.SetDefault(log)

	layout := newLayout(os.Getenv("OBLIMINT_ROOT"))
	socket := os.Getenv("OBLIMINT_HOSTD_SOCKET")
	if socket == "" {
		socket = path.Join(layout.RunDir(), "hostd.sock")
	}

	quota, why := detectQuota(layout, fsInfo, exec.LookPath, execRunner, envFlag(os.Getenv(allowMeasuredQuotaEnv)))
	log.Info("quota mode", "mode", quota.Mode(), "reason", why)
	ops := newHostOps(layout, quota, fdOwner)

	ln, err := listenUnix(socket)
	if err != nil {
		log.Error("listen failed", "socket", socket, "err", err)
		os.Exit(1)
	}

	srv := &http.Server{
		Handler:           newMux(ops, layout),
		ReadHeaderTimeout: 5 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdownCtx)
	}()

	log.Info("hostd started", "version", version, "socket", socket, "root", layout.Root)
	if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Error("serve failed", "err", err)
		os.Exit(1)
	}
	_ = os.Remove(socket)
	log.Info("hostd stopped")
}
