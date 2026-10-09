package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os/exec"
	"strings"
	"sync"
	"time"
)

// Signature updates: scand runs freshclam ONE-SHOT itself — every
// 24h / FRESHCLAM_CHECKS and on POST /v1/update — then asks clamd to RELOAD
// when something changed. One runner (mutex): a manual update never races a
// scheduled one on the database directory lock, which a freshclam daemon
// running next to a manual freshclam would.
//
// freshclam exit codes: 0 = updated, 1 = already up to date, other = error.

// Freshclam runs freshclam and reloads clamd.
type Freshclam struct {
	Bin     string
	Config  string
	PreArgs []string
	Reload  func(ctx context.Context) error
	Log     *slog.Logger

	mu      sync.Mutex
	stateMu sync.Mutex
	last    time.Time
	lastErr error
}

var errUpToDate = errors.New("up to date")

func (f *Freshclam) run(ctx context.Context) error {
	args := append(append([]string{}, f.PreArgs...), "--config-file="+f.Config, "--stdout", "--no-warnings")
	cmd := exec.CommandContext(ctx, f.Bin, args...)
	var buf strings.Builder
	sink := &stringSink{b: &buf, max: 8192}
	cmd.Stdout = sink
	cmd.Stderr = sink
	err := cmd.Run()
	if err == nil {
		return nil
	}
	var ee *exec.ExitError
	if errors.As(err, &ee) && ee.ExitCode() == 1 {
		return errUpToDate
	}
	if ctx.Err() != nil {
		return errors.New("freshclam timed out")
	}
	if f.Log != nil {
		f.Log.Warn("freshclam failed", "err", err, "output", truncate(buf.String(), 2000))
	}
	return fmt.Errorf("freshclam failed: %v", err)
}

// UpdateNow runs freshclam then reloads clamd when the databases changed.
func (f *Freshclam) UpdateNow(ctx context.Context) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	err := f.run(ctx)
	switch {
	case errors.Is(err, errUpToDate):
		err = nil
	case err == nil && f.Reload != nil:
		if rerr := f.Reload(ctx); rerr != nil {
			err = fmt.Errorf("clamd reload failed: %w", rerr)
		} else if f.Log != nil {
			f.Log.Info("signatures updated, clamd reloading")
		}
	}
	f.stateMu.Lock()
	f.last, f.lastErr = time.Now(), err
	f.stateMu.Unlock()
	return err
}

// LastUpdate is the time and outcome of the last run (zero time: never).
func (f *Freshclam) LastUpdate() (time.Time, error) {
	f.stateMu.Lock()
	defer f.stateMu.Unlock()
	return f.last, f.lastErr
}

// UpdateInterval is 24 h / checks (checks clamped to 1 … 24).
func UpdateInterval(checks int) time.Duration {
	if checks < 1 {
		checks = 1
	}
	if checks > 24 {
		checks = 24
	}
	return 24 * time.Hour / time.Duration(checks)
}

// Schedule runs UpdateNow after `first`, then every interval, until ctx ends.
func (f *Freshclam) Schedule(ctx context.Context, first, interval time.Duration) {
	t := time.NewTimer(first)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		rctx, cancel := context.WithTimeout(ctx, 15*time.Minute)
		if err := f.UpdateNow(rctx); err != nil && f.Log != nil {
			f.Log.Warn("scheduled signature update failed", "err", err)
		}
		cancel()
		t.Reset(interval)
	}
}

type stringSink struct {
	b   *strings.Builder
	max int
}

func (s *stringSink) Write(p []byte) (int, error) {
	if room := s.max - s.b.Len(); room > 0 {
		if len(p) > room {
			s.b.Write(p[:room])
		} else {
			s.b.Write(p)
		}
	}
	return len(p), nil
}
