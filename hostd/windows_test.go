package main

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

func rwSpec(w int64) WindowSpec {
	return WindowSpec{WindowRef: WindowRef{7, 9, w, "blog"}, Owner: tenant, ReleaseNumber: 3, Mode: windowModeRW}
}

func TestEnsureWindowMountsAndChowns(t *testing.T) {
	tm := newTestManager(t)
	tm.mkSite(t, 7, 9, 3, map[string]string{"index.php": phpOpen, "wp/inc/a.php": "a"})
	l := tm.layout
	st, err := tm.EnsureWindow(bg, rwSpec(5))
	if err != nil {
		t.Fatal(err)
	}
	if !st.Mounted || *st.Mode != "rw" || *st.ReleaseNumber != 3 || st.QuarantineExecutables || st.WindowID != 5 {
		t.Errorf("status %+v", st)
	}
	// Mount sequence: private clone of releases/, RO bind of the pristine
	// release on lower/, clone dropped, overlay over releases/3.
	calls := tm.mnt.calls
	if len(calls) != 5 {
		t.Fatalf("calls %q", calls)
	}
	tmpClone := strings.Fields(calls[1])[2]
	want := []string{
		"privateArea " + l.PrivateMount(),
		"privateBind " + l.Releases(7, 9) + " " + tmpClone,
		"bindRO " + tmpClone + "/3 " + l.WindowLower(7, 9, 5),
		"unmount " + tmpClone,
		"overlay oblimint-window-5 " + l.Release(7, 9, 3) + " false lowerdir=" + l.WindowLower(7, 9, 5) + ",upperdir=" + l.WindowUpper(7, 9, 5) +
			",workdir=" + l.WindowWork(7, 9, 5) + ",metacopy=on,redirect_dir=on,index=off,xino=off",
	}
	if !slices.Equal(calls, want) {
		t.Errorf("mount calls:\n got %q\nwant %q", calls, want)
	}
	if !strings.HasPrefix(tmpClone, l.PrivateMount()+"/7-9-") {
		t.Errorf("private clone %s", tmpClone)
	}
	if exists(filepath.FromSlash(tmpClone)) {
		t.Error("private clone dir left")
	}
	// Window dirs root 0700 (M3); upper takes the owner of the release root.
	for p, want := range map[string]string{
		"accounts/7/sites/9/windows":         "0:0 0700",
		"accounts/7/sites/9/windows/5":       "0:0 0700",
		"accounts/7/sites/9/windows/5/lower": "0:0 0700",
		"accounts/7/sites/9/windows/5/work":  "0:0 0700",
		"run/hostd-mnt":                      "0:0 0700",
	} {
		if got := tm.owners.got[p]; got != want {
			t.Errorf("owner of %s = %q, want %q", p, got, want)
		}
	}
	if got := tm.owners.got["accounts/7/sites/9/windows/5/upper"]; !strings.HasPrefix(got, "0:0 ") {
		t.Errorf("upper owner %q", got)
	}
	// Ownership walk of the merged view (lchown, every entry).
	wantChown := []string{
		"accounts/7/sites/9/releases/3 20001:20002",
		"accounts/7/sites/9/releases/3/index.php 20001:20002",
		"accounts/7/sites/9/releases/3/wp 20001:20002",
		"accounts/7/sites/9/releases/3/wp/inc 20001:20002",
		"accounts/7/sites/9/releases/3/wp/inc/a.php 20001:20002",
	}
	if got := tm.chowns.list(); !slices.Equal(got, wantChown) {
		t.Errorf("chown walk:\n got %q\nwant %q", got, wantChown)
	}
	var state windowState
	if err := json.Unmarshal([]byte(readFile(t, tm.abs("accounts/7/sites/9/windows/5/state.json"))), &state); err != nil {
		t.Fatal(err)
	}
	if state != (windowState{7, 9, 5, "blog", 20001, 20002, 3, "rw", false, true, true, "", false}) {
		t.Errorf("state %+v", state)
	}

	// Idempotent: nothing mounted again, no second walk.
	tm.mnt.calls = nil
	tm.chowns.got = nil
	if _, err := tm.EnsureWindow(bg, rwSpec(5)); err != nil {
		t.Fatal(err)
	}
	if len(tm.mnt.calls) != 0 || len(tm.chowns.got) != 0 {
		t.Errorf("second ensure: calls %q chowns %q", tm.mnt.calls, tm.chowns.got)
	}

	// Freeze: unmount then a read-only overlay (upper on top of lower).
	ro := rwSpec(5)
	ro.Mode = windowModeRO
	st, err = tm.EnsureWindow(bg, ro)
	if err != nil {
		t.Fatal(err)
	}
	wantRO := []string{
		"unmount " + l.Release(7, 9, 3),
		"overlay oblimint-window-5 " + l.Release(7, 9, 3) + " true lowerdir=" + l.WindowUpper(7, 9, 5) + ":" + l.WindowLower(7, 9, 5) + ",metacopy=on,redirect_dir=on,index=off,xino=off",
	}
	if !slices.Equal(tm.mnt.calls, wantRO) || *st.Mode != "ro" {
		t.Errorf("freeze calls %q status %+v", tm.mnt.calls, st)
	}
	// ro → rw again (recovery of an open window): same upper, no walk.
	tm.mnt.calls = nil
	if st, err = tm.EnsureWindow(bg, rwSpec(5)); err != nil || *st.Mode != "rw" || len(tm.chowns.got) != 0 {
		t.Errorf("unfreeze %+v %v chowns %q", st, err, tm.chowns.got)
	}

	// Another window, or another release, on the same site: 409 conflict.
	if _, err := tm.EnsureWindow(bg, rwSpec(6)); codeOf(err) != codeConflict {
		t.Errorf("second window: %v", err)
	}
	other := rwSpec(5)
	other.ReleaseNumber = 4
	if _, err := tm.EnsureWindow(bg, other); codeOf(err) != codeConflict {
		t.Errorf("other release: %v", err)
	}
	ls, err := tm.ListWindows(bg)
	if err != nil || !slices.Equal(ls, []MountedWindow{{7, 9, 5, "rw", 3}}) {
		t.Errorf("listWindows %+v %v", ls, err)
	}
}

