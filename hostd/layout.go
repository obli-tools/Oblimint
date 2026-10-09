package main

import (
	"fmt"
	"path"
	"regexp"
	"strconv"
	"strings"
)

// ─────────────────────────────────────────────────────────────────────────────
// Hosting filesystem layout (docs/P1-PLAN.md §4). SHARED CONTRACT with
// server/src/services/hosting/paths.ts: keep both files in sync.
//
//   <root>/accounts/<accountId>/                 root:root 0711  (XFS project 100000+accountId)
//     staging/                                   uid:gid   0750
//       <siteSlug>/                              uid:gid   0750
//     data/                                      uid:gid   0750
//       <siteSlug>/<data path>/                  uid:gid   0750
//     filesrv/                                   uid:gid   0700
//     sites/                                     root:root 0711
//       <siteId>/                                root:root 0755
//         repo.git/                              (created by the panel)
//         releases/                              root:root 0755
//         runtime/                               root:root 0755
//
// hostd never takes an absolute path from the panel (except GET /v1/fs and
// GET /v1/du, checked by RelFromAbs): every path is computed here from ids,
// slugs and validated relative data paths.
// ─────────────────────────────────────────────────────────────────────────────

const (
	defaultRoot = "/srv/oblimint"
	// projectIDBase + accountId = XFS project id of an account.
	projectIDBase = 100000
	// minOwnerID: uid/gid below this are system ids, never a hosting account.
	minOwnerID     = 10000
	maxOwnerID     = 1<<31 - 2
	maxDataPathLen = 255
)

