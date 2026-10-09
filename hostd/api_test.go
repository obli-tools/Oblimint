package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
)

// fakeOps records the calls it receives and returns err when set.
type fakeOps struct {
	calls []string
	err   error
}

func (f *fakeOps) rec(format string, args ...any) {
	f.calls = append(f.calls, fmt.Sprintf(format, args...))
}

func mb(p *int64) string {
	if p == nil {
		return "null"
	}
	return fmt.Sprint(*p)
}

func (f *fakeOps) FSInfo(rel []string) (FSInfo, error) {
	f.rec("fs %s", strings.Join(rel, "/"))
	return FSInfo{Path: "/srv/oblimint", FSType: "xfs", MountPoint: "/srv/oblimint", Options: []string{"prjquota"}, ProjectQuota: true}, f.err
}
func (f *fakeOps) EnsureAccount(_ context.Context, a AccountSpec) (QuotaMode, error) {
	f.rec("ensureAccount %d %d:%d %s", a.AccountID, a.Owner.UID, a.Owner.GID, mb(a.QuotaMB))
	return quotaXFS, f.err
}
func (f *fakeOps) SetQuota(_ context.Context, id int64, q *int64) (QuotaMode, error) {
	f.rec("setQuota %d %s", id, mb(q))
	return quotaMeasured, f.err
}
func (f *fakeOps) Usage(_ context.Context, id int64) (Usage, error) {
	f.rec("usage %d", id)
	q := int64(1 << 30)
	return Usage{AccountID: id, UsedBytes: 123, QuotaBytes: &q, Mode: quotaXFS, MeasuredAt: "2026-10-09T10:00:00Z"}, f.err
}
func (f *fakeOps) RemoveAccount(_ context.Context, id int64, purge bool) error {
	f.rec("removeAccount %d %v", id, purge)
	return f.err
}
func (f *fakeOps) EnsureSite(_ context.Context, s SiteSpec) error {
	f.rec("ensureSite %d %d %s %d:%d", s.AccountID, s.SiteID, s.Slug, s.Owner.UID, s.Owner.GID)
	return f.err
}
func (f *fakeOps) RemoveSite(_ context.Context, a, s int64, slug string, purge bool) error {
	f.rec("removeSite %d %d %s %v", a, s, slug, purge)
	return f.err
}
func (f *fakeOps) EnsureDataPaths(_ context.Context, s SiteSpec, p []string) error {
	f.rec("ensureDataPaths %d %d %s %v", s.AccountID, s.SiteID, s.Slug, p)
	return f.err
}
func (f *fakeOps) SeedDataPath(_ context.Context, s SiteSpec, p string) (SeedResult, error) {
	f.rec("seed %d %d %s %s", s.AccountID, s.SiteID, s.Slug, p)
	return SeedResult{Copied: true, Files: 4}, f.err
}
func (f *fakeOps) ClearDataPaths(_ context.Context, s SiteSpec, p []string) error {
	f.rec("clear %d %d %s %v", s.AccountID, s.SiteID, s.Slug, p)
	return f.err
}
func (f *fakeOps) Du(_ context.Context, rel []string) (int64, error) {
	f.rec("du %s", strings.Join(rel, "/"))
	return 4096, f.err
}
func (f *fakeOps) EnsureDbInstance(_ context.Context, s DbInstanceSpec) error {
	f.rec("ensureDb %d %d %d:%d", s.AccountID, s.InstanceID, s.Owner.UID, s.Owner.GID)
	return f.err
}
func (f *fakeOps) RemoveDbInstance(_ context.Context, a, i int64, purge bool) error {
	f.rec("removeDb %d %d %v", a, i, purge)
	return f.err
}
func (f *fakeOps) SetDefaultDbSocket(_ context.Context, a int64, fam DbFamily, i *int64) error {
	f.rec("dbDefault %d %s %s", a, fam, mb(i))
	return f.err
}

