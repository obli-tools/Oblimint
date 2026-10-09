package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"path"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"
)

// ─────────────────────────────────────────────────────────────────────────────
// windowManager implements the P3 host operations (docs/P3-PLAN.md §4, §8):
// window overlays, export, staging reflection, workspaces, typed-path and
// supervised watchers, quarantine store, events. One operation per site at a
// time (site lock); the mounts themselves are behind the mounter interface.
// ─────────────────────────────────────────────────────────────────────────────

type siteKey struct{ a, s int64 }
type windowKey struct{ a, s, w int64 }

// siteWatch is the typed-path watch of one site.
type siteWatch struct {
	spec    WatchSpec
	watches []*treeWatch
}

type windowManager struct {
	// layout uses the RESOLVED root: mountinfo shows resolved paths and the
	// mount syscalls take them as they are.
	layout     Layout
	mnt        mounter
	attrs      overlayAttrs
	own        ownerFunc
	lchown     lchownFunc
	clone      cloneFunc
	events     *eventRing
	quarantine *quarantineStore
	now        func() time.Time
	// sleep paces the wait for the writers of a detached overlay (tests: no-op).
	sleep  func(time.Duration)
	newHub func() (notifyHub, error)
	// watchStatePath persists the typed watch specs (restored at start).
	watchStatePath string
	typedRescan    time.Duration

	hubMu sync.Mutex
	hub   notifyHub

	mu         sync.Mutex
	typed      map[siteKey]*siteWatch
	supervised map[windowKey]*treeWatch
	lost       map[windowKey]bool

	locks sync.Map // siteKey → chan struct{}
}

func newWindowManager(l Layout, mnt mounter, attrs overlayAttrs, own ownerFunc, lchown lchownFunc, now func() time.Time) *windowManager {
	if resolved, err := filepath.EvalSymlinks(filepath.FromSlash(l.Root)); err == nil {
		l = newLayout(filepath.ToSlash(resolved))
	}
	return &windowManager{
		layout: l, mnt: mnt, attrs: attrs, own: own, lchown: lchown, clone: reflinkClone,
		events:         newEventRing(maxEvents, now),
		quarantine:     newQuarantineStore(l, own, lchown, now),
		now:            now,
		sleep:          time.Sleep,
		newHub:         newNotifyHub,
		watchStatePath: path.Join(l.RunDir(), "hostd-watches.json"),
		typedRescan:    30 * time.Minute,
		typed:          map[siteKey]*siteWatch{},
		supervised:     map[windowKey]*treeWatch{},
		lost:           map[windowKey]bool{},
	}
}

// ── Helpers ──────────────────────────────────────────────────────────────────

// lockSite takes the site lock for as long as ctx lives (window operations
// can be long: chown walk, export, copies).
func (m *windowManager) lockSite(ctx context.Context, a, s int64) (func(), error) {
	v, _ := m.locks.LoadOrStore(siteKey{a, s}, make(chan struct{}, 1))
	ch := v.(chan struct{})
	select {
	case ch <- struct{}{}:
		return func() { <-ch }, nil
	case <-ctx.Done():
		return nil, busy("site %d is busy with another window operation, retry later", s)
	}
}

// tryLockSite takes the site lock only when free.
func (m *windowManager) tryLockSite(a, s int64) (func(), bool) {
	v, _ := m.locks.LoadOrStore(siteKey{a, s}, make(chan struct{}, 1))
	ch := v.(chan struct{})
	select {
	case ch <- struct{}{}:
		return func() { <-ch }, true
	default:
		return nil, false
	}
}

