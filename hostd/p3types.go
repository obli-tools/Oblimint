package main

import (
	"regexp"
	"strings"
)

// ─────────────────────────────────────────────────────────────────────────────
// P3 JSON contract (docs/P3-PLAN.md §8). Field names are EXACTLY those of the
// TypeScript types of server/src/services/hostd/client.ts (HostdWindowStatus,
// HostdDiffEntry, HostdWindowManifest, HostdWindowExportResult,
// HostdPropagationResult, HostdMountedWindow, HostdStagingApplyResult,
// HostdQuarantineEntry, HostdEvent): keep both sides in sync.
// ─────────────────────────────────────────────────────────────────────────────

const (
	windowModeRW = "rw"
	windowModeRO = "ro"
)

// WindowRef names one window of a site (slug: for the quarantine entries).
type WindowRef struct {
	AccountID, SiteID, WindowID int64
	Slug                        string
}

func (r WindowRef) validate() error {
	if err := validateID("account id", r.AccountID); err != nil {
		return err
	}
	if err := validateID("site id", r.SiteID); err != nil {
		return err
	}
	if err := validateID("window id", r.WindowID); err != nil {
		return err
	}
	return validateSlug(r.Slug)
}

// WindowSpec is the validated body of PUT .../windows/{wid}.
type WindowSpec struct {
	WindowRef
	Owner                 Owner
	ReleaseNumber         int64
	Mode                  string // rw | ro
	QuarantineExecutables bool
}

func (s WindowSpec) validate() error {
	if err := s.WindowRef.validate(); err != nil {
		return err
	}
	if err := validateOwner(s.Owner); err != nil {
		return err
	}
	if err := validateID("release number", s.ReleaseNumber); err != nil {
		return err
	}
	if s.Mode != windowModeRW && s.Mode != windowModeRO {
		return badRequest("mode must be rw or ro")
	}
	return nil
}

// WindowStatus mirrors HostdWindowStatus.
type WindowStatus struct {
	AccountID             int64   `json:"accountId"`
	SiteID                int64   `json:"siteId"`
	WindowID              int64   `json:"windowId"`
	Mounted               bool    `json:"mounted"`
	Mode                  *string `json:"mode"`
	ReleaseNumber         *int64  `json:"releaseNumber"`
	QuarantineExecutables bool    `json:"quarantineExecutables"`
	UpperBytes            int64   `json:"upperBytes"`
	UpperEntries          int64   `json:"upperEntries"`
	ExportReady           bool    `json:"exportReady"`
	// WritersDetached: the freeze could only lazily detach the rw overlay and
	// processes still hold it (they can write into upper/): export refused.
	WritersDetached bool `json:"writersDetached,omitempty"`
}

// Diff entry kinds / types / skip reasons (HostdChangeKind, HostdDiffEntry).
const (
	changeAdded      = "added"
	changeModified   = "modified"
	changeDeleted    = "deleted"
	changeTypechange = "typechange"

	entryFile    = "file"
	entrySymlink = "symlink"
	entryDir     = "dir"

	skipTooLarge = "tooLarge"
	skipSpecial  = "special"
)

// DiffEntry mirrors HostdDiffEntry.
type DiffEntry struct {
	Path       string  `json:"path"`
	Change     string  `json:"change"`
	Type       string  `json:"type"`
	Size       *int64  `json:"size"`
	Mode       *int    `json:"mode"`
	SHA256     *string `json:"sha256"`
	LinkTarget *string `json:"linkTarget"`
	Exported   bool    `json:"exported"`
	Skipped    *string `json:"skipped"`
}

// WindowManifest mirrors HostdWindowManifest (export/manifest.json).
type WindowManifest struct {
	Version       int         `json:"version"`
	WindowID      int64       `json:"windowId"`
	ReleaseNumber int64       `json:"releaseNumber"`
	CreatedAt     string      `json:"createdAt"`
	Entries       []DiffEntry `json:"entries"`
	Truncated     bool        `json:"truncated"`
}

// ExportOptions mirrors HostdExportOptions.
type ExportOptions struct {
	MaxFileBytes  int64 `json:"maxFileBytes"`
	MaxTotalBytes int64 `json:"maxTotalBytes"`
	MaxEntries    int   `json:"maxEntries"`
}

func (o ExportOptions) validate() error {
	if o.MaxFileBytes <= 0 || o.MaxTotalBytes <= 0 || o.MaxEntries <= 0 || o.MaxEntries > 10_000_000 {
		return badRequest("maxFileBytes, maxTotalBytes and maxEntries must be positive")
	}
	return nil
}

// ExportResult mirrors HostdWindowExportResult.
type ExportResult struct {
	Entries   int   `json:"entries"`
	Added     int   `json:"added"`
	Modified  int   `json:"modified"`
	Deleted   int   `json:"deleted"`
	Bytes     int64 `json:"bytes"`
	Truncated bool  `json:"truncated"`
}

// PropagationResult mirrors HostdPropagationResult.
type PropagationResult struct {
	PID     int     `json:"pid"`
	Visible bool    `json:"visible"`
	Mode    *string `json:"mode"`
	Error   *string `json:"error"`
}

// MountedWindow mirrors HostdMountedWindow.
type MountedWindow struct {
	AccountID     int64  `json:"accountId"`
	SiteID        int64  `json:"siteId"`
	WindowID      int64  `json:"windowId"`
	Mode          string `json:"mode"`
	ReleaseNumber int64  `json:"releaseNumber"`
}