func do(t *testing.T, ops Ops, method, target, body string) (int, map[string]any) {
	t.Helper()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(method, target, strings.NewReader(body))
	newMux(ops, newLayout("/srv/oblimint"), nil, nil).ServeHTTP(rec, req)
	var out map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("%s %s: non-JSON body %q", method, target, rec.Body)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
		t.Errorf("%s %s: content-type %q", method, target, ct)
	}
	return rec.Code, out
}

func TestHandlersSuccess(t *testing.T) {
	tests := []struct {
		method, target, body string
		call                 string
		want                 string // JSON of the expected response
	}{
		{"GET", "/v1/health", "", "", `{"ok":true,"version":"` + version + `"}`},
		{"GET", "/v1/fs", "", "fs ", `{"path":"/srv/oblimint","fsType":"xfs","mountPoint":"/srv/oblimint","options":["prjquota"],"projectQuota":true}`},
		{"GET", "/v1/fs?path=/srv/oblimint/accounts", "", "fs accounts", ""},
		{"PUT", "/v1/accounts/7", `{"uid":20007,"gid":20008,"quotaMb":2048}`, "ensureAccount 7 20007:20008 2048", `{"quotaMode":"xfs"}`},
		{"PUT", "/v1/accounts/7", `{"uid":20007,"gid":20007,"quotaMb":null}`, "ensureAccount 7 20007:20007 null", ""},
		{"PUT", "/v1/accounts/7", `{"uid":20007,"gid":20007,"quotaMb":0}`, "ensureAccount 7 20007:20007 null", ""},
		{"PUT", "/v1/accounts/7/quota", `{"quotaMb":10}`, "setQuota 7 10", `{"quotaMode":"measured"}`},
		{"PUT", "/v1/accounts/7/quota", `{"quotaMb":null}`, "setQuota 7 null", ""},
		{"GET", "/v1/accounts/7/usage", "", "usage 7", `{"accountId":7,"usedBytes":123,"quotaBytes":1073741824,"mode":"xfs","measuredAt":"2026-10-09T10:00:00Z"}`},
		{"DELETE", "/v1/accounts/7", "", "removeAccount 7 false", `{"ok":true}`},
		{"DELETE", "/v1/accounts/7?purge=1", "", "removeAccount 7 true", `{"ok":true}`},
		{"PUT", "/v1/accounts/7/sites/9", `{"slug":"blog","uid":20007,"gid":20007}`, "ensureSite 7 9 blog 20007:20007", `{"ok":true}`},
		{"DELETE", "/v1/accounts/7/sites/9?slug=blog&purge=1", "", "removeSite 7 9 blog true", `{"ok":true}`},
		{"DELETE", "/v1/accounts/7/sites/9?slug=blog", "", "removeSite 7 9 blog false", ""},
		{"PUT", "/v1/accounts/7/sites/9/data-paths", `{"slug":"blog","uid":20007,"gid":20007,"paths":["wp-content/uploads","cache"]}`, "ensureDataPaths 7 9 blog [wp-content/uploads cache]", `{"ok":true}`},
		{"PUT", "/v1/accounts/7/sites/9/data-paths", `{"slug":"blog","uid":20007,"gid":20007,"paths":[]}`, "ensureDataPaths 7 9 blog []", ""},
		{"POST", "/v1/accounts/7/sites/9/data-paths/seed", `{"slug":"blog","uid":20007,"gid":20007,"path":"wp-content/uploads"}`, "seed 7 9 blog wp-content/uploads", `{"copied":true,"files":4}`},
		{"POST", "/v1/accounts/7/sites/9/data-paths/clear", `{"slug":"blog","uid":20007,"gid":20007,"paths":["cache"]}`, "clear 7 9 blog [cache]", `{"ok":true}`},
		{"GET", "/v1/du?path=/srv/oblimint/accounts/7", "", "du accounts/7", `{"path":"/srv/oblimint/accounts/7","bytes":4096}`},
		{"GET", "/v1/du?path=/srv/oblimint", "", "du ", ""},
		{"PUT", "/v1/accounts/7/db-instances/12", `{"uid":20007,"gid":20007}`, "ensureDb 7 12 20007:20007", `{"ok":true}`},
		{"DELETE", "/v1/accounts/7/db-instances/12", "", "removeDb 7 12 false", `{"ok":true}`},
		{"DELETE", "/v1/accounts/7/db-instances/12?purge=1", "", "removeDb 7 12 true", ""},
		{"PUT", "/v1/accounts/7/db-default/mysql", `{"instanceId":12}`, "dbDefault 7 mysql 12", `{"ok":true}`},
		{"PUT", "/v1/accounts/7/db-default/postgresql", `{"instanceId":null}`, "dbDefault 7 postgresql null", ""},
	}
	for _, tt := range tests {
		f := &fakeOps{}
		code, body := do(t, f, tt.method, tt.target, tt.body)
		name := tt.method + " " + tt.target
		if code != http.StatusOK {
			t.Errorf("%s: %d %v", name, code, body)
			continue
		}
		if tt.call != "" && !slices.Equal(f.calls, []string{tt.call}) {
			t.Errorf("%s: calls %q, want %q", name, f.calls, tt.call)
		}
		if tt.want != "" {
			var want map[string]any
			_ = json.Unmarshal([]byte(tt.want), &want)
			if fmt.Sprint(body) != fmt.Sprint(want) {
				t.Errorf("%s: body %v, want %v", name, body, want)
			}
		}
	}
}

