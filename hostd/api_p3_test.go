package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
	"time"
)

// fakeP3 records the calls it receives and returns err when set.
type fakeP3 struct {
	calls []string
	err   error
}

func (f *fakeP3) rec(format string, args ...any) {
	f.calls = append(f.calls, fmt.Sprintf(format, args...))
}

func (f *fakeP3) EnsureWindow(_ context.Context, s WindowSpec) (WindowStatus, error) {
	f.rec("ensureWindow %d %d %d %s %d:%d %d %s %v", s.AccountID, s.SiteID, s.WindowID, s.Slug, s.Owner.UID, s.Owner.GID, s.ReleaseNumber, s.Mode, s.QuarantineExecutables)
	return WindowStatus{AccountID: s.AccountID, SiteID: s.SiteID, WindowID: s.WindowID, Mounted: true, Mode: strPtr(s.Mode), ReleaseNumber: i64Ptr(s.ReleaseNumber), UpperBytes: 10, UpperEntries: 2}, f.err
}
func (f *fakeP3) WindowStatus(_ context.Context, a, s, w int64) (WindowStatus, error) {
	f.rec("status %d %d %d", a, s, w)
	return WindowStatus{AccountID: a, SiteID: s, WindowID: w}, f.err
}
func (f *fakeP3) ExportWindow(_ context.Context, r WindowRef, o ExportOptions) (ExportResult, error) {
	f.rec("export %d %d %d %s %d %d %d", r.AccountID, r.SiteID, r.WindowID, r.Slug, o.MaxFileBytes, o.MaxTotalBytes, o.MaxEntries)
	return ExportResult{Entries: 3, Added: 1, Modified: 1, Deleted: 1, Bytes: 42}, f.err
}
func (f *fakeP3) RemoveWindow(_ context.Context, r WindowRef, keep bool) error {
	f.rec("removeWindow %d %d %d %s %v", r.AccountID, r.SiteID, r.WindowID, r.Slug, keep)
	return f.err
}
func (f *fakeP3) VerifyWindow(_ context.Context, a, s, w int64, pids []int) ([]PropagationResult, error) {
	f.rec("verify %d %d %d %v", a, s, w, pids)
	return []PropagationResult{{PID: pids[0], Visible: true, Mode: strPtr("rw")}}, f.err
}
func (f *fakeP3) ListWindows(context.Context) ([]MountedWindow, error) {
	f.rec("listWindows")
	return []MountedWindow{{7, 9, 5, "ro", 3}}, f.err
}
func (f *fakeP3) ApplyToStaging(_ context.Context, s SiteSpec, src StagingSource, ch []StagingChange) (StagingApplyResult, error) {
	f.rec("staging %d %d %s %s:%d %d", s.AccountID, s.SiteID, s.Slug, src.Kind, src.ID, len(ch))
	return StagingApplyResult{Written: 1, Conflicts: []StagingConflict{{"a", "symlink"}}}, f.err
}
func (f *fakeP3) EnsureWorkspace(_ context.Context, ws WorkspaceSpec) (WorkspaceResult, error) {
	f.rec("workspace %d %d %s %d %d", ws.AccountID, ws.SiteID, ws.Slug, ws.WorkspaceID, ws.ReleaseNumber)
	return WorkspaceResult{Files: 12, Bytes: 3400}, f.err
}
func (f *fakeP3) RemoveWorkspace(_ context.Context, a, s int64, slug string, id int64) error {
	f.rec("removeWorkspace %d %d %s %d", a, s, slug, id)
	return f.err
}
func (f *fakeP3) SetWatch(_ context.Context, ws WatchSpec) (WatchResult, error) {
	f.rec("watch %d %d %s %+v", ws.AccountID, ws.SiteID, ws.Slug, ws.Typed)
	return WatchResult{Watching: len(ws.Typed), Quarantined: 1}, f.err
}
func (f *fakeP3) RemoveWatch(_ context.Context, a, s int64) error {
	f.rec("removeWatch %d %d", a, s)
	return f.err
}
func (f *fakeP3) ListQuarantine(_ context.Context, a int64) ([]QuarantineEntry, error) {
	f.rec("listQuarantine %d", a)
	return []QuarantineEntry{}, f.err
}
func (f *fakeP3) RestoreQuarantine(_ context.Context, a int64, id string, o Owner, overwrite bool) (RestoreResult, error) {
	f.rec("restore %d %s %d:%d %v", a, id, o.UID, o.GID, overwrite)
	return RestoreResult{Restored: true, Path: "uploads/a.jpg"}, f.err
}
func (f *fakeP3) DeleteQuarantine(_ context.Context, a int64, id string) error {
	f.rec("deleteQuarantine %d %s", a, id)
	return f.err
}
func (f *fakeP3) QuarantinePreview(_ context.Context, a int64, id string, max int) (Preview, error) {
	f.rec("preview %d %s %d", a, id, max)
	return Preview{Base64: "aGk=", Size: 2}, f.err
}
func (f *fakeP3) Events(_ context.Context, since int64, wait time.Duration) ([]Event, int64) {
	f.rec("events %d %v", since, wait)
	return []Event{}, since
}

