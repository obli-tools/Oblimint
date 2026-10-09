package main

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"os"
	"strconv"
	"time"
)

// HTTP API of scand (docs/P3-PLAN.md §9.1). Every /v1 route requires the
// shared key (X-Oblimint-Scanner-Key, constant-time comparison). The name
// query parameter is informational only (logs), never a path scand opens.
//
//	POST /v1/scan?name=<path>  body = file bytes (≤ SCAND_MAX_FILE_MB)
//	  → {"clamav":{"status":"ok|found|error|disabled","signature"?},
//	     "yara":{"matches":[{rule,tags,meta}],"error"?,"disabled"?}}
//	GET  /v1/status            → versions, signatures date, rule count
//	POST /v1/update            → freshclam now, then clamd RELOAD
//	GET  /healthz              → "ok" (no key: Docker HEALTHCHECK, no information)

const keyHeader = "X-Oblimint-Scanner-Key"

// ClamEngine is what the server needs from clamd (fake in tests).
type ClamEngine interface {
	Instream(ctx context.Context, r io.Reader) (ClamResult, error)
	Version(ctx context.Context) (string, error)
}

// YaraEngine is what the server needs from yara (fake in tests).
type YaraEngine interface {
	Scan(ctx context.Context, file string) ([]YaraMatch, error)
}

// Updater refreshes the signatures.
type Updater interface {
	UpdateNow(ctx context.Context) error
	LastUpdate() (time.Time, error)
}

// Server holds the engines and limits.
type Server struct {
	Key          string
	ClamAV       bool
	Yara         bool
	Clam         ClamEngine
	YaraEng      YaraEngine
	Updater      Updater
	MaxFileBytes int64
	TmpDir       string
	YaraVersion  string
	Rules        RulesInfo
	RulesErr     error
	Version      string
	Log          *slog.Logger
	sem          chan struct{}
}

// Handler builds the HTTP handler.
func (s *Server) Handler(concurrency int) http.Handler {
	if concurrency < 1 {
		concurrency = 1
	}
	s.sem = make(chan struct{}, concurrency)
	if s.Log == nil {
		s.Log = slog.Default()
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		_, _ = io.WriteString(w, "ok")
	})
	mux.Handle("POST /v1/scan", s.auth(http.HandlerFunc(s.scan)))
	mux.Handle("GET /v1/status", s.auth(http.HandlerFunc(s.status)))
	mux.Handle("POST /v1/update", s.auth(http.HandlerFunc(s.update)))
	return mux
}

// keysEqual compares hashes in constant time (no length leak, no early return).
func keysEqual(presented, expected string) bool {
	if presented == "" || expected == "" {
		return false
	}
	a := sha256.Sum256([]byte(presented))
	b := sha256.Sum256([]byte(expected))
	return subtle.ConstantTimeCompare(a[:], b[:]) == 1
}

func (s *Server) auth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !keysEqual(r.Header.Get(keyHeader), s.Key) {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
			return
		}
		next.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

type clamOut struct {
	Status    string `json:"status"`
	Signature string `json:"signature,omitempty"`
}

type yaraOut struct {
	Matches  []YaraMatch `json:"matches"`
	Error    string      `json:"error,omitempty"`
	Disabled bool        `json:"disabled,omitempty"`
}

type scanOut struct {
	ClamAV clamOut `json:"clamav"`
	Yara   yaraOut `json:"yara"`
}