// openRel enters rel below the root without following links (404 when missing).
func (m *windowManager) openRel(rel []string) (*os.Root, error) {
	root, err := os.OpenRoot(m.layout.Root)
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

func isNotFound(err error) bool {
	var ae *apiError
	return errors.Is(err, fs.ErrNotExist) || (errors.As(err, &ae) && ae.Code == codeNotFound)
}

func (m *windowManager) emit(e Event) Event { return m.events.push(e) }

func (m *windowManager) siteOverlays(mounts []Mount, a, s int64) []mountedOverlay {
	var out []mountedOverlay
	for _, ov := range windowOverlays(mounts, m.layout.Root) {
		if ov.AccountID == a && ov.SiteID == s {
			out = append(out, ov)
		}
	}
	return out
}

func (m *windowManager) findOverlay(mounts []Mount, a, s, w int64) (mountedOverlay, bool) {
	for _, ov := range m.siteOverlays(mounts, a, s) {
		if ov.WindowID == w {
			return ov, true
		}
	}
	return mountedOverlay{}, false
}

func (m *windowManager) readState(a, s, w int64) (windowState, bool) {
	var st windowState
	dir, err := m.openRel(m.layout.WindowRel(a, s, w))
	if err != nil {
		return st, false
	}
	defer dir.Close()
	if err := readJSONFile(dir, "state.json", &st); err != nil {
		return st, false
	}
	return st, st.WindowID == w && st.SiteID == s && st.AccountID == a
}

func (m *windowManager) writeState(st windowState) error {
	dir, err := m.openRel(m.layout.WindowRel(st.AccountID, st.SiteID, st.WindowID))
	if err != nil {
		return err
	}
	defer dir.Close()
	return writeJSONFile(dir, "state.json", st)
}

// unmountAll unmounts target while something is mounted there (stacked mounts).
func (m *windowManager) unmountAll(target string) error {
	_, err := m.unmountAllDetached(target)
	return err
}

// unmountAllDetached is unmountAll reporting whether one of the unmounts had
// to fall back to a lazy detach (the mount lives on for its holders).
func (m *windowManager) unmountAllDetached(target string) (bool, error) {
	detached := false
	for range 8 {
		mounts, err := m.mnt.mounts()
		if err != nil {
			return detached, err
		}
		if !isMountPoint(mounts, target) {
			return detached, nil
		}
		d, err := m.mnt.unmount(target)
		detached = detached || d
		if err != nil {
			return detached, err
		}
	}
	return detached, fmt.Errorf("%s: still mounted after 8 unmounts", target)
}

// Draining the writers of a lazily detached rw overlay: wait for them to
// leave (drainWaitSteps x drainPoll), SIGKILL the remaining holders, wait
// again (drainKillSteps x drainPoll).
const (
	drainPoll      = 250 * time.Millisecond
	drainWaitSteps = 8
	drainKillSteps = 8
)

// drainDetached ensures no process still holds the detached overlay of
// device dev: a holder keeps a WRITABLE handle on the window (open file,
// mapping, cwd) whose writes would land in upper/ after the freeze, never
// exported nor analysed (M2). With kill, the holders still there after the
// grace period are killed (they can only be this site's processes: the
// overlay is mounted nowhere else). 409 windowWriters when some remain.
func (m *windowManager) drainDetached(a, s, w int64, dev string, kill bool) error {
	if dev == "" {
		return conflictError(codeWindowWriters, "window %d: the frozen layer was only detached and its device is unknown: some process may still write into it; discard the window", w)
	}
	killed := false
	for i := 0; ; i++ {
		pids, err := m.mnt.holders(dev)
		if err != nil {
			return fmt.Errorf("window %d: holders of the detached layer: %w", w, err)
		}
		pids = slices.DeleteFunc(pids, func(p int) bool { return p <= 1 })
		if len(pids) == 0 {
			if i > 0 {
				slog.Info("window: detached layer released", "account", a, "site", s, "window", w, "dev", dev, "killed", killed)
			}
			return nil
		}
		if !kill || i >= drainWaitSteps+drainKillSteps {
			return conflictError(codeWindowWriters, "window %d: processes %v still hold the frozen layer (writes remain possible)", w, pids)
		}
		if i == drainWaitSteps {
			slog.Warn("window: killing the processes still holding the detached rw layer", "account", a, "site", s, "window", w, "dev", dev, "pids", pids)
			for _, p := range pids {
				if err := m.mnt.kill(p); err != nil {
					slog.Warn("window: kill failed", "pid", p, "err", err)
				}
			}
			killed = true
		}
		m.sleep(drainPoll)
	}
}

// settleDetached re-checks a recorded detached overlay (state.json) and
// clears the record once nobody holds it. Error: still held (or unknown).
func (m *windowManager) settleDetached(st *windowState, kill bool) error {
	if !st.writersDetached() {
		return nil
	}
	if st.DetachedUnknown {
		return m.drainDetached(st.AccountID, st.SiteID, st.WindowID, "", kill)
	}
	if err := m.drainDetached(st.AccountID, st.SiteID, st.WindowID, st.DetachedDev, kill); err != nil {
		return err
	}
	st.DetachedDev = ""
	return m.writeState(*st)
}

// relUnder is the POSIX path of name (in the directory dirName) relative to base.
func relUnder(base, dirName, name string) string {
	rel, err := filepath.Rel(filepath.Clean(base), filepath.Clean(dirName))
	if err != nil || rel == "." {
		return name
	}
	return filepath.ToSlash(rel) + "/" + name
}

// ── Windows ──────────────────────────────────────────────────────────────────

// EnsureWindow mounts (or switches the mode of) the window overlay over
// releases/<n>. Idempotent. Only this site's release becomes writable (M1),
// rw only when asked (M2).
func (m *windowManager) EnsureWindow(ctx context.Context, spec WindowSpec) (WindowStatus, error) {
	if err := spec.validate(); err != nil {
		return WindowStatus{}, err
	}
	a, s, w, n := spec.AccountID, spec.SiteID, spec.WindowID, spec.ReleaseNumber
	unlock, err := m.lockSite(ctx, a, s)
	if err != nil {
		return WindowStatus{}, err
	}
	defer unlock()

	mounts, err := m.mnt.mounts()
	if err != nil {
		return WindowStatus{}, err
	}
	var cur *mountedOverlay
	for _, ov := range m.siteOverlays(mounts, a, s) {
		if ov.WindowID != w || ov.ReleaseNumber != n {
			return WindowStatus{}, conflictError(codeConflict, "site %d: window %d is mounted on release %d", s, ov.WindowID, ov.ReleaseNumber)
		}
		cur = &ov
	}
	rel, err := m.openRel(m.layout.ReleaseRel(a, s, n))
	if isNotFound(err) {
		return WindowStatus{}, notFound("release %d of site %d does not exist", n, s)
	}
	if err != nil {
		return WindowStatus{}, err
	}
	relFi, err := rel.Stat(".")
	rel.Close()
	if err != nil {
		return WindowStatus{}, err
	}

	key := windowKey{a, s, w}
	st, _ := m.readState(a, s, w)
	// A previous freeze left a detached rw layer still held: drain it first
	// (nothing is mounted or switched while it can still be written).
	if err := m.settleDetached(&st, true); err != nil {
		return WindowStatus{}, err
	}
	metacopy := st.Metacopy
	if cur != nil {
		if top, ok := topMountAt(mounts, cur.MountPoint); ok && hasMetacopy(top) {
			metacopy = true
		}
	}
	if spec.Mode == windowModeRO || !spec.QuarantineExecutables {
		m.stopSupervised(key)
	}
	var stale switchResult
	var staleErr error
	switch {
	case cur == nil:
		if err := m.prepareWindow(spec, relFi, mounts); err != nil {
			return WindowStatus{}, err
		}
		used, err := m.mountWindow(spec, mounts, metacopy)
		if err != nil {
			return WindowStatus{}, err
		}
		metacopy = metacopy || used
		slog.Info("window mounted", "account", a, "site", s, "window", w, "release", n, "mode", spec.Mode)
	case cur.Mode != spec.Mode:
		res, err := m.switchMode(spec, cur.Mode, metacopy)
		switch {
		case res.stale() && !res.mounted:
			// Neither switched nor drained: record the detached writers
			// (export refuses) on the state as it was.
			st.AccountID, st.SiteID, st.WindowID = a, s, w
			st.DetachedDev, st.DetachedUnknown = res.staleDev, res.staleUnknown
			if werr := m.writeState(st); werr != nil {
				slog.Error("window: detached writers NOT recorded", "window", w, "err", werr)
			}
			return WindowStatus{}, err
		case res.stale():
			// Frozen, but writers survive on the detached rw layer: record
			// it below, then answer the drain error.
			stale, staleErr = res, err
		case err != nil:
			return WindowStatus{}, err
		}
		metacopy = metacopy || res.metacopy
		slog.Info("window mode switched", "account", a, "site", s, "window", w, "from", cur.Mode, "to", spec.Mode)
	}
	if st.ReleaseNumber != n {
		st.Chowned = false
	}
	st = windowState{AccountID: a, SiteID: s, WindowID: w, Slug: spec.Slug, UID: spec.Owner.UID, GID: spec.Owner.GID,
		ReleaseNumber: n, Mode: spec.Mode, QuarantineExecutables: spec.QuarantineExecutables, Chowned: st.Chowned, Metacopy: metacopy,
		DetachedDev: stale.staleDev, DetachedUnknown: stale.staleUnknown}
	if spec.Mode == windowModeRW && !st.Chowned {
		if err := m.chownMerged(ctx, spec); err != nil {
			_ = m.writeState(st)
			return WindowStatus{}, fmt.Errorf("window %d: ownership walk: %w", w, err)
		}
		st.Chowned = true
	}
	if err := m.writeState(st); err != nil {
		return WindowStatus{}, err
	}
	if staleErr != nil {
		return WindowStatus{}, staleErr
	}
	m.mu.Lock()
	delete(m.lost, key)
	m.mu.Unlock()
	if spec.Mode == windowModeRW && spec.QuarantineExecutables {
		if err := m.startSupervised(spec); err != nil {
			return WindowStatus{}, fmt.Errorf("window %d: supervision: %w", w, err)
		}
	}
	return m.status(a, s, w)
}

// prepareWindow creates windows/<w>/{lower,work} (root 0700) and upper/ with
// the owner and mode of the release root (the overlay root inode is upper/).
// A lower/ that is still a mount point is left alone: its root IS the
// release root (owner / mode never touched through the bind).
func (m *windowManager) prepareWindow(spec WindowSpec, relFi fs.FileInfo, mounts []Mount) error {
	a, s, w := spec.AccountID, spec.SiteID, spec.WindowID
	root, err := os.OpenRoot(m.layout.Root)
	if err != nil {
		return err
	}
	defer root.Close()
	specs := m.layout.windowDirs(a, s, w)
	if isMountPoint(mounts, m.layout.WindowLower(a, s, w)) {
		specs = slices.DeleteFunc(specs, func(d dirSpec) bool { return slices.Equal(d.Rel, m.layout.WindowLowerRel(a, s, w)) })
	}
	if err := ensureTree(root, specs, m.own); err != nil {
		return err
	}
	win, err := m.openRel(m.layout.WindowRel(a, s, w))
	if err != nil {
		return err
	}
	defer win.Close()
	if _, err := win.Lstat("upper"); err == nil {
		up, err := openDir(win, "upper") // kept (host reboot): never a link
		if err == nil {
			up.Close()
		}
		return err
	}
	up, err := ensureDir(win, "upper", ownerOf(relFi), relFi.Mode().Perm(), m.own)
	if err != nil {
		return err
	}
	return up.Close()
}

// mountWindow binds the pristine release on lower/ (when not already there)
// then mounts the overlay over releases/<n>.
func (m *windowManager) mountWindow(spec WindowSpec, mounts []Mount, needMetacopy bool) (bool, error) {
	a, s, w, n := spec.AccountID, spec.SiteID, spec.WindowID, spec.ReleaseNumber
	lower := m.layout.WindowLower(a, s, w)
	bound := false
	if !isMountPoint(mounts, lower) {
		if err := m.bindPristine(a, s, n, lower); err != nil {
			return false, err
		}
		bound = true
	}
	used, err := m.mountOverlay(spec, spec.Mode == windowModeRO, needMetacopy)
	if err != nil {
		if bound {
			if uerr := m.unmountAll(lower); uerr != nil {
				slog.Warn("window: lower bind left mounted after a failed overlay", "lower", lower, "err", uerr)
			}
		}
		return false, err
	}
	return used, nil
}

// bindPristine binds releases/<n> on lower/ through a PRIVATE clone of
// releases/ (see overlay.go): lower/ never receives the overlay mounted over
// the release, and its own mount/unmount propagate cleanly to the host.
func (m *windowManager) bindPristine(a, s, n int64, lower string) error {
	run, err := m.openRel([]string{"run"})
	if err != nil {
		return err
	}
	area, err := ensureDir(run, "hostd-mnt", rootOwner, 0o700, m.own)
	run.Close()
	if err != nil {
		return err
	}
	defer area.Close()
	if err := m.mnt.privateArea(m.layout.PrivateMount()); err != nil {
		return err
	}
	var b [6]byte
	if _, err := rand.Read(b[:]); err != nil {
		return err
	}
	tmpName := fmt.Sprintf("%d-%d-%s", a, s, hex.EncodeToString(b[:]))
	if err := area.Mkdir(tmpName, 0o700); err != nil {
		return err
	}
	tmp := path.Join(m.layout.PrivateMount(), tmpName)
	defer func() {
		if err := m.unmountAll(tmp); err != nil {
			slog.Warn("window: private clone left mounted", "dir", tmp, "err", err)
			return
		}
		_ = area.Remove(tmpName)
	}()
	if err := m.mnt.privateBind(m.layout.Releases(a, s), tmp); err != nil {
		return err
	}
	return m.mnt.bindRO(path.Join(tmp, id(n)), lower)
}

// mountOverlay tries the option sets best first (metacopy, then without) and
// reports whether the mounted one uses metacopy. needMetacopy: upper/ may hold
// metadata-only entries (the window was mounted with metacopy before), so
// only the metacopy options are tried: a mount without metacopy would serve
// EIO for those files; failing keeps the previous view instead.
func (m *windowManager) mountOverlay(spec WindowSpec, ro, needMetacopy bool) (bool, error) {
	a, s, w := spec.AccountID, spec.SiteID, spec.WindowID
	opts, err := overlayOptions(m.layout.WindowLower(a, s, w), m.layout.WindowUpper(a, s, w), m.layout.WindowWork(a, s, w), ro)
	if err != nil {
		return false, err
	}
	if needMetacopy {
		opts = slices.DeleteFunc(opts, func(o string) bool { return !strings.Contains(o, ",metacopy=on") })
	}
	target := m.layout.Release(a, s, spec.ReleaseNumber)
	var errs []error
	for i, o := range opts {
		err := m.mnt.overlay(overlaySource(w), target, o, ro)
		if err == nil {
			if i > 0 {
				slog.Warn("window overlay mounted with fallback options", "target", target, "options", o, "refused", errors.Join(errs...))
			}
			return strings.Contains(o, ",metacopy=on"), nil
		}
		errs = append(errs, err)
	}
	return false, errors.Join(errs...)
}

// switchMode remounts the overlay in the other mode (a remount ro would not
// propagate into the containers: unmount, then mount the new overlay).
//
// Freeze (rw → ro): the unmount is retried while busy, but a process with an
// open file / cwd on the overlay (here or in a container) can force a lazy
// detach, and the detached rw overlay stays writable for it: its writes would
// land in upper/ (a lower layer of the new ro overlay, never exported nor
// analysed). Those holders are drained (waited for, then killed) BEFORE the
// ro overlay is mounted, so upper/ never changes under it; meanwhile the site
// serves its pristine release. Still held afterwards: the ro overlay is
// mounted all the same (the site keeps the window's content) and stale names
// the detached device (stale != "" or staleUnknown): EnsureWindow records it
// and answers windowWriters, export refuses until the holders are gone.
// switchResult: metacopy = the mounted overlay uses metacopy; mounted = the
// new mode is mounted; staleDev / staleUnknown = a detached rw layer is still
// held (its device, or unknown).
type switchResult struct {
	metacopy, mounted bool
	staleDev          string
	staleUnknown      bool
}

func (r switchResult) stale() bool { return r.staleDev != "" || r.staleUnknown }

func (m *windowManager) switchMode(spec WindowSpec, from string, needMetacopy bool) (switchResult, error) {
	target := m.layout.Release(spec.AccountID, spec.SiteID, spec.ReleaseNumber)
	oldDev := ""
	if mounts, merr := m.mnt.mounts(); merr == nil {
		if top, ok := topMountAt(mounts, target); ok && top.FSType == "overlay" {
			oldDev = top.Dev
		}
	}
	detached, err := m.unmountAllDetached(target)
	if err != nil {
		return switchResult{}, err
	}
	var drainErr error
	if detached && from == windowModeRW {
		slog.Warn("window: rw overlay busy, lazily detached: draining its writers", "target", target, "dev", oldDev)
		drainErr = m.drainDetached(spec.AccountID, spec.SiteID, spec.WindowID, oldDev, true)
	}
	var res switchResult
	if drainErr != nil {
		res.staleDev, res.staleUnknown = oldDev, oldDev == ""
	}
	used, err := m.mountOverlay(spec, spec.Mode == windowModeRO, needMetacopy)
	if err != nil {
		// Put the previous view back: the site must keep serving its content.
		if _, rerr := m.mountOverlay(spec, from == windowModeRO, needMetacopy); rerr != nil {
			slog.Error("window: previous overlay NOT restored", "target", target, "err", rerr)
		}
		return res, errors.Join(err, drainErr)
	}
	res.metacopy, res.mounted = used, true
	return res, drainErr
}

// chownMerged gives the merged view to the account uid (lchown of every
// entry, never following a link nor entering another mount). With metacopy
// only metadata is copied up.
func (m *windowManager) chownMerged(ctx context.Context, spec WindowSpec) error {
	target := m.layout.Release(spec.AccountID, spec.SiteID, spec.ReleaseNumber)
	merged, err := m.openRel(m.layout.ReleaseRel(spec.AccountID, spec.SiteID, spec.ReleaseNumber))
	if err != nil {
		return err
	}
	defer merged.Close()
	var skip skipFunc
	if mounts, err := m.mnt.mounts(); err == nil {
		if below := mountsBelowIn(mounts, target); len(below) > 0 {
			skip = func(rel string) bool { _, ok := below[rel]; return ok }
		}
	}
	if err := m.lchown(merged, ".", spec.Owner); err != nil {
		return err
	}
	_, err = walkTreeSkip(ctx, merged, skip, func(parent *os.Root, name string, _ fs.FileInfo, _ *os.Root) error {
		if err := m.lchown(parent, name, spec.Owner); err != nil && !errors.Is(err, fs.ErrNotExist) {
			return err
		}
		return nil
	})
	return err
}

// WindowStatus answers mounted:false when nothing is mounted.
func (m *windowManager) WindowStatus(_ context.Context, a, s, w int64) (WindowStatus, error) {
	for _, c := range []struct {
		what string
		n    int64
	}{{"account id", a}, {"site id", s}, {"window id", w}} {
		if err := validateID(c.what, c.n); err != nil {
			return WindowStatus{}, err
		}
	}
	return m.status(a, s, w)
}

func (m *windowManager) status(a, s, w int64) (WindowStatus, error) {
	st := WindowStatus{AccountID: a, SiteID: s, WindowID: w}
	mounts, err := m.mnt.mounts()
	if err != nil {
		return st, err
	}
	state, hasState := m.readState(a, s, w)
	if ov, ok := m.findOverlay(mounts, a, s, w); ok {
		st.Mounted = true
		st.Mode = strPtr(ov.Mode)
		st.ReleaseNumber = i64Ptr(ov.ReleaseNumber)
		st.QuarantineExecutables = hasState && state.QuarantineExecutables && ov.Mode == windowModeRW
	} else if hasState {
		st.ReleaseNumber = i64Ptr(state.ReleaseNumber)
	}
	st.WritersDetached = hasState && state.writersDetached()
	var newest time.Time
	st.UpperBytes, st.UpperEntries, newest = m.upperStats(a, s, w)
	if exp, err := m.openRel(m.layout.WindowExportRel(a, s, w)); err == nil {
		if fi, err := exp.Lstat("manifest.json"); err == nil && fi.Mode().IsRegular() && !changeTime(fi).Before(newest) && !st.WritersDetached {
			st.ExportReady = true
		}
		exp.Close()
	}
	return st, nil
}

// upperStats measures the upper layer: regular files with data, symlinks and
// whiteouts (metadata-only copies and directories excluded), and the newest
// inode change time seen (directories included: a creation / deletion
// changes its parent). ctime, not mtime: an application sets any mtime
// (archive extraction, touch -d), never the ctime.
func (m *windowManager) upperStats(a, s, w int64) (bytes, entries int64, newest time.Time) {
	upper, err := m.openRel(m.layout.WindowUpperRel(a, s, w))
	if err != nil {
		return 0, 0, newest
	}
	defer upper.Close()
	if fi, err := upper.Stat("."); err == nil {
		newest = changeTime(fi)
	}
	_, _ = walkTree(context.Background(), upper, func(parent *os.Root, name string, fi fs.FileInfo, sub *os.Root) error {
		if c := changeTime(fi); c.After(newest) {
			newest = c
		}
		if fi.IsDir() {
			return nil
		}
		k, err := m.attrs.classify(parent, name, fi, sub, relUnder(upper.Name(), parent.Name(), name))
		if err != nil || (k.metacopy && !k.redirect) {
			return nil
		}
		entries++
		if !k.whiteout && fi.Mode().IsRegular() {
			bytes += fi.Size()
		}
		return nil
	})
	return bytes, entries, newest
}

// ExportWindow writes export/manifest.json + export/files/ (replacing a
// previous export). 409 windowNotMounted when the overlay is not mounted.
func (m *windowManager) ExportWindow(ctx context.Context, ref WindowRef, opts ExportOptions) (ExportResult, error) {
	if err := ref.validate(); err != nil {
		return ExportResult{}, err
	}
	if err := opts.validate(); err != nil {
		return ExportResult{}, err
	}
	a, s, w := ref.AccountID, ref.SiteID, ref.WindowID
	unlock, err := m.lockSite(ctx, a, s)
	if err != nil {
		return ExportResult{}, err
	}
	defer unlock()
	mounts, err := m.mnt.mounts()
	if err != nil {
		return ExportResult{}, err
	}
	ov, ok := m.findOverlay(mounts, a, s, w)
	if !ok {
		return ExportResult{}, conflictError(codeWindowNotMounted, "window %d is not mounted", w)
	}
	// A detached rw layer still held can still write into upper/: an export
	// now would miss (or half-capture) those writes. Never kills here: the
	// freeze (EnsureWindow) does.
	if st, ok := m.readState(a, s, w); ok {
		if err := m.settleDetached(&st, false); err != nil {
			return ExportResult{}, err
		}
	}
	if !isMountPoint(mounts, m.layout.WindowLower(a, s, w)) {
		return ExportResult{}, fmt.Errorf("window %d: lower bind missing", w)
	}
	upper, err := m.openRel(m.layout.WindowUpperRel(a, s, w))
	if err != nil {
		return ExportResult{}, err
	}
	defer upper.Close()
	lower, err := m.openRel(m.layout.WindowLowerRel(a, s, w))
	if err != nil {
		return ExportResult{}, err
	}
	defer lower.Close()
	merged, err := m.openRel(m.layout.ReleaseRel(a, s, ov.ReleaseNumber))
	if err != nil {
		return ExportResult{}, err
	}
	defer merged.Close()
	return m.export(ctx, ref, ov.ReleaseNumber, upper, lower, merged, opts)
}

// export writes the export of a window from opened trees (tests call it with
// simulated layers).
func (m *windowManager) export(ctx context.Context, ref WindowRef, releaseNumber int64, upper, lower, merged *os.Root, opts ExportOptions) (ExportResult, error) {
	win, err := m.openRel(m.layout.WindowRel(ref.AccountID, ref.SiteID, ref.WindowID))
	if err != nil {
		return ExportResult{}, err
	}
	defer win.Close()
	if err := removeTree(win, "export"); err != nil {
		return ExportResult{}, err
	}
	exp, err := ensureDir(win, "export", rootOwner, 0o700, m.own)
	if err != nil {
		return ExportResult{}, err
	}
	defer exp.Close()
	files, err := ensureDir(exp, "files", rootOwner, 0o700, m.own)
	if err != nil {
		return ExportResult{}, err
	}
	defer files.Close()
	entries, res, err := exportDiff(ctx, upper, lower, merged, files, m.attrs, opts)
	if err != nil {
		return ExportResult{}, err
	}
	manifest := WindowManifest{Version: 1, WindowID: ref.WindowID, ReleaseNumber: releaseNumber,
		CreatedAt: m.now().UTC().Format(time.RFC3339), Entries: entries, Truncated: res.Truncated}
	if err := writeJSONFile(exp, "manifest.json", manifest); err != nil {
		return ExportResult{}, err
	}
	slog.Info("window exported", "account", ref.AccountID, "site", ref.SiteID, "window", ref.WindowID,
		"entries", res.Entries, "bytes", res.Bytes, "truncated", res.Truncated)
	return res, nil
}

// RemoveWindow unmounts the overlay and the lower bind, then removes upper/,
// work/ (and export/ unless keepExport). Idempotent.
func (m *windowManager) RemoveWindow(ctx context.Context, ref WindowRef, keepExport bool) error {
	if err := ref.validate(); err != nil {
		return err
	}
	a, s, w := ref.AccountID, ref.SiteID, ref.WindowID
	unlock, err := m.lockSite(ctx, a, s)
	if err != nil {
		return err
	}
	defer unlock()
	return m.removeWindowLocked(a, s, w, keepExport)
}

func (m *windowManager) removeWindowLocked(a, s, w int64, keepExport bool) error {
	key := windowKey{a, s, w}
	m.stopSupervised(key)
	for range 8 {
		mounts, err := m.mnt.mounts()
		if err != nil {
			return err
		}
		ov, ok := m.findOverlay(mounts, a, s, w)
		if !ok {
			break
		}
		detached, err := m.mnt.unmount(ov.MountPoint)
		if err != nil {
			return err
		}
		if detached {
			// Its holders keep writing into an upper/ about to be removed:
			// nothing serves nor exports it any more (harmless, logged).
			slog.Warn("window: overlay lazily detached on removal", "account", a, "site", s, "window", w, "mode", ov.Mode)
		}
	}
	mounts, err := m.mnt.mounts()
	if err != nil {
		return err
	}
	if _, ok := m.findOverlay(mounts, a, s, w); ok {
		return fmt.Errorf("window %d: overlay still mounted", w)
	}
	lower := m.layout.WindowLower(a, s, w)
	if err := m.unmountAll(lower); err != nil {
		return err
	}
	m.mu.Lock()
	delete(m.lost, key)
	m.mu.Unlock()
	win, err := m.openRel(m.layout.WindowRel(a, s, w))
	if isNotFound(err) {
		return nil
	}
	if err != nil {
		return err
	}
	defer win.Close()
	// lower/ is an empty mount point directory: rmdir only (never a recursive
	// removal through a bind that would still be there).
	if err := win.Remove("lower"); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("window %d: lower: %w", w, err)
	}
	for _, name := range []string{"upper", "work", "state.json"} {
		if err := removeTree(win, name); err != nil {
			return err
		}
	}
	if !keepExport {
		if err := removeTree(win, "export"); err != nil {
			return err
		}
	}
	if empty, err := isEmptyDir(win); err == nil && empty {
		if windows, err := m.openRel(m.layout.WindowsRel(a, s)); err == nil {
			_ = windows.Remove(id(w))
			windows.Close()
		}
	}
	slog.Info("window removed", "account", a, "site", s, "window", w, "keepExport", keepExport)
	return nil
}