func doP3(t *testing.T, p3 P3Ops, method, target, body string) (int, map[string]any) {
	t.Helper()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(method, target, strings.NewReader(body))
	newMux(&fakeOps{}, newLayout("/srv/oblimint"), nil, nil, p3).ServeHTTP(rec, req)
	var out map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("%s %s: non-JSON body %q", method, target, rec.Body)
	}
	return rec.Code, out
}

const qid = "20261009t031500-1a2b3c4d"

func TestP3HandlersSuccess(t *testing.T) {
	site := `"slug":"blog","uid":20007,"gid":20007`
	win := "/v1/accounts/7/sites/9/windows/5"
	tests := []struct {
		method, target, body string
		call                 string
		want                 string
	}{
		{"PUT", win, `{` + site + `,"releaseNumber":3,"mode":"rw","quarantineExecutables":true}`, "ensureWindow 7 9 5 blog 20007:20007 3 rw true",
			`{"accountId":7,"siteId":9,"windowId":5,"mounted":true,"mode":"rw","releaseNumber":3,"quarantineExecutables":false,"upperBytes":10,"upperEntries":2,"exportReady":false}`},
		{"PUT", win, `{` + site + `,"releaseNumber":3,"mode":"ro","quarantineExecutables":false}`, "ensureWindow 7 9 5 blog 20007:20007 3 ro false", ""},
		{"GET", win, "", "status 7 9 5", `{"accountId":7,"siteId":9,"windowId":5,"mounted":false,"mode":null,"releaseNumber":null,"quarantineExecutables":false,"upperBytes":0,"upperEntries":0,"exportReady":false}`},
		{"POST", win + "/export", `{` + site + `,"maxFileBytes":1000,"maxTotalBytes":20000,"maxEntries":50}`, "export 7 9 5 blog 1000 20000 50",
			`{"entries":3,"added":1,"modified":1,"deleted":1,"bytes":42,"truncated":false}`},
		{"DELETE", win + "?slug=blog&keepExport=1", "", "removeWindow 7 9 5 blog true", `{"ok":true}`},
		{"DELETE", win + "?slug=blog&keepExport=0", "", "removeWindow 7 9 5 blog false", ""},
		{"POST", win + "/verify", `{"pids":[1234,5678]}`, "verify 7 9 5 [1234 5678]", `{"results":[{"pid":1234,"visible":true,"mode":"rw","error":null}]}`},
		{"GET", "/v1/windows", "", "listWindows", `{"windows":[{"accountId":7,"siteId":9,"windowId":5,"mode":"ro","releaseNumber":3}]}`},
		{"POST", "/v1/accounts/7/sites/9/staging/apply", `{` + site + `,"source":{"kind":"window","id":5},"changes":[{"path":"a","op":"write"},{"path":"b","op":"delete"}]}`,
			"staging 7 9 blog window:5 2", `{"written":1,"deleted":0,"conflicts":[{"path":"a","reason":"symlink"}]}`},
		{"POST", "/v1/accounts/7/sites/9/staging/apply", `{` + site + `,"source":{"kind":"workspace","id":11},"changes":[]}`, "staging 7 9 blog workspace:11 0", ""},
		{"PUT", "/v1/accounts/7/sites/9/workspaces/11", `{` + site + `,"releaseNumber":3}`, "workspace 7 9 blog 11 3", `{"files":12,"bytes":3400}`},
		{"DELETE", "/v1/accounts/7/sites/9/workspaces/11?slug=blog", "", "removeWorkspace 7 9 blog 11", `{"ok":true}`},
		{"PUT", "/v1/accounts/7/sites/9/watch", `{` + site + `,"typed":[{"path":"wp-content/uploads","allowedExtensions":["jpg","png"]}]}`,
			"watch 7 9 blog [{Path:wp-content/uploads AllowedExtensions:[jpg png]}]", `{"watching":1,"quarantined":1}`},
		{"DELETE", "/v1/accounts/7/sites/9/watch", "", "removeWatch 7 9", `{"ok":true}`},
		{"GET", "/v1/accounts/7/quarantine", "", "listQuarantine 7", `{"entries":[]}`},
		{"POST", "/v1/accounts/7/quarantine/" + qid + "/restore", `{"uid":20007,"gid":20007,"overwrite":true}`, "restore 7 " + qid + " 20007:20007 true", `{"restored":true,"path":"uploads/a.jpg"}`},
		{"DELETE", "/v1/accounts/7/quarantine/" + qid, "", "deleteQuarantine 7 " + qid, `{"ok":true}`},
		{"GET", "/v1/accounts/7/quarantine/" + qid + "/preview?max=262144", "", "preview 7 " + qid + " 262144", `{"base64":"aGk=","truncated":false,"size":2}`},
		{"GET", "/v1/accounts/7/quarantine/" + qid + "/preview", "", "preview 7 " + qid + " 65536", ""},
		{"GET", "/v1/events?since=12&wait=99", "", "events 12 55s", `{"events":[],"next":12}`},
		{"GET", "/v1/events", "", "events 0 0s", ""},
	}
	for _, tt := range tests {
		f := &fakeP3{}
		code, body := doP3(t, f, tt.method, tt.target, tt.body)
		name := tt.method + " " + tt.target
		if code != http.StatusOK {
			t.Errorf("%s: %d %v", name, code, body)
			continue
		}
		if !slices.Equal(f.calls, []string{tt.call}) {
			t.Errorf("%s: calls %q, want %q", name, f.calls, tt.call)
		}
		if tt.want != "" {
			var want map[string]any
			if err := json.Unmarshal([]byte(tt.want), &want); err != nil {
				t.Fatal(err)
			}
			if fmt.Sprint(body) != fmt.Sprint(want) {
				t.Errorf("%s: body %v, want %v", name, body, want)
			}
		}
	}
}