func (s *Server) scan(w http.ResponseWriter, r *http.Request) {
	name := truncate(r.URL.Query().Get("name"), 255)
	if r.ContentLength > s.MaxFileBytes {
		writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{"error": "too large"})
		return
	}
	select {
	case s.sem <- struct{}{}:
		defer func() { <-s.sem }()
	case <-r.Context().Done():
		return
	}
	tmp, err := os.CreateTemp(s.TmpDir, "scan-*")
	if err != nil {
		s.Log.Error("temp file", "err", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "temp file"})
		return
	}
	defer func() {
		_ = tmp.Close()
		_ = os.Remove(tmp.Name())
	}()
	n, err := io.Copy(tmp, http.MaxBytesReader(w, r.Body, s.MaxFileBytes))
	if err != nil {
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{"error": "too large"})
			return
		}
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "body"})
		return
	}
	out := scanOut{ClamAV: clamOut{Status: "disabled"}, Yara: yaraOut{Matches: []YaraMatch{}, Disabled: !s.Yara}}
	if s.ClamAV {
		if _, err := tmp.Seek(0, io.SeekStart); err != nil {
			out.ClamAV = clamOut{Status: "error"}
		} else if res, err := s.Clam.Instream(r.Context(), tmp); err != nil {
			s.Log.Warn("clamd scan failed", "name", strconv.Quote(name), "err", err)
			out.ClamAV = clamOut{Status: "error"}
		} else if res.Found {
			out.ClamAV = clamOut{Status: "found", Signature: res.Signature}
		} else {
			out.ClamAV = clamOut{Status: "ok"}
		}
	}
	if s.Yara {
		if s.RulesErr != nil {
			out.Yara.Error = "rules unavailable"
		} else if matches, err := s.YaraEng.Scan(r.Context(), tmp.Name()); err != nil {
			s.Log.Warn("yara scan failed", "name", strconv.Quote(name), "err", err)
			out.Yara.Error = "yara failed"
		} else if matches != nil {
			out.Yara.Matches = matches
		}
	}
	if out.ClamAV.Status == "found" || len(out.Yara.Matches) > 0 {
		rules := make([]string, 0, len(out.Yara.Matches))
		for _, m := range out.Yara.Matches {
			rules = append(rules, m.Rule)
		}
		s.Log.Info("detection", "name", strconv.Quote(name), "bytes", n, "clamav", out.ClamAV.Signature, "yara", rules)
	}
	writeJSON(w, http.StatusOK, out)
}

type engineStatus struct {
	Enabled            bool    `json:"enabled"`
	Available          bool    `json:"available"`
	Version            *string `json:"version"`
	SignatureVersion   *string `json:"signatureVersion"`
	SignaturesUpdated  *string `json:"signaturesUpdatedAt"`
	RuleCount          *int    `json:"ruleCount"`
	Error              *string `json:"error"`
	LastUpdateAttempt  *string `json:"lastUpdateAt,omitempty"`
	LastUpdateFailedAt *string `json:"lastUpdateFailedAt,omitempty"`
}

func strp(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// StatusBody is GET /v1/status.
type StatusBody struct {
	Version string       `json:"version"`
	ClamAV  engineStatus `json:"clamav"`
	Yara    engineStatus `json:"yara"`
}

func (s *Server) statusBody(ctx context.Context) StatusBody {
	body := StatusBody{Version: s.Version, ClamAV: engineStatus{Enabled: s.ClamAV}, Yara: engineStatus{Enabled: s.Yara}}
	if s.ClamAV {
		cctx, cancel := context.WithTimeout(ctx, 3*time.Second)
		raw, err := s.Clam.Version(cctx)
		cancel()
		if err != nil {
			body.ClamAV.Error = strp("clamd not answering (starting or loading signatures)")
		} else if v, perr := ParseVersion(raw); perr != nil {
			body.ClamAV.Error = strp("unexpected clamd version reply")
		} else {
			body.ClamAV.Available = true
			body.ClamAV.Version = strp(v.Engine)
			body.ClamAV.SignatureVersion = strp(v.Daily)
			if !v.SignaturesDate.IsZero() {
				body.ClamAV.SignaturesUpdated = strp(v.SignaturesDate.Format(time.RFC3339))
			}
		}
		if s.Updater != nil {
			if at, err := s.Updater.LastUpdate(); !at.IsZero() {
				if err != nil {
					body.ClamAV.LastUpdateFailedAt = strp(at.UTC().Format(time.RFC3339))
				} else {
					body.ClamAV.LastUpdateAttempt = strp(at.UTC().Format(time.RFC3339))
				}
			}
		}
	}
	if s.Yara {
		body.Yara.Version = strp(s.YaraVersion)
		switch {
		case s.RulesErr != nil:
			body.Yara.Error = strp("compiled rules unavailable")
		case s.YaraVersion == "":
			body.Yara.Error = strp("yara binary unavailable")
		default:
			body.Yara.Available = true
			count := s.Rules.Count
			body.Yara.RuleCount = &count
			body.Yara.SignatureVersion = strp(s.Rules.Version)
		}
	}
	return body
}

func (s *Server) status(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.statusBody(r.Context()))
}

func (s *Server) update(w http.ResponseWriter, r *http.Request) {
	if !s.ClamAV || s.Updater == nil {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "skipped": true})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 9*time.Minute)
	defer cancel()
	if err := s.Updater.UpdateNow(ctx); err != nil {
		s.Log.Warn("signature update failed", "err", err)
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "signature update failed"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}
