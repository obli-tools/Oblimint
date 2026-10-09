package main

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func typedSpec(typed ...TypedPath) WatchSpec {
	return WatchSpec{SiteSpec: SiteSpec{AccountID: 7, SiteID: 9, Slug: "blog", Owner: tenant}, Typed: typed}
}

func quarantinedPaths(t *testing.T, tm *testManager) []string {
	t.Helper()
	list, err := tm.quarantine.list(7)
	if err != nil {
		t.Fatal(err)
	}
	var out []string
	for _, e := range list {
		out = append(out, e.Path+" "+e.Reason)
	}
	slices.Sort(out)
	return out
}

func TestTypedWatchInitialScanAndEvents(t *testing.T) {
	tm := newTestManager(t)
	tm.mkSite(t, 7, 9, 3, nil)
	data := tm.abs("accounts/7/data/blog")
	writeTree(t, data, map[string]string{
		"uploads/ok.jpg":                          jpegHead + "pixels",
		"uploads/2026/10/shell.php":               phpOpen + " echo 1;",
		"uploads/2026/10/poly.jpg":                jpegHead + phpOpen + " echo 2;",
		"uploads/" + sftpgoUploadPrefix + "fresh": "partial upload",
		"uploads/private/notes.txt":               "nested typed path: its own rules",
		"cache/whatever.php":                      "not a typed path",
	})
	spec := typedSpec(
		TypedPath{Path: "uploads", AllowedExtensions: []string{"jpg", "png"}},
		TypedPath{Path: "uploads/private", AllowedExtensions: []string{"txt"}},
		TypedPath{Path: "missing", AllowedExtensions: []string{"jpg"}},
	)
	res, err := tm.SetWatch(bg, spec)
	if err != nil {
		t.Fatal(err)
	}
	if res.Watching != 2 || res.Quarantined != 2 {
		t.Errorf("setWatch %+v", res)
	}
	want := []string{"uploads/2026/10/poly.jpg polyglot", "uploads/2026/10/shell.php extension"}
	if got := quarantinedPaths(t, tm); !slices.Equal(got, want) {
		t.Errorf("quarantined %q", got)
	}
	for _, p := range []string{"uploads/ok.jpg", "uploads/" + sftpgoUploadPrefix + "fresh", "uploads/private/notes.txt", "cache/whatever.php"} {
		if !exists(filepath.Join(data, filepath.FromSlash(p))) {
			t.Errorf("%s moved", p)
		}
	}
	// Events: one 'quarantined' per file + one 'watchError' for the missing path.
	evs, _, _ := tm.events.after(0)
	kinds := map[string]int{}
	for _, e := range evs {
		kinds[e.Kind]++
		if e.Kind == eventQuarantined && (e.EntryID == nil || e.SiteID == nil || *e.SiteID != 9) {
			t.Errorf("event %+v", e)
		}
	}
	if kinds[eventQuarantined] != 2 || kinds[eventWatchError] != 1 {
		t.Errorf("events %v", kinds)
	}

	// Live events through the watch of uploads/.
	tm.mu.Lock()
	sw := tm.typed[siteKey{7, 9}]
	tm.mu.Unlock()
	uploads := sw.watches[0]
	root := filepath.Join(data, "uploads")
	writeTree(t, root, map[string]string{"new/dir/evil.png": phpOpen + " echo 3;", "late.png": pngHead + "ok"})
	uploads.handleEvent(fsEvent{wd: tm.hub.wdOf(t, root), mask: evCreate | evIsDir, name: "new"})
	uploads.handleEvent(fsEvent{wd: tm.hub.wdOf(t, root), mask: evCloseWrite, name: "late.png"})
	// A file still being written (IN_CREATE only) waits for IN_CLOSE_WRITE.
	writeTree(t, root, map[string]string{"pending.php": ""})
	uploads.handleEvent(fsEvent{wd: tm.hub.wdOf(t, root), mask: evCreate, name: "pending.php"})
	if !exists(filepath.Join(root, "pending.php")) {
		t.Error("checked before being written")
	}
	uploads.handleEvent(fsEvent{wd: tm.hub.wdOf(t, root), mask: evCloseWrite, name: "pending.php"})
	// The SFTPGo temp file is checked once renamed (IN_MOVED_TO of the final name).
	if err := os.Rename(filepath.Join(root, sftpgoUploadPrefix+"fresh"), filepath.Join(root, "final.exe")); err != nil {
		t.Fatal(err)
	}
	uploads.handleEvent(fsEvent{wd: tm.hub.wdOf(t, root), mask: evMovedTo, name: "final.exe"})
	want = []string{
		"uploads/2026/10/poly.jpg polyglot", "uploads/2026/10/shell.php extension",
		"uploads/final.exe extension", "uploads/new/dir/evil.png php-content", "uploads/pending.php extension",
	}
	if got := quarantinedPaths(t, tm); !slices.Equal(got, want) {
		t.Errorf("after events %q", got)
	}
	if !exists(filepath.Join(root, "late.png")) {
		t.Error("conforming file moved")
	}
	if uploads.lost.Load() {
		t.Error("rescan requested without reason")
	}
	uploads.handleEvent(fsEvent{wd: -1, mask: evOverflow})
	if !uploads.lost.Load() {
		t.Error("overflow must trigger a rescan")
	}

	// Persisted, then removed.
	var recs []watchRecord
	if err := json.Unmarshal([]byte(readFile(t, filepath.Join(tm.root, "run", "hostd-watches.json"))), &recs); err != nil || len(recs) != 1 || len(recs[0].Typed) != 3 {
		t.Errorf("persisted %+v %v", recs, err)
	}
	if err := tm.RemoveWatch(bg, 7, 9); err != nil {
		t.Fatal(err)
	}
	tm.mu.Lock()
	n := len(tm.typed)
	tm.mu.Unlock()
	if n != 0 || len(tm.hub.removed) == 0 {
		t.Errorf("watch not removed: %d typed, removed wds %v", n, tm.hub.removed)
	}
	if got := readFile(t, filepath.Join(tm.root, "run", "hostd-watches.json")); strings.TrimSpace(got) != "[]" {
		t.Errorf("persisted after removal: %s", got)
	}
}

