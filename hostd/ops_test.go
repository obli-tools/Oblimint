package main

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

// ownerRec is an ownerFunc recording "<path relative to the root> uid:gid mode".
type ownerRec struct {
	mu   sync.Mutex
	root string
	got  map[string]string
}

func (r *ownerRec) own(f *os.File, o Owner, mode fs.FileMode) error {
	rel, err := filepath.Rel(r.root, filepath.Clean(f.Name()))
	if err != nil {
		return err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.got[filepath.ToSlash(rel)] = fmt.Sprintf("%d:%d %04o", o.UID, o.GID, mode.Perm())
	return nil
}

func (r *ownerRec) reset() {
	r.mu.Lock()
	r.got = map[string]string{}
	r.mu.Unlock()
}

// bg is the context of the direct op calls in the tests.
var bg = context.Background()

var tenant = Owner{20001, 20002}

func newTestOps(t *testing.T) (*hostOps, *ownerRec, string) {
	t.Helper()
	dir := t.TempDir()
	rec := &ownerRec{root: dir, got: map[string]string{}}
	q := newMeasuredQuota("", true, "test") // operator accepted measured-only limits
	h := newHostOps(newLayout(dir), q, rec.own)
	h.now = func() time.Time { return time.Date(2026, 10, 9, 12, 0, 0, 0, time.FixedZone("x", 3600)) }
	return h, rec, dir
}

func mustWrite(t *testing.T, p, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

// symlinkOrSkip creates a symlink or skips the test (Windows without the
// SeCreateSymbolicLink privilege / developer mode).
func symlinkOrSkip(t *testing.T, target, link string) {
	t.Helper()
	if err := os.Symlink(target, link); err != nil {
		t.Skipf("symlinks unavailable here: %v", err)
	}
}

func statusOf(err error) int {
	s, _ := classify(err)
	return s
}

func provision(t *testing.T, h *hostOps) SiteSpec {
	t.Helper()
	if _, err := h.EnsureAccount(bg, AccountSpec{AccountID: 3, Owner: tenant, QuotaMB: i64(100)}); err != nil {
		t.Fatal(err)
	}
	s := SiteSpec{AccountID: 3, SiteID: 9, Slug: "blog", Owner: tenant}
	if err := h.EnsureSite(bg, s); err != nil {
		t.Fatal(err)
	}
	return s
}

func TestEnsureAccountAndSite(t *testing.T) {
	h, rec, dir := newTestOps(t)
	mode, err := h.EnsureAccount(bg, AccountSpec{AccountID: 3, Owner: tenant, QuotaMB: i64(100)})
	if err != nil || mode != quotaMeasured {
		t.Fatalf("ensure account: %v %v", mode, err)
	}
	want := map[string]string{
		"accounts":           "0:0 0711",
		"accounts/3":         "0:0 0711",
		"accounts/3/staging": "20001:20002 0750",
		"accounts/3/data":    "0:20002 0750", // root-owned: data/<slug> (bind source) cannot be swapped by the uid
		"accounts/3/filesrv": "20001:20002 0700",
		"accounts/3/sites":   "0:0 0711",
		// P2: bind sources of the sites (dbsock) and parent of the instance data: root-owned.
		"accounts/3/dbsock":            "0:20002 0750",
		"accounts/3/dbsock/mysql":      "0:20002 0750",
		"accounts/3/dbsock/postgresql": "0:20002 0750",
		"accounts/3/databases":         "0:0 0711",
	}
	assertOwners(t, rec, want)

	rec.reset()
	if err := h.EnsureSite(bg, SiteSpec{AccountID: 3, SiteID: 9, Slug: "blog", Owner: tenant}); err != nil {
		t.Fatal(err)
	}
	assertOwners(t, rec, map[string]string{
		"accounts/3/staging/blog":     "20001:20002 0750",
		"accounts/3/data/blog":        "20001:20002 0750",
		"accounts/3/sites/9":          "0:0 0755",
		"accounts/3/sites/9/releases": "0:0 0755",
		"accounts/3/sites/9/runtime":  "0:0 0755",
	})

	// Idempotent: a second run fixes the same set, keeps tenant content.
	mustWrite(t, filepath.Join(dir, "accounts/3/staging/blog/index.php"), "<?php")
	rec.reset()
	if _, err := h.EnsureAccount(bg, AccountSpec{AccountID: 3, Owner: tenant}); err != nil {
		t.Fatal(err)
	}
	assertOwners(t, rec, want)
	if _, err := os.Stat(filepath.Join(dir, "accounts/3/staging/blog/index.php")); err != nil {
		t.Error("tenant content lost")
	}

	// The quota limit is stored (measured mode) and reported.
	u, err := h.Usage(bg, 3)
	if err != nil || u.Mode != quotaMeasured || u.QuotaBytes != nil || u.MeasuredAt != "2026-10-09T11:00:00Z" || u.UsedBytes < 5 {
		t.Errorf("usage = %+v %v", u, err)
	}
	if _, err := h.SetQuota(bg, 3, i64(50)); err != nil {
		t.Fatal(err)
	}
	if u, _ := h.Usage(bg, 3); u.QuotaBytes == nil || *u.QuotaBytes != 50*mib {
		t.Errorf("quota = %v", u.QuotaBytes)
	}

	// A site of an account never provisioned: 404.
	if err := h.EnsureSite(bg, SiteSpec{AccountID: 4, SiteID: 1, Slug: "x", Owner: tenant}); statusOf(err) != http.StatusNotFound {
		t.Errorf("missing account: %v", err)
	}
	if _, err := h.Usage(bg, 4); statusOf(err) != http.StatusNotFound {
		t.Errorf("usage of missing account: %v", err)
	}
	if _, err := h.SetQuota(bg, 4, nil); statusOf(err) != http.StatusNotFound {
		t.Errorf("quota of missing account: %v", err)
	}
}

func assertOwners(t *testing.T, rec *ownerRec, want map[string]string) {
	t.Helper()
	rec.mu.Lock()
	defer rec.mu.Unlock()
	if len(rec.got) != len(want) {
		t.Errorf("owner calls = %v, want %v", rec.got, want)
	}
	for k, v := range want {
		if rec.got[k] != v {
			t.Errorf("%s: got %q, want %q", k, rec.got[k], v)
		}
	}
}

func TestDataPathsSeedClear(t *testing.T) {
	h, rec, dir := newTestOps(t)
	s := provision(t, h)
	staging := filepath.Join(dir, "accounts/3/staging/blog")
	data := filepath.Join(dir, "accounts/3/data/blog")

	rec.reset()
	if err := h.EnsureDataPaths(bg, s, []string{"wp-content/uploads", "cache"}); err != nil {
		t.Fatal(err)
	}
	assertOwners(t, rec, map[string]string{
		"accounts/3/data/blog/wp-content":         "20001:20002 0750",
		"accounts/3/data/blog/wp-content/uploads": "20001:20002 0750",
		"accounts/3/data/blog/cache":              "20001:20002 0750",
	})
	if err := h.EnsureDataPaths(bg, s, []string{"cache"}); err != nil {
		t.Fatalf("idempotent: %v", err)
	}

	// Seed: copies files + dirs from the staging when the data dir is empty.
	mustWrite(t, filepath.Join(staging, "wp-content/uploads/2026/10/a.jpg"), "jpeg")
	mustWrite(t, filepath.Join(staging, "wp-content/uploads/b.txt"), "bb")
	mustWrite(t, filepath.Join(staging, "wp-content/uploads/.htaccess"), "deny")
	rec.reset()
	res, err := h.SeedDataPath(bg, s, "wp-content/uploads")
	if err != nil || !res.Copied || res.Files != 3 {
		t.Fatalf("seed = %+v %v", res, err)
	}
	if b, _ := os.ReadFile(filepath.Join(data, "wp-content/uploads/2026/10/a.jpg")); string(b) != "jpeg" {
		t.Errorf("copied content = %q", b)
	}
	// The copy is made in a temp sibling then renamed into place.
	got := map[string]string{}
	for k, v := range rec.got {
		got[seedTmpRe.ReplaceAllString(k, "/uploads")] = v
	}
	if got["accounts/3/data/blog/wp-content/uploads/b.txt"] != "20001:20002 0640" ||
		got["accounts/3/data/blog/wp-content/uploads/2026"] != "20001:20002 0750" ||
		got["accounts/3/data/blog/wp-content/uploads/2026/10/a.jpg"] != "20001:20002 0640" {
		t.Errorf("seed ownership = %v", got)
	}

	// Not empty any more: no second copy.
	mustWrite(t, filepath.Join(staging, "wp-content/uploads/new.txt"), "n")
	if res, err := h.SeedDataPath(bg, s, "wp-content/uploads"); err != nil || res.Copied || res.Files != 0 {
		t.Errorf("second seed = %+v %v", res, err)
	}
	if _, err := os.Stat(filepath.Join(data, "wp-content/uploads/new.txt")); err == nil {
		t.Error("a non-empty data dir must not be seeded")
	}
	// Nothing in the staging: created empty, copied=false.
	if res, err := h.SeedDataPath(bg, s, "cache/pages"); err != nil || res.Copied {
		t.Errorf("seed without source = %+v %v", res, err)
	}
	if fi, err := os.Stat(filepath.Join(data, "cache/pages")); err != nil || !fi.IsDir() {
		t.Error("seed must create the data dir")
	}

	// Clear: empties, keeps the directory, does not touch siblings.
	if err := h.ClearDataPaths(bg, s, []string{"wp-content/uploads"}); err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(filepath.Join(data, "wp-content/uploads"))
	if err != nil || len(entries) != 0 {
		t.Errorf("after clear: %v %v", entries, err)
	}
	if _, err := os.Stat(filepath.Join(data, "cache/pages")); err != nil {
		t.Error("clear touched a sibling path")
	}

	// Invalid paths never reach the disk.
	for _, p := range []string{"../../staging", "/etc", `a\b`, ""} {
		if err := h.EnsureDataPaths(bg, s, []string{p}); statusOf(err) != http.StatusBadRequest {
			t.Errorf("path %q: %v", p, err)
		}
	}
}

func TestRemoveSiteAndAccount(t *testing.T) {
	h, _, dir := newTestOps(t)
	s := provision(t, h)
	mustWrite(t, filepath.Join(dir, "accounts/3/data/blog/x"), "x")
	mustWrite(t, filepath.Join(dir, "accounts/3/sites/9/releases/1/index.php"), "x")

	if err := h.RemoveSite(bg, 3, 9, "blog", false); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, "accounts/3/data/blog/x")); err != nil {
		t.Error("purge=0 must keep files")
	}
	if err := h.RemoveSite(bg, 3, 9, "blog", true); err != nil {
		t.Fatal(err)
	}
	for _, p := range []string{"staging/blog", "data/blog", "sites/9"} {
		if _, err := os.Lstat(filepath.Join(dir, "accounts/3", p)); !errors.Is(err, fs.ErrNotExist) {
			t.Errorf("%s still there: %v", p, err)
		}
	}
	if err := h.RemoveSite(bg, 3, 9, "blog", true); err != nil {
		t.Errorf("purge is idempotent: %v", err)
	}
	if err := h.EnsureSite(bg, s); err != nil {
		t.Fatal(err)
	}

	_, _ = h.SetQuota(bg, 3, i64(10))
	if err := h.RemoveAccount(bg, 3, false); err != nil {
		t.Fatal(err)
	}
	if u, err := h.Usage(bg, 3); err != nil || u.QuotaBytes != nil {
		t.Errorf("purge=0 must release the quota and keep the tree: %+v %v", u, err)
	}
	if err := h.RemoveAccount(bg, 3, true); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(filepath.Join(dir, "accounts/3")); !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("account tree still there: %v", err)
	}
	if err := h.RemoveAccount(bg, 3, true); err != nil {
		t.Errorf("purge is idempotent: %v", err)
	}
}

