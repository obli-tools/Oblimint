package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// AccountSpec / SiteSpec are validated inputs of the account and site ops.
type AccountSpec struct {
	AccountID int64
	Owner     Owner
	QuotaMB   *int64 // nil = no limit
}

type SiteSpec struct {
	AccountID, SiteID int64
	Slug              string
	Owner             Owner
}

func (s SiteSpec) validate() error {
	if err := validateID("account id", s.AccountID); err != nil {
		return err
	}
	if err := validateID("site id", s.SiteID); err != nil {
		return err
	}
	if err := validateSlug(s.Slug); err != nil {
		return err
	}
	return validateOwner(s.Owner)
}

// Usage is the answer of GET /v1/accounts/{id}/usage.
type Usage struct {
	AccountID  int64     `json:"accountId"`
	UsedBytes  int64     `json:"usedBytes"`
	QuotaBytes *int64    `json:"quotaBytes"`
	Mode       QuotaMode `json:"mode"`
	MeasuredAt string    `json:"measuredAt"`
}

// SeedResult is the answer of POST .../data-paths/seed.
type SeedResult struct {
	Copied bool `json:"copied"`
	Files  int  `json:"files"`
}

// Ops is every host operation behind the HTTP API. Inputs reach it validated
// by the handlers; hostOps validates again (defence in depth). ctx is the
// request context: cancelled when the panel gives up (its timeout closes the
// connection), so long walks / copies / waits on the account lock stop.
type Ops interface {
	// FSInfo describes the filesystem holding rel (components under the root).
	FSInfo(rel []string) (FSInfo, error)
	EnsureAccount(ctx context.Context, a AccountSpec) (QuotaMode, error)
	SetQuota(ctx context.Context, accountID int64, quotaMB *int64) (QuotaMode, error)
	Usage(ctx context.Context, accountID int64) (Usage, error)
	RemoveAccount(ctx context.Context, accountID int64, purge bool) error
	EnsureSite(ctx context.Context, s SiteSpec) error
	RemoveSite(ctx context.Context, accountID, siteID int64, slug string, purge bool) error
	EnsureDataPaths(ctx context.Context, s SiteSpec, paths []string) error
	SeedDataPath(ctx context.Context, s SiteSpec, dataPath string) (SeedResult, error)
	ClearDataPaths(ctx context.Context, s SiteSpec, paths []string) error
	// Du returns the bytes used below rel (components under the root).
	Du(ctx context.Context, rel []string) (int64, error)
	// P2 — database instances (dbops.go).
	EnsureDbInstance(ctx context.Context, s DbInstanceSpec) error
	RemoveDbInstance(ctx context.Context, accountID, instanceID int64, purge bool) error
	SetDefaultDbSocket(ctx context.Context, accountID int64, f DbFamily, instanceID *int64) error
}

// quickLockWait bounds how long a short operation (ensure*, quota, non purge
// remove) waits for an account held by a long one (seed, clear, purge): it
// answers 409 busy before the panel's default 30 s timeout, so the caller gets
// an explicit, retryable error instead of a hostdTimeout.
const quickLockWait = 20 * time.Second

// hostOps is the real implementation. Everything here is OS independent; the
// Linux specifics are the ownerFunc (fchown/fchmod), fileUsage and the quota.
type hostOps struct {
	layout Layout
	quota  Quota
	own    ownerFunc
	// resolveRoot resolves the configured root (an admin choice, it may be a
	// symlink); mountInfo looks a resolved path up in mountinfo WITHOUT
	// resolving it again (tenant links below the root are never followed).
	resolveRoot func(string) (string, error)
	mountInfo   func(string) (FSInfo, error)
	now         func() time.Time

	locks sync.Map // accountID → chan struct{} (cap 1): one operation per account at a time
}

func newHostOps(l Layout, q Quota, own ownerFunc) *hostOps {
	return &hostOps{layout: l, quota: q, own: own, resolveRoot: filepath.EvalSymlinks, mountInfo: mountInfoOf, now: time.Now}
}

