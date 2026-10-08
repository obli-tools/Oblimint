// Command hostd is the Oblimint host agent. It exposes a small HTTP API on a
// unix socket that only the panel server talks to.
package main

import (
	"context"
	_ "embed"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"
)

//go:embed VERSION
var embeddedVersion string

// version can be overridden at build time with -ldflags "-X main.version=...".
var version = strings.TrimSpace(embeddedVersion)

const defaultSocket = "/srv/oblimint/run/hostd.sock"

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stderr, nil))
	slog.SetDefault(log)

	socket := os.Getenv("OBLIMINT_HOSTD_SOCKET")
	if socket == "" {
		socket = defaultSocket
	}

	ln, err := listenUnix(socket)
	if err != nil {
		log.Error("listen failed", "socket", socket, "err", err)
		os.Exit(1)
	}

	srv := &http.Server{
		Handler:           newMux(),
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

	log.Info("hostd started", "version", version, "socket", socket)
	if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Error("serve failed", "err", err)
		os.Exit(1)
	}
	_ = os.Remove(socket)
	log.Info("hostd stopped")
}
