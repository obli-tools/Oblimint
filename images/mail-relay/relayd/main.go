// Command relayd is the policy service and content filter of the Oblimint
// site relay (images/mail-relay, docs/P4-PLAN.md §9.5): Postfix asks it, for
// every relayed message, whether the authenticated site may send it (allowed
// envelope sender, account not suspended, hourly limits) and hands it the
// accepted messages to fix their From header. Standard library only.
//
//	relayd -config /etc/oblimint/relay/policy.json \
//	       -policy 127.0.0.1:10031 -filter 127.0.0.1:10027 -reinject 127.0.0.1:10026
//
// Logs: decisions as JSON lines on stdout (followed by the panel), its own
// diagnostics as JSON on stderr.
package main

import (
	"flag"
	"log/slog"
	"net"
	"os"
	"os/signal"
	"syscall"
	"time"
)

var version = "dev"

func main() {
	cfgPath := flag.String("config", "/etc/oblimint/relay/policy.json", "policy file written by the panel")
	policyAddr := flag.String("policy", "127.0.0.1:10031", "policy service listen address")
	filterAddr := flag.String("filter", "127.0.0.1:10027", "content filter listen address")
	reinjectAddr := flag.String("reinject", "127.0.0.1:10026", "Postfix reinjection address")
	flag.Parse()

	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stderr, nil)))
	holder := newConfigHolder(*cfgPath)
	if err := holder.Refresh(); err != nil {
		// Keeps running with an empty policy (nothing relayed) until the panel writes a valid file.
		slog.Error("policy file refused", "err", err)
	}
	stop := make(chan struct{})
	go holder.Watch(stop, 2*time.Second)

	emit := jsonEmitter(os.Stdout)
	pol := NewPolicy(holder.Get, emit)
	fil := NewFilter(holder.Get, *reinjectAddr, emit)

	pln, err := net.Listen("tcp", *policyAddr)
	if err != nil {
		slog.Error("policy listen failed", "addr", *policyAddr, "err", err)
		os.Exit(1)
	}
	fln, err := net.Listen("tcp", *filterAddr)
	if err != nil {
		slog.Error("filter listen failed", "addr", *filterAddr, "err", err)
		os.Exit(1)
	}
	errs := make(chan error, 2)
	go func() { errs <- pol.Serve(pln) }()
	go func() { errs <- fil.Serve(fln) }()
	slog.Info("relayd started", "version", version, "policy", *policyAddr, "filter", *filterAddr)

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGTERM, os.Interrupt)
	select {
	case <-sig:
	case err := <-errs:
		slog.Error("listener stopped", "err", err)
		close(stop)
		os.Exit(1)
	}
	close(stop)
	_ = pln.Close()
	_ = fln.Close()
	slog.Info("relayd stopped")
}