func TestP3HandlersRejectBadInput(t *testing.T) {
	site := `"slug":"blog","uid":20007,"gid":20007`
	win := "/v1/accounts/7/sites/9/windows/5"
	tests := []struct{ method, target, body string }{
		{"PUT", win, `{` + site + `,"mode":"rw"}`},
		{"PUT", win, `{` + site + `,"releaseNumber":0,"mode":"rw"}`},
		{"PUT", win, `{` + site + `,"releaseNumber":3,"mode":"rwx"}`},
		{"PUT", win, `{"slug":"../x","uid":20007,"gid":20007,"releaseNumber":3,"mode":"rw"}`},
		{"PUT", win, `{"slug":"blog","uid":0,"gid":0,"releaseNumber":3,"mode":"rw"}`},
		{"PUT", "/v1/accounts/7/sites/9/windows/0", `{` + site + `,"releaseNumber":3,"mode":"rw"}`},
		{"PUT", "/v1/accounts/7/sites/9/windows/x", `{` + site + `,"releaseNumber":3,"mode":"rw"}`},
		{"GET", "/v1/accounts/7/sites/9/windows/05", ""},
		{"POST", win + "/export", `{` + site + `,"maxFileBytes":0,"maxTotalBytes":1,"maxEntries":1}`},
		{"DELETE", win + "?slug=Blog", ""},
		{"DELETE", win + "?slug=blog&keepExport=yes", ""},
		{"POST", win + "/verify", `{"pids":[1]}`},
		{"POST", win + "/verify", `{"pids":[0]}`},
		{"POST", win + "/verify", `{"pids":"12"}`},
		{"POST", "/v1/accounts/7/sites/9/staging/apply", `{` + site + `,"changes":[]}`},
		{"POST", "/v1/accounts/7/sites/9/staging/apply", `{` + site + `,"source":{"kind":"git","id":5},"changes":[]}`},
		{"POST", "/v1/accounts/7/sites/9/staging/apply", `{` + site + `,"source":{"kind":"window","id":0},"changes":[]}`},
		{"PUT", "/v1/accounts/7/sites/9/workspaces/11", `{` + site + `}`},
		{"PUT", "/v1/accounts/7/sites/9/workspaces/x", `{` + site + `,"releaseNumber":3}`},
		{"DELETE", "/v1/accounts/7/sites/9/workspaces/11", ""},
		{"PUT", "/v1/accounts/7/sites/9/watch", `{` + site + `,"typed":[{"path":"../../etc","allowedExtensions":["jpg"]}]}`},
		{"PUT", "/v1/accounts/7/sites/9/watch", `{` + site + `,"typed":[{"path":"up","allowedExtensions":["a/b"]}]}`},
		{"GET", "/v1/accounts/0/quarantine", ""},
		{"POST", "/v1/accounts/7/quarantine/..%2F..%2Fetc/restore", `{"uid":20007,"gid":20007}`},
		{"POST", "/v1/accounts/7/quarantine/ABC/restore", `{"uid":20007,"gid":20007}`},
		{"POST", "/v1/accounts/7/quarantine/" + qid + "/restore", `{"uid":1,"gid":1}`},
		{"DELETE", "/v1/accounts/7/quarantine/short", ""},
		{"GET", "/v1/accounts/7/quarantine/" + qid + "/preview?max=262145", ""},
		{"GET", "/v1/accounts/7/quarantine/" + qid + "/preview?max=0", ""},
		{"GET", "/v1/events?since=-1", ""},
		{"GET", "/v1/events?wait=x", ""},
	}
	for _, tt := range tests {
		f := &fakeP3{}
		code, body := doP3(t, f, tt.method, tt.target, tt.body)
		name := tt.method + " " + tt.target + " " + tt.body
		if code != http.StatusBadRequest || body["code"] != codeInvalid {
			t.Errorf("%s: %d %v", name, code, body)
		}
		if len(f.calls) != 0 {
			t.Errorf("%s: reached %q", name, f.calls)
		}
	}
}