// VerifyWindow reads /proc/<pid>/mountinfo of container processes.
func (m *windowManager) VerifyWindow(_ context.Context, a, s, w int64, pids []int) ([]PropagationResult, error) {
	mounts, err := m.mnt.mounts()
	if err != nil {
		return nil, err
	}
	ov, ok := m.findOverlay(mounts, a, s, w)
	if !ok {
		return nil, conflictError(codeWindowNotMounted, "window %d is not mounted", w)
	}
	out := make([]PropagationResult, 0, len(pids))
	for _, pid := range pids {
		if !m.mnt.pidExists(pid) {
			out = append(out, PropagationResult{PID: pid, Error: strPtr("processus introuvable")})
			continue
		}
		pm, err := m.mnt.pidMounts(pid)
		if err != nil {
			out = append(out, PropagationResult{PID: pid, Error: strPtr(err.Error())})
			continue
		}
		out = append(out, propagationResult(pid, pm, ov.ReleaseNumber))
	}
	return out, nil
}

// ListWindows lists every window overlay currently mounted.
func (m *windowManager) ListWindows(context.Context) ([]MountedWindow, error) {
	mounts, err := m.mnt.mounts()
	if err != nil {
		return nil, err
	}
	out := []MountedWindow{}
	for _, ov := range windowOverlays(mounts, m.layout.Root) {
		out = append(out, ov.MountedWindow)
	}
	return out, nil
}