func TestEnsureWindowErrors(t *testing.T) {
	tm := newTestManager(t)
	tm.mkSite(t, 7, 9, 3, map[string]string{"a": "a"})
	missing := rwSpec(5)
	missing.ReleaseNumber = 8
	if _, err := tm.EnsureWindow(bg, missing); statusOf(err) != 404 {
		t.Errorf("missing release: %v", err)
	}
	bad := rwSpec(5)
	bad.Mode = "rwx"
	if _, err := tm.EnsureWindow(bg, bad); statusOf(err) != 400 {
		t.Errorf("bad mode: %v", err)
	}
	// metacopy refused by the kernel: the fallback options are tried.
	tm.mnt.failN = 1
	if _, err := tm.EnsureWindow(bg, rwSpec(5)); err != nil {
		t.Fatal(err)
	}
	ov := tm.mnt.callsOf("overlay")
	if len(ov) != 2 || strings.Contains(ov[1], "metacopy") {
		t.Errorf("fallback %q", ov)
	}
	if err := tm.RemoveWindow(bg, WindowRef{7, 9, 5, "blog"}, false); err != nil {
		t.Fatal(err)
	}
	// Every option refused: the lower bind made for it is dropped again.
	tm.mnt.calls, tm.mnt.tries, tm.mnt.failN = nil, 0, 10
	if _, err := tm.EnsureWindow(bg, rwSpec(5)); err == nil {
		t.Fatal("mount failure not reported")
	}
	if mounts, _ := tm.mnt.mounts(); len(mounts) != 0 {
		t.Errorf("mounts left: %+v", mounts)
	}
}

