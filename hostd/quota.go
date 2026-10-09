package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// QuotaMode mirrors QuotaMode of @oblimint/shared.
type QuotaMode string

const (
	// quotaXFS: hard limits enforced by the kernel (XFS project quotas).
	quotaXFS QuotaMode = "xfs"
	// quotaMeasured: usage measured by walking the tree, the limit is only
	// remembered (the panel alerts, nothing is enforced). A disk limit is
	// refused in this mode unless the operator accepted unenforced limits
	// (OBLIMINT_ALLOW_MEASURED_QUOTA=1): otherwise one account could fill the
	// shared filesystem while the plan promises a cap.
	quotaMeasured QuotaMode = "measured"
)

// allowMeasuredQuotaEnv is the operator opt-in to disk limits that are only
// measured (no filesystem able to enforce them). The panel forwards it from
// its own environment to the hostd container.
const allowMeasuredQuotaEnv = "OBLIMINT_ALLOW_MEASURED_QUOTA"

// envFlag reads a boolean opt-in: 1 / true / yes (case-insensitive) = on.
func envFlag(v string) bool {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "1", "true", "yes", "on":
		return true
	}
	return false
}

const mib = 1024 * 1024

// Quota manages the per-account disk quota (one project per account).
type Quota interface {
	Mode() QuotaMode
	// Ensure tags dir with the project and sets the hard limit (nil = no
	// limit).
	Ensure(ctx context.Context, projectID uint32, dir string, limitMB *int64) error
	// Usage returns the bytes used by the project and its limit in bytes.
	Usage(ctx context.Context, projectID uint32, dir string) (used int64, limit *int64, err error)
	// Release removes the limit of the project (files are left as they are).
	Release(projectID uint32) error
}

// runner executes a command and returns its combined output (injectable).
type runner func(ctx context.Context, name string, args ...string) ([]byte, error)