// lock takes the account lock, waiting at most maxWait (0 = as long as ctx
// lives). A caller that left, or a wait that ran out, gets 409 busy.
func (h *hostOps) lock(ctx context.Context, accountID int64, maxWait time.Duration) (func(), error) {
	m, _ := h.locks.LoadOrStore(accountID, make(chan struct{}, 1))
	ch := m.(chan struct{})
	unlock := func() { <-ch }
	select {
	case ch <- struct{}{}:
		return unlock, nil
	default:
	}
	if maxWait > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, maxWait)
		defer cancel()
	}
	select {
	case ch <- struct{}{}:
		return unlock, nil
	case <-ctx.Done():
		return nil, busy("account %d is busy with another operation, retry later", accountID)
	}
}

func (h *hostOps) openRoot() (*os.Root, error) { return os.OpenRoot(h.layout.Root) }

// open enters rel below the root without following links (404 when missing).
func (h *hostOps) open(rel []string) (*os.Root, error) {
	root, err := h.openRoot()
	if err != nil {
		return nil, err
	}
	defer root.Close()
	dir, err := openPath(root, rel)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, notFound("%s does not exist", path.Join(rel...))
	}
	return dir, err
}

// FSInfo checks that rel exists below the root without following a link,
// then looks up <resolved root>/<rel> in mountinfo (no further resolution).
func (h *hostOps) FSInfo(rel []string) (FSInfo, error) {
	if len(rel) > 0 {
		root, err := h.openRoot()
		if err != nil {
			return FSInfo{}, err
		}
		parent, err := openPath(root, rel[:len(rel)-1])
		root.Close()
		if errors.Is(err, fs.ErrNotExist) {
			return FSInfo{}, notFound("%s does not exist", path.Join(rel...))
		}
		if err != nil {
			return FSInfo{}, err
		}
		fi, err := parent.Lstat(rel[len(rel)-1])
		parent.Close()
		if errors.Is(err, fs.ErrNotExist) {
			return FSInfo{}, notFound("%s does not exist", path.Join(rel...))
		}
		if err != nil {
			return FSInfo{}, err
		}
		if fi.Mode()&fs.ModeSymlink != 0 {
			return FSInfo{}, unsafePath("%s is a symbolic link", path.Join(rel...))
		}
	}
	resolved, err := h.resolveRoot(filepath.FromSlash(h.layout.Root))
	if err != nil {
		return FSInfo{}, err
	}
	return h.mountInfo(path.Join(append([]string{filepath.ToSlash(resolved)}, rel...)...))
}

func (h *hostOps) EnsureAccount(ctx context.Context, a AccountSpec) (QuotaMode, error) {
	if err := validateID("account id", a.AccountID); err != nil {
		return "", err
	}
	if err := validateOwner(a.Owner); err != nil {
		return "", err
	}
	unlock, err := h.lock(ctx, a.AccountID, quickLockWait)
	if err != nil {
		return "", err
	}
	defer unlock()
	root, err := h.openRoot()
	if err != nil {
		return "", err
	}
	defer root.Close()
	specs := append([]dirSpec{{[]string{"accounts"}, rootOwner, 0o711}}, h.layout.accountDirs(a.AccountID, a.Owner)...)
	if err := ensureTree(root, specs, h.own); err != nil {
		return "", err
	}
	if err := h.quota.Ensure(ctx, projectID(a.AccountID), h.layout.Account(a.AccountID), a.QuotaMB); err != nil {
		return "", fmt.Errorf("quota: %w", err)
	}
	return h.quota.Mode(), nil
}