// StagingSource is {kind:'window'|'workspace', id}.
type StagingSource struct {
	Kind string `json:"kind"`
	ID   int64  `json:"id"`
}

func (s StagingSource) validate() error {
	if s.Kind != "window" && s.Kind != "workspace" {
		return badRequest("source.kind must be window or workspace")
	}
	return validateID("source id", s.ID)
}

// StagingChange mirrors HostdStagingChange.
type StagingChange struct {
	Path string `json:"path"`
	Op   string `json:"op"`
}

// Staging conflict reasons.
const (
	conflictSymlink       = "symlink"
	conflictNotDirectory  = "notDirectory"
	conflictMissingSource = "missingSource"
	conflictInvalid       = "invalid"
)

type StagingConflict struct {
	Path   string `json:"path"`
	Reason string `json:"reason"`
}

// StagingApplyResult mirrors HostdStagingApplyResult.
type StagingApplyResult struct {
	Written   int               `json:"written"`
	Deleted   int               `json:"deleted"`
	Conflicts []StagingConflict `json:"conflicts"`
}

// WorkspaceSpec is the validated body of PUT .../workspaces/{wsid}.
type WorkspaceSpec struct {
	SiteSpec
	WorkspaceID   int64
	ReleaseNumber int64
}

type WorkspaceResult struct {
	Files int64 `json:"files"`
	Bytes int64 `json:"bytes"`
}

// TypedPath is one typed data path of a watch spec.
type TypedPath struct {
	Path              string   `json:"path"`
	AllowedExtensions []string `json:"allowedExtensions"`
}

// WatchSpec is the validated body of PUT .../watch.
type WatchSpec struct {
	SiteSpec
	Typed []TypedPath
}

type WatchResult struct {
	Watching    int `json:"watching"`
	Quarantined int `json:"quarantined"`
}

// Quarantine reasons (HostdQuarantineReason), sources and areas.
const (
	reasonExtension       = "extension"
	reasonPHPContent      = "php-content"
	reasonPolyglot        = "polyglot"
	reasonMagicMismatch   = "magic-mismatch"
	reasonExecutableWrite = "executable-write"
	reasonSpecial         = "special"

	sourceTyped      = "typed"
	sourceSupervised = "supervised"
	areaData         = "data"
	areaCode         = "code"
)

// QuarantineEntry mirrors HostdQuarantineEntry.
type QuarantineEntry struct {
	ID            string  `json:"id"`
	AccountID     int64   `json:"accountId"`
	SiteID        *int64  `json:"siteId"`
	Slug          *string `json:"slug"`
	Source        string  `json:"source"`
	Area          string  `json:"area"`
	Path          string  `json:"path"`
	DataPath      *string `json:"dataPath"`
	Reason        string  `json:"reason"`
	Detail        *string `json:"detail"`
	Size          int64   `json:"size"`
	SHA256        string  `json:"sha256"`
	DetectedType  *string `json:"detectedType"`
	QuarantinedAt string  `json:"quarantinedAt"`
	RestoredAt    *string `json:"restoredAt"`
}

type RestoreResult struct {
	Restored bool   `json:"restored"`
	Path     string `json:"path"`
}

type Preview struct {
	Base64    string `json:"base64"`
	Truncated bool   `json:"truncated"`
	Size      int64  `json:"size"`
}

// Event kinds (HostdEventKind).
const (
	eventQuarantined = "quarantined"
	eventWatchError  = "watchError"
	eventWindowLost  = "windowLost"
)

// Event mirrors HostdEvent.
type Event struct {
	Seq       int64   `json:"seq"`
	At        string  `json:"at"`
	Kind      string  `json:"kind"`
	AccountID int64   `json:"accountId"`
	SiteID    *int64  `json:"siteId"`
	WindowID  *int64  `json:"windowId"`
	EntryID   *string `json:"entryId"`
	Message   *string `json:"message"`
}

// ── Validation ───────────────────────────────────────────────────────────────

// quarantineIDRe: same rule as entry() in client.ts (an id is never a path, R2).
var quarantineIDRe = regexp.MustCompile(`^[0-9a-z-]{8,64}$`)

func validateQuarantineID(s string) error {
	if !quarantineIDRe.MatchString(s) {
		return badRequest("invalid quarantine entry %q", s)
	}
	return nil
}

const (
	maxRelPathLen = 4096
	maxNameLen    = 255
)

// splitRelPath validates a relative POSIX path of a release / staging tree
// (R2): not empty, not absolute, no '.', '..' or empty component, no NUL, no
// backslash, at most 4096 bytes and 255 bytes per component. Unlike data paths
// any other character is allowed (file names of real applications).
func splitRelPath(p string) ([]string, bool) {
	if p == "" || len(p) > maxRelPathLen || strings.HasPrefix(p, "/") || strings.ContainsAny(p, "\x00\\") {
		return nil, false
	}
	segs := strings.Split(p, "/")
	for _, s := range segs {
		if s == "" || s == "." || s == ".." || len(s) > maxNameLen {
			return nil, false
		}
	}
	return segs, true
}

func strPtr(s string) *string { return &s }
func i64Ptr(n int64) *int64   { return &n }
func intPtr(n int) *int       { return &n }

// optStr returns nil for "" (JSON null).
func optStr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}