func TestDiskUsageDedupesHardLinks(t *testing.T) {
	dir := t.TempDir()
	mustWrite(t, filepath.Join(dir, "releases/1/big.bin"), strings.Repeat("x", 10000))
	mustWrite(t, filepath.Join(dir, "releases/1/small.txt"), "abc")
	if err := os.MkdirAll(filepath.Join(dir, "releases/2"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Link(filepath.Join(dir, "releases/1/big.bin"), filepath.Join(dir, "releases/2/big.bin")); err != nil {
		t.Skipf("hard links unavailable: %v", err)
	}
	r, err := os.OpenRoot(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	used, err := diskUsage(bg, r)
	if err != nil {
		t.Fatal(err)
	}
	// Apparent sizes on Windows, allocated blocks on Linux: the hard link must
	// not be counted twice (well below 2 × 10000 + 3).
	if used < 10003 || used >= 20000 {
		t.Errorf("used = %d", used)
	}
}

// dirLinkOrSkip links link → target (a directory): a symlink, or on Windows
// without the symlink privilege a junction (which Go reports as irregular).
func dirLinkOrSkip(t *testing.T, target, link string) {
	t.Helper()
	if err := os.Symlink(target, link); err == nil {
		return
	}
	if runtime.GOOS == "windows" {
		out, err := exec.Command("cmd", "/c", "mklink", "/J", link, target).CombinedOutput()
		if err == nil {
			return
		}
		t.Logf("mklink /J: %v %s", err, out)
	}
	t.Skip("neither symlinks nor junctions available here")
}

func TestDirLinksAreNeverFollowed(t *testing.T) {
	h, _, dir := newTestOps(t)
	s := provision(t, h)
	outside := t.TempDir()
	mustWrite(t, filepath.Join(outside, "secret/huge.bin"), strings.Repeat("s", 50000))
	mustWrite(t, filepath.Join(outside, "secret/passwd"), "root:x:0:0")
	data := filepath.Join(dir, "accounts/3/data/blog")
	staging := filepath.Join(dir, "accounts/3/staging/blog")

	// data/<slug>/wp-content -> outside: mkdir -p must refuse to go through it.
	dirLinkOrSkip(t, filepath.Join(outside, "secret"), filepath.Join(data, "wp-content"))
	err := h.EnsureDataPaths(bg, s, []string{"wp-content/uploads"})
	if statusOf(err) != http.StatusConflict {
		t.Errorf("mkdir through a link: %v", err)
	}
	if _, err := os.Stat(filepath.Join(outside, "secret/uploads")); err == nil {
		t.Error("a directory was created outside the tree")
	}
	if err := h.ClearDataPaths(bg, s, []string{"wp-content"}); statusOf(err) != http.StatusConflict {
		t.Errorf("clear through a link: %v", err)
	}
	if _, err := os.Stat(filepath.Join(outside, "secret/passwd")); err != nil {
		t.Error("clear followed the link")
	}

	// A link that stays INSIDE the root (os.Root alone would follow it):
	// data/<slug>/rel -> sites/9/releases must never get the tenant's owner.
	releases := filepath.Join(dir, "accounts/3/sites/9/releases")
	dirLinkOrSkip(t, releases, filepath.Join(data, "rel"))
	if err := h.EnsureDataPaths(bg, s, []string{"rel/x"}); statusOf(err) != http.StatusConflict {
		t.Errorf("mkdir through an in-root link: %v", err)
	}
	if _, err := os.Stat(filepath.Join(releases, "x")); err == nil {
		t.Error("a directory was created in the releases through a link")
	}
	if res, err := h.SeedDataPath(bg, s, "rel"); statusOf(err) != http.StatusConflict {
		t.Errorf("seed into an in-root link: %+v %v", res, err)
	}

	// Usage / du: the link is counted as itself, never its target.
	u, err := h.Usage(bg, 3)
	if err != nil || u.UsedBytes >= 50000 {
		t.Errorf("usage followed a link: %+v %v", u, err)
	}
	n, err := h.Du(bg, []string{"accounts", "3", "data", "blog", "wp-content"})
	if err != nil || n >= 50000 {
		t.Errorf("du on a link = %d %v", n, err)
	}
	if _, err := h.Du(bg, []string{"accounts", "3", "data", "blog", "wp-content", "passwd"}); statusOf(err) != http.StatusConflict {
		t.Errorf("du through a link: %v", err)
	}

	// Seed from a linked source directory is refused.
	dirLinkOrSkip(t, filepath.Join(outside, "secret"), filepath.Join(staging, "linked"))
	if _, err := h.SeedDataPath(bg, s, "linked"); statusOf(err) != http.StatusConflict {
		t.Errorf("seed from a linked source: %v", err)
	}
	if _, err := os.Stat(filepath.Join(data, "linked/passwd")); err == nil {
		t.Error("seed copied through a link")
	}

	// Purge removes the links, not their targets.
	if err := h.RemoveSite(bg, 3, 9, "blog", true); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(outside, "secret/passwd")); err != nil {
		t.Error("purge followed a link")
	}
	if _, err := os.Lstat(data); !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("data dir still there: %v", err)
	}
}

func TestSeedSkipsSymlinks(t *testing.T) {
	h, _, dir := newTestOps(t)
	s := provision(t, h)
	outside := t.TempDir()
	mustWrite(t, filepath.Join(outside, "passwd"), "root:x:0:0")
	staging := filepath.Join(dir, "accounts/3/staging/blog")
	data := filepath.Join(dir, "accounts/3/data/blog")
	mustWrite(t, filepath.Join(staging, "media/ok.txt"), "ok")
	symlinkOrSkip(t, filepath.Join(outside, "passwd"), filepath.Join(staging, "media/leak"))
	symlinkOrSkip(t, outside, filepath.Join(staging, "media/leakdir"))
	res, err := h.SeedDataPath(bg, s, "media")
	if err != nil || res.Files != 1 {
		t.Fatalf("seed = %+v %v", res, err)
	}
	for _, name := range []string{"leak", "leakdir"} {
		if _, err := os.Lstat(filepath.Join(data, "media", name)); !errors.Is(err, fs.ErrNotExist) {
			t.Errorf("%s was copied", name)
		}
	}
}

func TestDuContainment(t *testing.T) {
	h, _, dir := newTestOps(t)
	provision(t, h)
	mustWrite(t, filepath.Join(dir, "accounts/3/data/blog/f"), strings.Repeat("a", 1234))
	n, err := h.Du(bg, []string{"accounts", "3", "data", "blog", "f"})
	if err != nil || n == 0 {
		t.Errorf("du file = %d %v", n, err)
	}
	if total, err := h.Du(bg, nil); err != nil || total < n {
		t.Errorf("du root = %d %v", total, err)
	}
	if _, err := h.Du(bg, []string{"accounts", "3", "nope"}); statusOf(err) != http.StatusNotFound {
		t.Errorf("du missing: %v", err)
	}
	// ".." can never escape the os.Root even if it slipped through.
	if _, err := h.Du(bg, []string{"..", "x"}); err == nil {
		t.Error("du escaped the root")
	}
}

// seedTmpRe matches the temp directory of a seed in recorded paths.
var seedTmpRe = regexp.MustCompile(`/\.oblimint-seed-[0-9a-f]{16}`)

// An interrupted seed (copy error, caller gone, hostd killed) leaves the
// target empty, and the next seed starts over and completes it.
func TestSeedIsCrashSafe(t *testing.T) {
	h, rec, dir := newTestOps(t)
	s := provision(t, h)
	staging := filepath.Join(dir, "accounts/3/staging/blog")
	data := filepath.Join(dir, "accounts/3/data/blog")
	for i := 0; i < 5; i++ {
		mustWrite(t, filepath.Join(staging, fmt.Sprintf("up/d%d/f.txt", i)), "x")
	}
	isEmpty := func() bool {
		entries, err := os.ReadDir(filepath.Join(data, "up"))
		return err == nil && len(entries) == 0
	}
	noTemp := func() {
		t.Helper()
		entries, _ := os.ReadDir(data)
		for _, e := range entries {
			if strings.HasPrefix(e.Name(), seedTmpPrefix) {
				t.Errorf("temp directory left behind: %s", e.Name())
			}
		}
	}

	// 1. The copy fails part way (ENOSPC / EDQUOT / changed during copy...).
	calls := 0
	h.own = func(f *os.File, o Owner, mode fs.FileMode) error {
		if strings.HasSuffix(filepath.ToSlash(f.Name()), "f.txt") {
			if calls++; calls == 3 {
				return errors.New("no space left on device")
			}
		}
		return rec.own(f, o, mode)
	}
	if _, err := h.SeedDataPath(bg, s, "up"); err == nil {
		t.Fatal("the copy error must surface")
	}
	if !isEmpty() {
		t.Fatal("a failed seed must leave the target empty")
	}
	noTemp()

	// 2. The caller left (panel timeout): stop, nothing half copied.
	h.own = rec.own
	ctx, cancel := context.WithCancel(bg)
	cancel()
	if _, err := h.SeedDataPath(ctx, s, "up"); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled seed: %v", err)
	}
	if !isEmpty() {
		t.Fatal("a cancelled seed must leave the target empty")
	}

	// 3. hostd was killed during a copy: the stale temp dir is removed.
	mustWrite(t, filepath.Join(data, seedTmpPrefix+"0123456789abcdef", "d0", "f.txt"), "partial")
	res, err := h.SeedDataPath(bg, s, "up")
	if err != nil || !res.Copied || res.Files != 5 {
		t.Fatalf("retry = %+v %v", res, err)
	}
	noTemp()
	for i := 0; i < 5; i++ {
		if b, err := os.ReadFile(filepath.Join(data, fmt.Sprintf("up/d%d/f.txt", i))); err != nil || string(b) != "x" {
			t.Errorf("d%d: %q %v", i, b, err)
		}
	}
	if got := rec.got["accounts/3/data/blog/up"]; got != "20001:20002 0750" {
		t.Errorf("seeded dir ownership = %q", got)
	}
}

