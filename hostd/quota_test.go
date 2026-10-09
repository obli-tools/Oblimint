package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"
)

// Output of `xfs_quota -x -c "report -p -b -n -N" /srv/oblimint` (xfsprogs 6.x).
const sampleReport = `#0                 1234          0          0     00 [--------]
#100001          204800          0    1048576     00 [--------]
#100002         1048580          0    1048576     00 [7 days]
#100003               0          0          0     00 [--------]

`

func TestParseXFSReport(t *testing.T) {
	rows, err := parseXFSReport(sampleReport)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 4 {
		t.Fatalf("rows = %v", rows)
	}
	if r := rows[100001]; r.UsedKiB != 204800 || r.HardKiB != 1048576 || r.SoftKiB != 0 {
		t.Errorf("100001 = %+v", r)
	}
	if r := rows[100002]; r.UsedKiB != 1048580 {
		t.Errorf("100002 = %+v", r)
	}
	// Header lines (without -N) and named projects are skipped.
	withHeader := "Project quota on /srv/oblimint (/dev/sdb1)\n                               Blocks                     \nProject ID       Used       Soft       Hard    Warn/Grace     \n---------- -------------------------------------------------- \nweb          10   0   0   00 [--------]\n#100005          10          0         20     00 [--------]\n"
	rows, err = parseXFSReport(withHeader)
	if err != nil || len(rows) != 1 || rows[100005].HardKiB != 20 {
		t.Errorf("with header: %v %v", rows, err)
	}
	if _, err := parseXFSReport("#100001 12x 0 0 00 [--------]\n"); err == nil {
		t.Error("expected an error on a malformed number")
	}
}

type fakeRun struct {
	calls [][]string
	out   map[string]string // command (-c value) → output
	err   error
}

func (f *fakeRun) run(_ context.Context, name string, args ...string) ([]byte, error) {
	f.calls = append(f.calls, append([]string{name}, args...))
	if f.err != nil {
		return nil, f.err
	}
	return []byte(f.out[args[2]]), nil
}

func (f *fakeRun) commands() []string {
	var cmds []string
	for _, c := range f.calls {
		cmds = append(cmds, c[3])
	}
	return cmds
}

func i64(n int64) *int64 { return &n }

// fakeProj is a projAttr keyed by the (cleaned) name of the opened file.
type fakeProj struct {
	mu   sync.Mutex
	root string
	id   map[string]uint32
	inh  map[string]bool
	sets []string // "<rel> <id> <inherit>"
}

func newFakeProj(root string) *fakeProj {
	return &fakeProj{root: root, id: map[string]uint32{}, inh: map[string]bool{}}
}

func (p *fakeProj) key(f *os.File) string {
	rel, _ := filepath.Rel(p.root, filepath.Clean(f.Name()))
	return filepath.ToSlash(rel)
}

func (p *fakeProj) get(f *os.File) (uint32, bool, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	k := p.key(f)
	return p.id[k], p.inh[k], nil
}

func (p *fakeProj) set(f *os.File, id uint32, inherit bool) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	k := p.key(f)
	p.id[k], p.inh[k] = id, inherit
	p.sets = append(p.sets, fmt.Sprintf("%s %d %v", k, id, inherit))
	return nil
}

func (p *fakeProj) takeSets() []string {
	p.mu.Lock()
	defer p.mu.Unlock()
	out := p.sets
	p.sets = nil
	slices.Sort(out)
	return out
}

func newTestXFS(t *testing.T) (*xfsQuota, *fakeRun, *fakeProj, string) {
	t.Helper()
	dir := t.TempDir()
	mustWrite(t, filepath.Join(dir, "data", "blog", "up", "a.jpg"), "x")
	mustWrite(t, filepath.Join(dir, "staging", "blog", "index.php"), "<?php")
	fr := &fakeRun{out: map[string]string{"report -p -b -n -N -L 100001 -U 100001": sampleReport}}
	q := newXFSQuota("/srv/oblimint", fr.run)
	attr := newFakeProj(dir)
	q.attr = attr
	q.background = func(f func()) { f() }
	return q, fr, attr, dir
}