func (h *hostOps) SetQuota(ctx context.Context, accountID int64, quotaMB *int64) (QuotaMode, error) {
	if err := validateID("account id", accountID); err != nil {
		return "", err
	}
	unlock, err := h.lock(ctx, accountID, quickLockWait)
	if err != nil {
		return "", err
	}
	defer unlock()
	dir, err := h.open(h.layout.AccountRel(accountID))
	if err != nil {
		return "", err
	}
	dir.Close()
	if err := h.quota.Ensure(ctx, projectID(accountID), h.layout.Account(accountID), quotaMB); err != nil {
		return "", fmt.Errorf("quota: %w", err)
	}
	return h.quota.Mode(), nil
}

func (h *hostOps) Usage(ctx context.Context, accountID int64) (Usage, error) {
	if err := validateID("account id", accountID); err != nil {
		return Usage{}, err
	}
	// No account lock: measuring may be long and only reads.
	dir, err := h.open(h.layout.AccountRel(accountID))
	if err != nil {
		return Usage{}, err
	}
	dir.Close()
	used, limit, err := h.quota.Usage(ctx, projectID(accountID), h.layout.Account(accountID))
	if err != nil {
		return Usage{}, err
	}
	return Usage{
		AccountID:  accountID,
		UsedBytes:  used,
		QuotaBytes: limit,
		Mode:       h.quota.Mode(),
		MeasuredAt: h.now().UTC().Format(time.RFC3339),
	}, nil
}

func (h *hostOps) RemoveAccount(ctx context.Context, accountID int64, purge bool) error {
	if err := validateID("account id", accountID); err != nil {
		return err
	}
	unlock, err := h.lock(ctx, accountID, lockWait(purge))
	if err != nil {
		return err
	}
	defer unlock()
	if err := h.quota.Release(projectID(accountID)); err != nil {
		return fmt.Errorf("quota: %w", err)
	}
	if !purge {
		return nil
	}
	accounts, err := h.open([]string{"accounts"})
	var ae *apiError
	if errors.As(err, &ae) && ae.Code == codeNotFound {
		return nil
	}
	if err != nil {
		return err
	}
	defer accounts.Close()
	return removeEntry(accounts, id(accountID))
}

func (h *hostOps) EnsureSite(ctx context.Context, s SiteSpec) error {
	if err := s.validate(); err != nil {
		return err
	}
	unlock, err := h.lock(ctx, s.AccountID, quickLockWait)
	if err != nil {
		return err
	}
	defer unlock()
	root, err := h.openRoot()
	if err != nil {
		return err
	}
	defer root.Close()
	// The account tree must exist (reconcile: ensureAccount first).
	acct, err := h.open(h.layout.AccountRel(s.AccountID))
	if err != nil {
		return err
	}
	acct.Close()
	return ensureTree(root, h.layout.siteDirs(s.AccountID, s.SiteID, s.Slug, s.Owner), h.own)
}

func (h *hostOps) RemoveSite(ctx context.Context, accountID, siteID int64, slug string, purge bool) error {
	if err := validateID("account id", accountID); err != nil {
		return err
	}
	if err := validateID("site id", siteID); err != nil {
		return err
	}
	if err := validateSlug(slug); err != nil {
		return err
	}
	if !purge {
		return nil // nothing is held per site besides its files
	}
	unlock, err := h.lock(ctx, accountID, 0)
	if err != nil {
		return err
	}
	defer unlock()
	for _, rel := range [][]string{
		h.layout.SiteStagingRel(accountID, slug),
		h.layout.SiteDataRel(accountID, slug),
		h.layout.SiteRel(accountID, siteID),
	} {
		parent, err := h.open(rel[:len(rel)-1])
		var ae *apiError
		if errors.As(err, &ae) && ae.Code == codeNotFound {
			continue
		}
		if err != nil {
			return err
		}
		err = removeEntry(parent, rel[len(rel)-1])
		parent.Close()
		if err != nil {
			return err
		}
	}
	return nil
}

// openSiteData enters data/<slug> of an existing site.
func (h *hostOps) openSiteData(s SiteSpec) (*os.Root, error) {
	return h.open(h.layout.SiteDataRel(s.AccountID, s.Slug))
}