func TestP3HandlersErrorsAndLimits(t *testing.T) {
	for _, c := range []struct {
		err    error
		status int
		code   string
	}{
		{conflictError(codeConflict, "window 4 is mounted"), 409, codeConflict},
		{conflictError(codeWindowNotMounted, "not mounted"), 409, codeWindowNotMounted},
		{conflictError(codeRestoreConflict, "exists"), 409, codeRestoreConflict},
		{errUnsupported, 501, codeUnsupported},
		{notFound("release 3 of site 9 does not exist"), 404, codeNotFound},
	} {
		code, body := doP3(t, &fakeP3{err: c.err}, "PUT", "/v1/accounts/7/sites/9/windows/5", `{"slug":"blog","uid":20007,"gid":20007,"releaseNumber":3,"mode":"rw"}`)
		if code != c.status || body["code"] != c.code {
			t.Errorf("%v: %d %v", c.err, code, body)
		}
	}
	// Without the P3 manager every P3 route is 501.
	if code, body := doP3(t, nil, "GET", "/v1/windows", ""); code != 501 || body["code"] != codeUnsupported {
		t.Errorf("nil p3: %d %v", code, body)
	}
	// The staging change list may exceed the 1 MiB limit of the other routes.
	var b strings.Builder
	b.WriteString(`{"slug":"blog","uid":20007,"gid":20007,"source":{"kind":"window","id":5},"changes":[`)
	for i := range 30000 {
		if i > 0 {
			b.WriteByte(',')
		}
		fmt.Fprintf(&b, `{"path":"wp-content/plugins/some-plugin/includes/file-%06d.php","op":"write"}`, i)
	}
	b.WriteString(`]}`)
	if b.Len() <= maxBodyBytes {
		t.Fatalf("body too small for the test: %d", b.Len())
	}
	f := &fakeP3{}
	if code, body := doP3(t, f, "POST", "/v1/accounts/7/sites/9/staging/apply", b.String()); code != 200 || len(f.calls) != 1 {
		t.Errorf("large staging body: %d %v", code, body)
	}
	// Other routes keep 1 MiB.
	big := `{"slug":"blog","uid":20007,"gid":20007,"typed":[{"path":"up","allowedExtensions":["` + strings.Repeat("x", maxBodyBytes) + `"]}]}`
	if code, _ := doP3(t, &fakeP3{}, "PUT", "/v1/accounts/7/sites/9/watch", big); code != 400 {
		t.Errorf("1 MiB limit: %d", code)
	}
}
