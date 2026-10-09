package main

import (
	"fmt"
	"path"
	"slices"
	"strconv"
	"strings"
)

// ─────────────────────────────────────────────────────────────────────────────
// Window overlay (docs/P3-PLAN.md §4.1): pure helpers (option strings,
// mountinfo analysis, state file). The mount syscalls live in mounter_linux.go.
//
// The overlay is mounted OVER sites/<s>/releases/<n> (the path the containers
// see does not change), with lowerdir = windows/<w>/lower, a read-only bind of
// the pristine release. That bind is made from a PRIVATE clone of releases/
// (run/hostd-mnt): a bind taken directly from the shared hosting mount would
// join its peer group and receive the overlay itself on top of its root (the
// "lower" view would then show the merged content and the diff would be empty).
// ─────────────────────────────────────────────────────────────────────────────

// overlaySourcePrefix names our overlays in mountinfo (source field): the
// window id is read back from it (listWindows, recovery).
const overlaySourcePrefix = "oblimint-window-"

func overlaySource(windowID int64) string { return overlaySourcePrefix + id(windowID) }

// overlayPathOK: lowerdir / upperdir values are separated by ':' and ','; the
// paths hostd builds never contain them (ids, fixed names), but the root is an
// admin setting: refuse instead of escaping.
func overlayPathOK(p string) error {
	if p == "" || strings.ContainsAny(p, ",:\\\x00\n") {
		return fmt.Errorf("path %q cannot be used in overlay options", p)
	}
	return nil
}

// overlayOptions returns the option strings to try, best first. rw: the upper
// layer is writable (metacopy: a chown only copies metadata up). ro (freeze):
// no upper, the upper layer becomes the top lower layer (same content, no
// write possible). The fallbacks keep a window usable on a kernel without
// metacopy (chown then copies data up: slower, same diff) or refusing
// redirect_dir=on without an upper layer.
func overlayOptions(lower, upper, work string, ro bool) ([]string, error) {
	for _, p := range []string{lower, upper, work} {
		if err := overlayPathOK(p); err != nil {
			return nil, err
		}
	}
	var layers string
	if ro {
		layers = "lowerdir=" + upper + ":" + lower
	} else {
		layers = "lowerdir=" + lower + ",upperdir=" + upper + ",workdir=" + work
	}
	if ro {
		return []string{
			layers + ",metacopy=on,redirect_dir=on,index=off,xino=off",
			layers + ",metacopy=on,redirect_dir=follow,index=off,xino=off",
			layers + ",redirect_dir=follow,index=off,xino=off",
		}, nil
	}
	return []string{
		layers + ",metacopy=on,redirect_dir=on,index=off,xino=off",
		layers + ",redirect_dir=on,index=off,xino=off",
	}, nil
}

// mountMode reads rw / ro from the per-mount options.
func mountMode(m Mount) string {
	if slices.Contains(m.Options, "ro") {
		return windowModeRO
	}
	return windowModeRW
}

// topMountAt returns the mount on top of mountPoint (the last one listed).
func topMountAt(mounts []Mount, mountPoint string) (Mount, bool) {
	var top Mount
	found := false
	for _, m := range mounts {
		if m.MountPoint == mountPoint {
			top, found = m, true
		}
	}
	return top, found
}

// isMountPoint reports whether something is mounted at p.
func isMountPoint(mounts []Mount, p string) bool {
	_, ok := topMountAt(mounts, p)
	return ok
}

// windowIDOfMount reads the window id of one of our overlays: from the source
// field (oblimint-window-<id>), else from the layer options (.../windows/<id>/upper|lower).
func windowIDOfMount(m Mount) (int64, bool) {
	if s, ok := strings.CutPrefix(m.Source, overlaySourcePrefix); ok {
		if n, err := strconv.ParseInt(s, 10, 64); err == nil && n > 0 {
			return n, true
		}
	}
	for _, o := range m.SuperOptions {
		k, v, ok := strings.Cut(o, "=")
		if !ok || (k != "upperdir" && k != "lowerdir") {
			continue
		}
		for _, layer := range strings.Split(v, ":") {
			dir, last := path.Split(path.Clean(layer))
			if last != "upper" && last != "lower" {
				continue
			}
			parent, wid := path.Split(path.Clean(dir))
			if path.Base(path.Clean(parent)) != "windows" {
				continue
			}
			if n, err := strconv.ParseInt(wid, 10, 64); err == nil && n > 0 {
				return n, true
			}
		}
	}
	return 0, false
}

// mountedOverlay is a window overlay found in mountinfo.
type mountedOverlay struct {
	MountedWindow
	MountPoint string
}