func TestXFSQuotaCommands(t *testing.T) {
	q, fr, attr, dir := newTestXFS(t)
	now := time.Date(2026, 10, 9, 12, 0, 0, 0, time.UTC)
	q.now = func() time.Time { return now }

	// Untagged tree: every directory (with PROJINHERIT) and regular file is
	// tagged by hostd through descriptors, xfs_quota only sets the limit.
	if err := q.Ensure(bg, 100001, dir, i64(1024)); err != nil {
		t.Fatal(err)
	}
	want := [][]string{{"xfs_quota", "-x", "-c", "limit -p bhard=1024m 100001", "/srv/oblimint"}}
	if len(fr.calls) != 1 || !slices.Equal(fr.calls[0], want[0]) {
		t.Fatalf("calls = %q", fr.calls)
	}
	wantSets := []string{
		". 100001 true",
		"data 100001 true", "data/blog 100001 true", "data/blog/up 100001 true", "data/blog/up/a.jpg 100001 false",
		"staging 100001 true", "staging/blog 100001 true", "staging/blog/index.php 100001 false",
	}
	if got := attr.takeSets(); !slices.Equal(got, wantSets) {
		t.Errorf("tagged = %q\nwant %q", got, wantSets)
	}

	// Already tagged, audit not due: no walk, only the limit (0 = none).
	fr.calls = nil
	mustWrite(t, filepath.Join(dir, "data", "blog", "moved.bin"), "x")
	attr.id["data/blog/moved.bin"] = 0 // the tenant ran chproj 0 on it
	if err := q.Ensure(bg, 100001, dir, nil); err != nil {
		t.Fatal(err)
	}
	if got := fr.commands(); !slices.Equal(got, []string{"limit -p bhard=0m 100001"}) {
		t.Errorf("commands = %q", got)
	}
	if got := attr.takeSets(); len(got) != 0 {
		t.Errorf("no walk expected before the audit is due, got %q", got)
	}
	// Audit due: what left the project is re-tagged, the rest is untouched.
	now = now.Add(q.auditEvery)
	if err := q.Ensure(bg, 100001, dir, nil); err != nil {
		t.Fatal(err)
	}
	if got := attr.takeSets(); !slices.Equal(got, []string{"data/blog/moved.bin 100001 false"}) {
		t.Errorf("audit re-tagged %q", got)
	}
	// A directory moved out (or PROJINHERIT cleared) below the root.
	now = now.Add(q.auditEvery)
	attr.inh["data/blog/up"] = false
	_ = q.Ensure(bg, 100001, dir, nil)
	if got := attr.takeSets(); !slices.Equal(got, []string{"data/blog/up 100001 true"}) {
		t.Errorf("audit re-tagged %q", got)
	}
	// Root tagged with another project: synchronous re-tag of the root at least.
	attr.id["."] = 100009
	_ = q.Ensure(bg, 100001, dir, i64(5))
	if got := attr.takeSets(); !slices.Contains(got, ". 100001 true") {
		t.Errorf("root not re-tagged: %q", got)
	}

	used, limit, err := q.Usage(bg, 100001, "")
	if err != nil || used != 204800*1024 || limit == nil || *limit != 1048576*1024 {
		t.Errorf("usage = %d %v %v", used, limit, err)
	}
	// A project absent from the report has used nothing.
	fr.out = map[string]string{}
	if used, limit, err := q.Usage(bg, 100001, ""); err != nil || used != 0 || limit != nil {
		t.Errorf("empty usage = %d %v %v", used, limit, err)
	}

	fr.calls = nil
	if err := q.Release(100001); err != nil || !slices.Equal(fr.commands(), []string{"limit -p bhard=0m 100001"}) {
		t.Errorf("release: %v %q", err, fr.commands())
	}

	fr.err = errors.New("boom")
	if err := q.Ensure(bg, 100001, dir, nil); err == nil {
		t.Error("runner error must surface")
	}
	if err := q.Ensure(bg, 100001, filepath.Join(dir, "missing"), nil); err == nil {
		t.Error("a missing account tree must be refused")
	}
}