func TestHandlersRejectBadInput(t *testing.T) {
	site := `"uid":20007,"gid":20007`
	tests := []struct{ method, target, body string }{
		{"GET", "/v1/fs?path=srv", ""},
		{"GET", "/v1/fs?path=/etc", ""},
		{"GET", "/v1/fs?path=/proc/self", ""},
		{"GET", "/v1/fs?path=/srv/oblimint/x/../y", ""},
		{"GET", "/v1/fs?path=/srv/oblimint/../../etc", ""},
		{"GET", "/v1/du", ""},
		{"GET", "/v1/du?path=/etc", ""},
		{"GET", "/v1/du?path=/srv/oblimint/../../etc", ""},
		{"GET", "/v1/du?path=srv/oblimint", ""},
		{"GET", "/v1/du?path=/srv/oblimintx", ""},
		{"PUT", "/v1/accounts/0", `{"uid":20007,"gid":20007}`},
		{"PUT", "/v1/accounts/-1", `{"uid":20007,"gid":20007}`},
		{"PUT", "/v1/accounts/abc", `{"uid":20007,"gid":20007}`},
		{"PUT", "/v1/accounts/07", `{"uid":20007,"gid":20007}`},
		{"PUT", "/v1/accounts/7", `{"uid":0,"gid":0}`},
		{"PUT", "/v1/accounts/7", `{"uid":20007}`},
		{"PUT", "/v1/accounts/7", `{"uid":20007,"gid":20007,"quotaMb":-1}`},
		{"PUT", "/v1/accounts/7", `not json`},
		{"PUT", "/v1/accounts/7/quota", `{"quotaMb":"10"}`},
		{"DELETE", "/v1/accounts/7?purge=yes", ""},
		{"PUT", "/v1/accounts/7/sites/9", `{"slug":"../x",` + site + `}`},
		{"PUT", "/v1/accounts/7/sites/9", `{"slug":"Blog",` + site + `}`},
		{"PUT", "/v1/accounts/7/sites/0", `{"slug":"blog",` + site + `}`},
		{"PUT", "/v1/accounts/7/sites/9", `{"slug":"blog","uid":100,"gid":100}`},
		{"DELETE", "/v1/accounts/7/sites/9?purge=1", ""},
		{"DELETE", "/v1/accounts/7/sites/9?slug=..&purge=1", ""},
		{"PUT", "/v1/accounts/7/sites/9/data-paths", `{"slug":"blog",` + site + `,"paths":["../../etc"]}`},
		{"PUT", "/v1/accounts/7/sites/9/data-paths", `{"slug":"blog",` + site + `,"paths":["/abs"]}`},
		{"PUT", "/v1/accounts/7/sites/9/data-paths", `{"slug":"blog",` + site + `,"paths":["a\\b"]}`},
		{"PUT", "/v1/accounts/7/sites/9/data-paths", `{"slug":"blog",` + site + `,"paths":["ok","été"]}`},
		{"POST", "/v1/accounts/7/sites/9/data-paths/seed", `{"slug":"blog",` + site + `,"path":""}`},
		{"POST", "/v1/accounts/7/sites/9/data-paths/seed", `{"slug":"blog",` + site + `,"path":"a/../b"}`},
		{"POST", "/v1/accounts/7/sites/9/data-paths/clear", `{"slug":"blog",` + site + `,"paths":["."]}`},
		{"PUT", "/v1/accounts/7/db-instances/0", `{"uid":20007,"gid":20007}`},
		{"PUT", "/v1/accounts/7/db-instances/x", `{"uid":20007,"gid":20007}`},
		{"PUT", "/v1/accounts/7/db-instances/12", `{"uid":100,"gid":100}`},
		{"DELETE", "/v1/accounts/7/db-instances/12?purge=maybe", ""},
		{"PUT", "/v1/accounts/7/db-default/redis", `{"instanceId":12}`},
		{"PUT", "/v1/accounts/7/db-default/mysql", `{}`},
		{"PUT", "/v1/accounts/7/db-default/mysql", `{"instanceId":"12"}`},
	}
	for _, tt := range tests {
		f := &fakeOps{}
		code, body := do(t, f, tt.method, tt.target, tt.body)
		name := tt.method + " " + tt.target + " " + tt.body
		if code != http.StatusBadRequest || body["ok"] != false || body["code"] != codeInvalid || body["error"] == "" {
			t.Errorf("%s: %d %v", name, code, body)
		}
		if len(f.calls) != 0 {
			t.Errorf("%s: ops reached with %q", name, f.calls)
		}
	}
}