// lockWait: purges may wait for a long operation (the panel gives them the
// long timeout), the rest is quick.
func lockWait(long bool) time.Duration {
	if long {
		return 0
	}
	return quickLockWait
}

func splitDataPaths(paths []string) ([][]string, error) {
	out := make([][]string, 0, len(paths))
	for _, p := range paths {
		segs, err := splitDataPath(p)
		if err != nil {
			return nil, err
		}
		out = append(out, segs)
	}
	return out, nil
}

func (h *hostOps) EnsureDataPaths(ctx context.Context, s SiteSpec, paths []string) error {
	if err := s.validate(); err != nil {
		return err
	}
	all, err := splitDataPaths(paths)
	if err != nil {
		return err
	}
	unlock, err := h.lock(ctx, s.AccountID, quickLockWait)
	if err != nil {
		return err
	}
	defer unlock()
	data, err := h.openSiteData(s)
	if err != nil {
		return err
	}
	defer data.Close()
	for _, segs := range all {
		dir, err := mkdirAll(data, segs, s.Owner, 0o750, h.own)
		if err != nil {
			return err
		}
		dir.Close()
	}
	return nil
}

// seedTmpPrefix names the hostd-owned sibling a seed is copied into before it
// is renamed into place (fixed length: a data path segment may be 255 bytes).
const seedTmpPrefix = ".oblimint-seed-"

// SeedDataPath copies staging/<slug>/<path> into data/<slug>/<path> when the
// latter is empty. Crash-safe: the copy goes into a sibling temp directory
// that is renamed over the (still empty) target only once complete, so an
// interrupted seed (hostd restart, ENOSPC / quota, panel timeout, tenant
// race) leaves the target empty and the next seed starts over. Leftover temp
// directories are removed first (only one seed per account runs at a time).
func (h *hostOps) SeedDataPath(ctx context.Context, s SiteSpec, dataPath string) (SeedResult, error) {
	if err := s.validate(); err != nil {
		return SeedResult{}, err
	}
	segs, err := splitDataPath(dataPath)
	if err != nil {
		return SeedResult{}, err
	}
	unlock, err := h.lock(ctx, s.AccountID, 0)
	if err != nil {
		return SeedResult{}, err
	}
	defer unlock()
	data, err := h.openSiteData(s)
	if err != nil {
		return SeedResult{}, err
	}
	defer data.Close()
	last := segs[len(segs)-1]
	parent, err := mkdirAll(data, segs[:len(segs)-1], s.Owner, 0o750, h.own)
	if err != nil {
		return SeedResult{}, err
	}
	defer parent.Close()
	if err := removeStaleSeeds(parent); err != nil {
		return SeedResult{}, err
	}
	dst, err := ensureDir(parent, last, s.Owner, 0o750, h.own)
	if err != nil {
		return SeedResult{}, err
	}
	empty, err := isEmptyDir(dst)
	dst.Close()
	if err != nil || !empty {
		return SeedResult{}, err
	}
	src, err := h.open(append(h.layout.SiteStagingRel(s.AccountID, s.Slug), segs...))
	var ae *apiError
	if errors.As(err, &ae) && ae.Code == codeNotFound {
		return SeedResult{}, nil // nothing to seed from
	}
	if err != nil {
		return SeedResult{}, err
	}
	defer src.Close()

	tmpName, err := seedTmpName()
	if err != nil {
		return SeedResult{}, err
	}
	// Mkdir never goes through an existing entry (the name is random anyway).
	if err := parent.Mkdir(tmpName, 0o700); err != nil {
		return SeedResult{}, err
	}
	committed := false
	defer func() {
		if !committed {
			if err := removeEntry(parent, tmpName); err != nil {
				slog.Warn("seed: temp directory not removed (next seed retries)", "dir", path.Join(parent.Name(), tmpName), "err", err)
			}
		}
	}()
	tmp, err := openDir(parent, tmpName)
	if err != nil {
		return SeedResult{}, err
	}
	n, err := copyTree(ctx, src, tmp, s.Owner, h.own, 0)
	if err == nil {
		err = applyOwner(tmp, s.Owner, 0o750, h.own)
	}
	tmp.Close()
	if err != nil {
		return SeedResult{}, err
	}

	// Commit: the target must still be empty (PHP may have written to it in
	// the meantime: then it is kept and the copy dropped).
	if err := parent.Remove(last); err != nil && !errors.Is(err, fs.ErrNotExist) {
		if filled, _ := entryFilled(parent, last); filled {
			return SeedResult{}, nil
		}
		return SeedResult{}, err
	}
	if err := parent.Rename(tmpName, last); err != nil {
		if _, lerr := parent.Lstat(last); lerr == nil {
			return SeedResult{}, nil // recreated meanwhile: not ours to replace
		}
		return SeedResult{}, err
	}
	committed = true
	return SeedResult{Copied: true, Files: n}, nil
}

