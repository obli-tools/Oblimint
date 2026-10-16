//go:build linux

package main

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"context"
	"io"
	"os"
	"path/filepath"
	"sort"
	"testing"
)

func writeZip(t *testing.T, p string, entries map[string]string, links map[string]string) {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	names := make([]string, 0, len(entries))
	for n := range entries {
		names = append(names, n)
	}
	sort.Strings(names)
	for _, n := range names {
		w, _ := zw.Create(n)
		w.Write([]byte(entries[n]))
	}
	for n, target := range links {
		h := &zip.FileHeader{Name: n}
		h.SetMode(os.ModeSymlink | 0o777)
		w, _ := zw.CreateHeader(h)
		w.Write([]byte(target))
	}
	zw.Close()
	if err := os.WriteFile(p, buf.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestFilesExtractZip(t *testing.T) {
	m, acct, o := filesFixture(t)
	site := filepath.Join(acct, "staging/site")
	writeZip(t, filepath.Join(site, "a.zip"), map[string]string{
		"wp/index.php":       "<?php",
		"wp/inc/conf.php":    "conf",
		"../escape.txt":      "no",
		"/abs.txt":           "abs is cleaned",
		"wp/link/inside.txt": "blocked by the link",
	}, map[string]string{"wp/evil": "/etc/passwd"})
	os.Chown(filepath.Join(site, "a.zip"), o.UID, o.GID)
	os.MkdirAll(filepath.Join(site, "out/wp"), 0o755)
	os.Symlink("/etc", filepath.Join(site, "out/wp/link"))
	filepath.Walk(filepath.Join(site, "out"), func(p string, _ os.FileInfo, _ error) error { return os.Lchown(p, o.UID, o.GID) })

	res, err := m.Extract(context.Background(), 1, segs(t, "staging/site/a.zip"), segs(t, "staging/site/out"), o, false)
	if err != nil {
		t.Fatal(err)
	}
	if res.Files != 3 || len(res.Conflicts) != 1 || res.Conflicts[0] != "wp/link/inside.txt" {
		t.Fatalf("result: %+v", res)
	}
	b, _ := os.ReadFile(filepath.Join(site, "out/wp/inc/conf.php"))
	fi, _ := os.Lstat(filepath.Join(site, "out/wp/inc/conf.php"))
	if string(b) != "conf" || ownerOf(fi) != o || fi.Mode().Perm() != filesFileMode {
		t.Fatalf("content/owner: %q %v %v", b, ownerOf(fi), fi.Mode())
	}
	if _, err := os.Lstat(filepath.Join(site, "out/abs.txt")); err != nil {
		t.Fatal("absolute name not confined into the target")
	}
	for _, p := range []string{filepath.Join(acct, "staging/escape.txt"), filepath.Join(site, "escape.txt"), filepath.Join(site, "out/wp/evil")} {
		if _, err := os.Lstat(p); err == nil {
			t.Fatalf("%s created", p)
		}
	}
	// Existing files are kept unless overwrite.
	os.WriteFile(filepath.Join(site, "out/wp/index.php"), []byte("mine"), 0o644)
	m.Extract(context.Background(), 1, segs(t, "staging/site/a.zip"), segs(t, "staging/site/out"), o, false)
	if b, _ := os.ReadFile(filepath.Join(site, "out/wp/index.php")); string(b) != "mine" {
		t.Fatal("existing file replaced without overwrite")
	}
	m.Extract(context.Background(), 1, segs(t, "staging/site/a.zip"), segs(t, "staging/site/out"), o, true)
	if b, _ := os.ReadFile(filepath.Join(site, "out/wp/index.php")); string(b) != "<?php" {
		t.Fatal("not replaced with overwrite")
	}
	// Into a root-owned directory: refused.
	if _, err := m.Extract(context.Background(), 1, segs(t, "staging/site/a.zip"), segs(t, "data/site"), o, false); code(err) != codeForbidden {
		t.Fatalf("extract into data/site: %v", err)
	}
}

func TestFilesExtractTarGz(t *testing.T) {
	m, acct, o := filesFixture(t)
	site := filepath.Join(acct, "staging/site")
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	tw.WriteHeader(&tar.Header{Name: "app/", Typeflag: tar.TypeDir, Mode: 0o755})
	tw.WriteHeader(&tar.Header{Name: "app/a.txt", Typeflag: tar.TypeReg, Mode: 0o600, Size: 2})
	tw.Write([]byte("hi"))
	tw.WriteHeader(&tar.Header{Name: "app/l", Typeflag: tar.TypeSymlink, Linkname: "/etc/shadow"})
	tw.WriteHeader(&tar.Header{Name: "app/h", Typeflag: tar.TypeLink, Linkname: "/etc/shadow"})
	tw.Close()
	gz.Close()
	os.WriteFile(filepath.Join(site, "x.tar.gz"), buf.Bytes(), 0o644)
	res, err := m.Extract(context.Background(), 1, segs(t, "staging/site/x.tar.gz"), segs(t, "staging/site"), o, false)
	if err != nil || res.Files != 1 || res.Skipped != 2 {
		t.Fatalf("%+v %v", res, err)
	}
	if b, _ := os.ReadFile(filepath.Join(site, "app/a.txt")); string(b) != "hi" {
		t.Fatal("content")
	}
}

func TestFilesZipStream(t *testing.T) {
	m, acct, o := filesFixture(t)
	site := filepath.Join(acct, "staging/site")
	os.MkdirAll(filepath.Join(site, "d/e"), 0o755)
	os.WriteFile(filepath.Join(site, "d/e/f.txt"), []byte("deep"), 0o644)
	os.WriteFile(filepath.Join(site, "g.txt"), []byte("top"), 0o644)
	os.Symlink("/etc", filepath.Join(site, "d/link"))
	_ = o
	var buf bytes.Buffer
	if err := m.WriteZip(context.Background(), 1, segs(t, "staging/site"), []string{"d", "g.txt", "../x"}, &buf); err != nil {
		t.Fatal(err)
	}
	zr, err := zip.NewReader(bytes.NewReader(buf.Bytes()), int64(buf.Len()))
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]string{}
	for _, f := range zr.File {
		rc, _ := f.Open()
		b, _ := io.ReadAll(rc)
		got[f.Name] = string(b)
	}
	if got["d/e/f.txt"] != "deep" || got["g.txt"] != "top" || len(got) != 4 {
		t.Fatalf("zip: %v", got)
	}
	if _, ok := got["d/link"]; ok {
		t.Fatal("link followed / stored")
	}
}

func TestFilesTarRoundTrip(t *testing.T) {
	m, acct, o := filesFixture(t)
	site := filepath.Join(acct, "staging/site")
	os.MkdirAll(filepath.Join(site, "css"), 0o755)
	os.WriteFile(filepath.Join(site, "index.php"), []byte("<?php echo 1;"), 0o644)
	os.WriteFile(filepath.Join(site, "css/a.css"), []byte("body{}"), 0o644)
	os.Symlink("/etc/passwd", filepath.Join(site, "evil"))
	os.WriteFile(filepath.Join(acct, "data/site/uploads/photo.jpg"), []byte("jpg"), 0o644)
	filepath.Walk(acct, func(p string, _ os.FileInfo, _ error) error { return nil })
	var buf bytes.Buffer
	if err := m.WriteTar(context.Background(), 1, [][]string{segs(t, "staging"), segs(t, "data")}, false, &buf); err != nil {
		t.Fatal(err)
	}
	names := map[string]byte{}
	tr := tar.NewReader(bytes.NewReader(buf.Bytes()))
	for {
		h, err := tr.Next()
		if err != nil {
			break
		}
		names[h.Name] = h.Typeflag
	}
	if names["staging/site/index.php"] != tar.TypeReg || names["staging/site/evil"] != tar.TypeSymlink || names["data/site/uploads/photo.jpg"] != tar.TypeReg {
		t.Fatalf("tar entries: %v", names)
	}
	// Relative tar of staging/site (the backup form), restored into the same folder.
	var site2 bytes.Buffer
	if err := m.WriteTar(context.Background(), 1, [][]string{segs(t, "staging/site")}, true, &site2); err != nil {
		t.Fatal(err)
	}
	rel := map[string]bool{}
	tr = tar.NewReader(bytes.NewReader(site2.Bytes()))
	for {
		h, err := tr.Next()
		if err != nil {
			break
		}
		rel[h.Name] = true
	}
	if !rel["index.php"] || !rel["css/a.css"] || !rel["css/"] || len(rel) != 4 {
		t.Fatalf("relative tar entries: %v", rel)
	}
	if err := m.WriteTar(context.Background(), 1, [][]string{segs(t, "staging"), segs(t, "data")}, true, io.Discard); err == nil {
		t.Fatal("relative tar of two roots accepted")
	}
	os.WriteFile(filepath.Join(site, "stale.txt"), []byte("x"), 0o644)
	res, err := m.Untar(context.Background(), 1, segs(t, "staging/site"), o, false, true, bytes.NewReader(site2.Bytes()))
	if err != nil {
		t.Fatal(err)
	}
	if res.Files != 2 {
		t.Fatalf("result %+v", res)
	}
	if _, err := os.Lstat(filepath.Join(site, "stale.txt")); err == nil {
		t.Fatal("clear did not empty the folder")
	}
	if _, err := os.Lstat(filepath.Join(site, "evil")); err == nil {
		t.Fatal("link restored")
	}
	b, _ := os.ReadFile(filepath.Join(site, "css/a.css"))
	fi, _ := os.Lstat(filepath.Join(site, "css/a.css"))
	if string(b) != "body{}" || ownerOf(fi) != o {
		t.Fatalf("content/owner %q %v", b, ownerOf(fi))
	}
}
