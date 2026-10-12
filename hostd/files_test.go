//go:build linux

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Ownership is real here (fchown): run as root (the hostd test container).
func filesFixture(t *testing.T) (*fileManager, string, Owner) {
	t.Helper()
	if os.Geteuid() != 0 {
		t.Skip("needs root (ownership checks)")
	}
	root := t.TempDir()
	o := Owner{10001, 10001}
	acct := filepath.Join(root, "accounts", "1")
	mk := func(rel string, uid, gid int, mode os.FileMode) {
		p := filepath.Join(acct, rel)
		if err := os.MkdirAll(p, mode); err != nil {
			t.Fatal(err)
		}
		if err := os.Chown(p, uid, gid); err != nil {
			t.Fatal(err)
		}
	}
	mk("", 0, 0, 0o711)
	mk("staging", o.UID, o.GID, 0o750)
	mk("staging/site", o.UID, o.GID, 0o750)
	mk("data", 0, o.GID, 0o750)
	mk("data/site", 0, o.GID, 0o750)
	mk("data/site/uploads", o.UID, o.GID, 0o750)
	return newFileManager(newLayout(root), fdOwner, time.Now), acct, o
}

func segs(t *testing.T, p string) []string {
	t.Helper()
	s, err := splitFilesPath(p)
	if err != nil {
		t.Fatalf("%s: %v", p, err)
	}
	return s
}

func code(err error) string {
	_, c := classify(err)
	return c
}

func TestSplitFilesPath(t *testing.T) {
	for _, bad := range []string{"", "/", "sites/1", "staging/../x", "staging//a", "staging/./a", "releases/x", "staging/a\x00b"} {
		if _, err := splitFilesPath(bad); err == nil {
			t.Errorf("%q accepted", bad)
		}
	}
	if s, err := splitFilesPath("/staging/site/a b/é.txt/"); err != nil || len(s) != 4 {
		t.Fatalf("got %v %v", s, err)
	}
}

func TestFilesMkdirListDelete(t *testing.T) {
	m, acct, o := filesFixture(t)
	if err := m.Mkdir(1, segs(t, "staging/site/css"), o); err != nil {
		t.Fatal(err)
	}
	fi, err := os.Lstat(filepath.Join(acct, "staging/site/css"))
	if err != nil || ownerOf(fi) != o || fi.Mode().Perm() != filesDirMode {
		t.Fatalf("owner/mode: %v %v %v", err, ownerOf(fi), fi.Mode())
	}
	if err := m.Mkdir(1, segs(t, "staging/site/css"), o); code(err) != codeExists {
		t.Fatalf("second mkdir: %v", err)
	}
	// First two levels and root-owned directories: refused like SFTP.
	if err := m.Mkdir(1, segs(t, "staging/other"), o); code(err) != codeForbidden {
		t.Fatalf("staging/other: %v", err)
	}
	if err := m.Mkdir(1, segs(t, "data/site/x"), o); code(err) != codeForbidden {
		t.Fatalf("data/site/x: %v", err)
	}
	if err := m.Mkdir(1, segs(t, "data/site/uploads/x"), o); err != nil {
		t.Fatalf("data path: %v", err)
	}
	os.WriteFile(filepath.Join(acct, "staging/site/index.php"), []byte("<?php"), 0o644)
	os.Symlink("/etc", filepath.Join(acct, "staging/site/evil"))
	os.WriteFile(filepath.Join(acct, "staging/site", uploadTmpPrefix+strings.Repeat("a", 32)), nil, 0o600)
	l, err := m.List(context.Background(), 1, segs(t, "staging/site"))
	if err != nil {
		t.Fatal(err)
	}
	if l.UID != o.UID || len(l.Entries) != 3 {
		t.Fatalf("listing: %+v", l)
	}
	if e := l.Entries[1]; e.Name != "evil" || e.Kind != "symlink" || e.Target != "/etc" {
		t.Fatalf("symlink entry: %+v", e)
	}
	// Never through a link.
	if _, err := m.List(context.Background(), 1, segs(t, "staging/site/evil")); code(err) != codeUnsafePath {
		t.Fatalf("list through link: %v", err)
	}
	if err := m.Mkdir(1, segs(t, "staging/site/evil/x"), o); code(err) != codeUnsafePath {
		t.Fatalf("mkdir through link: %v", err)
	}
	if _, _, err := m.Open(1, segs(t, "staging/site/evil")); code(err) != codeNotRegular {
		t.Fatalf("open link: %v", err)
	}
	// Deleting the link removes the link only.
	if err := m.Delete(1, segs(t, "staging/site/evil"), o); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat("/etc/passwd"); err != nil {
		t.Fatal("target touched")
	}
	if err := m.Delete(1, segs(t, "staging/site/css"), o); err != nil {
		t.Fatal(err)
	}
	if err := m.Delete(1, segs(t, "staging/site"), o); code(err) != codeForbidden {
		t.Fatalf("site root deleted: %v", err)
	}
}

