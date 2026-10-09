package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"
)

// layers builds a simulated window: lower (the release), merged (what the
// overlay shows) and upper (what overlayfs would have written) + the markers.
type layers struct {
	lower, upper, merged, out string
}

func newLayers(t *testing.T, lower, upper, merged map[string]string) layers {
	t.Helper()
	base := t.TempDir()
	l := layers{
		lower: filepath.Join(base, "lower"), upper: filepath.Join(base, "upper"),
		merged: filepath.Join(base, "merged"), out: filepath.Join(base, "out"),
	}
	for _, d := range []string{l.lower, l.upper, l.merged, l.out} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	writeTree(t, l.lower, lower)
	writeTree(t, l.upper, upper)
	writeTree(t, l.merged, merged)
	return l
}

func openRoots(t *testing.T, dirs ...string) []*os.Root {
	t.Helper()
	var out []*os.Root
	for _, d := range dirs {
		r, err := os.OpenRoot(d)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { r.Close() })
		out = append(out, r)
	}
	return out
}

func runExport(t *testing.T, l layers, attrs fakeAttrs, opts ExportOptions) ([]DiffEntry, ExportResult) {
	t.Helper()
	r := openRoots(t, l.upper, l.lower, l.merged, l.out)
	entries, res, err := exportDiff(context.Background(), r[0], r[1], r[2], r[3], attrs, opts)
	if err != nil {
		t.Fatal(err)
	}
	return entries, res
}

func summary(entries []DiffEntry) []string {
	var out []string
	for _, e := range entries {
		s := e.Change + " " + e.Type + " " + e.Path
		if e.Skipped != nil {
			s += " skipped=" + *e.Skipped
		}
		if e.Exported {
			s += " exported"
		}
		out = append(out, s)
	}
	slices.Sort(out)
	return out
}

func sum(s string) string {
	h := sha256.Sum256([]byte(s))
	return hex.EncodeToString(h[:])
}

var bigOpts = ExportOptions{MaxFileBytes: 1 << 20, MaxTotalBytes: 1 << 30, MaxEntries: 1000}

func TestExportDiff(t *testing.T) {
	lower := map[string]string{
		"keep.txt": "same", "mod.txt": "old", "same-size.txt": "aaaa", "chowned.php": "<?php echo 1;",
		"gone.txt": "bye", "olddir/a.txt": "a", "olddir/sub/b.txt": "b",
		"opq/x.txt": "x", "opq/y.txt": "y", "ren/r.txt": "r", "tc": "file before", "dir/": "",
		"exec.sh": "#!/bin/sh",
	}
	merged := map[string]string{
		"keep.txt": "same", "mod.txt": "new content", "same-size.txt": "bbbb", "chowned.php": "<?php echo 1;",
		"opq/y.txt": "y2", "opq/z.txt": "z", "renamed/r.txt": "r", "tc/inner.txt": "inner",
		"new/deep/n.txt": "n", "big.bin": strings.Repeat("B", 2048), "dir/": "", "exec.sh": "#!/bin/sh",
	}
	upper := map[string]string{
		"mod.txt": "new content", "same-size.txt": "bbbb",
		"chowned.php": "",                          // metadata-only copy-up (chown walk)
		"gone.txt":    "", "olddir": "", "ren": "", // whiteouts (char devices 0/0 on Linux)
		"opq/y.txt": "y2", "opq/z.txt": "z", // opaque directory
		"renamed/":       "",      // redirected directory (rename of ren/)
		"tc/inner.txt":   "inner", // a directory replacing a file
		"new/deep/n.txt": "n", "big.bin": strings.Repeat("B", 2048),
		"dir/":    "", // copied up by the chown walk (plain merge dir)
		"exec.sh": "",
	}
	attrs := fakeAttrs{
		"chowned.php": {metacopy: true},
		"gone.txt":    {whiteout: true}, "olddir": {whiteout: true}, "ren": {whiteout: true},
		"opq":     {opaque: true},
		"renamed": {redirect: true},
		"exec.sh": {metacopy: true},
	}
	l := newLayers(t, lower, upper, merged)
	if err := os.Chmod(filepath.Join(l.merged, "exec.sh"), 0o755); err != nil {
		t.Fatal(err)
	}
	entries, res := runExport(t, l, attrs, ExportOptions{MaxFileBytes: 1024, MaxTotalBytes: 1 << 20, MaxEntries: 100})

	want := []string{
		"added file big.bin skipped=tooLarge",
		"added file new/deep/n.txt exported",
		"added file opq/z.txt exported",
		"added file renamed/r.txt exported",
		"added file tc/inner.txt exported",
		"deleted dir olddir",
		"deleted dir olddir/sub",
		"deleted dir ren",
		"deleted file gone.txt",
		"deleted file olddir/a.txt",
		"deleted file olddir/sub/b.txt",
		"deleted file opq/x.txt",
		"deleted file ren/r.txt",
		"modified file mod.txt exported",
		"modified file opq/y.txt exported",
		"modified file same-size.txt exported",
		"typechange dir tc",
	}
	if execBitSupported(t, l.merged) {
		want = append(want, "modified file exec.sh exported")
		slices.Sort(want)
	}
	if got := summary(entries); !slices.Equal(got, want) {
		t.Errorf("entries:\n got %q\nwant %q", got, want)
	}
	if res.Entries != len(want) || res.Added != 5 || res.Deleted != 8 || res.Truncated {
		t.Errorf("result: %+v", res)
	}
	for _, e := range entries {
		switch e.Path {
		case "mod.txt":
			if e.SHA256 == nil || *e.SHA256 != sum("new content") || *e.Size != 11 || e.Mode == nil {
				t.Errorf("mod.txt entry: %+v", e)
			}
		case "big.bin":
			if e.Exported || e.SHA256 == nil || *e.SHA256 != sum(strings.Repeat("B", 2048)) || *e.Size != 2048 {
				t.Errorf("big.bin entry: %+v", e)
			}
		case "gone.txt", "olddir":
			if e.Size != nil || e.SHA256 != nil || e.Exported {
				t.Errorf("deletion with content: %+v", e)
			}
		}
	}
	// New content copied into the export, nothing else.
	if got := readFile(t, filepath.Join(l.out, "mod.txt")); got != "new content" {
		t.Errorf("export mod.txt = %q", got)
	}
	if got := readFile(t, filepath.Join(l.out, "renamed", "r.txt")); got != "r" {
		t.Errorf("export renamed/r.txt = %q", got)
	}
	for _, p := range []string{"keep.txt", "chowned.php", "big.bin", "gone.txt"} {
		if exists(filepath.Join(l.out, p)) {
			t.Errorf("%s exported", p)
		}
	}
	if res.Bytes != int64(len("new content")+len("y2")+len("z")+len("r")+len("inner")+len("n")+len("bbbb")) && !execBitSupported(t, l.merged) {
		t.Errorf("bytes = %d", res.Bytes)
	}
}