func TestRemoveWindow(t *testing.T) {
	tm := newTestManager(t)
	tm.mkSite(t, 7, 9, 3, map[string]string{"a": "a"})
	if _, err := tm.EnsureWindow(bg, rwSpec(5)); err != nil {
		t.Fatal(err)
	}
	writeTree(t, tm.abs("accounts/7/sites/9/windows/5"), map[string]string{"upper/new.php": "x", "export/manifest.json": "{}", "work/work/": ""})
	ref := WindowRef{7, 9, 5, "blog"}
	tm.mnt.calls = nil
	if err := tm.RemoveWindow(bg, ref, true); err != nil {
		t.Fatal(err)
	}
	want := []string{"unmount " + tm.layout.Release(7, 9, 3), "unmount " + tm.layout.WindowLower(7, 9, 5)}
	if !slices.Equal(tm.mnt.calls, want) {
		t.Errorf("unmounts %q", tm.mnt.calls)
	}
	win := tm.abs("accounts/7/sites/9/windows/5")
	for _, p := range []string{"upper", "work", "lower", "state.json"} {
		if exists(filepath.Join(win, p)) {
			t.Errorf("%s left", p)
		}
	}
	if !exists(filepath.Join(win, "export", "manifest.json")) {
		t.Error("export removed despite keepExport")
	}
	st, err := tm.WindowStatus(bg, 7, 9, 5)
	if err != nil || st.Mounted || st.Mode != nil || !st.ExportReady || st.UpperEntries != 0 {
		t.Errorf("status after removal %+v %v", st, err)
	}
	if err := tm.RemoveWindow(bg, ref, false); err != nil {
		t.Fatal(err)
	}
	if exists(win) {
		t.Error("window dir left")
	}
	if err := tm.RemoveWindow(bg, ref, false); err != nil {
		t.Errorf("idempotent removal: %v", err)
	}
}

func TestRemoveWindowNeverDeletesThroughLower(t *testing.T) {
	tm := newTestManager(t)
	tm.mkSite(t, 7, 9, 3, map[string]string{"a": "a"})
	if _, err := tm.EnsureWindow(bg, rwSpec(5)); err != nil {
		t.Fatal(err)
	}
	// The lower bind cannot be unmounted: nothing is removed.
	writeTree(t, tm.abs("accounts/7/sites/9/windows/5/lower"), map[string]string{"release-file": "x"})
	tm.mnt.fail = map[string]error{"unmount " + tm.layout.WindowLower(7, 9, 5): errors.New("EPERM")}
	if err := tm.RemoveWindow(bg, WindowRef{7, 9, 5, "blog"}, false); err == nil {
		t.Fatal("removal went on with lower still mounted")
	}
	if !exists(tm.abs("accounts/7/sites/9/windows/5/lower/release-file")) || !exists(tm.abs("accounts/7/sites/9/windows/5/upper")) {
		t.Error("content removed while lower is mounted")
	}
}

func TestWindowStatusUpperStats(t *testing.T) {
	tm := newTestManager(t)
	tm.mkSite(t, 7, 9, 3, map[string]string{"a": "a"})
	if _, err := tm.EnsureWindow(bg, rwSpec(5)); err != nil {
		t.Fatal(err)
	}
	up := tm.abs("accounts/7/sites/9/windows/5/upper")
	writeTree(t, up, map[string]string{"new.php": "12345", "chowned.php": "", "gone": "", "dir/x.txt": "123"})
	tm.attrs["chowned.php"] = upperKind{metacopy: true}
	tm.attrs["gone"] = upperKind{whiteout: true}
	st, err := tm.WindowStatus(bg, 7, 9, 5)
	if err != nil {
		t.Fatal(err)
	}
	if st.UpperBytes != 8 || st.UpperEntries != 3 || st.ExportReady {
		t.Errorf("status %+v", st)
	}
	// Export written after the last write: ready; a later write: stale.
	past := time.Now().Add(-time.Hour)
	_ = filepath.Walk(up, func(p string, _ os.FileInfo, _ error) error { return os.Chtimes(p, past, past) })
	writeTree(t, tm.abs("accounts/7/sites/9/windows/5/export"), map[string]string{"manifest.json": "{}"})
	if st, _ = tm.WindowStatus(bg, 7, 9, 5); !st.ExportReady {
		t.Errorf("export ready %+v", st)
	}
	future := time.Now().Add(time.Hour)
	if err := os.Chtimes(filepath.Join(up, "new.php"), future, future); err != nil {
		t.Fatal(err)
	}
	if st, _ = tm.WindowStatus(bg, 7, 9, 5); st.ExportReady {
		t.Errorf("stale export reported ready %+v", st)
	}
	if st, err = tm.WindowStatus(bg, 7, 9, 6); err != nil || st.Mounted || st.ReleaseNumber != nil {
		t.Errorf("unknown window %+v %v", st, err)
	}
	if _, err := tm.ExportWindow(bg, WindowRef{7, 9, 6, "blog"}, bigOpts); codeOf(err) != codeWindowNotMounted {
		t.Errorf("export of an unmounted window: %v", err)
	}
}