func TestFilesMoveCopy(t *testing.T) {
	m, acct, o := filesFixture(t)
	site := filepath.Join(acct, "staging/site")
	os.MkdirAll(filepath.Join(site, "a/b"), 0o755)
	os.WriteFile(filepath.Join(site, "a/b/f.txt"), []byte("hello"), 0o644)
	os.WriteFile(filepath.Join(site, "g.txt"), []byte("g"), 0o644)
	filepath.Walk(site, func(p string, _ os.FileInfo, _ error) error { return os.Lchown(p, o.UID, o.GID) })

	if err := m.Move(1, segs(t, "staging/site/a"), segs(t, "staging/site/a/b/c"), o, false); code(err) != codeInvalid {
		t.Fatalf("move into itself: %v", err)
	}
	if err := m.Copy(context.Background(), 1, segs(t, "staging/site/a"), segs(t, "staging/site/a2"), o); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(filepath.Join(site, "a2/b/f.txt")); string(b) != "hello" {
		t.Fatalf("copy content %q", b)
	}
	if err := m.Move(1, segs(t, "staging/site/g.txt"), segs(t, "staging/site/a/b/f.txt"), o, false); code(err) != codeExists {
		t.Fatalf("no overwrite: %v", err)
	}
	if err := m.Move(1, segs(t, "staging/site/g.txt"), segs(t, "staging/site/a/b/f.txt"), o, true); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(filepath.Join(site, "a/b/f.txt")); string(b) != "g" {
		t.Fatalf("overwrite content %q", b)
	}
	if err := m.Move(1, segs(t, "staging/site/a2"), segs(t, "staging/site/a"), o, true); code(err) != codeExists {
		t.Fatalf("directory replaced: %v", err)
	}
	// Into a root-owned directory: refused.
	if err := m.Move(1, segs(t, "staging/site/a2"), segs(t, "data/site/a2"), o, false); code(err) != codeForbidden {
		t.Fatalf("move to data/site: %v", err)
	}
	if err := m.Move(1, segs(t, "staging/site/a2"), segs(t, "data/site/uploads/a2"), o, false); err != nil {
		t.Fatalf("move to data path: %v", err)
	}
}

func TestFilesUpload(t *testing.T) {
	m, acct, o := filesFixture(t)
	p := segs(t, "staging/site/big.bin")
	id := strings.Repeat("0123456789abcdef", 2)
	data := bytes.Repeat([]byte("0123456789"), 1000) // 10 000 bytes, 3 chunks of 4 096
	if err := m.UploadBegin(1, p, o, id, int64(len(data)), false); err != nil {
		t.Fatal(err)
	}
	if err := m.UploadBegin(1, p, o, id, int64(len(data)), false); err != nil {
		t.Fatalf("replayed begin: %v", err)
	}
	for _, off := range []int64{8192, 0, 4096} { // any order
		end := min(off+4096, int64(len(data)))
		if err := m.UploadChunk(1, p, o, id, off, end-off, bytes.NewReader(data[off:end])); err != nil {
			t.Fatal(err)
		}
	}
	if err := m.UploadCommit(1, p, o, id, int64(len(data))+1, false); code(err) != codeInvalid {
		t.Fatalf("size mismatch: %v", err)
	}
	if err := m.UploadCommit(1, p, o, id, int64(len(data)), false); err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(filepath.Join(acct, "staging/site/big.bin"))
	fi, _ := os.Lstat(filepath.Join(acct, "staging/site/big.bin"))
	if !bytes.Equal(got, data) || ownerOf(fi) != o || fi.Mode().Perm() != filesFileMode {
		t.Fatalf("content/owner/mode: %d bytes %v %v", len(got), ownerOf(fi), fi.Mode())
	}
	// Second upload onto the same name: refused without overwrite (at begin and at commit).
	if err := m.UploadBegin(1, p, o, id, 1, false); code(err) != codeExists {
		t.Fatalf("begin without overwrite: %v", err)
	}
	if err := m.UploadBegin(1, p, o, id, 1, true); err != nil {
		t.Fatal(err)
	}
	m.UploadChunk(1, p, o, id, 0, 1, bytes.NewReader([]byte("x")))
	if err := m.UploadCommit(1, p, o, id, 1, false); code(err) != codeExists {
		t.Fatalf("overwrite without flag: %v", err)
	}
	// The tenant swaps the temporary file for a link: refused, target untouched.
	tmp := filepath.Join(acct, "staging/site", uploadTmpPrefix+id)
	os.Remove(tmp)
	os.Symlink("/etc/passwd", tmp)
	if err := m.UploadChunk(1, p, o, id, 0, 1, bytes.NewReader([]byte("x"))); code(err) != codeUnsafePath {
		t.Fatalf("chunk into link: %v", err)
	}
	if err := m.UploadAbort(1, p, o, id); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(tmp); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("temporary not removed")
	}
	// A root file hard-linked as the temporary: refused (owner check).
	os.WriteFile(filepath.Join(acct, "rootfile"), []byte("secret"), 0o600)
	os.Link(filepath.Join(acct, "rootfile"), tmp)
	if err := m.UploadChunk(1, p, o, id, 0, 1, bytes.NewReader([]byte("x"))); code(err) != codeUnsafePath {
		t.Fatalf("chunk into a root hard link: %v", err)
	}
}