func TestTypedWatchAllowListAndRescanCache(t *testing.T) {
	tm := newTestManager(t)
	tm.mkSite(t, 7, 9, 3, nil)
	data := tm.abs("accounts/7/data/blog")
	writeTree(t, data, map[string]string{"uploads/doc.pdf": "plain text pretending"})
	// The staff restored this exact content at this path.
	store, err := tm.quarantine.storeDir(7, true)
	if err != nil {
		t.Fatal(err)
	}
	if err := tm.quarantine.allow(store, allowEntry{Area: areaData, Slug: "blog", Path: "uploads/doc.pdf", SHA256: sum("plain text pretending")}); err != nil {
		t.Fatal(err)
	}
	store.Close()
	writeTree(t, data, map[string]string{"uploads/doc.pdf": "plain text pretending", "uploads/doc.txt": "x"})
	res, err := tm.SetWatch(bg, typedSpec(TypedPath{Path: "uploads", AllowedExtensions: []string{".PDF"}}))
	if err != nil {
		t.Fatal(err)
	}
	if res.Quarantined != 1 {
		t.Errorf("quarantined %d", res.Quarantined)
	}
	if got := quarantinedPaths(t, tm); !slices.Equal(got, []string{"uploads/doc.txt extension"}) {
		t.Errorf("quarantined %q", got)
	}
	// Changed content at the allowed path: no longer allowed.
	mustWrite(t, filepath.Join(data, "uploads", "doc.pdf"), "#!/bin/sh")
	tm.mu.Lock()
	w := tm.typed[siteKey{7, 9}].watches[0]
	tm.mu.Unlock()
	w.handleEvent(fsEvent{wd: tm.hub.wdOf(t, filepath.Join(data, "uploads")), mask: evCloseWrite, name: "doc.pdf"})
	if exists(filepath.Join(data, "uploads", "doc.pdf")) {
		t.Error("changed allowed file not quarantined")
	}
	_ = tm.RemoveWatch(bg, 7, 9)
}