func TestVerifyWindow(t *testing.T) {
	tm := newTestManager(t)
	tm.mkSite(t, 7, 9, 3, map[string]string{"a": "a"})
	if _, err := tm.VerifyWindow(bg, 7, 9, 5, []int{100}); codeOf(err) != codeWindowNotMounted {
		t.Errorf("not mounted: %v", err)
	}
	if _, err := tm.EnsureWindow(bg, rwSpec(5)); err != nil {
		t.Fatal(err)
	}
	tm.mnt.pids[100] = []Mount{{MountPoint: "/srv/releases", FSType: "xfs", Options: []string{"ro"}}, {MountPoint: "/srv/releases/3", FSType: "overlay", Options: []string{"rw"}}}
	tm.mnt.pids[200] = []Mount{{MountPoint: "/srv/releases", FSType: "xfs", Options: []string{"ro"}}}
	res, err := tm.VerifyWindow(bg, 7, 9, 5, []int{100, 200, 300})
	if err != nil {
		t.Fatal(err)
	}
	if len(res) != 3 || !res[0].Visible || *res[0].Mode != "rw" || res[1].Visible || res[1].Error != nil || res[2].Error == nil {
		t.Errorf("results %+v", res)
	}
}

func TestReleaseSiteUnmountsBeforeRemoval(t *testing.T) {
	tm := newTestManager(t)
	tm.mkSite(t, 7, 9, 3, map[string]string{"a": "a"})
	if _, err := tm.EnsureWindow(bg, rwSpec(5)); err != nil {
		t.Fatal(err)
	}
	if _, err := tm.SetWatch(bg, typedSpec(TypedPath{Path: "uploads", AllowedExtensions: []string{"jpg"}})); err != nil {
		t.Fatal(err)
	}
	h := newHostOps(tm.layout, newMeasuredQuota("", true, "test"), tm.owners.own)
	h.releaser = tm.windowManager
	if err := h.RemoveSite(bg, 7, 9, "blog", true); err != nil {
		t.Fatal(err)
	}
	if mounts, _ := tm.mnt.mounts(); len(mounts) != 0 {
		t.Errorf("mounts left after removeSite: %+v", mounts)
	}
	tm.mu.Lock()
	n := len(tm.typed)
	tm.mu.Unlock()
	if n != 0 {
		t.Error("typed watch left after removeSite")
	}
	if exists(tm.abs("accounts/7/sites/9")) {
		t.Error("site tree not purged")
	}
	// removeAccount: same for every site of the account.
	tm.mkSite(t, 7, 9, 3, map[string]string{"a": "a"})
	if _, err := tm.EnsureWindow(bg, rwSpec(5)); err != nil {
		t.Fatal(err)
	}
	if err := h.RemoveAccount(bg, 7, true); err != nil {
		t.Fatal(err)
	}
	if mounts, _ := tm.mnt.mounts(); len(mounts) != 0 {
		t.Errorf("mounts left after removeAccount: %+v", mounts)
	}
}