// The tagging walk never follows a symlink a tenant planted in its tree
// (`xfs_quota project -s` would have tagged the link target).
func TestXFSTagNeverFollowsLinks(t *testing.T) {
	q, _, attr, dir := newTestXFS(t)
	outside := t.TempDir()
	mustWrite(t, filepath.Join(outside, "other-account.db"), "secret")
	symlinkOrSkip(t, outside, filepath.Join(dir, "data", "blog", "evil"))
	symlinkOrSkip(t, filepath.Join(outside, "other-account.db"), filepath.Join(dir, "data", "blog", "evil.db"))
	if err := q.Ensure(bg, 100001, dir, nil); err != nil {
		t.Fatal(err)
	}
	for _, s := range attr.takeSets() {
		if strings.Contains(s, "evil") || strings.HasPrefix(s, "..") {
			t.Errorf("followed a link: %s", s)
		}
	}
}

func TestXFSTagCancelled(t *testing.T) {
	q, _, _, dir := newTestXFS(t)
	ctx, cancel := context.WithCancel(bg)
	cancel()
	if err := q.Ensure(ctx, 100001, dir, nil); !errors.Is(err, context.Canceled) {
		t.Errorf("cancelled ensure: %v", err)
	}
}

func TestMeasuredQuotaPersistsLimits(t *testing.T) {
	state := filepath.Join(t.TempDir(), "run", "hostd-quota.json")
	q := newMeasuredQuota(state)
	q.measure = func(context.Context, string) (int64, error) { return 4096, nil }
	if err := q.Ensure(bg, 100001, "x", i64(10)); err != nil {
		t.Fatal(err)
	}
	_ = q.Ensure(bg, 100002, "x", i64(20))
	_ = q.Ensure(bg, 100002, "x", nil)

	q2 := newMeasuredQuota(state)
	q2.measure = q.measure
	used, limit, err := q2.Usage(bg, 100001, "x")
	if err != nil || used != 4096 || limit == nil || *limit != 10*mib {
		t.Errorf("usage = %d %v %v", used, limit, err)
	}
	if _, limit, _ := q2.Usage(bg, 100002, "x"); limit != nil {
		t.Errorf("limit of 100002 should be cleared, got %d", *limit)
	}
	_ = q2.Release(100001)
	if _, limit, _ := newMeasuredQuota(state).Usage(bg, 100001, t.TempDir()); limit != nil {
		t.Error("release must clear the limit")
	}
}

func TestDetectQuota(t *testing.T) {
	l := newLayout("/srv/oblimint")
	found := func(string) (string, error) { return "/usr/sbin/xfs_quota", nil }
	missing := func(string) (string, error) { return "", errors.New("not found") }
	xfs := func(string) (FSInfo, error) {
		return FSInfo{FSType: "xfs", MountPoint: "/srv/oblimint", ProjectQuota: true}, nil
	}
	noPrj := func(string) (FSInfo, error) { return FSInfo{FSType: "xfs", MountPoint: "/"}, nil }
	ext4 := func(string) (FSInfo, error) { return FSInfo{FSType: "ext4", MountPoint: "/", ProjectQuota: true}, nil }
	unknown := func(string) (FSInfo, error) { return FSInfo{}, errUnsupported }

	if q, _ := detectQuota(l, xfs, found, nil); q.Mode() != quotaXFS || q.(*xfsQuota).mountPoint != "/srv/oblimint" {
		t.Errorf("xfs+prjquota: %v", q.Mode())
	}
	for name, info := range map[string]func(string) (FSInfo, error){"noprj": noPrj, "ext4": ext4, "unknown": unknown} {
		if q, _ := detectQuota(l, info, found, nil); q.Mode() != quotaMeasured {
			t.Errorf("%s: %v", name, q.Mode())
		}
	}
	if q, why := detectQuota(l, xfs, missing, nil); q.Mode() != quotaMeasured || !strings.Contains(why, "xfs_quota") {
		t.Errorf("no binary: %v %s", q.Mode(), why)
	}
}