// windowOverlays lists the overlays mounted over <root>/accounts/<a>/sites/<s>/releases/<n>
// (top mount of each release dir only). root is the resolved hosting root.
func windowOverlays(mounts []Mount, root string) []mountedOverlay {
	prefix := strings.TrimRight(root, "/") + "/accounts/"
	tops := map[string]Mount{}
	var order []string
	for _, m := range mounts {
		if !strings.HasPrefix(m.MountPoint, prefix) {
			continue
		}
		if _, seen := tops[m.MountPoint]; !seen {
			order = append(order, m.MountPoint)
		}
		tops[m.MountPoint] = m
	}
	var out []mountedOverlay
	for _, mp := range order {
		m := tops[mp]
		if m.FSType != "overlay" {
			continue
		}
		// accounts/<a>/sites/<s>/releases/<n>
		segs := strings.Split(strings.TrimPrefix(mp, prefix), "/")
		if len(segs) != 5 || segs[1] != "sites" || segs[3] != "releases" {
			continue
		}
		a, err1 := parseID(segs[0])
		s, err2 := parseID(segs[2])
		n, err3 := parseID(segs[4])
		if err1 != nil || err2 != nil || err3 != nil {
			continue
		}
		w, ok := windowIDOfMount(m)
		if !ok {
			continue
		}
		out = append(out, mountedOverlay{
			MountedWindow: MountedWindow{AccountID: a, SiteID: s, WindowID: w, Mode: mountMode(m), ReleaseNumber: n},
			MountPoint:    mp,
		})
	}
	return out
}

// mountsBelow returns the mount points strictly below dir, relative to it
// ("a/b" → fstype). Used by the measuring / tagging walks so they never
// descend into a window overlay or a lower bind.
func mountsBelowIn(mounts []Mount, dir string) map[string]string {
	dir = strings.TrimRight(dir, "/")
	out := map[string]string{}
	for _, m := range mounts {
		if rel, ok := strings.CutPrefix(m.MountPoint, dir+"/"); ok && rel != "" {
			out[rel] = m.FSType
		}
	}
	return out
}

// propagationResult checks the mountinfo of a container process: the overlay
// is visible at <containerReleases>/<n> (the releases bind is rslave).
func propagationResult(pid int, mounts []Mount, releaseNumber int64) PropagationResult {
	target := path.Join(containerReleasesDir, id(releaseNumber))
	m, ok := topMountAt(mounts, target)
	if !ok || m.FSType != "overlay" {
		return PropagationResult{PID: pid}
	}
	mode := mountMode(m)
	return PropagationResult{PID: pid, Visible: true, Mode: &mode}
}

// containerReleasesDir is CONTAINER_PATHS.releases of paths.ts.
const containerReleasesDir = "/srv/releases"

// windowState is windows/<w>/state.json: what hostd mounted for the window.
type windowState struct {
	AccountID             int64  `json:"accountId"`
	SiteID                int64  `json:"siteId"`
	WindowID              int64  `json:"windowId"`
	Slug                  string `json:"slug"`
	UID                   int    `json:"uid"`
	GID                   int    `json:"gid"`
	ReleaseNumber         int64  `json:"releaseNumber"`
	Mode                  string `json:"mode"`
	QuarantineExecutables bool   `json:"quarantineExecutables"`
	// Chowned: the metadata chown walk of the merged view completed.
	Chowned bool `json:"chowned"`
	// Metacopy: the overlay has been mounted with metacopy=on at least once,
	// so upper/ may hold metadata-only entries that an overlay mounted
	// without metacopy refuses to follow (EIO): the no-metacopy fallbacks
	// are never offered again for this window.
	Metacopy bool `json:"metacopy,omitempty"`
	// DetachedDev: a freeze could only DETACH the rw overlay (still busy) and
	// some process kept a handle on it: it can still write into upper/ (now a
	// lower layer of the ro overlay). Set until no process holds that device
	// any more; export refuses meanwhile (windowWriters).
	DetachedDev string `json:"detachedDev,omitempty"`
	// DetachedUnknown: same, but the device of the detached overlay was not
	// known (never cleared: the window must be removed).
	DetachedUnknown bool `json:"detachedUnknown,omitempty"`
}

// writersDetached: a detached rw overlay may still have writers.
func (st windowState) writersDetached() bool { return st.DetachedDev != "" || st.DetachedUnknown }

// hasMetacopy reports whether a mounted overlay uses metacopy=on.
func hasMetacopy(m Mount) bool {
	return slices.Contains(m.SuperOptions, "metacopy=on") || slices.Contains(m.Options, "metacopy=on")
}
