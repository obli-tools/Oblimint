package main

import (
	"context"
	"os"
	"path"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func TestSplitRelPath(t *testing.T) {
	good := []string{"a", "wp-content/plugins/x/x.php", "dir with space/é.txt", ".htaccess", "a/.b/c", strings.Repeat("a", 255)}
	for _, p := range good {
		if _, ok := splitRelPath(p); !ok {
			t.Errorf("%q refused", p)
		}
	}
	bad := []string{"", ".", "..", "/abs", "a/../b", "a/./b", "a//b", "a/", `a\b`, "a\x00b", strings.Repeat("a", 256), strings.Repeat("a/", 2049) + "a"}
	for _, p := range bad {
		if _, ok := splitRelPath(p); ok {
			t.Errorf("%q accepted", p)
		}
	}
}

type stagingFixture struct {
	src, dst string
	rec      *ownerRec
	chowns   *lchownRec
}

func newStagingFixture(t *testing.T, src, dst map[string]string) stagingFixture {
	t.Helper()
	base := t.TempDir()
	f := stagingFixture{src: filepath.Join(base, "src"), dst: filepath.Join(base, "dst")}
	for _, d := range []string{f.src, f.dst} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	writeTree(t, f.src, src)
	writeTree(t, f.dst, dst)
	f.rec = &ownerRec{root: f.dst, got: map[string]string{}}
	f.chowns = &lchownRec{root: f.dst}
	return f
}

func (f stagingFixture) apply(t *testing.T, changes ...StagingChange) StagingApplyResult {
	t.Helper()
	r := openRoots(t, f.src, f.dst)
	res, err := applyChanges(context.Background(), r[0], r[1], tenant, f.rec.own, f.chowns.lchown, changes)
	if err != nil {
		t.Fatal(err)
	}
	return res
}

func w(p string) StagingChange { return StagingChange{Path: p, Op: "write"} }
func d(p string) StagingChange { return StagingChange{Path: p, Op: "delete"} }

func TestApplyChanges(t *testing.T) {
	f := newStagingFixture(t,
		map[string]string{"wp-content/plugins/new/new.php": "<?php new", "index.php": "<?php v2", "bin/tool.sh": "#!/bin/sh", "tc": "now a file"},
		map[string]string{"index.php": "<?php v1", "old.txt": "old", "olddir/x.txt": "x", "olddir/y/z.txt": "z", "tc/a.txt": "a", "keep.txt": "mine"})
	if err := os.Chmod(filepath.Join(f.src, "bin", "tool.sh"), 0o755); err != nil {
		t.Fatal(err)
	}
	res := f.apply(t,
		w("wp-content/plugins/new/new.php"), w("index.php"), w("bin/tool.sh"), w("tc"),
		d("old.txt"), d("olddir"), d("missing/deep.txt"), d("tc/a.txt"),
		w("../escape"), StagingChange{Path: "x", Op: "chmod"}, w("/abs"),
	)
	if res.Written != 4 || res.Deleted != 4 {
		t.Errorf("result %+v", res)
	}
	wantConflicts := []StagingConflict{{"../escape", "invalid"}, {"x", "invalid"}, {"/abs", "invalid"}}
	if !slices.Equal(res.Conflicts, wantConflicts) {
		t.Errorf("conflicts %+v", res.Conflicts)
	}
	for p, want := range map[string]string{"wp-content/plugins/new/new.php": "<?php new", "index.php": "<?php v2", "tc": "now a file", "keep.txt": "mine"} {
		if got := readFile(t, filepath.Join(f.dst, filepath.FromSlash(p))); got != want {
			t.Errorf("%s = %q", p, got)
		}
	}
	for _, p := range []string{"old.txt", "olddir"} {
		if exists(filepath.Join(f.dst, p)) {
			t.Errorf("%s not deleted", p)
		}
	}
	// Created directories and written files belong to the account (uid:gid,
	// dirs 0750, files 0644 / 0755 with the source exec bit; a file is owned
	// through its temp descriptor, before the rename).
	for _, p := range []string{"wp-content", "wp-content/plugins", "wp-content/plugins/new", "bin"} {
		if got := f.rec.got[p]; got != "20001:20002 0750" {
			t.Errorf("owner of dir %s = %q", p, got)
		}
	}
	var files []string
	for k, v := range f.rec.got {
		if strings.HasPrefix(path.Base(k), stagingTmpPrefix) {
			files = append(files, path.Dir(k)+" "+v)
		}
	}
	slices.Sort(files)
	execMode := "0644"
	if fi, err := os.Stat(filepath.Join(f.src, "bin", "tool.sh")); err == nil && execBit(fi) {
		execMode = "0755" // no exec bit on Windows
	}
	wantFiles := []string{". 20001:20002 0644", ". 20001:20002 0644", "bin 20001:20002 " + execMode, "wp-content/plugins/new 20001:20002 0644"}
	if !slices.Equal(files, wantFiles) {
		t.Errorf("file owners %q, want %q", files, wantFiles)
	}
	// No temp file left behind.
	_ = filepath.WalkDir(f.dst, func(p string, de os.DirEntry, err error) error {
		if strings.HasPrefix(de.Name(), stagingTmpPrefix) {
			t.Errorf("temp file left: %s", p)
		}
		return nil
	})
}

func TestApplyChangesConflicts(t *testing.T) {
	f := newStagingFixture(t,
		map[string]string{"a/b.txt": "b", "file/x.txt": "x", "busy": "file"},
		map[string]string{"file": "a regular file where a dir is expected", "busy/inner.txt": "tenant data"})
	res := f.apply(t, w("file/x.txt"), w("nosrc.txt"), w("busy"), w("a/b.txt"))
	want := []StagingConflict{{"file/x.txt", "notDirectory"}, {"nosrc.txt", "missingSource"}, {"busy", "notDirectory"}}
	if !slices.Equal(res.Conflicts, want) || res.Written != 1 {
		t.Errorf("result %+v", res)
	}
	if got := readFile(t, filepath.Join(f.dst, "file")); !strings.HasPrefix(got, "a regular file") {
		t.Errorf("file overwritten: %q", got)
	}
	if got := readFile(t, filepath.Join(f.dst, "busy", "inner.txt")); got != "tenant data" {
		t.Errorf("non-empty dir replaced: %q", got)
	}
}

func TestApplyChangesNeverFollowsLinks(t *testing.T) {
	outside := t.TempDir()
	f := newStagingFixture(t, map[string]string{"up/evil.php": "<?php", "link.txt": "data", "x.php": "<?php"}, map[string]string{})
	symlinkOrSkip(t, outside, filepath.Join(f.dst, "up"))
	symlinkOrSkip(t, filepath.Join(outside, "victim"), filepath.Join(f.dst, "x.php"))
	mustWrite(t, filepath.Join(outside, "victim"), "untouched")
	srcLink := filepath.Join(f.src, "srclink")
	symlinkOrSkip(t, "../../etc/passwd", srcLink)
	res := f.apply(t, w("up/evil.php"), w("x.php"), w("srclink"), d("up/whatever"))
	if !slices.Equal(res.Conflicts, []StagingConflict{{"up/whatever", "symlink"}, {"up/evil.php", "symlink"}}) {
		t.Errorf("conflicts %+v", res.Conflicts)
	}
	if exists(filepath.Join(outside, "evil.php")) {
		t.Error("written through a symlinked parent")
	}
	// The final symlink is replaced by the file, its target untouched.
	if got := readFile(t, filepath.Join(outside, "victim")); got != "untouched" {
		t.Errorf("written through the final symlink: %q", got)
	}
	if fi, err := os.Lstat(filepath.Join(f.dst, "x.php")); err != nil || !fi.Mode().IsRegular() {
		t.Errorf("x.php not replaced by a file: %v %v", fi, err)
	}
	// A symlink of the source is recreated as a symlink (lchown, never resolved).
	if target, err := os.Readlink(filepath.Join(f.dst, "srclink")); err != nil || target != "../../etc/passwd" {
		t.Errorf("srclink: %q %v", target, err)
	}
	if len(f.chowns.list()) != 1 || !strings.HasSuffix(f.chowns.list()[0], " 20001:20002") {
		t.Errorf("lchown of the link: %v", f.chowns.list())
	}
}

func TestWindowManagerApplyToStaging(t *testing.T) {
	tm := newTestManager(t)
	tm.mkSite(t, 7, 9, 3, nil)
	writeTree(t, tm.abs("accounts/7/sites/9/windows/5/export/files"), map[string]string{"p/new.php": "<?php"})
	s := SiteSpec{AccountID: 7, SiteID: 9, Slug: "blog", Owner: tenant}
	res, err := tm.ApplyToStaging(context.Background(), s, StagingSource{Kind: "window", ID: 5}, []StagingChange{w("p/new.php")})
	if err != nil || res.Written != 1 {
		t.Fatalf("%+v %v", res, err)
	}
	if got := readFile(t, tm.abs("accounts/7/staging/blog/p/new.php")); got != "<?php" {
		t.Errorf("staging content %q", got)
	}
	if _, err := tm.ApplyToStaging(context.Background(), s, StagingSource{Kind: "workspace", ID: 11}, []StagingChange{w("x")}); statusOf(err) != 404 {
		t.Errorf("missing workspace: %v", err)
	}
	if _, err := tm.ApplyToStaging(context.Background(), s, StagingSource{Kind: "git", ID: 1}, nil); statusOf(err) != 400 {
		t.Errorf("bad source kind: %v", err)
	}
}

// Directory links (junctions on Windows): the parent refusal runs everywhere.
func TestApplyChangesRefusesLinkedParent(t *testing.T) {
	outside := t.TempDir()
	mustWrite(t, filepath.Join(outside, "keep.txt"), "outside")
	f := newStagingFixture(t, map[string]string{"up/evil.php": "<?php", "src-linked/x.txt": "x"}, map[string]string{})
	dirLinkOrSkip(t, outside, filepath.Join(f.dst, "up"))
	res := f.apply(t, w("up/evil.php"), d("up/keep.txt"))
	// A junction is not a symlink for Go on Windows (an irregular entry):
	// either way it is a conflict, never traversed.
	if res.Written != 0 || len(res.Conflicts) == 0 || res.Conflicts[len(res.Conflicts)-1].Path != "up/evil.php" {
		t.Errorf("result %+v", res)
	}
	for _, c := range res.Conflicts {
		if c.Reason != conflictSymlink && c.Reason != conflictNotDirectory {
			t.Errorf("conflict %+v", c)
		}
	}
	if exists(filepath.Join(outside, "evil.php")) || !exists(filepath.Join(outside, "keep.txt")) {
		t.Error("staging apply went through a linked directory")
	}
	// A linked directory in the SOURCE is never read through either.
	src2 := t.TempDir()
	mustWrite(t, filepath.Join(src2, "secret.txt"), "secret")
	dirLinkOrSkip(t, src2, filepath.Join(f.src, "lnk"))
	res = f.apply(t, w("lnk/secret.txt"))
	if !slices.Equal(res.Conflicts, []StagingConflict{{"lnk/secret.txt", "missingSource"}}) {
		t.Errorf("source link: %+v", res)
	}
}
