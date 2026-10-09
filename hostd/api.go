package main

import (
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
)

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

// maxBodyBytes bounds every JSON body (a data-path list is the largest one)
// except POST .../staging/apply (maxStagingBodyBytes).
const maxBodyBytes = 1 << 20

// api serves the hostd HTTP API (unix socket, panel only).
type api struct {
	ops    Ops
	layout Layout
	// P2 (nil = 501 unsupported: tests of the P1 routes).
	fw *firewallManager
	gw *gateway
	// P3 (nil = 501 unsupported).
	p3 P3Ops
}

func newMux(ops Ops, l Layout, fw *firewallManager, gw *gateway, p3 P3Ops) *http.ServeMux {
	a := &api{ops: ops, layout: l, fw: fw, gw: gw, p3: p3}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/health", a.health)
	mux.HandleFunc("GET /v1/fs", a.fs)
	mux.HandleFunc("GET /v1/du", a.du)
	mux.HandleFunc("PUT /v1/accounts/{id}", a.ensureAccount)
	mux.HandleFunc("PUT /v1/accounts/{id}/quota", a.setQuota)
	mux.HandleFunc("GET /v1/accounts/{id}/usage", a.usage)
	mux.HandleFunc("DELETE /v1/accounts/{id}", a.removeAccount)
	mux.HandleFunc("PUT /v1/accounts/{id}/sites/{siteId}", a.ensureSite)
	mux.HandleFunc("DELETE /v1/accounts/{id}/sites/{siteId}", a.removeSite)
	mux.HandleFunc("PUT /v1/accounts/{id}/sites/{siteId}/data-paths", a.ensureDataPaths)
	mux.HandleFunc("POST /v1/accounts/{id}/sites/{siteId}/data-paths/seed", a.seedDataPath)
	mux.HandleFunc("POST /v1/accounts/{id}/sites/{siteId}/data-paths/clear", a.clearDataPaths)
	// P2 — databases, firewall, port gateway (api_p2.go).
	mux.HandleFunc("PUT /v1/accounts/{id}/db-instances/{iid}", a.ensureDbInstance)
	mux.HandleFunc("DELETE /v1/accounts/{id}/db-instances/{iid}", a.removeDbInstance)
	mux.HandleFunc("PUT /v1/accounts/{id}/db-default/{family}", a.setDefaultDbSocket)
	mux.HandleFunc("GET /v1/firewall", a.firewallStatus)
	mux.HandleFunc("PUT /v1/firewall/global", a.setFirewallGlobal)
	// P4 — bans on the shared mail ports (mail.go).
	mux.HandleFunc("PUT /v1/firewall/mail", a.setMailFirewall)
	mux.HandleFunc("PUT /v1/firewall/accounts/{id}", a.applyFirewall)
	mux.HandleFunc("DELETE /v1/firewall/accounts/{id}", a.removeFirewall)
	mux.HandleFunc("PUT /v1/gateway/accounts/{id}", a.setGateway)
	mux.HandleFunc("DELETE /v1/gateway/accounts/{id}", a.removeGateway)
	mux.HandleFunc("GET /v1/gateway/events", a.gatewayEvents)
	// P3 — windows, staging, workspaces, watch, quarantine, events (api_p3.go).
	registerP3(mux, a)
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		writeError(w, &apiError{http.StatusNotFound, codeNotFound, "no route " + r.Method + " " + r.URL.Path})
	})
	return mux
}

var okBody = map[string]any{"ok": true}

func (a *api) health(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "version": version})
}

func (a *api) fs(w http.ResponseWriter, r *http.Request) {
	p := r.URL.Query().Get("path")
	if p == "" {
		p = a.layout.Root
	}
	// Same contract as /v1/du: absolute, clean, inside the root (R2).
	rel, err := a.layout.RelFromAbs(p)
	if err != nil {
		writeError(w, err)
		return
	}
	info, err := a.ops.FSInfo(rel)
	reply(w, r, info, err)
}

