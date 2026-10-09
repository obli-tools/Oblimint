package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
)

const testKey = "0123456789abcdef0123456789abcdef"

type fakeClam struct {
	verdict func([]byte) (ClamResult, error)
	version string
	err     error
}

func (f *fakeClam) Instream(_ context.Context, r io.Reader) (ClamResult, error) {
	b, _ := io.ReadAll(r)
	return f.verdict(b)
}

func (f *fakeClam) Version(context.Context) (string, error) { return f.version, f.err }

type fakeYara struct {
	matches []YaraMatch
	err     error
	seen    []string
}

func (f *fakeYara) Scan(_ context.Context, file string) ([]YaraMatch, error) {
	b, _ := os.ReadFile(file)
	f.seen = append(f.seen, string(b))
	return f.matches, f.err
}

type fakeUpdater struct {
	calls int
	err   error
}

func (f *fakeUpdater) UpdateNow(context.Context) error { f.calls++; return f.err }
func (f *fakeUpdater) LastUpdate() (time.Time, error) {
	if f.calls == 0 {
		return time.Time{}, nil
	}
	return time.Date(2026, 10, 9, 3, 0, 0, 0, time.UTC), f.err
}

func newTestServer(t *testing.T) (*Server, *fakeClam, *fakeYara) {
	t.Helper()
	clam := &fakeClam{
		verdict: func(b []byte) (ClamResult, error) {
			if bytes.Contains(b, []byte("VIRUS")) {
				return ClamResult{Found: true, Signature: "Oblimint.Test.Virus"}, nil
			}
			return ClamResult{}, nil
		},
		version: "ClamAV 1.4.3/27420/Thu Oct  8 08:24:32 2026",
	}
	yara := &fakeYara{}
	s := &Server{
		Key: testKey, ClamAV: true, Yara: true, Clam: clam, YaraEng: yara, MaxFileBytes: 1024,
		TmpDir: t.TempDir(), YaraVersion: "4.5.2", Rules: RulesInfo{Version: "oblimint-1", Count: 33}, Version: "test",
	}
	return s, clam, yara
}

