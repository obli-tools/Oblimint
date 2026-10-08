package main

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"path"
)

const defaultFSPath = "/srv/oblimint"

// errUnsupported is returned by OS specific helpers outside Linux.
var errUnsupported = errors.New("not supported on this OS")

// FSInfo describes the filesystem holding a path.
type FSInfo struct {
	Path         string   `json:"path"`
	FSType       string   `json:"fsType"`
	MountPoint   string   `json:"mountPoint"`
	Options      []string `json:"options"`
	ProjectQuota bool     `json:"projectQuota"`
}

func newMux() *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/health", handleHealth)
	mux.HandleFunc("GET /v1/fs", handleFS)
	return mux
}

func handleHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "version": version})
}

func handleFS(w http.ResponseWriter, r *http.Request) {
	p := r.URL.Query().Get("path")
	if p == "" {
		p = defaultFSPath
	}
	if !path.IsAbs(p) {
		writeError(w, http.StatusBadRequest, "path must be absolute")
		return
	}
	info, err := fsInfo(path.Clean(p))
	switch {
	case errors.Is(err, errUnsupported):
		writeError(w, http.StatusNotImplemented, err.Error())
	case err != nil:
		slog.Error("fs info", "path", p, "err", err)
		writeError(w, http.StatusInternalServerError, err.Error())
	default:
		writeJSON(w, http.StatusOK, info)
	}
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]any{"ok": false, "error": msg})
}