func TestTypedWatchSpecials(t *testing.T) {
	tm := newTestManager(t)
	tm.mkSite(t, 7, 9, 3, nil)
	data := tm.abs("accounts/7/data/blog/uploads")
	writeTree(t, data, map[string]string{"ok.jpg": jpegHead})
	symlinkOrSkip(t, "/etc/passwd", filepath.Join(data, "link.jpg"))
	res, err := tm.SetWatch(bg, typedSpec(TypedPath{Path: "uploads", AllowedExtensions: []string{"jpg"}}))
	if err != nil || res.Quarantined != 1 {
		t.Fatalf("%+v %v", res, err)
	}
	if got := quarantinedPaths(t, tm); !slices.Equal(got, []string{"uploads/link.jpg special"}) {
		t.Errorf("quarantined %q", got)
	}
	_ = tm.RemoveWatch(bg, 7, 9)
}

func TestSetWatchValidation(t *testing.T) {
	tm := newTestManager(t)
	tm.mkSite(t, 7, 9, 3, nil)
	for _, typed := range [][]TypedPath{
		{{Path: "../etc", AllowedExtensions: []string{"jpg"}}},
		{{Path: "/abs"}},
		{{Path: "ok", AllowedExtensions: []string{"a/b"}}},
	} {
		if _, err := tm.SetWatch(bg, typedSpec(typed...)); statusOf(err) != 400 {
			t.Errorf("%+v: %v", typed, err)
		}
	}
	// Empty list = no watch.
	if res, err := tm.SetWatch(bg, typedSpec()); err != nil || res.Watching != 0 {
		t.Errorf("empty: %+v %v", res, err)
	}
	// No notifier (not Linux): 501.
	tm.newHub = func() (notifyHub, error) { return nil, errUnsupported }
	if _, err := tm.SetWatch(bg, typedSpec(TypedPath{Path: "uploads"})); statusOf(err) != 501 {
		t.Errorf("unsupported: %v", err)
	}
}

func TestRestoreWatchesAtStart(t *testing.T) {
	tm := newTestManager(t)
	tm.mkSite(t, 7, 9, 3, nil)
	writeTree(t, tm.abs("accounts/7/data/blog"), map[string]string{"uploads/x.php": phpOpen})
	recs := []watchRecord{{AccountID: 7, SiteID: 9, Slug: "blog", UID: 20001, GID: 20002, Typed: []TypedPath{{Path: "uploads", AllowedExtensions: []string{"jpg"}}}}}
	b, _ := json.Marshal(recs)
	mustWrite(t, filepath.Join(tm.root, "run", "hostd-watches.json"), string(b))
	tm.restoreWatches()
	if got := quarantinedPaths(t, tm); !slices.Equal(got, []string{"uploads/x.php extension"}) {
		t.Errorf("after restore %q", got)
	}
	tm.mu.Lock()
	sw := tm.typed[siteKey{7, 9}]
	tm.mu.Unlock()
	if sw == nil || sw.spec.Owner != tenant {
		t.Fatalf("watch not restored: %+v", sw)
	}
	_ = tm.RemoveWatch(bg, 7, 9)
}

// ── Supervised windows ───────────────────────────────────────────────────────

