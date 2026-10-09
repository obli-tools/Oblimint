package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"time"
)

// P3 handlers: window overlays, staging reflection, workspaces, typed-path
// watch, quarantine, events (docs/P3-PLAN.md §8; contract:
// server/src/services/hostd/client.ts).

// P3Ops is every P3 host operation (windowManager; tests inject a fake).
type P3Ops interface {
	EnsureWindow(ctx context.Context, spec WindowSpec) (WindowStatus, error)
	WindowStatus(ctx context.Context, accountID, siteID, windowID int64) (WindowStatus, error)
	ExportWindow(ctx context.Context, ref WindowRef, opts ExportOptions) (ExportResult, error)
	RemoveWindow(ctx context.Context, ref WindowRef, keepExport bool) error
	VerifyWindow(ctx context.Context, accountID, siteID, windowID int64, pids []int) ([]PropagationResult, error)
	ListWindows(ctx context.Context) ([]MountedWindow, error)
	ApplyToStaging(ctx context.Context, s SiteSpec, src StagingSource, changes []StagingChange) (StagingApplyResult, error)
	EnsureWorkspace(ctx context.Context, ws WorkspaceSpec) (WorkspaceResult, error)
	RemoveWorkspace(ctx context.Context, accountID, siteID int64, slug string, workspaceID int64) error
	SetWatch(ctx context.Context, ws WatchSpec) (WatchResult, error)
	RemoveWatch(ctx context.Context, accountID, siteID int64) error
	ListQuarantine(ctx context.Context, accountID int64) ([]QuarantineEntry, error)
	RestoreQuarantine(ctx context.Context, accountID int64, entryID string, o Owner, overwrite bool) (RestoreResult, error)
	DeleteQuarantine(ctx context.Context, accountID int64, entryID string) error
	QuarantinePreview(ctx context.Context, accountID int64, entryID string, max int) (Preview, error)
	Events(ctx context.Context, since int64, wait time.Duration) ([]Event, int64)
}

const maxVerifyPids = 256

func registerP3(mux *http.ServeMux, a *api) {
	const win = "/v1/accounts/{id}/sites/{siteId}/windows/{wid}"
	mux.HandleFunc("PUT "+win, a.ensureWindow)
	mux.HandleFunc("GET "+win, a.windowStatus)
	mux.HandleFunc("DELETE "+win, a.removeWindow)
	mux.HandleFunc("POST "+win+"/export", a.exportWindow)
	mux.HandleFunc("POST "+win+"/verify", a.verifyWindow)
	mux.HandleFunc("GET /v1/windows", a.listWindows)
	mux.HandleFunc("POST /v1/accounts/{id}/sites/{siteId}/staging/apply", a.applyToStaging)
	mux.HandleFunc("PUT /v1/accounts/{id}/sites/{siteId}/workspaces/{wsid}", a.ensureWorkspace)
	mux.HandleFunc("DELETE /v1/accounts/{id}/sites/{siteId}/workspaces/{wsid}", a.removeWorkspace)
	mux.HandleFunc("PUT /v1/accounts/{id}/sites/{siteId}/watch", a.setWatch)
	mux.HandleFunc("DELETE /v1/accounts/{id}/sites/{siteId}/watch", a.removeWatch)
	mux.HandleFunc("GET /v1/accounts/{id}/quarantine", a.listQuarantine)
	mux.HandleFunc("POST /v1/accounts/{id}/quarantine/{qid}/restore", a.restoreQuarantine)
	mux.HandleFunc("DELETE /v1/accounts/{id}/quarantine/{qid}", a.deleteQuarantine)
	mux.HandleFunc("GET /v1/accounts/{id}/quarantine/{qid}/preview", a.quarantinePreview)
	mux.HandleFunc("GET /v1/events", a.events)
}

func (a *api) p3Unsupported(w http.ResponseWriter) bool {
	if a.p3 == nil {
		writeError(w, &apiError{http.StatusNotImplemented, codeUnsupported, "windows / quarantine not available"})
		return true
	}
	return false
}

