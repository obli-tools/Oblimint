package main

import (
	"fmt"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"slices"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"
)

// ── Fakes of the P3 OS layer (no mount, no inotify, no xattr on a dev box) ──

// fakeMounter keeps a mount table in memory and records every call.
type fakeMounter struct {
	mu    sync.Mutex
	table []Mount
	calls []string
	fail  map[string]error // call prefix → error
	pids  map[int][]Mount
	failN int // overlay: fail the first failN attempts
	tries int
	devN  int // overlay superblock devices handed out ("0:<n>")
	// detach: unmount of these targets reports a lazy detach (once).
	detach map[string]bool
	// holding: device → pids holding it; kill removes a pid unless unkillable.
	holding    map[string][]int
	unkillable map[int]bool
	killed     []int
	holderScan int
}

func (f *fakeMounter) rec(format string, args ...any) error {
	c := fmt.Sprintf(format, args...)
	f.calls = append(f.calls, c)
	for p, err := range f.fail {
		if strings.HasPrefix(c, p) {
			return err
		}
	}
	return nil
}

func (f *fakeMounter) mounts() ([]Mount, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.table), nil
}
func (f *fakeMounter) pidMounts(pid int) ([]Mount, error) {
	m, ok := f.pids[pid]
	if !ok {
		return nil, fs.ErrNotExist
	}
	return m, nil
}
func (f *fakeMounter) pidExists(pid int) bool { _, ok := f.pids[pid]; return ok }
func (f *fakeMounter) privateArea(dir string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.rec("privateArea %s", dir)
}
func (f *fakeMounter) privateBind(src, dst string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if err := f.rec("privateBind %s %s", src, dst); err != nil {
		return err
	}
	f.table = append(f.table, Mount{MountPoint: dst, FSType: "xfs", Root: src, Options: []string{"rw"}})
	return nil
}
func (f *fakeMounter) bindRO(src, dst string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if err := f.rec("bindRO %s %s", src, dst); err != nil {
		return err
	}
	f.table = append(f.table, Mount{MountPoint: dst, FSType: "xfs", Root: src, Options: []string{"ro", "nosuid", "nodev"}})
	return nil
}
func (f *fakeMounter) overlay(source, target, options string, ro bool) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if err := f.rec("overlay %s %s %v %s", source, target, ro, options); err != nil {
		return err
	}
	f.tries++
	if f.tries <= f.failN {
		return fmt.Errorf("EINVAL (try %d)", f.tries)
	}
	mode := "rw"
	if ro {
		mode = "ro"
	}
	f.devN++
	f.table = append(f.table, Mount{Dev: fmt.Sprintf("0:%d", f.devN), MountPoint: target, FSType: "overlay", Source: source,
		Options: []string{mode, "nosuid", "nodev"}, SuperOptions: append([]string{mode}, strings.Split(options, ",")...)})
	return nil
}
func (f *fakeMounter) unmount(target string) (bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if err := f.rec("unmount %s", target); err != nil {
		return false, err
	}
	for i := len(f.table) - 1; i >= 0; i-- {
		if f.table[i].MountPoint == target {
			f.table = append(f.table[:i], f.table[i+1:]...)
			break
		}
	}
	detached := f.detach[target]
	delete(f.detach, target)
	return detached, nil
}
func (f *fakeMounter) holders(dev string) ([]int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.holderScan++
	if err := f.rec("holders %s", dev); err != nil {
		return nil, err
	}
	return slices.Clone(f.holding[dev]), nil
}
func (f *fakeMounter) kill(pid int) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.killed = append(f.killed, pid)
	if f.unkillable[pid] {
		return nil
	}
	for dev, pids := range f.holding {
		f.holding[dev] = slices.DeleteFunc(pids, func(p int) bool { return p == pid })
	}
	return nil
}

func (f *fakeMounter) callsOf(prefix string) []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []string
	for _, c := range f.calls {
		if strings.HasPrefix(c, prefix) {
			out = append(out, c)
		}
	}
	return out
}

// fakeAttrs marks upper-layer entries by their path relative to the upper root.
type fakeAttrs map[string]upperKind

func (f fakeAttrs) classify(_ *os.Root, _ string, _ fs.FileInfo, _ *os.Root, rel string) (upperKind, error) {
	return f[rel], nil
}

// lchownRec records "<path relative to root> uid:gid".
type lchownRec struct {
	mu   sync.Mutex
	root string
	got  []string
}