func seedTmpName() (string, error) {
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return seedTmpPrefix + hex.EncodeToString(b[:]), nil
}

// removeStaleSeeds removes the temp directories of interrupted seeds.
func removeStaleSeeds(parent *os.Root) error {
	f, err := parent.Open(".")
	if err != nil {
		return err
	}
	names, err := f.Readdirnames(-1)
	f.Close()
	if err != nil {
		return err
	}
	for _, name := range names {
		if strings.HasPrefix(name, seedTmpPrefix) {
			if err := removeEntry(parent, name); err != nil {
				return err
			}
		}
	}
	return nil
}

// entryFilled reports whether name inside parent exists and is not an empty
// directory.
func entryFilled(parent *os.Root, name string) (bool, error) {
	d, err := openDir(parent, name)
	if errors.Is(err, errUnsafePath) {
		return true, nil // a file or a link now: something is there
	}
	if err != nil {
		return false, err
	}
	defer d.Close()
	empty, err := isEmptyDir(d)
	return !empty, err
}

func (h *hostOps) ClearDataPaths(ctx context.Context, s SiteSpec, paths []string) error {
	if err := s.validate(); err != nil {
		return err
	}
	all, err := splitDataPaths(paths)
	if err != nil {
		return err
	}
	unlock, err := h.lock(ctx, s.AccountID, 0)
	if err != nil {
		return err
	}
	defer unlock()
	data, err := h.openSiteData(s)
	if err != nil {
		return err
	}
	defer data.Close()
	for _, segs := range all {
		dir, err := mkdirAll(data, segs, s.Owner, 0o750, h.own)
		if err != nil {
			return err
		}
		err = clearDir(ctx, dir)
		dir.Close()
		if err != nil {
			return err
		}
	}
	return nil
}

func (h *hostOps) Du(ctx context.Context, rel []string) (int64, error) {
	root, err := h.openRoot()
	if err != nil {
		return 0, err
	}
	defer root.Close()
	if len(rel) == 0 {
		return diskUsage(ctx, root)
	}
	parent, err := openPath(root, rel[:len(rel)-1])
	if errors.Is(err, fs.ErrNotExist) {
		return 0, notFound("%s does not exist", path.Join(rel...))
	}
	if err != nil {
		return 0, err
	}
	defer parent.Close()
	name := rel[len(rel)-1]
	fi, err := parent.Lstat(name)
	if errors.Is(err, fs.ErrNotExist) {
		return 0, notFound("%s does not exist", path.Join(rel...))
	}
	if err != nil {
		return 0, err
	}
	if !fi.IsDir() { // a file, or a symlink counted as itself
		return allocated(parent, name, fi, map[fileKey]bool{}), nil
	}
	dir, err := openDir(parent, name)
	if err != nil {
		return 0, err
	}
	defer dir.Close()
	return diskUsage(ctx, dir)
}