// ── Staging, workspaces ──────────────────────────────────────────────────────

func (m *windowManager) ApplyToStaging(ctx context.Context, s SiteSpec, src StagingSource, changes []StagingChange) (StagingApplyResult, error) {
	if err := s.validate(); err != nil {
		return StagingApplyResult{}, err
	}
	if err := src.validate(); err != nil {
		return StagingApplyResult{}, err
	}
	if err := validStagingChanges(changes); err != nil {
		return StagingApplyResult{}, err
	}
	unlock, err := m.lockSite(ctx, s.AccountID, s.SiteID)
	if err != nil {
		return StagingApplyResult{}, err
	}
	defer unlock()
	srcRel := m.layout.WindowExportFilesRel(s.AccountID, s.SiteID, src.ID)
	if src.Kind == "workspace" {
		srcRel = m.layout.WorkspaceTreeRel(s.AccountID, s.SiteID, src.ID)
	}
	from, err := m.openRel(srcRel)
	if err != nil {
		return StagingApplyResult{}, err
	}
	defer from.Close()
	to, err := m.openRel(m.layout.SiteStagingRel(s.AccountID, s.Slug))
	if err != nil {
		return StagingApplyResult{}, err
	}
	defer to.Close()
	res, err := applyChanges(ctx, from, to, s.Owner, m.own, m.lchown, changes)
	if err == nil {
		slog.Info("staging updated", "account", s.AccountID, "site", s.SiteID, "source", src.Kind, "id", src.ID,
			"written", res.Written, "deleted", res.Deleted, "conflicts", len(res.Conflicts))
	}
	return res, err
}