func TestFilesStaleTemporarySwept(t *testing.T) {
	m, acct, _ := filesFixture(t)
	tmp := filepath.Join(acct, "staging/site", uploadTmpPrefix+strings.Repeat("b", 32))
	os.WriteFile(tmp, []byte("x"), 0o600)
	old := time.Now().Add(-2 * uploadStaleAfter)
	os.Chtimes(tmp, old, old)
	if _, err := m.List(context.Background(), 1, segs(t, "staging/site")); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(tmp); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("stale temporary kept")
	}
}

// HTTP contract (api_files.go) end to end on a real tree.
func TestFilesAPI(t *testing.T) {
	m, acct, o := filesFixture(t)
	a := &api{files: m}
	mux := http.NewServeMux()
	registerFiles(mux, a)
	call := func(method, target, body string, hdr ...string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(method, target, strings.NewReader(body))
		for i := 0; i+1 < len(hdr); i += 2 {
			req.Header.Set(hdr[i], hdr[i+1])
		}
		mux.ServeHTTP(rec, req)
		return rec
	}
	owner := fmt.Sprintf(`"uid":%d,"gid":%d`, o.UID, o.GID)
	id := strings.Repeat("c", 32)
	if r := call("POST", "/v1/accounts/1/files/mkdir", `{`+owner+`,"path":"staging/site/img"}`); r.Code != 200 {
		t.Fatalf("mkdir: %d %s", r.Code, r.Body)
	}
	if r := call("POST", "/v1/accounts/1/files/uploads/"+id, `{`+owner+`,"path":"staging/site/img/a.txt","size":11}`); r.Code != 200 {
		t.Fatalf("begin: %d %s", r.Code, r.Body)
	}
	q := fmt.Sprintf("?path=staging/site/img/a.txt&uid=%d&gid=%d&offset=", o.UID, o.GID)
	if r := call("PUT", "/v1/accounts/1/files/uploads/"+id+q+"6", "world"); r.Code != 200 {
		t.Fatalf("chunk 2: %d %s", r.Code, r.Body)
	}
	if r := call("PUT", "/v1/accounts/1/files/uploads/"+id+q+"0", "hello "); r.Code != 200 {
		t.Fatalf("chunk 1: %d %s", r.Code, r.Body)
	}
	if r := call("POST", "/v1/accounts/1/files/uploads/"+id+"/commit", `{`+owner+`,"path":"staging/site/img/a.txt","size":11}`); r.Code != 200 {
		t.Fatalf("commit: %d %s", r.Code, r.Body)
	}
	r := call("GET", "/v1/accounts/1/files/content?path=staging/site/img/a.txt", "", "Range", "bytes=6-")
	if r.Code != http.StatusPartialContent || r.Body.String() != "world" || r.Header().Get("X-Oblimint-Size") != "11" {
		t.Fatalf("range read: %d %q %v", r.Code, r.Body, r.Header())
	}
	r = call("GET", "/v1/accounts/1/files?path=staging/site/img", "")
	var l FileListing
	if err := json.Unmarshal(r.Body.Bytes(), &l); err != nil || len(l.Entries) != 1 || l.Entries[0].Size != 11 {
		t.Fatalf("listing: %d %s", r.Code, r.Body)
	}
	if r := call("POST", "/v1/accounts/1/files/move", `{`+owner+`,"from":"staging/site/img/a.txt","to":"data/site/a.txt"}`); r.Code != 403 {
		t.Fatalf("move into root-owned dir: %d %s", r.Code, r.Body)
	}
	if r := call("POST", "/v1/accounts/1/files/delete", `{`+owner+`,"path":"staging/site/img"}`); r.Code != 200 {
		t.Fatalf("delete: %d %s", r.Code, r.Body)
	}
	if _, err := os.Lstat(filepath.Join(acct, "staging/site/img")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("not deleted")
	}
	if r := call("GET", "/v1/accounts/1/files?path=../../etc", ""); r.Code != 400 {
		t.Fatalf("escape: %d", r.Code)
	}
}