// siteIDs reads {id} and {siteId}.
func siteIDs(r *http.Request) (int64, int64, error) {
	a, err := pathID(r, "id")
	if err != nil {
		return 0, 0, err
	}
	s, err := pathID(r, "siteId")
	return a, s, err
}

// windowRef reads {id}, {siteId}, {wid} (+ the slug given).
func windowRef(r *http.Request, slug string) (WindowRef, error) {
	a, s, err := siteIDs(r)
	if err != nil {
		return WindowRef{}, err
	}
	w, err := pathID(r, "wid")
	if err != nil {
		return WindowRef{}, err
	}
	ref := WindowRef{AccountID: a, SiteID: s, WindowID: w, Slug: slug}
	return ref, ref.validate()
}

type windowBody struct {
	siteBody
	ReleaseNumber         *int64 `json:"releaseNumber"`
	Mode                  string `json:"mode"`
	QuarantineExecutables bool   `json:"quarantineExecutables"`
}

func (a *api) ensureWindow(w http.ResponseWriter, r *http.Request) {
	if a.p3Unsupported(w) {
		return
	}
	var body windowBody
	s, err := siteSpec(r, &body)
	var spec WindowSpec
	if err == nil {
		spec.WindowRef, err = windowRef(r, s.Slug)
	}
	if err == nil && body.ReleaseNumber == nil {
		err = badRequest("releaseNumber is required")
	}
	if err == nil {
		spec.Owner, spec.ReleaseNumber, spec.Mode, spec.QuarantineExecutables = s.Owner, *body.ReleaseNumber, body.Mode, body.QuarantineExecutables
		err = spec.validate()
	}
	if err != nil {
		writeError(w, err)
		return
	}
	st, err := a.p3.EnsureWindow(r.Context(), spec)
	reply(w, r, st, err)
}

func (a *api) windowStatus(w http.ResponseWriter, r *http.Request) {
	if a.p3Unsupported(w) {
		return
	}
	acc, site, err := siteIDs(r)
	var wid int64
	if err == nil {
		wid, err = pathID(r, "wid")
	}
	if err != nil {
		writeError(w, err)
		return
	}
	st, err := a.p3.WindowStatus(r.Context(), acc, site, wid)
	reply(w, r, st, err)
}

type exportBody struct {
	siteBody
	ExportOptions
}

func (a *api) exportWindow(w http.ResponseWriter, r *http.Request) {
	if a.p3Unsupported(w) {
		return
	}
	var body exportBody
	s, err := siteSpec(r, &body)
	var ref WindowRef
	if err == nil {
		ref, err = windowRef(r, s.Slug)
	}
	if err == nil {
		err = body.ExportOptions.validate()
	}
	if err != nil {
		writeError(w, err)
		return
	}
	res, err := a.p3.ExportWindow(r.Context(), ref, body.ExportOptions)
	reply(w, r, res, err)
}

func (a *api) removeWindow(w http.ResponseWriter, r *http.Request) {
	if a.p3Unsupported(w) {
		return
	}
	ref, err := windowRef(r, r.URL.Query().Get("slug"))
	var keep bool
	if err == nil {
		keep, err = queryBool(r, "keepExport")
	}
	if err != nil {
		writeError(w, err)
		return
	}
	reply(w, r, okBody, a.p3.RemoveWindow(r.Context(), ref, keep))
}

func (a *api) verifyWindow(w http.ResponseWriter, r *http.Request) {
	if a.p3Unsupported(w) {
		return
	}
	var body struct {
		PIDs []int `json:"pids"`
	}
	acc, site, err := siteIDs(r)
	var wid int64
	if err == nil {
		wid, err = pathID(r, "wid")
	}
	if err == nil {
		err = decode(r, &body)
	}
	if err == nil && len(body.PIDs) > maxVerifyPids {
		err = badRequest("too many pids (max %d)", maxVerifyPids)
	}
	for _, p := range body.PIDs {
		if err == nil && p <= 1 {
			err = badRequest("invalid pid %d", p)
		}
	}
	if err != nil {
		writeError(w, err)
		return
	}
	res, err := a.p3.VerifyWindow(r.Context(), acc, site, wid, body.PIDs)
	reply(w, r, map[string]any{"results": res}, err)
}