func (m *windowManager) EnsureWorkspace(ctx context.Context, ws WorkspaceSpec) (WorkspaceResult, error) {
	if err := ws.validate(); err != nil {
		return WorkspaceResult{}, err
	}
	if err := validateID("workspace id", ws.WorkspaceID); err != nil {
		return WorkspaceResult{}, err
	}
	if err := validateID("release number", ws.ReleaseNumber); err != nil {
		return WorkspaceResult{}, err
	}
	a, s := ws.AccountID, ws.SiteID
	unlock, err := m.lockSite(ctx, a, s)
	if err != nil {
		return WorkspaceResult{}, err
	}
	defer unlock()
	// The release itself: through the pristine lower bind when a window
	// overlay covers it (a workspace never copies a window's changes).
	srcRel := m.layout.ReleaseRel(a, s, ws.ReleaseNumber)
	if mounts, err := m.mnt.mounts(); err == nil {
		for _, ov := range m.siteOverlays(mounts, a, s) {
			if ov.ReleaseNumber == ws.ReleaseNumber && isMountPoint(mounts, m.layout.WindowLower(a, s, ov.WindowID)) {
				srcRel = m.layout.WindowLowerRel(a, s, ov.WindowID)
			}
		}
	}
	src, err := m.openRel(srcRel)
	if isNotFound(err) {
		return WorkspaceResult{}, notFound("release %d of site %d does not exist", ws.ReleaseNumber, s)
	}
	if err != nil {
		return WorkspaceResult{}, err
	}
	defer src.Close()
	root, err := os.OpenRoot(m.layout.Root)
	if err != nil {
		return WorkspaceResult{}, err
	}
	err = ensureTree(root, m.layout.workspaceDirs(a, s, ws.WorkspaceID), m.own)
	root.Close()
	if err != nil {
		return WorkspaceResult{}, err
	}
	wsDir, err := m.openRel(m.layout.WorkspaceRel(a, s, ws.WorkspaceID))
	if err != nil {
		return WorkspaceResult{}, err
	}
	defer wsDir.Close()
	if err := removeTree(wsDir, "tree"); err != nil {
		return WorkspaceResult{}, err
	}
	tree, err := ensureDir(wsDir, "tree", ws.Owner, 0o755, m.own)
	if err != nil {
		return WorkspaceResult{}, err
	}
	defer tree.Close()
	c := &treeCopier{ctx: ctx, owner: ws.Owner, own: m.own, lchown: m.lchown, clone: m.clone}
	if err := c.copyTree(src, tree, 0); err != nil {
		return WorkspaceResult{}, err
	}
	slog.Info("workspace ready", "account", a, "site", s, "workspace", ws.WorkspaceID, "release", ws.ReleaseNumber, "files", c.files, "bytes", c.bytes)
	return WorkspaceResult{Files: c.files, Bytes: c.bytes}, nil
}