func TestSupervisedRevertsExecutableWrites(t *testing.T) {
	tm := newTestManager(t)
	release := map[string]string{"index.php": phpOpen + " echo 'v1';", "readme.txt": "doc", "wp-content/": ""}
	tm.mkSite(t, 7, 9, 3, release)
	win := "accounts/7/sites/9/windows/5"
	// lower = the pristine release (a RO bind on Linux, a copy here).
	writeTree(t, tm.abs(win+"/lower"), release)
	merged := tm.abs("accounts/7/sites/9/releases/3")
	// Written while executables were allowed (supervised allowance): the
	// baseline of the supervision, judged by the analysis, never reverted.
	update := phpOpen + " echo 'update';"
	writeTree(t, merged, map[string]string{"wp-content/updated-plugin.php": update, "readme.txt": "doc"})
	writeTree(t, tm.abs(win+"/upper"), map[string]string{"chowned/": "", "wp-content/updated-plugin.php": update,
		"readme.txt": ""}) // readme.txt: metadata-only copy (chown)
	tm.attrs["readme.txt"] = upperKind{metacopy: true}

	spec := WindowSpec{WindowRef: WindowRef{7, 9, 5, "blog"}, Owner: tenant, ReleaseNumber: 3, Mode: windowModeRW, QuarantineExecutables: true}
	if err := tm.startSupervised(spec); err != nil {
		t.Fatal(err)
	}
	defer tm.stopSupervised(windowKey{7, 9, 5})
	if list, _ := tm.quarantine.list(7); len(list) != 0 || !exists(filepath.Join(merged, "wp-content", "updated-plugin.php")) {
		t.Fatalf("baseline judged at start: %d entries", len(list))
	}
	tm.mu.Lock()
	tw := tm.supervised[windowKey{7, 9, 5}]
	tm.mu.Unlock()
	// A rescan (IN_Q_OVERFLOW) leaves the unchanged baseline alone.
	if n, err := tw.rescan(); err != nil || n != 0 {
		t.Fatalf("rescan of the baseline: %d %v", n, err)
	}

	// What the application did through the overlay (merged view = releases/3)
	// once supervised: every write event is judged.
	changed := map[string]string{
		"index.php":                 phpOpen + " echo 'hacked';",
		"wp-content/new-plugin.php": phpOpen + " echo 'new';",
		"wp-content/data.json":      `{"cache":true}`,
		"wp-content/noext":          "#!/bin/sh\necho hi",
	}
	writeTree(t, merged, changed)
	writeTree(t, tm.abs(win+"/upper"), changed)
	for p := range changed {
		dir, name := filepath.Split(filepath.Join(tm.abs(win+"/upper"), filepath.FromSlash(p)))
		tw.handleEvent(fsEvent{wd: tm.hub.wdOf(t, dir), mask: evCloseWrite, name: name})
	}

	// index.php: release content back (through the merged view), as the account.
	if got := readFile(t, filepath.Join(merged, "index.php")); got != phpOpen+" echo 'v1';" {
		t.Errorf("index.php not reverted: %q", got)
	}
	if exists(filepath.Join(merged, "wp-content", "new-plugin.php")) || exists(filepath.Join(merged, "wp-content", "noext")) {
		t.Error("new executables not removed")
	}
	if !exists(filepath.Join(merged, "wp-content", "data.json")) {
		t.Error("data file removed")
	}
	// The lower layer is never written (M1).
	if got := readFile(t, tm.abs(win+"/lower/index.php")); got != phpOpen+" echo 'v1';" {
		t.Errorf("lower modified: %q", got)
	}
	list, _ := tm.quarantine.list(7)
	var got []string
	for _, e := range list {
		got = append(got, e.Path+" "+e.Source+" "+e.Area+" "+e.Reason)
		if e.Path == "index.php" && e.SHA256 != sum(phpOpen+" echo 'hacked';") {
			t.Errorf("evidence of index.php: %+v", e)
		}
	}
	slices.Sort(got)
	want := []string{
		"index.php supervised code executable-write",
		"wp-content/new-plugin.php supervised code executable-write",
		"wp-content/noext supervised code executable-write",
	}
	if !slices.Equal(got, want) {
		t.Errorf("quarantined %q", got)
	}
	evs, _, _ := tm.events.after(0)
	if len(evs) != 3 || evs[0].WindowID == nil || *evs[0].WindowID != 5 {
		t.Errorf("events %+v", evs)
	}
	// Our own revert is not taken again: same content as the release.
	mustWrite(t, tm.abs(win+"/upper/index.php"), phpOpen+" echo 'v1';")
	tw.handleEvent(fsEvent{wd: tm.hub.wdOf(t, tm.abs(win+"/upper")), mask: evCloseWrite, name: "index.php"})
	if list2, _ := tm.quarantine.list(7); len(list2) != 3 {
		t.Errorf("own revert quarantined: %d entries", len(list2))
	}
	// An allow-listed (restored by the staff) executable stays.
	writeTree(t, merged, map[string]string{"ok.php": phpOpen + " echo 'staff';"})
	writeTree(t, tm.abs(win+"/upper"), map[string]string{"ok.php": phpOpen + " echo 'staff';"})
	store, _ := tm.quarantine.storeDir(7, true)
	_ = tm.quarantine.allow(store, allowEntry{Area: areaCode, Slug: "blog", Path: "ok.php", SHA256: sum(phpOpen + " echo 'staff';")})
	store.Close()
	tw.handleEvent(fsEvent{wd: tm.hub.wdOf(t, tm.abs(win+"/upper")), mask: evCloseWrite, name: "ok.php"})
	if !exists(filepath.Join(merged, "ok.php")) {
		t.Error("allow-listed executable reverted")
	}
	// A baseline entry changed after the start (event lost): a rescan judges it.
	hacked := phpOpen + " echo 'changed after the allowance';"
	writeTree(t, merged, map[string]string{"wp-content/updated-plugin.php": hacked})
	writeTree(t, tm.abs(win+"/upper"), map[string]string{"wp-content/updated-plugin.php": hacked})
	if n, err := tw.rescan(); err != nil || n != 1 {
		t.Errorf("rescan of a changed baseline entry: %d %v", n, err)
	}
	if exists(filepath.Join(merged, "wp-content", "updated-plugin.php")) {
		t.Error("changed baseline entry not reverted")
	}
}