// A seed holding the account makes quick operations answer 409 busy instead
// of hanging until the panel times out.
func TestAccountLockBusy(t *testing.T) {
	h, _, _ := newTestOps(t)
	s := provision(t, h)
	unlock, err := h.lock(bg, s.AccountID, 0)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(bg, 50*time.Millisecond)
	defer cancel()
	if err := h.EnsureSite(ctx, s); statusOf(err) != http.StatusConflict {
		t.Errorf("ensure while busy: %v", err)
	} else if _, code := classify(err); code != codeBusy {
		t.Errorf("code = %s", code)
	}
	// Another account is not blocked.
	if _, err := h.EnsureAccount(bg, AccountSpec{AccountID: 4, Owner: tenant}); err != nil {
		t.Errorf("other account: %v", err)
	}
	done := make(chan error, 1)
	go func() { done <- h.EnsureSite(bg, s) }()
	time.Sleep(20 * time.Millisecond)
	unlock()
	if err := <-done; err != nil {
		t.Errorf("ensure after release: %v", err)
	}
}

// A tenant tree deeper than the copy limit (128) is still measured: usage
// and du never fail because of tenant-shaped content.
func TestUsageOfDeepTree(t *testing.T) {
	h, _, dir := newTestOps(t)
	provision(t, h)
	data, err := os.OpenRoot(filepath.Join(dir, "accounts/3/data/blog"))
	if err != nil {
		t.Fatal(err)
	}
	cur := data
	for i := 0; i < 130; i++ {
		if err := cur.Mkdir("a", 0o755); err != nil {
			t.Fatal(err)
		}
		next, err := cur.OpenRoot("a")
		if cur != data {
			cur.Close()
		}
		if err != nil {
			t.Fatal(err)
		}
		cur = next
	}
	if err := cur.WriteFile("deep.bin", make([]byte, 5000), 0o644); err != nil {
		t.Fatal(err)
	}
	cur.Close()
	data.Close()

	u, err := h.Usage(bg, 3)
	if err != nil || u.UsedBytes < 5000 {
		t.Fatalf("usage of a 130-level tree = %+v %v", u, err)
	}
	if n, err := h.Du(bg, []string{"accounts", "3", "data", "blog"}); err != nil || n < 5000 {
		t.Fatalf("du of a 130-level tree = %d %v", n, err)
	}
	// Past the walk limit: measured down to the limit, never an error.
	defer func(old int) { maxWalkDepth = old }(maxWalkDepth)
	maxWalkDepth = 10
	u, err = h.Usage(bg, 3)
	if err != nil || u.UsedBytes >= 5000 {
		t.Fatalf("usage past the walk limit = %+v %v", u, err)
	}
	// The caller left: the walk stops.
	ctx, cancel := context.WithCancel(bg)
	cancel()
	if _, err := h.Usage(ctx, 3); !errors.Is(err, context.Canceled) {
		t.Errorf("cancelled usage: %v", err)
	}
}