func TestHandlersMapErrors(t *testing.T) {
	tests := []struct {
		err    error
		status int
		code   string
	}{
		{notFound("accounts/7 does not exist"), 404, codeNotFound},
		{fs.ErrNotExist, 404, codeNotFound},
		{unsafePath("data/blog/x is a symbolic link"), 409, codeUnsafePath},
		{fmt.Errorf("wrapped: %w", errUnsupported), 501, codeUnsupported},
		{busy("account 7 is busy"), 409, codeBusy},
		{fmt.Errorf("copy: %w", context.Canceled), 503, codeCancelled},
		{errors.New("disk on fire"), 500, codeInternal},
	}
	for _, tt := range tests {
		code, body := do(t, &fakeOps{err: tt.err}, "PUT", "/v1/accounts/7/sites/9", `{"slug":"blog","uid":20007,"gid":20007}`)
		if code != tt.status || body["code"] != tt.code || body["ok"] != false || !strings.Contains(fmt.Sprint(body["error"]), tt.err.Error()) {
			t.Errorf("%v: %d %v", tt.err, code, body)
		}
	}
	if code, body := do(t, &fakeOps{}, "GET", "/v1/nope", ""); code != 404 || body["code"] != codeNotFound {
		t.Errorf("unknown route: %d %v", code, body)
	}
	if code, _ := do(t, &fakeOps{}, "POST", "/v1/accounts/7", "{}"); code != http.StatusMethodNotAllowed && code != 404 {
		t.Errorf("wrong method: %d", code)
	}
}