func TestWorkspace(t *testing.T) {
	tm := newTestManager(t)
	tm.mkSite(t, 7, 9, 3, map[string]string{"index.php": phpOpen, "wp/a.txt": "aa", "empty/": ""})
	ws := WorkspaceSpec{SiteSpec: SiteSpec{AccountID: 7, SiteID: 9, Slug: "blog", Owner: tenant}, WorkspaceID: 11, ReleaseNumber: 3}
	writeTree(t, tm.abs("accounts/7/sites/9/work/11/tree"), map[string]string{"stale.txt": "old run"})
	res, err := tm.EnsureWorkspace(bg, ws)
	if err != nil {
		t.Fatal(err)
	}
	if res.Files != 2 || res.Bytes != int64(len(phpOpen)+2) {
		t.Errorf("result %+v", res)
	}
	tree := tm.abs("accounts/7/sites/9/work/11/tree")
	if readFile(t, filepath.Join(tree, "wp", "a.txt")) != "aa" || exists(filepath.Join(tree, "stale.txt")) || !exists(filepath.Join(tree, "empty")) {
		t.Error("tree content")
	}
	for p, want := range map[string]string{
		"accounts/7/sites/9/work":                  "0:0 0711",
		"accounts/7/sites/9/work/11":               "0:0 0711",
		"accounts/7/sites/9/work/11/tree":          "20001:20002 0755",
		"accounts/7/sites/9/work/11/tree/wp":       "20001:20002 0755",
		"accounts/7/sites/9/work/11/tree/wp/a.txt": "20001:20002 0644",
	} {
		if got := tm.owners.got[p]; got != want {
			t.Errorf("owner of %s = %q, want %q", p, got, want)
		}
	}
	// A window covers the release: the pristine lower layer is copied.
	if _, err := tm.EnsureWindow(bg, rwSpec(5)); err != nil {
		t.Fatal(err)
	}
	writeTree(t, tm.abs("accounts/7/sites/9/windows/5/lower"), map[string]string{"pristine.txt": "p"})
	if _, err := tm.EnsureWorkspace(bg, ws); err != nil {
		t.Fatal(err)
	}
	if !exists(filepath.Join(tree, "pristine.txt")) || exists(filepath.Join(tree, "index.php")) {
		t.Error("workspace not taken from the lower layer")
	}
	if err := tm.RemoveWorkspace(bg, 7, 9, "blog", 11); err != nil {
		t.Fatal(err)
	}
	if exists(tm.abs("accounts/7/sites/9/work/11")) {
		t.Error("workspace not removed")
	}
	if err := tm.RemoveWorkspace(bg, 7, 9, "blog", 11); err != nil {
		t.Errorf("idempotent: %v", err)
	}
	ws.ReleaseNumber = 99
	if _, err := tm.EnsureWorkspace(bg, ws); statusOf(err) != 404 {
		t.Errorf("missing release: %v", err)
	}
}

func TestCheckLostEmitsOnce(t *testing.T) {
	tm := newTestManager(t)
	tm.mkSite(t, 7, 9, 3, map[string]string{"a": "a"})
	if _, err := tm.EnsureWindow(bg, rwSpec(5)); err != nil {
		t.Fatal(err)
	}
	tm.checkLost()
	if evs, _, _ := tm.events.after(0); len(evs) != 0 {
		t.Fatalf("mounted window reported lost: %+v", evs)
	}
	tm.mnt.table = nil // host rebooted
	tm.checkLost()
	tm.checkLost()
	evs, _, _ := tm.events.after(0)
	if len(evs) != 1 || evs[0].Kind != eventWindowLost || *evs[0].WindowID != 5 {
		t.Errorf("events %+v", evs)
	}
	// Remounted by the recovery: lost again later = a new event.
	if _, err := tm.EnsureWindow(bg, rwSpec(5)); err != nil {
		t.Fatal(err)
	}
	tm.checkLost()
	tm.mnt.table = nil
	tm.checkLost()
	if evs, _, _ := tm.events.after(1); len(evs) != 1 {
		t.Errorf("second loss %+v", evs)
	}
}

func TestMeasuringSkipsWindowMounts(t *testing.T) {
	dir := t.TempDir()
	writeTree(t, dir, map[string]string{
		"sites/9/releases/3/big.bin":    strings.Repeat("x", 1000), // under the overlay mount point
		"sites/9/windows/5/lower/l.bin": strings.Repeat("y", 100),
		"sites/9/windows/5/upper/u.bin": strings.Repeat("z", 10),
	})
	old := mountsBelow
	defer func() { mountsBelow = old }()
	mountsBelow = func(string) map[string]string {
		return map[string]string{"sites/9/releases/3": "overlay", "sites/9/windows/5/lower": "xfs"}
	}
	r := openRoots(t, dir)[0]
	n, err := diskUsage(context.Background(), r)
	if err != nil {
		t.Fatal(err)
	}
	// The overlay is not entered: the release counts once, through lower/.
	if n < 110 || n >= 1000 {
		t.Errorf("usage %d: the overlay was walked or the layers skipped", n)
	}
	// Quota tagging enters no mount point at all.
	attr := &recProj{}
	if _, err := tagTree(context.Background(), r, 100007, attr); err != nil {
		t.Fatal(err)
	}
	for _, p := range attr.seen {
		if strings.Contains(p, "releases/3") || strings.Contains(p, "lower") {
			t.Errorf("tagged through a mount: %s", p)
		}
	}
	if !slices.ContainsFunc(attr.seen, func(p string) bool { return strings.HasSuffix(p, "u.bin") }) {
		t.Errorf("upper not tagged: %q", attr.seen)
	}
}