func (a *api) listWindows(w http.ResponseWriter, r *http.Request) {
	if a.p3Unsupported(w) {
		return
	}
	list, err := a.p3.ListWindows(r.Context())
	reply(w, r, map[string]any{"windows": list}, err)
}

type stagingBody struct {
	siteBody
	Source  *StagingSource  `json:"source"`
	Changes []StagingChange `json:"changes"`
}

func (a *api) applyToStaging(w http.ResponseWriter, r *http.Request) {
	if a.p3Unsupported(w) {
		return
	}
	// The only large body (a change list): 64 MiB, at most 200 000 changes.
	r.Body = http.MaxBytesReader(w, r.Body, maxStagingBodyBytes)
	var body stagingBody
	s, err := siteSpecLarge(r, &body)
	if err == nil && body.Source == nil {
		err = badRequest("source is required")
	}
	if err == nil {
		err = body.Source.validate()
	}
	if err == nil {
		err = validStagingChanges(body.Changes)
	}
	if err != nil {
		writeError(w, err)
		return
	}
	res, err := a.p3.ApplyToStaging(r.Context(), s, *body.Source, body.Changes)
	reply(w, r, res, err)
}

// siteSpecLarge is siteSpec with the staging body limit.
func siteSpecLarge(r *http.Request, body interface{ site() *siteBody }) (SiteSpec, error) {
	accountID, siteID, err := siteIDs(r)
	if err != nil {
		return SiteSpec{}, err
	}
	dec := json.NewDecoder(io.LimitReader(r.Body, maxStagingBodyBytes))
	if err := dec.Decode(body); err != nil {
		return SiteSpec{}, badRequest("invalid JSON body: %v", err)
	}
	sb := body.site()
	o, err := sb.owner()
	if err != nil {
		return SiteSpec{}, err
	}
	s := SiteSpec{AccountID: accountID, SiteID: siteID, Slug: sb.Slug, Owner: o}
	return s, s.validate()
}

type workspaceBody struct {
	siteBody
	ReleaseNumber *int64 `json:"releaseNumber"`
}

func (a *api) ensureWorkspace(w http.ResponseWriter, r *http.Request) {
	if a.p3Unsupported(w) {
		return
	}
	var body workspaceBody
	s, err := siteSpec(r, &body)
	ws := WorkspaceSpec{SiteSpec: s}
	if err == nil {
		ws.WorkspaceID, err = pathID(r, "wsid")
	}
	if err == nil && body.ReleaseNumber == nil {
		err = badRequest("releaseNumber is required")
	}
	if err == nil {
		ws.ReleaseNumber = *body.ReleaseNumber
		err = validateID("release number", ws.ReleaseNumber)
	}
	if err != nil {
		writeError(w, err)
		return
	}
	res, err := a.p3.EnsureWorkspace(r.Context(), ws)
	reply(w, r, res, err)
}

func (a *api) removeWorkspace(w http.ResponseWriter, r *http.Request) {
	if a.p3Unsupported(w) {
		return
	}
	acc, site, err := siteIDs(r)
	var wsid int64
	if err == nil {
		wsid, err = pathID(r, "wsid")
	}
	slug := r.URL.Query().Get("slug")
	if err == nil {
		err = validateSlug(slug)
	}
	if err != nil {
		writeError(w, err)
		return
	}
	reply(w, r, okBody, a.p3.RemoveWorkspace(r.Context(), acc, site, slug, wsid))
}

type watchBody struct {
	siteBody
	Typed []TypedPath `json:"typed"`
}