func (m *windowManager) RemoveWorkspace(ctx context.Context, a, s int64, slug string, wsID int64) error {
	if err := validateID("account id", a); err != nil {
		return err
	}
	if err := validateID("site id", s); err != nil {
		return err
	}
	if err := validateSlug(slug); err != nil {
		return err
	}
	if err := validateID("workspace id", wsID); err != nil {
		return err
	}
	unlock, err := m.lockSite(ctx, a, s)
	if err != nil {
		return err
	}
	defer unlock()
	work, err := m.openRel(m.layout.WorkspacesRel(a, s))
	if isNotFound(err) {
		return nil
	}
	if err != nil {
		return err
	}
	defer work.Close()
	return removeTree(work, id(wsID))
}

// ── Watches ──────────────────────────────────────────────────────────────────

const (
	maxTypedPaths      = 100
	maxAllowedExts     = 200
	maxExtensionLength = 32
)

func validateTyped(typed []TypedPath) error {
	if len(typed) > maxTypedPaths {
		return badRequest("too many typed paths (max %d)", maxTypedPaths)
	}
	for _, t := range typed {
		if _, err := splitDataPath(t.Path); err != nil {
			return err
		}
		if len(t.AllowedExtensions) > maxAllowedExts {
			return badRequest("too many extensions for %s", t.Path)
		}
		for _, e := range t.AllowedExtensions {
			if len(e) > maxExtensionLength || strings.ContainsAny(e, "/\\\x00") {
				return badRequest("invalid extension %q", e)
			}
		}
	}
	return nil
}

func (m *windowManager) getHub() (notifyHub, error) {
	m.hubMu.Lock()
	defer m.hubMu.Unlock()
	if m.hub != nil {
		return m.hub, nil
	}
	h, err := m.newHub()
	if err != nil {
		return nil, err
	}
	m.hub = h
	return h, nil
}

// SetWatch replaces the typed-path watch of a site and quarantines the files
// that do not conform right away.
func (m *windowManager) SetWatch(ctx context.Context, ws WatchSpec) (WatchResult, error) {
	if err := ws.validate(); err != nil {
		return WatchResult{}, err
	}
	if err := validateTyped(ws.Typed); err != nil {
		return WatchResult{}, err
	}
	if len(ws.Typed) == 0 {
		return WatchResult{}, m.RemoveWatch(ctx, ws.AccountID, ws.SiteID)
	}
	hub, err := m.getHub()
	if err != nil {
		return WatchResult{}, err
	}
	unlock, err := m.lockSite(ctx, ws.AccountID, ws.SiteID)
	if err != nil {
		return WatchResult{}, err
	}
	defer unlock()
	res, err := m.startTyped(hub, ws)
	if err == nil {
		m.persistWatches()
	}
	return res, err
}

func (m *windowManager) startTyped(hub notifyHub, ws WatchSpec) (WatchResult, error) {
	key := siteKey{ws.AccountID, ws.SiteID}
	m.stopTyped(key)
	sw := &siteWatch{spec: ws}
	var res WatchResult
	for _, t := range ws.Typed {
		segs, _ := splitDataPath(t.Path)
		var nested []string
		for _, o := range ws.Typed {
			if rest, ok := strings.CutPrefix(o.Path, t.Path+"/"); ok {
				nested = append(nested, rest)
			}
		}
		sink := &typedSink{m: m, accountID: ws.AccountID, siteID: ws.SiteID, slug: ws.Slug, dataPath: t.Path,
			allowed: normalizeExtensions(t.AllowedExtensions), nested: nested, seen: map[string]fileStamp{}}
		rel := append(m.layout.SiteDataRel(ws.AccountID, ws.Slug), segs...)
		tw := newTreeWatch(fmt.Sprintf("typed %d/%d/%s", ws.AccountID, ws.SiteID, t.Path), hub,
			func() (*os.Root, error) { return m.openRel(rel) }, sink.check, m.typedRescan)
		n, err := tw.start()
		if isNotFound(err) || errors.Is(err, errUnsafePath) {
			slog.Warn("typed path not watched", "account", ws.AccountID, "site", ws.SiteID, "path", t.Path, "err", err)
			m.emit(Event{Kind: eventWatchError, AccountID: ws.AccountID, SiteID: i64Ptr(ws.SiteID),
				Message: strPtr("chemin typé non surveillé : " + t.Path)})
			continue
		}
		if err != nil {
			for _, w := range sw.watches {
				w.stop()
			}
			return WatchResult{}, err
		}
		sw.watches = append(sw.watches, tw)
		res.Watching++
		res.Quarantined += n
	}
	m.mu.Lock()
	m.typed[key] = sw
	m.mu.Unlock()
	return res, nil
}