func do(t *testing.T, h http.Handler, method, path, key string, body []byte) (*httptest.ResponseRecorder, map[string]any) {
	t.Helper()
	req := httptest.NewRequest(method, path, bytes.NewReader(body))
	if key != "" {
		req.Header.Set(keyHeader, key)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return rec, out
}

func TestAuth(t *testing.T) {
	s, _, _ := newTestServer(t)
	h := s.Handler(2)
	for _, key := range []string{"", "wrong", testKey + "x", strings.ToUpper(testKey)} {
		rec, _ := do(t, h, "POST", "/v1/scan?name=a", key, []byte("x"))
		if rec.Code != http.StatusUnauthorized {
			t.Errorf("key %q: %d", key, rec.Code)
		}
		rec, _ = do(t, h, "GET", "/v1/status", key, nil)
		if rec.Code != http.StatusUnauthorized {
			t.Errorf("status with key %q: %d", key, rec.Code)
		}
	}
	rec, _ := do(t, h, "GET", "/healthz", "", nil)
	if rec.Code != http.StatusOK || rec.Body.String() != "ok" {
		t.Fatalf("healthz: %d %q", rec.Code, rec.Body.String())
	}
	if keysEqual("", "") || keysEqual("a", "") || !keysEqual(testKey, testKey) {
		t.Fatal("keysEqual")
	}
}

func TestScanCleanFoundYara(t *testing.T) {
	s, _, yara := newTestServer(t)
	h := s.Handler(2)
	rec, out := do(t, h, "POST", "/v1/scan?name=wp-content%2Fx.php", testKey, []byte("hello"))
	if rec.Code != 200 {
		t.Fatalf("%d %s", rec.Code, rec.Body)
	}
	if out["clamav"].(map[string]any)["status"] != "ok" {
		t.Fatalf("%v", out)
	}
	if m := out["yara"].(map[string]any)["matches"].([]any); len(m) != 0 {
		t.Fatalf("%v", out)
	}
	if yara.seen[0] != "hello" {
		t.Fatalf("yara saw %q", yara.seen)
	}

	yara.matches = []YaraMatch{{Rule: "Oblimint_Webshell_Marker", Tags: []string{"webshell"}, Meta: map[string]any{"score": int64(80)}}}
	rec, out = do(t, h, "POST", "/v1/scan?name=x", testKey, []byte("VIRUS"))
	c := out["clamav"].(map[string]any)
	if rec.Code != 200 || c["status"] != "found" || c["signature"] != "Oblimint.Test.Virus" {
		t.Fatalf("%d %v", rec.Code, out)
	}
	m := out["yara"].(map[string]any)["matches"].([]any)[0].(map[string]any)
	if m["rule"] != "Oblimint_Webshell_Marker" || m["meta"].(map[string]any)["score"] != float64(80) {
		t.Fatalf("%v", m)
	}
	// Temp files are removed.
	if entries, _ := os.ReadDir(s.TmpDir); len(entries) != 0 {
		t.Fatalf("temp files left: %v", entries)
	}
}

func TestScanEngineErrorsAndDisabled(t *testing.T) {
	s, clam, yara := newTestServer(t)
	clam.verdict = func([]byte) (ClamResult, error) {
		return ClamResult{}, errors.New("dial unix /run/clamav/clamd.sock: connect: no such file")
	}
	yara.err = errors.New("yara failed: /usr/share/x: permission denied")
	h := s.Handler(1)
	_, out := do(t, h, "POST", "/v1/scan", testKey, []byte("x"))
	if out["clamav"].(map[string]any)["status"] != "error" || out["yara"].(map[string]any)["error"] != "yara failed" {
		t.Fatalf("%v", out)
	}
	body, _ := json.Marshal(out)
	if strings.Contains(string(body), "/run/") || strings.Contains(string(body), "/usr/") {
		t.Fatalf("raw engine error leaked: %s", body)
	}

	s2, _, _ := newTestServer(t)
	s2.ClamAV, s2.Yara = false, false
	_, out = do(t, s2.Handler(1), "POST", "/v1/scan", testKey, []byte("VIRUS"))
	if out["clamav"].(map[string]any)["status"] != "disabled" || out["yara"].(map[string]any)["disabled"] != true {
		t.Fatalf("%v", out)
	}

	s3, _, _ := newTestServer(t)
	s3.RulesErr = errors.New("missing")
	_, out = do(t, s3.Handler(1), "POST", "/v1/scan", testKey, []byte("x"))
	if out["yara"].(map[string]any)["error"] != "rules unavailable" {
		t.Fatalf("%v", out)
	}
}

func TestScanTooLarge(t *testing.T) {
	s, _, _ := newTestServer(t)
	h := s.Handler(1)
	rec, _ := do(t, h, "POST", "/v1/scan", testKey, bytes.Repeat([]byte("a"), 1025))
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("content-length: %d", rec.Code)
	}
	// Chunked body without Content-Length.
	req := httptest.NewRequest("POST", "/v1/scan", io.MultiReader(bytes.NewReader(bytes.Repeat([]byte("a"), 2000))))
	req.ContentLength = -1
	req.Header.Set(keyHeader, testKey)
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("chunked: %d", rr.Code)
	}
	rec, _ = do(t, h, "POST", "/v1/scan", testKey, bytes.Repeat([]byte("a"), 1024))
	if rec.Code != 200 {
		t.Fatalf("exact limit: %d", rec.Code)
	}
}

func TestStatusAndUpdate(t *testing.T) {
	s, clam, _ := newTestServer(t)
	up := &fakeUpdater{}
	s.Updater = up
	h := s.Handler(1)
	_, out := do(t, h, "GET", "/v1/status", testKey, nil)
	c := out["clamav"].(map[string]any)
	y := out["yara"].(map[string]any)
	if c["available"] != true || c["version"] != "1.4.3" || c["signatureVersion"] != "27420" || c["signaturesUpdatedAt"] != "2026-10-08T08:24:32Z" {
		t.Fatalf("clamav: %v", c)
	}
	if y["available"] != true || y["ruleCount"] != float64(33) || y["signatureVersion"] != "oblimint-1" || y["version"] != "4.5.2" {
		t.Fatalf("yara: %v", y)
	}

	rec, _ := do(t, h, "POST", "/v1/update", testKey, nil)
	if rec.Code != 200 || up.calls != 1 {
		t.Fatalf("update: %d %d", rec.Code, up.calls)
	}
	up.err = errors.New("freshclam failed: exit status 55")
	rec, out = do(t, h, "POST", "/v1/update", testKey, nil)
	if rec.Code != http.StatusBadGateway || out["error"] != "signature update failed" {
		t.Fatalf("update failure: %d %v", rec.Code, out)
	}

	clam.err = errors.New("connection refused")
	_, out = do(t, h, "GET", "/v1/status", testKey, nil)
	c = out["clamav"].(map[string]any)
	if c["available"] != false || !strings.Contains(c["error"].(string), "not answering") || c["lastUpdateFailedAt"] == nil {
		t.Fatalf("clamd down: %v", c)
	}

	s.ClamAV = false
	rec, out = do(t, h, "POST", "/v1/update", testKey, nil)
	if rec.Code != 200 || out["skipped"] != true {
		t.Fatalf("update without ClamAV: %d %v", rec.Code, out)
	}
}