func (a *api) setWatch(w http.ResponseWriter, r *http.Request) {
	if a.p3Unsupported(w) {
		return
	}
	var body watchBody
	s, err := siteSpec(r, &body)
	if err == nil {
		err = validateTyped(body.Typed)
	}
	if err != nil {
		writeError(w, err)
		return
	}
	res, err := a.p3.SetWatch(r.Context(), WatchSpec{SiteSpec: s, Typed: body.Typed})
	reply(w, r, res, err)
}

func (a *api) removeWatch(w http.ResponseWriter, r *http.Request) {
	if a.p3Unsupported(w) {
		return
	}
	acc, site, err := siteIDs(r)
	if err != nil {
		writeError(w, err)
		return
	}
	reply(w, r, okBody, a.p3.RemoveWatch(r.Context(), acc, site))
}

func (a *api) listQuarantine(w http.ResponseWriter, r *http.Request) {
	if a.p3Unsupported(w) {
		return
	}
	acc, err := pathID(r, "id")
	if err != nil {
		writeError(w, err)
		return
	}
	list, err := a.p3.ListQuarantine(r.Context(), acc)
	reply(w, r, map[string]any{"entries": list}, err)
}

// quarantineIDs reads {id} and {qid}.
func quarantineIDs(r *http.Request) (int64, string, error) {
	acc, err := pathID(r, "id")
	if err != nil {
		return 0, "", err
	}
	qid := r.PathValue("qid")
	return acc, qid, validateQuarantineID(qid)
}

func (a *api) restoreQuarantine(w http.ResponseWriter, r *http.Request) {
	if a.p3Unsupported(w) {
		return
	}
	var body struct {
		ownerBody
		Overwrite bool `json:"overwrite"`
	}
	acc, qid, err := quarantineIDs(r)
	if err == nil {
		err = decode(r, &body)
	}
	var o Owner
	if err == nil {
		o, err = body.owner()
	}
	if err != nil {
		writeError(w, err)
		return
	}
	res, err := a.p3.RestoreQuarantine(r.Context(), acc, qid, o, body.Overwrite)
	reply(w, r, res, err)
}

func (a *api) deleteQuarantine(w http.ResponseWriter, r *http.Request) {
	if a.p3Unsupported(w) {
		return
	}
	acc, qid, err := quarantineIDs(r)
	if err != nil {
		writeError(w, err)
		return
	}
	reply(w, r, okBody, a.p3.DeleteQuarantine(r.Context(), acc, qid))
}

func (a *api) quarantinePreview(w http.ResponseWriter, r *http.Request) {
	if a.p3Unsupported(w) {
		return
	}
	acc, qid, err := quarantineIDs(r)
	max := 64 << 10
	if err == nil {
		if s := r.URL.Query().Get("max"); s != "" {
			n, perr := strconv.Atoi(s)
			if perr != nil || n <= 0 || n > maxPreviewBytes {
				err = badRequest("max must be between 1 and %d", maxPreviewBytes)
			}
			max = n
		}
	}
	if err != nil {
		writeError(w, err)
		return
	}
	res, err := a.p3.QuarantinePreview(r.Context(), acc, qid, max)
	reply(w, r, res, err)
}

func (a *api) events(w http.ResponseWriter, r *http.Request) {
	if a.p3Unsupported(w) {
		return
	}
	q := r.URL.Query()
	var since int64
	wait := 0
	if s := q.Get("since"); s != "" {
		n, err := strconv.ParseInt(s, 10, 64)
		if err != nil || n < 0 {
			writeError(w, badRequest("since must be a sequence number"))
			return
		}
		since = n
	}
	if s := q.Get("wait"); s != "" {
		n, err := strconv.Atoi(s)
		if err != nil || n < 0 {
			writeError(w, badRequest("wait must be a number of seconds"))
			return
		}
		wait = min(n, maxEventsWait)
	}
	events, next := a.p3.Events(r.Context(), since, time.Duration(wait)*time.Second)
	writeJSON(w, http.StatusOK, map[string]any{"events": events, "next": next})
}
