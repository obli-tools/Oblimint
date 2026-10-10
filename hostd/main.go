// Command hostd is the Oblimint host agent. It exposes a small HTTP API on a
// unix socket that only the panel server talks to (docs/P1-PLAN.md §4, §7).
//
// Environment:
//
//	OBLIMINT_ROOT          hosting root (default /srv/oblimint)
//	OBLIMINT_HOSTD_SOCKET  API socket (default <root>/run/hostd.sock, mode 0660)
//	OBLIMINT_ALLOW_MEASURED_QUOTA  1 = without XFS project quotas, accept disk
//	                       limits that are only measured (default: refused)
//
// P2: the firewall (nftables table inet oblimint, driven through the nft
// binary) and the port gateway state are persisted in <root>/run/hostd-state.json
// and re-applied at start, before the panel pushes them again.
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
	// P3: window overlays, workspaces, typed-path / supervised watchers,
	// quarantine store and events.
	windows := newWindowManager(layout, defaultMounter(), defaultOverlayAttrs(), fdOwner, rootLchown, time.Now)
	ops.releaser = windows

	// P2: firewall + port gateway, restored from the state file.
	statePath := path.Join(layout.RunDir(), "hostd-state.json")
	fw := newFirewallManager(newExecNft(), realClock{}, statePath)
	gw := newGateway(realClock{}, fw.Allows)
	fw.gatewaySnapshot = gw.Specs
	gw.onChange = fw.GatewayChanged
	restoreState(fw, gw, statePath)
	defer gw.Close()

	// P4b: segment policy of the account fabrics + platform web bans (api_p4b.go),
	// each with its own state file, re-applied at start before the panel pushes again.
	nft := newExecNft()
	p4bManagers.segments = newSegmentManager(nft, path.Join(layout.RunDir(), "hostd-segments.json"))
	p4bManagers.webBans = newWebBanManager(nft, path.Join(layout.RunDir(), "hostd-webbans.json"))
	if err := p4bManagers.segments.Restore(context.Background()); err != nil {
		log.Warn("segment policy not applied at start", "err", err)
	}
	if err := p4bManagers.webBans.Restore(context.Background()); err != nil {
		log.Warn("web bans not applied at start", "err", err)
	}

	ln, err := listenUnix(socket)
	if err != nil {
		log.Error("listen failed", "socket", socket, "err", err)
		os.Exit(1)
	}

	srv := &http.Server{
		Handler:           newMux(ops, layout, fw, gw, windows),
		ReadHeaderTimeout: 5 * time.Second,
		// No WriteTimeout: GET /v1/gateway/events and /v1/events are long polls
		// (≤ 55 s); window operations may take minutes.
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	windows.start(ctx)
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

// restoreState re-applies the persisted firewall state and reopens the
// gateway listeners. Failures are logged: the panel pushes everything again.
func restoreState(fw *firewallManager, gw *gateway, statePath string) {
	st, err := loadState(statePath)
	if err != nil {
		slog.Warn("hostd state not loaded (waiting for the panel)", "path", statePath, "err", err)
	}
	if err := fw.Restore(context.Background(), st); err != nil {
		slog.Warn("firewall not applied at start", "err", err)
	}
	for key, spec := range st.Gateways {
		id, err := parseID(key)
		if err != nil {
			continue
		}
		spec.AccountID = id
		if err := gw.Set(spec); err != nil {
			slog.Warn("gateway not restored", "accountId", id, "err", err)
		}
	}
}