func (m *windowManager) stopTyped(key siteKey) {
	m.mu.Lock()
	sw := m.typed[key]
	delete(m.typed, key)
	m.mu.Unlock()
	if sw != nil {
		for _, w := range sw.watches {
			w.stop()
		}
	}
}

func (m *windowManager) RemoveWatch(_ context.Context, a, s int64) error {
	if err := validateID("account id", a); err != nil {
		return err
	}
	if err := validateID("site id", s); err != nil {
		return err
	}
	m.stopTyped(siteKey{a, s})
	m.persistWatches()
	return nil
}

// watchRecord is one persisted typed watch (run/hostd-watches.json).
type watchRecord struct {
	AccountID int64       `json:"accountId"`
	SiteID    int64       `json:"siteId"`
	Slug      string      `json:"slug"`
	UID       int         `json:"uid"`
	GID       int         `json:"gid"`
	Typed     []TypedPath `json:"typed"`
}

func (m *windowManager) persistWatches() {
	m.mu.Lock()
	recs := []watchRecord{}
	for _, sw := range m.typed {
		s := sw.spec
		recs = append(recs, watchRecord{s.AccountID, s.SiteID, s.Slug, s.Owner.UID, s.Owner.GID, s.Typed})
	}
	m.mu.Unlock()
	slices.SortFunc(recs, func(x, y watchRecord) int { return int(x.SiteID - y.SiteID) })
	b, err := json.MarshalIndent(recs, "", "  ")
	if err == nil {
		tmp := m.watchStatePath + ".tmp"
		if err = os.WriteFile(filepath.FromSlash(tmp), b, 0o600); err == nil {
			err = os.Rename(filepath.FromSlash(tmp), filepath.FromSlash(m.watchStatePath))
		}
	}
	if err != nil {
		slog.Warn("typed watches not persisted", "path", m.watchStatePath, "err", err)
	}
}

func (m *windowManager) startSupervised(spec WindowSpec) error {
	key := windowKey{spec.AccountID, spec.SiteID, spec.WindowID}
	m.mu.Lock()
	_, running := m.supervised[key]
	m.mu.Unlock()
	if running {
		return nil
	}
	hub, err := m.getHub()
	if err != nil {
		return err
	}
	sink := &supervisedSink{m: m, ref: spec.WindowRef, owner: spec.Owner, releaseNumber: spec.ReleaseNumber, writing: map[string]bool{}}
	upperRel := m.layout.WindowUpperRel(spec.AccountID, spec.SiteID, spec.WindowID)
	tw := newTreeWatch(fmt.Sprintf("supervised %d/%d/%d", spec.AccountID, spec.SiteID, spec.WindowID), hub,
		func() (*os.Root, error) { return m.openRel(upperRel) }, sink.check, 0)
	tw.scanned = sink.endBaseline
	if _, err := tw.start(); err != nil {
		return err
	}
	m.mu.Lock()
	m.supervised[key] = tw
	m.mu.Unlock()
	return nil
}

func (m *windowManager) stopSupervised(key windowKey) {
	m.mu.Lock()
	tw := m.supervised[key]
	delete(m.supervised, key)
	m.mu.Unlock()
	if tw != nil {
		tw.stop()
	}
}

// ── Quarantine ───────────────────────────────────────────────────────────────

func (m *windowManager) ListQuarantine(_ context.Context, a int64) ([]QuarantineEntry, error) {
	if err := validateID("account id", a); err != nil {
		return nil, err
	}
	return m.quarantine.list(a)
}

func (m *windowManager) RestoreQuarantine(ctx context.Context, a int64, eid string, o Owner, overwrite bool) (RestoreResult, error) {
	if err := validateID("account id", a); err != nil {
		return RestoreResult{}, err
	}
	if err := validateOwner(o); err != nil {
		return RestoreResult{}, err
	}
	if err := validateQuarantineID(eid); err != nil {
		return RestoreResult{}, err
	}
	target := func(meta quarantineMetaFile) (restoreTarget, error) {
		if meta.Slug == nil || validateSlug(*meta.Slug) != nil {
			return restoreTarget{}, badRequest("quarantine entry %s has no site", eid)
		}
		if meta.Area == areaData {
			dir, err := m.openRel(m.layout.SiteDataRel(a, *meta.Slug))
			return restoreTarget{root: dir, dirMode: 0o750}, err
		}
		// Code: only through the merged view of a window mounted rw (the
		// release itself is immutable).
		if meta.SiteID == nil {
			return restoreTarget{}, badRequest("quarantine entry %s has no site", eid)
		}
		mounts, err := m.mnt.mounts()
		if err != nil {
			return restoreTarget{}, err
		}
		for _, ov := range m.siteOverlays(mounts, a, *meta.SiteID) {
			if ov.Mode == windowModeRW {
				dir, err := m.openRel(m.layout.ReleaseRel(a, *meta.SiteID, ov.ReleaseNumber))
				return restoreTarget{root: dir, dirMode: 0o755}, err
			}
		}
		return restoreTarget{}, conflictError(codeConflict, "no window of site %d is open for writing: code can only be restored into an open window", *meta.SiteID)
	}
	return m.quarantine.restore(a, eid, o, overwrite, target)
}

func (m *windowManager) DeleteQuarantine(_ context.Context, a int64, eid string) error {
	if err := validateID("account id", a); err != nil {
		return err
	}
	return m.quarantine.remove(a, eid)
}

func (m *windowManager) QuarantinePreview(_ context.Context, a int64, eid string, max int) (Preview, error) {
	if err := validateID("account id", a); err != nil {
		return Preview{}, err
	}
	if max <= 0 || max > maxPreviewBytes {
		return Preview{}, badRequest("max must be between 1 and %d", maxPreviewBytes)
	}
	return m.quarantine.preview(a, eid, max)
}

func (m *windowManager) Events(ctx context.Context, since int64, wait time.Duration) ([]Event, int64) {
	return m.events.Wait(ctx, since, wait)
}

// ── Removal of sites / accounts (hostOps hooks) ─────────────────────────────

// ReleaseSite stops the watchers of a site and unmounts its windows (before
// its tree is removed).
func (m *windowManager) ReleaseSite(ctx context.Context, a, s int64) error {
	unlock, err := m.lockSite(ctx, a, s)
	if err != nil {
		return err
	}
	defer unlock()
	m.stopTyped(siteKey{a, s})
	m.persistWatches()
	m.mu.Lock()
	var keys []windowKey
	for k := range m.supervised {
		if k.a == a && k.s == s {
			keys = append(keys, k)
		}
	}
	m.mu.Unlock()
	for _, k := range keys {
		m.stopSupervised(k)
	}
	return m.unmountBelow(path.Join(m.layout.Site(a, s)) + "/")
}