// GET /v1/fs only describes paths inside the root, never through a link.
func TestFSInfoStaysInRoot(t *testing.T) {
	h, _, dir := newTestOps(t)
	provision(t, h)
	var looked []string
	h.resolveRoot = func(string) (string, error) { return "/real/oblimint", nil }
	h.mountInfo = func(p string) (FSInfo, error) {
		looked = append(looked, p)
		return FSInfo{Path: p, FSType: "xfs", MountPoint: "/real"}, nil
	}
	if fi, err := h.FSInfo(nil); err != nil || fi.Path != "/real/oblimint" {
		t.Errorf("root: %+v %v", fi, err)
	}
	if fi, err := h.FSInfo([]string{"accounts", "3"}); err != nil || fi.Path != "/real/oblimint/accounts/3" {
		t.Errorf("account: %+v %v", fi, err)
	}
	if _, err := h.FSInfo([]string{"accounts", "99"}); statusOf(err) != http.StatusNotFound {
		t.Errorf("missing: %v", err)
	}
	symlinkOrSkip(t, t.TempDir(), filepath.Join(dir, "accounts/3/data/blog/out"))
	for _, rel := range [][]string{{"accounts", "3", "data", "blog", "out"}, {"accounts", "3", "data", "blog", "out", "x"}} {
		if _, err := h.FSInfo(rel); statusOf(err) != http.StatusConflict {
			t.Errorf("%v through a link: %v", rel, err)
		}
	}
	if len(looked) != 2 {
		t.Errorf("mountinfo looked up for %q", looked)
	}
}

// Through the ops: in measured mode without the opt-in, an account with a
// disk limit is refused (409 quotaNotEnforced, the panel marks it in error)
// while an account without a limit is provisioned; SetQuota likewise.
func TestEnsureAccountMeasuredWithoutOptIn(t *testing.T) {
	dir := t.TempDir()
	rec := &ownerRec{root: dir, got: map[string]string{}}
	h := newHostOps(newLayout(dir), newMeasuredQuota("", false, "no prjquota"), rec.own)

	_, err := h.EnsureAccount(bg, AccountSpec{AccountID: 3, Owner: tenant, QuotaMB: i64(100)})
	if _, code := classify(err); code != codeQuotaNotEnforced {
		t.Fatalf("limited account: %v", err)
	}
	if mode, err := h.EnsureAccount(bg, AccountSpec{AccountID: 4, Owner: tenant}); err != nil || mode != quotaMeasured {
		t.Fatalf("unlimited account: %v %v", mode, err)
	}
	if _, err := h.SetQuota(bg, 4, i64(50)); err == nil {
		t.Error("SetQuota with a limit must be refused")
	}
	if _, err := h.SetQuota(bg, 4, nil); err != nil {
		t.Errorf("SetQuota(nil): %v", err)
	}
}