func (a *api) du(w http.ResponseWriter, r *http.Request) {
	p := r.URL.Query().Get("path")
	rel, err := a.layout.RelFromAbs(p)
	if err != nil {
		writeError(w, err)
		return
	}
	n, err := a.ops.Du(r.Context(), rel)
	reply(w, r, map[string]any{"path": p, "bytes": n}, err)
}

// ── Accounts ─────────────────────────────────────────────────────────────────

type ownerBody struct {
	UID *int `json:"uid"`
	GID *int `json:"gid"`
}

func (b ownerBody) owner() (Owner, error) {
	if b.UID == nil || b.GID == nil {
		return Owner{}, badRequest("uid and gid are required")
	}
	o := Owner{*b.UID, *b.GID}
	return o, validateOwner(o)
}

type quotaBody struct {
	// QuotaMB: MiB, null or 0 = no limit.
	QuotaMB *int64 `json:"quotaMb"`
}

func (b quotaBody) limit() (*int64, error) {
	if b.QuotaMB == nil || *b.QuotaMB == 0 {
		return nil, nil
	}
	if *b.QuotaMB < 0 || *b.QuotaMB > 1<<40 {
		return nil, badRequest("quotaMb must be a positive number of MiB or null")
	}
	return b.QuotaMB, nil
}

func (a *api) ensureAccount(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ownerBody
		quotaBody
	}
	accountID, err := pathID(r, "id")
	if err == nil {
		err = decode(r, &body)
	}
	var spec AccountSpec
	if err == nil {
		spec.AccountID = accountID
		spec.Owner, err = body.owner()
	}
	if err == nil {
		spec.QuotaMB, err = body.limit()
	}
	if err != nil {
		writeError(w, err)
		return
	}
	mode, err := a.ops.EnsureAccount(r.Context(), spec)
	reply(w, r, map[string]any{"quotaMode": mode}, err)
}

func (a *api) setQuota(w http.ResponseWriter, r *http.Request) {
	var body quotaBody
	accountID, err := pathID(r, "id")
	if err == nil {
		err = decode(r, &body)
	}
	var limit *int64
	if err == nil {
		limit, err = body.limit()
	}
	if err != nil {
		writeError(w, err)
		return
	}
	mode, err := a.ops.SetQuota(r.Context(), accountID, limit)
	reply(w, r, map[string]any{"quotaMode": mode}, err)
}

func (a *api) usage(w http.ResponseWriter, r *http.Request) {
	accountID, err := pathID(r, "id")
	if err != nil {
		writeError(w, err)
		return
	}
	u, err := a.ops.Usage(r.Context(), accountID)
	reply(w, r, u, err)
}

func (a *api) removeAccount(w http.ResponseWriter, r *http.Request) {
	accountID, err := pathID(r, "id")
	var purge bool
	if err == nil {
		purge, err = queryBool(r, "purge")
	}
	if err != nil {
		writeError(w, err)
		return
	}
	reply(w, r, okBody, a.ops.RemoveAccount(r.Context(), accountID, purge))
}

// ── Sites ────────────────────────────────────────────────────────────────────

type siteBody struct {
	ownerBody
	Slug string `json:"slug"`
}

// siteSpec reads {id}, {siteId} and the body (slug, uid, gid + extra fields).
func siteSpec(r *http.Request, body interface{ site() *siteBody }) (SiteSpec, error) {
	accountID, err := pathID(r, "id")
	if err != nil {
		return SiteSpec{}, err
	}
	siteID, err := pathID(r, "siteId")
	if err != nil {
		return SiteSpec{}, err
	}
	if err := decode(r, body); err != nil {
		return SiteSpec{}, err
	}
	sb := body.site()
	o, err := sb.owner()
	if err != nil {
		return SiteSpec{}, err
	}
	s := SiteSpec{AccountID: accountID, SiteID: siteID, Slug: sb.Slug, Owner: o}
	return s, s.validate()
}