func execRunner(ctx context.Context, name string, args ...string) ([]byte, error) {
	out, err := exec.CommandContext(ctx, name, args...).CombinedOutput()
	if err != nil {
		return out, fmt.Errorf("%s %s: %w: %s", name, strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
	return out, nil
}

// ── XFS project quotas ───────────────────────────────────────────────────────

// xfsQuota drives xfs_quota in expert mode (-x) on the filesystem mounted at
// mountPoint for the limits and the report. Project ids are numeric
// (100000+accountId): no /etc/projects.
//
// Tagging the tree with the project is done by hostd itself, NOT with
// `xfs_quota project -s` (which re-opens every path by name and so follows a
// link a tenant swapped in, R1): tagTree walks with the no-follow primitives
// and sets the project id through the opened descriptors. The owner of a file
// may move it out of the project (FS_IOC_FSSETXATTR needs no capability in
// the init user namespace): the site / filesrv containers must deny that ioctl
// (seccomp, orchestration), and Ensure re-audits the whole tree at most every
// auditEvery (in the background) and re-tags whatever left the project.
type xfsQuota struct {
	mountPoint string
	binary     string
	run        runner
	timeout    time.Duration
	attr       projAttr

	auditEvery time.Duration
	now        func() time.Time
	background func(func()) // runs an audit (go f(); tests: synchronously)

	mu        sync.Mutex
	lastAudit map[uint32]time.Time
	auditing  map[uint32]bool
}

// projAttr reads / sets the project id and the PROJINHERIT flag of an opened
// file or directory (FS_IOC_FSGETXATTR / FS_IOC_FSSETXATTR on Linux; set keeps
// the other flags).
type projAttr interface {
	get(f *os.File) (projectID uint32, inherit bool, err error)
	set(f *os.File, projectID uint32, inherit bool) error
}

func newXFSQuota(mountPoint string, run runner) *xfsQuota {
	return &xfsQuota{
		mountPoint: mountPoint, binary: "xfs_quota", run: run, timeout: 10 * time.Minute, attr: fsxattrProj{},
		auditEvery: time.Hour, now: time.Now, background: func(f func()) { go f() },
		lastAudit: map[uint32]time.Time{}, auditing: map[uint32]bool{},
	}
}

func (q *xfsQuota) Mode() QuotaMode { return quotaXFS }

func (q *xfsQuota) exec(ctx context.Context, command string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, q.timeout)
	defer cancel()
	return q.run(ctx, q.binary, xfsArgs(command, q.mountPoint)...)
}

// xfsArgs builds `xfs_quota -x -c "<command>" <mountPoint>`: the command is
// ONE argv element (no shell involved), built only from numbers.
func xfsArgs(command, mountPoint string) []string {
	return []string{"-x", "-c", command, mountPoint}
}

func xfsLimitCmd(projectID uint32, limitMB *int64) string {
	var n int64 // 0 = unlimited
	if limitMB != nil {
		n = *limitMB
	}
	return fmt.Sprintf("limit -p bhard=%dm %d", n, projectID)
}

func xfsReportCmd(projectID uint32) string {
	return fmt.Sprintf("report -p -b -n -N -L %d -U %d", projectID, projectID)
}

// Ensure tags the account tree when its root is not (yet) in the project with
// PROJINHERIT (creation, switch from the measured mode, root re-tagged by the
// tenant), otherwise schedules the periodic background audit; then sets the
// limit. dir is computed by the layout (root-owned parents).
func (q *xfsQuota) Ensure(ctx context.Context, projectID uint32, dir string, limitMB *int64) error {
	root, err := os.OpenRoot(dir)
	if err != nil {
		return err
	}
	defer root.Close()
	id, inherit, err := rootProject(root, q.attr)
	if err != nil {
		return err
	}
	if id != projectID || !inherit {
		fixed, err := tagTree(ctx, root, projectID, q.attr)
		if err != nil {
			return fmt.Errorf("tag %s with project %d: %w", dir, projectID, err)
		}
		q.audited(projectID)
		slog.Info("quota: tree tagged with its project", "dir", dir, "project", projectID, "entries", fixed)
	} else if q.auditDue(projectID) {
		q.background(func() { q.audit(projectID, dir) })
	}
	_, err = q.exec(ctx, xfsLimitCmd(projectID, limitMB))
	return err
}

// auditDue reports (and reserves) a due audit: one at a time per project.
func (q *xfsQuota) auditDue(projectID uint32) bool {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.auditing[projectID] || q.now().Sub(q.lastAudit[projectID]) < q.auditEvery {
		return false
	}
	q.auditing[projectID] = true
	return true
}

func (q *xfsQuota) audited(projectID uint32) {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.lastAudit[projectID] = q.now()
}

// audit re-tags whatever left the project below dir (logged: a tenant moved
// files out of its quota, or the tree was restored from elsewhere).
func (q *xfsQuota) audit(projectID uint32, dir string) {
	defer func() {
		q.mu.Lock()
		delete(q.auditing, projectID)
		q.mu.Unlock()
	}()
	ctx, cancel := context.WithTimeout(context.Background(), q.timeout)
	defer cancel()
	root, err := os.OpenRoot(dir)
	if err != nil {
		slog.Warn("quota audit: cannot open the account tree", "dir", dir, "err", err)
		return
	}
	defer root.Close()
	fixed, err := tagTree(ctx, root, projectID, q.attr)
	if err != nil {
		slog.Warn("quota audit failed", "dir", dir, "project", projectID, "err", err)
		return
	}
	q.audited(projectID)
	if fixed > 0 {
		slog.Warn("quota audit: entries outside the account project were re-tagged", "dir", dir, "project", projectID, "entries", fixed)
	}
}

func rootProject(root *os.Root, attr projAttr) (uint32, bool, error) {
	f, err := root.Open(".")
	if err != nil {
		return 0, false, err
	}
	defer f.Close()
	return attr.get(f)
}

// tagTree sets projectID (and PROJINHERIT on directories) on root and on every
// directory and regular file below it that lacks it, through descriptors
// opened without following links. Symlinks, fifos and sockets are skipped
// (they cannot be opened safely; a link only weighs its inode). Returns how
// many entries were changed.
func tagTree(ctx context.Context, root *os.Root, projectID uint32, attr projAttr) (int, error) {
	fixed := 0
	fix := func(f *os.File, dir bool) error {
		id, inherit, err := attr.get(f)
		if err != nil {
			return err
		}
		if id == projectID && (inherit || !dir) {
			return nil
		}
		fixed++
		return attr.set(f, projectID, dir)
	}
	fixDir := func(d *os.Root) error {
		f, err := d.Open(".")
		if err != nil {
			return err
		}
		defer f.Close()
		return fix(f, true)
	}
	if err := fixDir(root); err != nil {
		return fixed, err
	}
	tooDeep, err := walkTree(ctx, root, func(parent *os.Root, name string, fi fs.FileInfo, sub *os.Root) error {
		switch {
		case sub != nil:
			return fixDir(sub)
		case fi.Mode().IsRegular():
			f, ok, err := openRegular(parent, name)
			if errors.Is(err, fs.ErrNotExist) || errors.Is(err, errUnsafePath) || (err == nil && !ok) {
				return nil // vanished or swapped meanwhile
			}
			if err != nil {
				return err
			}
			defer f.Close()
			return fix(f, false)
		}
		return nil
	})
	if tooDeep > 0 {
		slog.Warn("quota: subtrees deeper than the walk limit were not tagged", "dir", root.Name(), "subtrees", tooDeep, "limit", maxWalkDepth)
	}
	return fixed, err
}

func (q *xfsQuota) Usage(ctx context.Context, projectID uint32, _ string) (int64, *int64, error) {
	out, err := q.exec(ctx, xfsReportCmd(projectID))
	if err != nil {
		return 0, nil, err
	}
	rows, err := parseXFSReport(string(out))
	if err != nil {
		return 0, nil, err
	}
	row, ok := rows[projectID]
	if !ok {
		return 0, nil, nil // nothing accounted yet
	}
	var limit *int64
	if row.HardKiB > 0 {
		b := row.HardKiB * 1024
		limit = &b
	}
	return row.UsedKiB * 1024, limit, nil
}

func (q *xfsQuota) Release(projectID uint32) error {
	_, err := q.exec(context.Background(), xfsLimitCmd(projectID, nil))
	return err
}

// xfsReportRow is one line of `report -p -b -n -N` (block counts in KiB).
type xfsReportRow struct {
	UsedKiB, SoftKiB, HardKiB int64
}

// parseXFSReport parses lines such as
//
//	#100001          2048          0    1048576     00 [--------]
//
// (project, used, soft, hard, warnings, grace). Header and blank lines, and
// projects reported by name, are skipped.
func parseXFSReport(out string) (map[uint32]xfsReportRow, error) {
	rows := make(map[uint32]xfsReportRow)
	sc := bufio.NewScanner(strings.NewReader(out))
	for sc.Scan() {
		f := strings.Fields(sc.Text())
		if len(f) < 4 {
			continue
		}
		id, err := strconv.ParseUint(strings.TrimPrefix(f[0], "#"), 10, 32)
		if err != nil {
			continue // header / dashes / named project
		}
		var nums [3]int64
		for i := range nums {
			if nums[i], err = strconv.ParseInt(f[i+1], 10, 64); err != nil || nums[i] < 0 {
				return nil, fmt.Errorf("xfs_quota report: bad line %q", sc.Text())
			}
		}
		rows[uint32(id)] = xfsReportRow{UsedKiB: nums[0], SoftKiB: nums[1], HardKiB: nums[2]}
	}
	return rows, sc.Err()
}

// ── Measured fallback ────────────────────────────────────────────────────────

// measuredQuota walks the tree (diskUsage) and only remembers the limit, in a
// small state file so a restart keeps it. Nothing stops a tenant from writing
// past that limit, so Ensure refuses a limit unless acceptLimits (operator
// opt-in): the account is then not provisioned (fail closed) instead of
// running with a cap that only exists on paper. reason (why no hard quota) is
// quoted in the refusal.
type measuredQuota struct {
	store        *limitStore
	measure      func(ctx context.Context, dir string) (int64, error)
	acceptLimits bool
	reason       string
}

func newMeasuredQuota(statePath string, acceptLimits bool, reason string) *measuredQuota {
	return &measuredQuota{store: newLimitStore(statePath), measure: measureDir, acceptLimits: acceptLimits, reason: reason}
}

// errNotEnforced: a disk limit was asked for on a filesystem that cannot
// enforce it, and the operator did not accept measured-only limits.
func (q *measuredQuota) errNotEnforced(limitMB int64) error {
	why := q.reason
	if why == "" {
		why = "no XFS project quota on the hosting root"
	}
	return &apiError{http.StatusConflict, codeQuotaNotEnforced, fmt.Sprintf(
		"disk limit of %d MiB refused: it cannot be enforced (%s). Put the hosting root on XFS mounted with prjquota for hard quotas, "+
			"or set %s=1 on the panel to accept limits that are only measured (no hard limit: an account can fill the disk)",
		limitMB, why, allowMeasuredQuotaEnv)}
}

func measureDir(ctx context.Context, dir string) (int64, error) {
	r, err := os.OpenRoot(dir)
	if err != nil {
		return 0, err
	}
	defer r.Close()
	return diskUsage(ctx, r)
}

func (q *measuredQuota) Mode() QuotaMode { return quotaMeasured }

func (q *measuredQuota) Ensure(_ context.Context, projectID uint32, _ string, limitMB *int64) error {
	if limitMB != nil && *limitMB > 0 && !q.acceptLimits {
		return q.errNotEnforced(*limitMB)
	}
	return q.store.set(projectID, limitMB)
}

func (q *measuredQuota) Usage(ctx context.Context, projectID uint32, dir string) (int64, *int64, error) {
	used, err := q.measure(ctx, dir)
	if err != nil {
		return 0, nil, err
	}
	var limit *int64
	if mb, ok := q.store.get(projectID); ok {
		b := mb * mib
		limit = &b
	}
	return used, limit, nil
}

func (q *measuredQuota) Release(projectID uint32) error { return q.store.set(projectID, nil) }

// limitStore keeps project → limit (MiB) in memory and, when path is set, in
// a JSON file written atomically (0600).
type limitStore struct {
	mu     sync.Mutex
	path   string
	limits map[uint32]int64
}

func newLimitStore(path string) *limitStore {
	s := &limitStore{path: path, limits: make(map[uint32]int64)}
	if path == "" {
		return s
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return s
	}
	var raw map[string]int64
	if json.Unmarshal(b, &raw) == nil {
		for k, v := range raw {
			if id, err := strconv.ParseUint(k, 10, 32); err == nil && v > 0 {
				s.limits[uint32(id)] = v
			}
		}
	}
	return s
}

func (s *limitStore) get(projectID uint32) (int64, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	v, ok := s.limits[projectID]
	return v, ok
}

func (s *limitStore) set(projectID uint32, limitMB *int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if limitMB == nil || *limitMB <= 0 {
		delete(s.limits, projectID)
	} else {
		s.limits[projectID] = *limitMB
	}
	return s.saveLocked()
}

func (s *limitStore) saveLocked() error {
	if s.path == "" {
		return nil
	}
	raw := make(map[string]int64, len(s.limits))
	for k, v := range s.limits {
		raw[strconv.FormatUint(uint64(k), 10)] = v
	}
	b, err := json.MarshalIndent(raw, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(s.path), 0o750); err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}

// ── Detection ────────────────────────────────────────────────────────────────

// detectQuota picks XFS project quotas when the root lives on XFS mounted with
// prjquota and xfs_quota is installed, the measured fallback otherwise.
// acceptMeasured (OBLIMINT_ALLOW_MEASURED_QUOTA) lets the fallback record disk
// limits it cannot enforce; without it the fallback refuses them.
func detectQuota(l Layout, info func(string) (FSInfo, error), lookPath func(string) (string, error), run runner, acceptMeasured bool) (Quota, string) {
	statePath := filepath.Join(filepath.FromSlash(l.RunDir()), "hostd-quota.json")
	measured := func(why string) (Quota, string) {
		policy := "disk limits refused (set " + allowMeasuredQuotaEnv + "=1 to accept unenforced limits)"
		if acceptMeasured {
			policy = "disk limits accepted but NOT enforced (" + allowMeasuredQuotaEnv + ")"
		}
		return newMeasuredQuota(statePath, acceptMeasured, why), why + "; " + policy
	}
	fi, err := info(l.Root)
	switch {
	case err != nil:
		return measured("filesystem unknown: " + err.Error())
	case fi.FSType != "xfs" || !fi.ProjectQuota:
		return measured(fmt.Sprintf("%s on %s (%s) has no XFS project quota", l.Root, fi.MountPoint, fi.FSType))
	}
	if _, err := lookPath("xfs_quota"); err != nil {
		return measured("xfs_quota not installed")
	}
	return newXFSQuota(fi.MountPoint, run), "xfs prjquota on " + fi.MountPoint
}