// execBitSupported: Windows has no exec bit (the exec-bit case only runs on Linux).
func execBitSupported(t *testing.T, dir string) bool {
	t.Helper()
	fi, err := os.Stat(filepath.Join(dir, "exec.sh"))
	return err == nil && fi.Mode().Perm()&0o111 != 0
}

func TestExportDiffChownOnlyIsEmpty(t *testing.T) {
	tree := map[string]string{"index.php": "<?php", "wp/a.php": "a", "wp/b/": ""}
	upper := map[string]string{"index.php": "", "wp/a.php": "", "wp/b/": ""}
	attrs := fakeAttrs{"index.php": {metacopy: true}, "wp/a.php": {metacopy: true}}
	entries, res := runExport(t, newLayers(t, tree, upper, tree), attrs, bigOpts)
	if len(entries) != 0 || res.Entries != 0 {
		t.Errorf("a chown-only window has changes: %v", summary(entries))
	}
	// The same paths fully copied up (no metacopy on this kernel) with the
	// same content: still no change (sha256 compared).
	upper = map[string]string{"index.php": "<?php", "wp/a.php": "a", "wp/b/": ""}
	entries, _ = runExport(t, newLayers(t, tree, upper, tree), fakeAttrs{}, bigOpts)
	if len(entries) != 0 {
		t.Errorf("full copy-up with the same content: %v", summary(entries))
	}
}

func TestExportDiffLimits(t *testing.T) {
	merged := map[string]string{"a.txt": "1111", "b.txt": "2222", "c.txt": "3333", "d.txt": "4444"}
	l := newLayers(t, nil, merged, merged)
	entries, res := runExport(t, l, fakeAttrs{}, ExportOptions{MaxFileBytes: 100, MaxTotalBytes: 100, MaxEntries: 2})
	if len(entries) != 2 || !res.Truncated || res.Entries != 2 {
		t.Errorf("maxEntries: %v %+v", summary(entries), res)
	}
	l = newLayers(t, nil, merged, merged)
	entries, res = runExport(t, l, fakeAttrs{}, ExportOptions{MaxFileBytes: 100, MaxTotalBytes: 10, MaxEntries: 100})
	if len(entries) != 2 || !res.Truncated || res.Bytes != 8 {
		t.Errorf("maxTotalBytes: %v %+v", summary(entries), res)
	}
}