var (
	slugRe       = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,39}$`)
	pathSegRe    = regexp.MustCompile(`^[A-Za-z0-9._@+-]+$`)
	positiveIDRe = regexp.MustCompile(`^[1-9][0-9]{0,15}$`)
)

// Owner is a uid:gid pair; rootOwner is root:root.
type Owner struct{ UID, GID int }

var rootOwner = Owner{0, 0}

// dirSpec is one directory hostd creates and keeps in shape.
type dirSpec struct {
	Rel   []string // components relative to the layout root
	Owner Owner
	Mode  uint32
}

// Layout computes every hosting path from the root (OBLIMINT_ROOT).
type Layout struct{ Root string }

func newLayout(root string) Layout {
	if root == "" {
		root = defaultRoot
	}
	r := strings.ReplaceAll(root, `\`, "/")
	if r != "/" {
		r = strings.TrimRight(r, "/")
	}
	return Layout{Root: r}
}

func id(n int64) string { return strconv.FormatInt(n, 10) }

// abs joins components under the root (POSIX, like path.posix.join in paths.ts).
func (l Layout) abs(rel []string) string { return path.Join(append([]string{l.Root}, rel...)...) }

func (l Layout) AccountRel(accountID int64) []string { return []string{"accounts", id(accountID)} }
func (l Layout) StagingRel(accountID int64) []string {
	return append(l.AccountRel(accountID), "staging")
}
func (l Layout) SiteStagingRel(accountID int64, slug string) []string {
	return append(l.StagingRel(accountID), slug)
}
func (l Layout) DataRel(accountID int64) []string { return append(l.AccountRel(accountID), "data") }
func (l Layout) SiteDataRel(accountID int64, slug string) []string {
	return append(l.DataRel(accountID), slug)
}
func (l Layout) FileServerStateRel(accountID int64) []string {
	return append(l.AccountRel(accountID), "filesrv")
}
func (l Layout) SitesRel(accountID int64) []string { return append(l.AccountRel(accountID), "sites") }
func (l Layout) SiteRel(accountID, siteID int64) []string {
	return append(l.SitesRel(accountID), id(siteID))
}
func (l Layout) ReleasesRel(accountID, siteID int64) []string {
	return append(l.SiteRel(accountID, siteID), "releases")
}
func (l Layout) RuntimeRel(accountID, siteID int64) []string {
	return append(l.SiteRel(accountID, siteID), "runtime")
}

func (l Layout) AccountsRoot() string           { return l.abs([]string{"accounts"}) }
func (l Layout) Account(accountID int64) string { return l.abs(l.AccountRel(accountID)) }
func (l Layout) Staging(accountID int64) string { return l.abs(l.StagingRel(accountID)) }
func (l Layout) SiteStaging(accountID int64, slug string) string {
	return l.abs(l.SiteStagingRel(accountID, slug))
}
func (l Layout) Data(accountID int64) string { return l.abs(l.DataRel(accountID)) }
func (l Layout) SiteData(accountID int64, slug string) string {
	return l.abs(l.SiteDataRel(accountID, slug))
}
func (l Layout) FileServerState(accountID int64) string {
	return l.abs(l.FileServerStateRel(accountID))
}
func (l Layout) Site(accountID, siteID int64) string { return l.abs(l.SiteRel(accountID, siteID)) }
func (l Layout) Releases(accountID, siteID int64) string {
	return l.abs(l.ReleasesRel(accountID, siteID))
}
func (l Layout) Runtime(accountID, siteID int64) string {
	return l.abs(l.RuntimeRel(accountID, siteID))
}
func (l Layout) RunDir() string { return l.abs([]string{"run"}) }

// accountDirs is the account tree in creation order (parents first).
func (l Layout) accountDirs(accountID int64, o Owner) []dirSpec {
	return []dirSpec{
		{l.AccountRel(accountID), rootOwner, 0o711},
		{l.StagingRel(accountID), o, 0o750},
		{l.DataRel(accountID), o, 0o750},
		{l.FileServerStateRel(accountID), o, 0o700},
		{l.SitesRel(accountID), rootOwner, 0o711},
	}
}

// siteDirs is the per-site tree (below an existing account tree).
func (l Layout) siteDirs(accountID, siteID int64, slug string, o Owner) []dirSpec {
	return []dirSpec{
		{l.SiteStagingRel(accountID, slug), o, 0o750},
		{l.SiteDataRel(accountID, slug), o, 0o750},
		{l.SiteRel(accountID, siteID), rootOwner, 0o755},
		{l.ReleasesRel(accountID, siteID), rootOwner, 0o755},
		{l.RuntimeRel(accountID, siteID), rootOwner, 0o755},
	}
}

// projectID is the XFS project id of an account.
func projectID(accountID int64) uint32 { return uint32(projectIDBase + accountID) }

// ── Validation ───────────────────────────────────────────────────────────────

// parseID parses a positive decimal id (no sign, no leading zero).
func parseID(s string) (int64, error) {
	if !positiveIDRe.MatchString(s) {
		return 0, badRequest("invalid id %q", s)
	}
	n, err := strconv.ParseInt(s, 10, 64)
	if err != nil || n > 1<<31 {
		return 0, badRequest("invalid id %q", s)
	}
	return n, nil
}

func validateID(what string, n int64) error {
	if n <= 0 || n > 1<<31 {
		return badRequest("invalid %s %d", what, n)
	}
	return nil
}

func validateOwner(o Owner) error {
	if o.UID < minOwnerID || o.UID > maxOwnerID || o.GID < minOwnerID || o.GID > maxOwnerID {
		return badRequest("uid/gid must be between %d and %d", minOwnerID, maxOwnerID)
	}
	return nil
}

func validateSlug(slug string) error {
	if !slugRe.MatchString(slug) {
		return badRequest("invalid site slug %q", slug)
	}
	return nil
}

// splitDataPath validates a data path exactly like the shared normalizeRelPath
// does, but strictly: the panel sends normalized paths, so hostd refuses
// anything that is not already normal (no trimming, no backslash rewriting).
func splitDataPath(p string) ([]string, error) {
	if p == "" || len(p) > maxDataPathLen {
		return nil, badRequest("invalid data path %q", p)
	}
	segs := strings.Split(p, "/")
	for _, s := range segs {
		if s == "" || s == "." || s == ".." || !pathSegRe.MatchString(s) {
			return nil, badRequest("invalid data path %q", p)
		}
	}
	return segs, nil
}

// RelFromAbs maps an absolute path received from the panel (GET /v1/du) to
// components relative to the root. The path must be absolute, already clean
// and inside the root; the root itself maps to an empty slice.
func (l Layout) RelFromAbs(p string) ([]string, error) {
	if p == "" || !path.IsAbs(p) || path.Clean(p) != p || strings.ContainsRune(p, 0) {
		return nil, badRequest("path must be absolute and clean")
	}
	if p == l.Root {
		return []string{}, nil
	}
	prefix := l.Root + "/"
	if l.Root == "/" {
		prefix = "/"
	}
	if !strings.HasPrefix(p, prefix) {
		return nil, badRequest("path %s is outside %s", p, l.Root)
	}
	return strings.Split(strings.TrimPrefix(p, prefix), "/"), nil
}

func (d dirSpec) String() string {
	return fmt.Sprintf("%s %d:%d %04o", path.Join(d.Rel...), d.Owner.UID, d.Owner.GID, d.Mode)
}
