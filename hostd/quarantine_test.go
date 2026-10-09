package main

import (
	"encoding/base64"
	"encoding/json"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func newTestStore(t *testing.T) (*testManager, *quarantineStore) {
	t.Helper()
	tm := newTestManager(t)
	tm.mkSite(t, 7, 9, 3, nil)
	return tm, tm.quarantine
}

func dataEntry(path string) QuarantineEntry {
	return QuarantineEntry{AccountID: 7, SiteID: i64Ptr(9), Slug: strPtr("blog"), Source: sourceTyped, Area: areaData,
		Path: path, DataPath: strPtr("uploads"), Reason: reasonPolyglot, Detail: strPtr("<?php"), DetectedType: strPtr("jpeg")}
}

func TestQuarantineMoveListPreviewDelete(t *testing.T) {
	tm, q := newTestStore(t)
	payload := jpegHead + phpOpen + " echo 1;"
	writeTree(t, tm.abs("accounts/7/data/blog/uploads/2026"), map[string]string{"x.jpg": payload})
	parent := openRoots(t, tm.abs("accounts/7/data/blog/uploads/2026"))[0]
	e, err := q.moveIn(7, parent, "x.jpg", dataEntry("uploads/2026/x.jpg"))
	if err != nil {
		t.Fatal(err)
	}
	if !quarantineIDRe.MatchString(e.ID) || !strings.HasPrefix(e.ID, "20261009t031500-") {
		t.Errorf("entry id %q", e.ID)
	}
	if e.Size != int64(len(payload)) || e.SHA256 != sum(payload) || e.QuarantinedAt != "2026-10-09T03:15:00Z" || e.RestoredAt != nil {
		t.Errorf("entry %+v", e)
	}
	// Moved (never deleted, never left in place).
	if exists(tm.abs("accounts/7/data/blog/uploads/2026/x.jpg")) {
		t.Error("file still in the data path")
	}
	dir := tm.abs("accounts/7/quarantine/" + e.ID)
	if got := readFile(t, filepath.Join(dir, "content")); got != payload {
		t.Errorf("content %q", got)
	}
	// Root-only store (M3, M9).
	for p, want := range map[string]string{
		"accounts/7/quarantine":                      "0:0 0700",
		"accounts/7/quarantine/" + e.ID:              "0:0 0700",
		"accounts/7/quarantine/" + e.ID + "/content": "0:0 0600",
	} {
		if got := tm.owners.got[p]; got != want {
			t.Errorf("owner of %s = %q, want %q", p, got, want)
		}
	}
	var meta map[string]any
	if err := json.Unmarshal([]byte(readFile(t, filepath.Join(dir, "meta.json"))), &meta); err != nil {
		t.Fatal(err)
	}
	if meta["kind"] != "file" || meta["path"] != "uploads/2026/x.jpg" || meta["dataPath"] != "uploads" {
		t.Errorf("meta %v", meta)
	}

	list, err := q.list(7)
	if err != nil || len(list) != 1 || list[0].ID != e.ID || list[0].Reason != reasonPolyglot {
		t.Fatalf("list %+v %v", list, err)
	}
	p, err := q.preview(7, e.ID, 5)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := base64.StdEncoding.DecodeString(p.Base64)
	if string(raw) != payload[:5] || !p.Truncated || p.Size != int64(len(payload)) {
		t.Errorf("preview %+v", p)
	}
	if _, err := q.preview(7, "nope-nope", 10); statusOf(err) != 404 {
		t.Errorf("missing entry preview: %v", err)
	}
	if _, err := q.preview(7, "../../etc", 10); statusOf(err) != 400 {
		t.Errorf("path as entry id: %v", err)
	}
	if err := q.remove(7, e.ID); err != nil {
		t.Fatal(err)
	}
	if exists(dir) {
		t.Error("entry not deleted")
	}
	if err := q.remove(7, e.ID); err != nil {
		t.Errorf("delete is idempotent: %v", err)
	}
	if list, err := q.list(8); statusOf(err) != 404 || list != nil {
		t.Errorf("unknown account: %v %v", list, err)
	}
}

func TestQuarantineRestoreData(t *testing.T) {
	tm, q := newTestStore(t)
	writeTree(t, tm.abs("accounts/7/data/blog/uploads"), map[string]string{"a.jpg": "legit but odd"})
	parent := openRoots(t, tm.abs("accounts/7/data/blog/uploads"))[0]
	e, err := q.moveIn(7, parent, "a.jpg", dataEntry("uploads/a.jpg"))
	if err != nil {
		t.Fatal(err)
	}
	owner := Owner{20001, 20002}
	// The path is taken meanwhile: refused without overwrite.
	writeTree(t, tm.abs("accounts/7/data/blog/uploads"), map[string]string{"a.jpg": "new upload"})
	_, err = tm.RestoreQuarantine(bg, 7, e.ID, owner, false)
	if code := codeOf(err); code != codeRestoreConflict {
		t.Fatalf("restore over an existing file: %v", err)
	}
	res, err := tm.RestoreQuarantine(bg, 7, e.ID, owner, true)
	if err != nil || !res.Restored || res.Path != "uploads/a.jpg" {
		t.Fatalf("restore %+v %v", res, err)
	}
	if got := readFile(t, tm.abs("accounts/7/data/blog/uploads/a.jpg")); got != "legit but odd" {
		t.Errorf("restored content %q", got)
	}
	// The entry is kept (restoredAt set), its content gone; (path, sha256) allowed.
	list, _ := q.list(7)
	if len(list) != 1 || list[0].RestoredAt == nil || *list[0].RestoredAt != "2026-10-09T03:15:00Z" {
		t.Errorf("entry after restore %+v", list)
	}
	if !q.allowed(7, allowEntry{Area: areaData, Slug: "blog", Path: "uploads/a.jpg", SHA256: sum("legit but odd")}) {
		t.Error("restored file not allow-listed")
	}
	if q.allowed(7, allowEntry{Area: areaData, Slug: "blog", Path: "uploads/a.jpg", SHA256: sum("other")}) {
		t.Error("allow-list ignores the content")
	}
	if _, err := tm.RestoreQuarantine(bg, 7, e.ID, owner, true); codeOf(err) != codeConflict {
		t.Errorf("second restore: %v", err)
	}
	// Restored as the account, through the descriptor (mode without group /
	// world write).
	if got := tm.owners.got["accounts/7/data/blog/uploads/a.jpg"]; got != "20001:20002 0644" {
		t.Errorf("restored owner %q", got)
	}
}

func TestQuarantineRestoreCodeNeedsOpenWindow(t *testing.T) {
	tm, q := newTestStore(t)
	e, err := q.copyIn(7, strings.NewReader(phpOpen+" echo 1;"), fakeFileInfo{name: "x.php", size: 14, mode: 0o644},
		QuarantineEntry{AccountID: 7, SiteID: i64Ptr(9), Slug: strPtr("blog"), Source: sourceSupervised, Area: areaCode, Path: "wp-content/x.php", Reason: reasonExecutableWrite})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tm.RestoreQuarantine(bg, 7, e.ID, tenant, false); codeOf(err) != codeConflict {
		t.Fatalf("code restore without a window: %v", err)
	}
	// A window mounted rw over release 3: restored through the merged view.
	tm.mnt.table = append(tm.mnt.table, Mount{MountPoint: tm.layout.Release(7, 9, 3), FSType: "overlay", Source: "oblimint-window-5", Options: []string{"rw"}})
	res, err := tm.RestoreQuarantine(bg, 7, e.ID, tenant, false)
	if err != nil || res.Path != "wp-content/x.php" {
		t.Fatalf("restore %+v %v", res, err)
	}
	if got := readFile(t, tm.abs("accounts/7/sites/9/releases/3/wp-content/x.php")); got != phpOpen+" echo 1;" {
		t.Errorf("restored %q", got)
	}
	if got := tm.owners.got["accounts/7/sites/9/releases/3/wp-content"]; got != "20001:20002 0755" {
		t.Errorf("created dir in the merged view: %q", got)
	}
}

func TestQuarantineRestoreNeverFollowsLinks(t *testing.T) {
	tm, q := newTestStore(t)
	writeTree(t, tm.abs("accounts/7/data/blog/uploads/sub"), map[string]string{"a.jpg": "x"})
	parent := openRoots(t, tm.abs("accounts/7/data/blog/uploads/sub"))[0]
	e, err := q.moveIn(7, parent, "a.jpg", dataEntry("uploads/sub/a.jpg"))
	if err != nil {
		t.Fatal(err)
	}
	parent.Close()
	outside := t.TempDir()
	if err := os.Remove(tm.abs("accounts/7/data/blog/uploads/sub")); err != nil {
		t.Fatal(err)
	}
	dirLinkOrSkip(t, outside, tm.abs("accounts/7/data/blog/uploads/sub"))
	if _, err := tm.RestoreQuarantine(bg, 7, e.ID, tenant, false); statusOf(err) != 409 {
		t.Errorf("restore through a linked parent: %v", err)
	}
	if exists(filepath.Join(outside, "a.jpg")) {
		t.Error("restored through a link")
	}
}

func codeOf(err error) string {
	if err == nil {
		return ""
	}
	_, code := classify(err)
	return code
}

// fakeFileInfo is the lstat result of a file that is not on disk.
type fakeFileInfo struct {
	name string
	size int64
	mode fs.FileMode
}

func (f fakeFileInfo) Name() string       { return f.name }
func (f fakeFileInfo) Size() int64        { return f.size }
func (f fakeFileInfo) Mode() fs.FileMode  { return f.mode }
func (f fakeFileInfo) ModTime() time.Time { return p3Now }
func (f fakeFileInfo) IsDir() bool        { return f.mode.IsDir() }
func (f fakeFileInfo) Sys() any           { return nil }