// recProj records the files tagTree opens.
type recProj struct{ seen []string }

func (r *recProj) get(f *os.File) (uint32, bool, error) {
	r.seen = append(r.seen, filepath.ToSlash(f.Name()))
	return 0, false, nil
}
func (r *recProj) set(*os.File, uint32, bool) error { return nil }

// Overlay gone but lower/ still bound (manual umount): re-ensuring never
// applies the window dir owner / mode to the bind's root (the release root).
func TestEnsureWindowLeavesMountedLowerAlone(t *testing.T) {
	tm := newTestManager(t)
	tm.mkSite(t, 7, 9, 3, map[string]string{"a": "a"})
	if _, err := tm.EnsureWindow(bg, rwSpec(5)); err != nil {
		t.Fatal(err)
	}
	if _, err := tm.mnt.unmount(tm.layout.Release(7, 9, 3)); err != nil {
		t.Fatal(err)
	}
	tm.owners.reset()
	tm.mnt.calls = nil
	if _, err := tm.EnsureWindow(bg, rwSpec(5)); err != nil {
		t.Fatal(err)
	}
	if _, touched := tm.owners.got["accounts/7/sites/9/windows/5/lower"]; touched {
		t.Error("owner / mode applied to the mounted lower bind")
	}
	if len(tm.mnt.callsOf("bindRO")) != 0 || len(tm.mnt.callsOf("overlay")) != 1 {
		t.Errorf("calls %q", tm.mnt.calls)
	}
}

// Once mounted with metacopy, the no-metacopy fallbacks are never offered
// again (they would serve EIO for the metadata-only upper entries): a freeze
// that cannot keep metacopy fails and the previous view is put back.
func TestFreezeNeverDropsMetacopy(t *testing.T) {
	tm := newTestManager(t)
	tm.mkSite(t, 7, 9, 3, map[string]string{"index.php": phpOpen})
	if _, err := tm.EnsureWindow(bg, rwSpec(5)); err != nil {
		t.Fatal(err)
	}
	if st, ok := tm.readState(7, 9, 5); !ok || !st.Metacopy {
		t.Fatalf("state %+v", st)
	}
	ro := rwSpec(5)
	ro.Mode = windowModeRO
	tm.mnt.calls, tm.mnt.tries, tm.mnt.failN = nil, 0, 2 // both metacopy ro options refused
	if _, err := tm.EnsureWindow(bg, ro); err == nil {
		t.Fatal("freeze without metacopy accepted")
	}
	ov := tm.mnt.callsOf("overlay")
	if len(ov) != 3 {
		t.Fatalf("overlay calls %q", ov)
	}
	for _, c := range ov {
		if !strings.Contains(c, ",metacopy=on") {
			t.Errorf("no-metacopy option tried: %q", c)
		}
	}
	if !strings.Contains(ov[2], " false ") {
		t.Errorf("previous rw view not restored: %q", ov[2])
	}
	// A kernel without metacopy (never mounted with it): the fallback is used.
	tm2 := newTestManager(t)
	tm2.mkSite(t, 7, 9, 3, map[string]string{"index.php": phpOpen})
	tm2.mnt.failN = 1
	if _, err := tm2.EnsureWindow(bg, rwSpec(5)); err != nil {
		t.Fatal(err)
	}
	if st, _ := tm2.readState(7, 9, 5); st.Metacopy {
		t.Error("metacopy recorded for a fallback mount")
	}
	tm2.mnt.calls, tm2.mnt.tries, tm2.mnt.failN = nil, 0, 2
	if _, err := tm2.EnsureWindow(bg, ro); err != nil {
		t.Fatalf("freeze with the last fallback: %v", err)
	}
}