func TestExportDiffSymlinks(t *testing.T) {
	l := newLayers(t, map[string]string{"cfg": "x"}, nil, nil)
	symlinkOrSkip(t, "/etc/passwd", filepath.Join(l.merged, "evil.php"))
	symlinkOrSkip(t, "/etc/passwd", filepath.Join(l.upper, "evil.php"))
	symlinkOrSkip(t, "target-a", filepath.Join(l.lower, "link"))
	symlinkOrSkip(t, "target-b", filepath.Join(l.merged, "link"))
	symlinkOrSkip(t, "target-b", filepath.Join(l.upper, "link"))
	writeTree(t, l.merged, map[string]string{"cfg": "x"})
	entries, _ := runExport(t, l, fakeAttrs{}, bigOpts)
	got := summary(entries)
	if !slices.Equal(got, []string{"added symlink evil.php exported", "modified symlink link exported"}) {
		t.Fatalf("symlinks: %q", got)
	}
	// Recreated as links, never resolved (R1).
	if target, err := os.Readlink(filepath.Join(l.out, "evil.php")); err != nil || target != "/etc/passwd" {
		t.Errorf("export evil.php: %q %v", target, err)
	}
	for _, e := range entries {
		if e.LinkTarget == nil || e.SHA256 != nil {
			t.Errorf("symlink entry: %+v", e)
		}
	}
}

func TestWindowExportWritesManifest(t *testing.T) {
	tm := newTestManager(t)
	tm.mkSite(t, 7, 9, 3, map[string]string{"index.php": "<?php"})
	l := newLayers(t, map[string]string{"index.php": "<?php"}, map[string]string{"plugin.php": "<?php new"}, map[string]string{"index.php": "<?php", "plugin.php": "<?php new"})
	if err := os.MkdirAll(tm.abs("accounts/7/sites/9/windows/5/export/files/stale"), 0o700); err != nil {
		t.Fatal(err)
	}
	r := openRoots(t, l.upper, l.lower, l.merged)
	ref := WindowRef{7, 9, 5, "blog"}
	res, err := tm.export(context.Background(), ref, 3, r[0], r[1], r[2], bigOpts)
	if err != nil {
		t.Fatal(err)
	}
	if res.Added != 1 || res.Entries != 1 {
		t.Errorf("result %+v", res)
	}
	exp := tm.abs("accounts/7/sites/9/windows/5/export")
	if exists(filepath.Join(exp, "files", "stale")) {
		t.Error("previous export not replaced")
	}
	if got := readFile(t, filepath.Join(exp, "files", "plugin.php")); got != "<?php new" {
		t.Errorf("exported content %q", got)
	}
	var m map[string]any
	if err := json.Unmarshal([]byte(readFile(t, filepath.Join(exp, "manifest.json"))), &m); err != nil {
		t.Fatal(err)
	}
	if m["version"] != float64(1) || m["windowId"] != float64(5) || m["releaseNumber"] != float64(3) || m["createdAt"] != "2026-10-09T03:15:00Z" || m["truncated"] != false {
		t.Errorf("manifest: %v", m)
	}
	entries := m["entries"].([]any)
	e := entries[0].(map[string]any)
	if e["path"] != "plugin.php" || e["change"] != "added" || e["type"] != "file" || e["exported"] != true || e["skipped"] != nil || e["linkTarget"] != nil {
		t.Errorf("manifest entry: %v", e)
	}
	if exists(filepath.Join(exp, "manifest.json.tmp")) {
		t.Error("manifest temp file left")
	}
	// Export dirs are root 0700 (M3).
	if got := tm.owners.got["accounts/7/sites/9/windows/5/export"]; got != "0:0 0700" {
		t.Errorf("export owner %q", got)
	}
}

// The export keeps the exec bit (root 0700): the staging apply reads it there.
func TestWindowExportKeepsExecBit(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("no POSIX exec bit on Windows")
	}
	tm := newTestManager(t)
	tm.mkSite(t, 7, 9, 3, map[string]string{"index.php": "<?php"})
	added := map[string]string{"bin/console": "#!/usr/bin/env php", "plugin.php": "<?php new"}
	merged := map[string]string{"index.php": "<?php", "bin/console": "#!/usr/bin/env php", "plugin.php": "<?php new"}
	l := newLayers(t, map[string]string{"index.php": "<?php"}, added, merged)
	for _, d := range []string{l.upper, l.merged} {
		if err := os.Chmod(filepath.Join(d, "bin", "console"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	r := openRoots(t, l.upper, l.lower, l.merged)
	if _, err := tm.export(context.Background(), WindowRef{7, 9, 5, "blog"}, 3, r[0], r[1], r[2], bigOpts); err != nil {
		t.Fatal(err)
	}
	files := tm.abs("accounts/7/sites/9/windows/5/export/files")
	for name, want := range map[string]os.FileMode{"bin/console": 0o700, "plugin.php": 0o600} {
		fi, err := os.Lstat(filepath.Join(files, filepath.FromSlash(name)))
		if err != nil || fi.Mode().Perm() != want {
			t.Errorf("%s: %v %v, want %v", name, fi.Mode(), err, want)
		}
	}
}