func TestTreeWatchStopAbortsScan(t *testing.T) {
	tm := newTestManager(t)
	dir := tm.abs("tree")
	files := map[string]string{}
	for i := range 50 {
		files[filepath.ToSlash(filepath.Join("d", string(rune('a'+i%26)), "f"+string(rune('a'+i/26))))] = "x"
	}
	writeTree(t, dir, files)
	var tw *treeWatch
	entries := 0
	tw = newTreeWatch("test", tm.hub, func() (*os.Root, error) { return os.OpenRoot(dir) }, func(*os.Root, string, uint32) bool {
		entries++
		if entries == 3 {
			tw.once.Do(func() { close(tw.stopc) }) // stop() arriving mid-scan
		}
		return false
	}, 0)
	if _, err := tw.start(); !errors.Is(err, errWatchStopped) {
		t.Fatalf("start: %v", err)
	}
	if entries != 3 {
		t.Errorf("scan went on after stop: %d entries", entries)
	}
	tw.stop() // done already closed: returns at once
	if len(tw.dirs) != 0 || tw.root != nil {
		t.Error("not released")
	}
	// A running watch: stop waits for the loop, which releases.
	tw2 := newTreeWatch("test2", tm.hub, func() (*os.Root, error) { return os.OpenRoot(dir) }, func(*os.Root, string, uint32) bool { return false }, 0)
	if _, err := tw2.start(); err != nil {
		t.Fatal(err)
	}
	tw2.stop()
	if len(tw2.dirs) != 0 || tw2.root != nil {
		t.Error("loop did not release")
	}
}
