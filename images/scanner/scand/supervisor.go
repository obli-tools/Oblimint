package main

import (
	"context"
	"log/slog"
	"os"
	"os/exec"
	"syscall"
	"time"
)

// Supervise keeps clamd running: it is started as a child of scand (itself
// under tini), its output goes to the container log, and it is restarted with
// a capped backoff when it exits. scand keeps serving meanwhile (ClamAV status
// 'error' / not available) — the panel then marks analyses scannerUnavailable.
func Supervise(ctx context.Context, log *slog.Logger, name string, argv []string) {
	backoff := 5 * time.Second
	for {
		started := time.Now()
		cmd := exec.Command(argv[0], argv[1:]...)
		cmd.Stdout = os.Stderr
		cmd.Stderr = os.Stderr
		if err := cmd.Start(); err != nil {
			log.Error("cannot start "+name, "err", err)
		} else {
			log.Info(name+" started", "pid", cmd.Process.Pid)
			done := make(chan error, 1)
			go func() { done <- cmd.Wait() }()
			select {
			case err := <-done:
				log.Warn(name+" exited", "err", err)
			case <-ctx.Done():
				_ = cmd.Process.Signal(syscall.SIGTERM)
				select {
				case <-done:
				case <-time.After(10 * time.Second):
					_ = cmd.Process.Kill()
					<-done
				}
				return
			}
		}
		if time.Since(started) > 5*time.Minute {
			backoff = 5 * time.Second
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
		if backoff < time.Minute {
			backoff *= 2
		}
	}
}
