// Command scand is the HTTP front of the Oblimint shared change scanner
// (container oblimint-scanner, docs/P3-PLAN.md §9.1). It runs under tini as
// the unprivileged `scand` user, supervises clamd (when SCAND_CLAMAV=1),
// schedules the freshclam runs and answers the panel on :8080 (panel network
// only, shared key).
//
// Environment (set by the panel, server/src/services/scan/scannerSpec.ts):
//
//	SCAND_KEY          shared key (required; X-Oblimint-Scanner-Key)
//	SCAND_CLAMAV       1 = run clamd + freshclam (default 1)
//	SCAND_YARA         1 = YARA on the compiled rules (default 1)
//	FRESHCLAM_CHECKS   signature updates per day, 1 … 24 (default 12)
//	SCAND_MAX_FILE_MB  largest accepted file (default 32)
//	SCAND_CONCURRENCY  files scanned at once (default 4)
//
// `scand -healthcheck` probes GET /healthz (Docker HEALTHCHECK).
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"
)

// version is set at build time (-ldflags "-X main.version=...").
var version = "dev"

func main() {
	health := flag.Bool("healthcheck", false, "probe the local /healthz and exit")
	flag.Parse()
	if *health {
		os.Exit(healthcheck())
	}

	log := slog.New(slog.NewJSONHandler(os.Stderr, nil))
	slog.SetDefault(log)
	cfg, err := LoadConfig(os.Getenv)
	if err != nil {
		log.Error("configuration", "err", err)
		os.Exit(2)
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()

	network, address, _ := ParseClamdAddr(cfg.ClamdAddr)
	clam := &Clamd{Network: network, Address: address, Timeout: 120 * time.Second}
	yara := &Yara{Bin: cfg.YaraBin, Rules: cfg.YaraRules, Timeout: 30 * time.Second}
	srv := &Server{
		Key:          cfg.Key,
		ClamAV:       cfg.ClamAV,
		Yara:         cfg.Yara,
		Clam:         clam,
		YaraEng:      yara,
		MaxFileBytes: cfg.MaxFileBytes(),
		TmpDir:       cfg.TmpDir,
		Version:      version,
		Log:          log,
	}
	if cfg.Yara {
		srv.YaraVersion = yara.Version(ctx)
		srv.Rules, srv.RulesErr = ReadRulesInfo(cfg.RulesInfo)
		if _, err := os.Stat(cfg.YaraRules); err != nil {
			srv.RulesErr = err
		}
		if srv.RulesErr != nil || srv.YaraVersion == "" {
			log.Error("YARA unavailable", "rulesErr", srv.RulesErr, "yaraVersion", srv.YaraVersion)
		}
	}

	if cfg.ClamAV {
		clamdConf, freshConf, err := cfg.WriteConfigs()
		if err != nil {
			log.Error("cannot render the ClamAV configuration", "err", err)
			os.Exit(1)
		}
		if n, err := SeedDatabase(cfg.DatabaseDir, cfg.SeedDir); err != nil {
			log.Warn("cannot seed the signature directory (freshclam will download)", "err", err)
		} else if n > 0 {
			log.Info("signature directory seeded from the image", "files", n)
		}
		fresh := &Freshclam{Bin: cfg.FreshclamBin, Config: freshConf, Reload: clam.Reload, Log: log}
		srv.Updater = fresh
		// First update a few minutes after start (the seed may be days old) — at once when there is no
		// database at all (clamd then restarts through the supervisor's backoff) — then every 24 h / checks.
		first := 3 * time.Minute
		if !hasDatabase(cfg.DatabaseDir) {
			log.Warn("no signature database yet: downloading now")
			first = 0
		}
		go Supervise(ctx, log, "clamd", []string{cfg.ClamdBin, "--foreground", "--config-file=" + clamdConf})
		go fresh.Schedule(ctx, first, UpdateInterval(cfg.FreshclamChecks))
	}

	httpSrv := &http.Server{
		Addr:              cfg.Addr,
		Handler:           srv.Handler(cfg.Concurrency),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       5 * time.Minute,
		WriteTimeout:      12 * time.Minute,
		IdleTimeout:       90 * time.Second,
		MaxHeaderBytes:    16 << 10,
	}
	go func() {
		<-ctx.Done()
		sctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = httpSrv.Shutdown(sctx)
	}()
	log.Info("scand listening", "addr", cfg.Addr, "clamav", cfg.ClamAV, "yara", cfg.Yara, "version", version)
	if err := httpSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Error("listen", "err", err)
		os.Exit(1)
	}
}

func healthcheck() int {
	addr := os.Getenv("SCAND_ADDR")
	if addr == "" {
		addr = ":8080"
	}
	if strings.HasPrefix(addr, ":") {
		addr = "127.0.0.1" + addr
	}
	c := http.Client{Timeout: 3 * time.Second}
	res, err := c.Get(fmt.Sprintf("http://%s/healthz", addr))
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return 1
	}
	return 0
}