func (b *siteBody) site() *siteBody { return b }

type pathsBody struct {
	siteBody
	Paths []string `json:"paths"`
}

type pathBody struct {
	siteBody
	Path string `json:"path"`
}

func checkPaths(paths []string) error {
	if len(paths) > 1000 {
		return badRequest("too many paths")
	}
	_, err := splitDataPaths(paths)
	return err
}

func (a *api) ensureSite(w http.ResponseWriter, r *http.Request) {
	var body siteBody
	s, err := siteSpec(r, &body)
	if err != nil {
		writeError(w, err)
		return
	}
	reply(w, r, okBody, a.ops.EnsureSite(r.Context(), s))
}

func (a *api) removeSite(w http.ResponseWriter, r *http.Request) {
	accountID, err := pathID(r, "id")
	var siteID int64
	if err == nil {
		siteID, err = pathID(r, "siteId")
	}
	slug := r.URL.Query().Get("slug")
	if err == nil {
		err = validateSlug(slug)
	}
	var purge bool
	if err == nil {
		purge, err = queryBool(r, "purge")
	}
	if err != nil {
		writeError(w, err)
		return
	}
	reply(w, r, okBody, a.ops.RemoveSite(r.Context(), accountID, siteID, slug, purge))
}

func (a *api) ensureDataPaths(w http.ResponseWriter, r *http.Request) {
	var body pathsBody
	s, err := siteSpec(r, &body)
	if err == nil {
		err = checkPaths(body.Paths)
	}
	if err != nil {
		writeError(w, err)
		return
	}
	reply(w, r, okBody, a.ops.EnsureDataPaths(r.Context(), s, body.Paths))
}

func (a *api) seedDataPath(w http.ResponseWriter, r *http.Request) {
	var body pathBody
	s, err := siteSpec(r, &body)
	if err == nil {
		_, err = splitDataPath(body.Path)
	}
	if err != nil {
		writeError(w, err)
		return
	}
	res, err := a.ops.SeedDataPath(r.Context(), s, body.Path)
	reply(w, r, res, err)
}

func (a *api) clearDataPaths(w http.ResponseWriter, r *http.Request) {
	var body pathsBody
	s, err := siteSpec(r, &body)
	if err == nil {
		err = checkPaths(body.Paths)
	}
	if err != nil {
		writeError(w, err)
		return
	}
	reply(w, r, okBody, a.ops.ClearDataPaths(r.Context(), s, body.Paths))
}

// ── Helpers ──────────────────────────────────────────────────────────────────

func pathID(r *http.Request, name string) (int64, error) { return parseID(r.PathValue(name)) }

// queryBool accepts 1/0/true/false (absent = false).
func queryBool(r *http.Request, name string) (bool, error) {
	switch r.URL.Query().Get(name) {
	case "", "0", "false":
		return false, nil
	case "1", "true":
		return true, nil
	default:
		return false, badRequest("%s must be 0 or 1", name)
	}
}

func decode(r *http.Request, v any) error {
	dec := json.NewDecoder(io.LimitReader(r.Body, maxBodyBytes))
	if err := dec.Decode(v); err != nil {
		return badRequest("invalid JSON body: %v", err)
	}
	return nil
}

// reply writes v, or the error with its status / code.
func reply(w http.ResponseWriter, r *http.Request, v any, err error) {
	if err != nil {
		if status, code := classify(err); status >= http.StatusInternalServerError && code != codeCancelled {
			slog.Error("request failed", "method", r.Method, "path", r.URL.Path, "err", err)
		} else {
			slog.Warn("request refused", "method", r.Method, "path", r.URL.Path, "err", err)
		}
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, v)
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, err error) {
	status, code := classify(err)
	writeJSON(w, status, map[string]any{"ok": false, "error": err.Error(), "code": code})
}