// ReleaseAccount does the same for every site of an account.
func (m *windowManager) ReleaseAccount(ctx context.Context, a int64) error {
	m.mu.Lock()
	sites := map[siteKey]bool{}
	for k := range m.typed {
		if k.a == a {
			sites[k] = true
		}
	}
	for k := range m.supervised {
		if k.a == a {
			sites[siteKey{k.a, k.s}] = true
		}
	}
	m.mu.Unlock()
	if mounts, err := m.mnt.mounts(); err == nil {
		for _, ov := range windowOverlays(mounts, m.layout.Root) {
			if ov.AccountID == a {
				sites[siteKey{ov.AccountID, ov.SiteID}] = true
			}
		}
	}
	for k := range sites {
		if err := m.ReleaseSite(ctx, k.a, k.s); err != nil {
			return err
		}
	}
	return m.unmountBelow(m.layout.Account(a) + "/sites/")
}

// unmountBelow unmounts the window mounts below prefix (overlays over
// releases/<n>, lower binds), deepest first. Unsupported (no mountinfo) = none.
func (m *windowManager) unmountBelow(prefix string) error {
	mounts, err := m.mnt.mounts()
	if errors.Is(err, errUnsupported) {
		return nil
	}
	if err != nil {
		return err
	}
	var targets []string
	for _, mt := range mounts {
		if !strings.HasPrefix(mt.MountPoint, prefix) {
			continue
		}
		rest := strings.TrimPrefix(mt.MountPoint, prefix)
		if strings.Contains("/"+rest+"/", "/windows/") || (mt.FSType == "overlay" && strings.Contains("/"+rest, "/releases/")) {
			if !slices.Contains(targets, mt.MountPoint) {
				targets = append(targets, mt.MountPoint)
			}
		}
	}
	slices.SortFunc(targets, func(x, y string) int { return len(y) - len(x) })
	for _, t := range targets {
		if err := m.unmountAll(t); err != nil {
			return err
		}
		slog.Info("window mount removed with its site", "target", t)
	}
	return nil
}

// ── Start: recovery and loss detection ───────────────────────────────────────

// start restores the typed watches and the supervision of the mounted rw
// windows (hostd restarted while the host kept its mounts), then checks every
// minute that the windows recorded in a state.json are still mounted.
func (m *windowManager) start(ctx context.Context) {
	go func() {
		m.restoreWatches()
		m.restoreSupervision()
		t := time.NewTicker(time.Minute)
		defer t.Stop()
		for {
			m.checkLost()
			select {
			case <-ctx.Done():
				return
			case <-t.C:
			}
		}
	}()
}

func (m *windowManager) restoreWatches() {
	b, err := os.ReadFile(filepath.FromSlash(m.watchStatePath))
	if err != nil {
		return
	}
	var recs []watchRecord
	if err := json.Unmarshal(b, &recs); err != nil {
		slog.Warn("typed watches: state file unreadable", "path", m.watchStatePath, "err", err)
		return
	}
	hub, err := m.getHub()
	if err != nil {
		slog.Warn("typed watches not restored", "err", err)
		return
	}
	for _, r := range recs {
		ws := WatchSpec{SiteSpec: SiteSpec{AccountID: r.AccountID, SiteID: r.SiteID, Slug: r.Slug, Owner: Owner{r.UID, r.GID}}, Typed: r.Typed}
		if ws.validate() != nil || validateTyped(ws.Typed) != nil {
			continue
		}
		unlock, ok := m.tryLockSite(r.AccountID, r.SiteID)
		if !ok {
			continue // the panel is already setting it
		}
		if _, err := m.startTyped(hub, ws); err != nil {
			slog.Warn("typed watch not restored", "account", r.AccountID, "site", r.SiteID, "err", err)
		}
		unlock()
	}
}

// windowStates lists every windows/<w>/state.json of the hosting root.
func (m *windowManager) windowStates() []windowState {
	var out []windowState
	accounts, err := m.openRel([]string{"accounts"})
	if err != nil {
		return nil
	}
	defer accounts.Close()
	an, _ := readNames(accounts)
	for _, as := range an {
		a, err := parseID(as)
		if err != nil {
			continue
		}
		sites, err := m.openRel(m.layout.SitesRel(a))
		if err != nil {
			continue
		}
		sn, _ := readNames(sites)
		sites.Close()
		for _, ss := range sn {
			s, err := parseID(ss)
			if err != nil {
				continue
			}
			wins, err := m.openRel(m.layout.WindowsRel(a, s))
			if err != nil {
				continue
			}
			wn, _ := readNames(wins)
			wins.Close()
			for _, ws := range wn {
				if w, err := parseID(ws); err == nil {
					if st, ok := m.readState(a, s, w); ok {
						out = append(out, st)
					}
				}
			}
		}
	}
	return out
}

func (m *windowManager) restoreSupervision() {
	mounts, err := m.mnt.mounts()
	if err != nil {
		return
	}
	for _, st := range m.windowStates() {
		ov, ok := m.findOverlay(mounts, st.AccountID, st.SiteID, st.WindowID)
		if !ok || ov.Mode != windowModeRW || !st.QuarantineExecutables {
			continue
		}
		spec := WindowSpec{WindowRef: WindowRef{st.AccountID, st.SiteID, st.WindowID, st.Slug}, Owner: Owner{st.UID, st.GID},
			ReleaseNumber: st.ReleaseNumber, Mode: windowModeRW, QuarantineExecutables: true}
		if err := spec.validate(); err != nil {
			continue
		}
		if err := m.startSupervised(spec); err != nil {
			slog.Warn("supervision not restored", "account", st.AccountID, "site", st.SiteID, "window", st.WindowID, "err", err)
		}
	}
}

// checkLost emits windowLost once for a window whose state.json says it is
// mounted while its overlay is gone (host reboot, manual umount).
func (m *windowManager) checkLost() {
	for _, st := range m.windowStates() {
		key := windowKey{st.AccountID, st.SiteID, st.WindowID}
		unlock, ok := m.tryLockSite(st.AccountID, st.SiteID)
		if !ok {
			continue // an operation is changing it right now
		}
		mounts, err := m.mnt.mounts()
		if err != nil {
			unlock()
			return
		}
		_, still := m.readState(st.AccountID, st.SiteID, st.WindowID)
		_, mounted := m.findOverlay(mounts, st.AccountID, st.SiteID, st.WindowID)
		unlock()
		if !still {
			continue // removed meanwhile
		}
		m.mu.Lock()
		already := m.lost[key]
		if mounted {
			delete(m.lost, key)
		} else {
			m.lost[key] = true
		}
		m.mu.Unlock()
		if !mounted && !already {
			slog.Warn("window overlay lost", "account", st.AccountID, "site", st.SiteID, "window", st.WindowID, "mode", st.Mode)
			m.emit(Event{Kind: eventWindowLost, AccountID: st.AccountID, SiteID: i64Ptr(st.SiteID), WindowID: i64Ptr(st.WindowID),
				Message: strPtr("overlay absent (mode " + st.Mode + ")")})
		}
	}
}