func relOf(root, name string) string {
	rel, err := filepath.Rel(filepath.Clean(root), filepath.Clean(name))
	if err != nil {
		return name
	}
	return filepath.ToSlash(rel)
}

func (r *lchownRec) lchown(dir *os.Root, name string, o Owner) error {
	if _, err := dir.Lstat(name); err != nil {
		return err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.got = append(r.got, fmt.Sprintf("%s %d:%d", path.Clean(relOf(r.root, dir.Name())+"/"+name), o.UID, o.GID))
	return nil
}

func (r *lchownRec) list() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := slices.Clone(r.got)
	sort.Strings(out)
	return out
}

// fakeHub stands in for inotify: one wd per directory name.
type fakeHub struct {
	mu      sync.Mutex
	next    int
	wds     map[string]int
	removed []int
}

func (h *fakeHub) add(dir *os.Root, _ *treeWatch) (int, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.wds == nil {
		h.wds = map[string]int{}
	}
	key := filepath.Clean(dir.Name())
	if wd, ok := h.wds[key]; ok {
		return wd, nil
	}
	h.next++
	h.wds[key] = h.next
	return h.next, nil
}

func (h *fakeHub) remove(wd int, _ *treeWatch) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.removed = append(h.removed, wd)
}

func (h *fakeHub) wdOf(t *testing.T, dir string) int {
	t.Helper()
	h.mu.Lock()
	defer h.mu.Unlock()
	wd, ok := h.wds[filepath.Clean(dir)]
	if !ok {
		t.Fatalf("no watch on %s (watched: %v)", dir, h.wds)
	}
	return wd
}

// testManager is a windowManager on a temp root with every OS part faked.
type testManager struct {
	*windowManager
	mnt    *fakeMounter
	owners *ownerRec
	chowns *lchownRec
	hub    *fakeHub
	attrs  fakeAttrs
	root   string // resolved root (OS path)
}

var p3Now = time.Date(2026, 10, 9, 3, 15, 0, 0, time.UTC)

func newTestManager(t *testing.T) *testManager {
	t.Helper()
	// A relative root: overlay options refuse ':' and a Windows temp path
	// has a drive letter (C:/...).
	t.Chdir(t.TempDir())
	dir := "hostroot"
	if err := os.Mkdir(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	mnt := &fakeMounter{pids: map[int][]Mount{}}
	attrs := fakeAttrs{}
	tm := &testManager{mnt: mnt, attrs: attrs, hub: &fakeHub{}}
	m := newWindowManager(newLayout(dir), mnt, attrs, nil, nil, func() time.Time { return p3Now })
	tm.root = filepath.FromSlash(m.layout.Root)
	tm.owners = &ownerRec{root: tm.root, got: map[string]string{}}
	tm.chowns = &lchownRec{root: tm.root}
	m.own = tm.owners.own
	m.lchown = tm.chowns.lchown
	m.quarantine.own = tm.owners.own
	m.quarantine.lchown = tm.chowns.lchown
	m.clone = func(*os.File, *os.File) error { return errUnsupported }
	m.newHub = func() (notifyHub, error) { return tm.hub, nil }
	m.sleep = func(time.Duration) {}
	tm.windowManager = m
	return tm
}

// abs is the OS path of a root-relative POSIX path.
func (tm *testManager) abs(rel string) string { return filepath.Join(tm.root, filepath.FromSlash(rel)) }

// writeTree creates files ("content"), directories (key ending in "/") below dir.
func writeTree(t *testing.T, dir string, files map[string]string) {
	t.Helper()
	for p, content := range files {
		full := filepath.Join(dir, filepath.FromSlash(strings.TrimSuffix(p, "/")))
		if strings.HasSuffix(p, "/") {
			if err := os.MkdirAll(full, 0o755); err != nil {
				t.Fatal(err)
			}
			continue
		}
		mustWrite(t, full, content)
	}
}

func readFile(t *testing.T, p string) string {
	t.Helper()
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func exists(p string) bool {
	_, err := os.Lstat(p)
	return err == nil
}

// mkSite creates the account / site / release trees a window needs.
func (tm *testManager) mkSite(t *testing.T, a, s, n int64, files map[string]string) {
	t.Helper()
	l := tm.layout
	for _, rel := range [][]string{l.SiteStagingRel(a, "blog"), l.SiteDataRel(a, "blog"), l.ReleaseRel(a, s, n), {"run"}} {
		if err := os.MkdirAll(tm.abs(path.Join(rel...)), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	writeTree(t, tm.abs(path.Join(l.ReleaseRel(a, s, n)...)), files)
}
