package main

import (
	"errors"
	"io"
	"io/fs"
	"log/slog"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// ─────────────────────────────────────────────────────────────────────────────
// Recursive watches (docs/P3-PLAN.md §8): typed data paths (data/<slug>/<path>)
// and supervised windows (windows/<w>/upper). One kernel notifier (inotify,
// inotify_linux.go) is shared by every watch: the default per-user limit of
// inotify instances (128) would not cover one per site. Each watch has its
// own goroutine and queue; a full queue or IN_Q_OVERFLOW triggers a rescan.
// ─────────────────────────────────────────────────────────────────────────────

// Event bits (inotify values: the Linux notifier passes them through).
const (
	evCloseWrite uint32 = 0x00000008
	evMovedFrom  uint32 = 0x00000040
	evMovedTo    uint32 = 0x00000080
	evCreate     uint32 = 0x00000100
	evDeleteSelf uint32 = 0x00000400
	evOverflow   uint32 = 0x00004000
	evIgnored    uint32 = 0x00008000
	evIsDir      uint32 = 0x40000000
)

type fsEvent struct {
	wd   int
	mask uint32
	name string
}

// notifyHub is the shared kernel notifier.
type notifyHub interface {
	// add watches the opened directory dir for w and returns the watch
	// descriptor (the same directory watched twice gives the same wd).
	add(dir *os.Root, w *treeWatch) (int, error)
	// remove drops w's interest in wd.
	remove(wd int, w *treeWatch)
}

// entryFunc handles one non-directory entry found by an event (mask) or a scan
// (mask 0) and reports whether it was quarantined.
type entryFunc func(root *os.Root, rel string, mask uint32) bool

// treeWatch watches a directory tree recursively.
type treeWatch struct {
	name    string // logs
	hub     notifyHub
	open    func() (*os.Root, error) // the watched root, entered without following links
	onEntry entryFunc
	every   time.Duration // periodic rescan (0 = never)
	// scanned (optional) runs once the first scan is done, before any event
	// is handled (supervised windows: end of the baseline).
	scanned func()

	root  *os.Root
	dirs  map[int]string // wd → directory relative to the root
	queue chan fsEvent
	lost  atomic.Bool
	stopc chan struct{}
	done  chan struct{}
	once  sync.Once
}

const watchQueueSize = 4096

func newTreeWatch(name string, hub notifyHub, open func() (*os.Root, error), onEntry entryFunc, every time.Duration) *treeWatch {
	return &treeWatch{name: name, hub: hub, open: open, onEntry: onEntry, every: every,
		dirs: map[int]string{}, queue: make(chan fsEvent, watchQueueSize), stopc: make(chan struct{}), done: make(chan struct{})}
}

// errWatchStopped aborts a scan once stop() was called.
var errWatchStopped = errors.New("watch stopped")

// start scans the tree once (synchronously: the count of quarantined files is
// returned) then follows the events in the background.
//
// Ownership: dirs and root belong to the goroutine running the watch (start,
// then loop); only that goroutine releases them (never stop(): a concurrent
// map iteration and write is a fatal runtime error).
func (w *treeWatch) start() (int, error) {
	n, err := w.rescan()
	if err != nil {
		w.release()
		close(w.done)
		return n, err
	}
	if w.scanned != nil {
		w.scanned()
	}
	go w.loop()
	return n, nil
}

// stop asks the watch to end and waits for it: scans check stopc between
// entries, so the wait is bounded by one entry check (one sniff at most).
func (w *treeWatch) stop() {
	w.once.Do(func() { close(w.stopc) })
	t := time.NewTimer(5 * time.Second)
	defer t.Stop()
	select {
	case <-w.done:
		return
	case <-t.C:
		slog.Warn("watch: still busy at stop, waiting", "watch", w.name)
	}
	<-w.done
}

func (w *treeWatch) stopped() bool {
	select {
	case <-w.stopc:
		return true
	default:
		return false
	}
}

func (w *treeWatch) release() {
	for wd := range w.dirs {
		w.hub.remove(wd, w)
	}
	w.dirs = map[int]string{}
	if w.root != nil {
		w.root.Close()
		w.root = nil
	}
}

// deliver is called by the hub (never blocks: a full queue means a rescan).
func (w *treeWatch) deliver(ev fsEvent) {
	select {
	case w.queue <- ev:
	default:
		w.lost.Store(true)
	}
}

func (w *treeWatch) loop() {
	defer close(w.done)
	defer w.release()
	var tick <-chan time.Time
	if w.every > 0 {
		t := time.NewTicker(w.every)
		defer t.Stop()
		tick = t.C
	}
	for {
		select {
		case <-w.stopc:
			return
		case ev := <-w.queue:
			w.handleEvent(ev)
		case <-tick:
			w.lost.Store(true)
		}
		if w.stopped() {
			return
		}
		if w.lost.Swap(false) {
			if _, err := w.rescan(); err != nil && !errors.Is(err, errWatchStopped) {
				slog.Warn("watch: rescan failed", "watch", w.name, "err", err)
			}
		}
	}
}

// rescan re-opens the root, re-adds every watch and checks every entry.
func (w *treeWatch) rescan() (int, error) {
	root, err := w.open()
	if err != nil {
		return 0, err
	}
	old := w.dirs
	if w.root != nil {
		w.root.Close()
	}
	w.root, w.dirs = root, map[int]string{}
	n, err := w.addTree("", 0)
	for wd := range old {
		if _, kept := w.dirs[wd]; !kept {
			w.hub.remove(wd, w)
		}
	}
	return n, err
}

// addTree watches the directory rel and everything below, checking files.
func (w *treeWatch) addTree(rel string, depth int) (int, error) {
	if depth > maxWalkDepth {
		return 0, nil
	}
	if w.stopped() {
		return 0, errWatchStopped
	}
	var dir *os.Root
	var err error
	if rel == "" {
		dir, err = w.root.OpenRoot(".")
	} else {
		segs, ok := splitRelPath(rel)
		if !ok {
			return 0, nil
		}
		dir, err = openPath(w.root, segs)
	}
	if errors.Is(err, fs.ErrNotExist) || errors.Is(err, errUnsafePath) {
		return 0, nil // vanished or swapped for a link meanwhile
	}
	if err != nil {
		return 0, err
	}
	defer dir.Close()
	wd, err := w.hub.add(dir, w)
	if err != nil {
		return 0, err
	}
	w.dirs[wd] = rel
	names, err := readNames(dir)
	if err != nil {
		return 0, ignoreVanished(err)
	}
	n := 0
	for _, name := range names {
		if w.stopped() {
			return n, errWatchStopped
		}
		fi, err := lstatIn(dir, name)
		if err != nil || fi == nil {
			continue
		}
		p := joinRel(rel, name)
		if fi.IsDir() {
			c, err := w.addTree(p, depth+1)
			n += c
			if err != nil {
				return n, err
			}
			continue
		}
		if w.onEntry(w.root, p, 0) {
			n++
		}
	}
	return n, nil
}

func (w *treeWatch) handleEvent(ev fsEvent) {
	if ev.mask&evOverflow != 0 {
		w.lost.Store(true)
		return
	}
	rel, ok := w.dirs[ev.wd]
	if !ok {
		return
	}
	if ev.mask&evIgnored != 0 {
		delete(w.dirs, ev.wd)
		if rel == "" {
			w.lost.Store(true) // the root itself went away: re-open it
		}
		return
	}
	if ev.name == "" {
		return
	}
	p := joinRel(rel, ev.name)
	switch {
	case ev.mask&evIsDir != 0 && ev.mask&(evCreate|evMovedTo) != 0:
		if _, err := w.addTree(p, strings.Count(p, "/")+1); err != nil && !errors.Is(err, errWatchStopped) {
			slog.Warn("watch: new directory not watched", "watch", w.name, "path", p, "err", err)
			w.lost.Store(true)
		}
	case ev.mask&evIsDir != 0 && ev.mask&evMovedFrom != 0:
		// The watches below keep their old relative paths: rebuild them.
		w.lost.Store(true)
	case ev.mask&evIsDir == 0 && ev.mask&(evCreate|evCloseWrite|evMovedTo) != 0:
		w.onEntry(w.root, p, ev.mask)
	}
}

// ── Typed data paths ─────────────────────────────────────────────────────────

// sftpgoUploadPrefix: SFTPGo atomic uploads write a temp file renamed at the
// end (checked at IN_MOVED_TO, or by a scan once it is older than an hour).
const sftpgoUploadPrefix = ".sftpgo-upload."

// typedSink checks the files of one typed path (root = data/<slug>/<path>).
type typedSink struct {
	m         *windowManager
	accountID int64
	siteID    int64
	slug      string
	dataPath  string
	allowed   map[string]bool
	// nested: other typed paths below this one, relative to it (their own
	// watch decides for their files).
	nested []string

	mu   sync.Mutex
	seen map[string]fileStamp // conforming files already checked (rescans)
}

// fileStamp identifies one state of an entry: the ctime cannot be set from
// userspace (utime / archive extraction only set the mtime).
type fileStamp struct {
	size  int64
	mtime time.Time
	ctime time.Time
}

func stampOf(fi fs.FileInfo) fileStamp { return fileStamp{fi.Size(), fi.ModTime(), changeTime(fi)} }

func (t *typedSink) inNested(rel string) bool {
	for _, n := range t.nested {
		if rel == n || strings.HasPrefix(rel, n+"/") {
			return true
		}
	}
	return false
}

// check classifies one entry; non-conforming ⇒ moved into the quarantine.
func (t *typedSink) check(root *os.Root, rel string, mask uint32) bool {
	if t.inNested(rel) {
		return false
	}
	segs, ok := splitRelPath(rel)
	if !ok {
		return false
	}
	parent, err := openPath(root, segs[:len(segs)-1])
	if err != nil {
		return false // vanished / swapped: the next event or scan sees it
	}
	defer parent.Close()
	name := segs[len(segs)-1]
	fi, err := parent.Lstat(name)
	if err != nil || fi.IsDir() {
		return false
	}
	if strings.HasPrefix(name, sftpgoUploadPrefix) && (mask != 0 || t.m.now().Sub(fi.ModTime()) < time.Hour) {
		return false
	}
	var v verdict
	var sum string
	if kindOf(fi) != kindFile {
		v = verdict{Reason: reasonSpecial, Detail: specialName(fi), DetectedType: specialName(fi)}
	} else {
		_, _, linked := fileUsage(parent, name, fi)
		// A plain creation is checked when written (IN_CLOSE_WRITE); a hard
		// link only produces IN_CREATE.
		if mask&evCreate != 0 && mask&(evCloseWrite|evMovedTo) == 0 && !linked {
			return false
		}
		stamp := stampOf(fi)
		t.mu.Lock()
		prev, known := t.seen[rel]
		t.mu.Unlock()
		if mask == 0 && known && prev == stamp {
			return false // unchanged since the last check
		}
		v, sum, err = sniffFile(parent, name, fi, t.allowed)
		if err != nil {
			return false
		}
		if v.ok() {
			t.mu.Lock()
			t.seen[rel] = stamp
			t.mu.Unlock()
			return false
		}
		path := joinRel(t.dataPath, rel)
		if t.m.quarantine.allowed(t.accountID, allowEntry{Area: areaData, Slug: t.slug, Path: path, SHA256: sum}) {
			return false
		}
	}
	t.mu.Lock()
	delete(t.seen, rel)
	t.mu.Unlock()
	path := joinRel(t.dataPath, rel)
	e := QuarantineEntry{
		AccountID: t.accountID, SiteID: i64Ptr(t.siteID), Slug: strPtr(t.slug),
		Source: sourceTyped, Area: areaData, Path: path, DataPath: strPtr(t.dataPath),
		Reason: v.Reason, Detail: optStr(v.Detail), DetectedType: optStr(v.DetectedType),
	}
	e, err = t.m.quarantine.moveIn(t.accountID, parent, name, e)
	if err != nil {
		slog.Warn("typed path: quarantine failed", "account", t.accountID, "site", t.siteID, "path", path, "err", err)
		t.m.emit(Event{Kind: eventWatchError, AccountID: t.accountID, SiteID: i64Ptr(t.siteID), Message: strPtr("quarantaine impossible : " + path)})
		return false
	}
	slog.Warn("typed path: file quarantined", "account", t.accountID, "site", t.siteID, "path", path, "reason", e.Reason, "entry", e.ID)
	t.m.emit(Event{Kind: eventQuarantined, AccountID: t.accountID, SiteID: i64Ptr(t.siteID), EntryID: strPtr(e.ID),
		Message: strPtr(e.Reason + " : " + path)})
	return true
}

func specialName(fi fs.FileInfo) string {
	switch t := fi.Mode().Type(); {
	case t&fs.ModeSymlink != 0:
		return "symlink"
	case t&fs.ModeNamedPipe != 0:
		return "fifo"
	case t&fs.ModeSocket != 0:
		return "socket"
	case t&fs.ModeDevice != 0:
		return "device"
	}
	return "special"
}

// sniffFile reads a regular file (whole up to 32 MiB, else its first and last
// MiB) and classifies it; sum is its sha256 (computed only when it does not
// conform: the allow-list key).
func sniffFile(dir *os.Root, name string, fi fs.FileInfo, allowed map[string]bool) (verdict, string, error) {
	f, ok, err := openRegular(dir, name)
	if err != nil || !ok {
		if err == nil {
			err = unsafePath("%s is not a regular file", name)
		}
		return verdict{}, "", err
	}
	defer f.Close()
	var head, tail []byte
	if fi.Size() <= sniffWholeLimit {
		head, err = io.ReadAll(io.LimitReader(f, sniffWholeLimit))
	} else {
		head = make([]byte, sniffEdgeBytes)
		var n int
		n, err = f.ReadAt(head, 0)
		head = head[:n]
		if err == nil || errors.Is(err, io.EOF) {
			tail = make([]byte, sniffEdgeBytes)
			n, err = f.ReadAt(tail, fi.Size()-sniffEdgeBytes)
			tail = tail[:n]
		}
		if errors.Is(err, io.EOF) {
			err = nil
		}
	}
	if err != nil {
		return verdict{}, "", err
	}
	v := classifyTyped(name, head, tail, allowed)
	if v.ok() {
		return v, "", nil
	}
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return v, "", err
	}
	sum, err := hashReader(f, newSHA256())
	return v, sum, err
}

// ── Supervised windows ───────────────────────────────────────────────────────

// supervisedSink reverts every executable write of a supervised window
// (root = windows/<w>/upper, paths relative to the release root).
type supervisedSink struct {
	m             *windowManager
	ref           WindowRef
	owner         Owner
	releaseNumber int64

	mu      sync.Mutex
	writing map[string]bool // temp names hostd is writing (its own events)
	// baseline: the upper entries present when the supervision (re)started.
	// They were written while executables were allowed (allowance, plain rw
	// mode) or while hostd was down: the window analysis judges them, the
	// supervision never reverts them. Scans (mask 0) only act on entries
	// that are new or changed (size / mtime / ctime) since then; events
	// always do.
	baseline  map[string]fileStamp
	baselined bool // the first scan is over
}

// endBaseline is the treeWatch "scanned" hook.
func (s *supervisedSink) endBaseline() {
	s.mu.Lock()
	s.baselined = true
	s.mu.Unlock()
}

func (s *supervisedSink) check(upper *os.Root, rel string, mask uint32) bool {
	segs, ok := splitRelPath(rel)
	if !ok {
		return false
	}
	s.mu.Lock()
	own := s.writing[rel]
	s.mu.Unlock()
	if own {
		return false
	}
	uparent, err := openPath(upper, segs[:len(segs)-1])
	if err != nil {
		return false
	}
	defer uparent.Close()
	name := segs[len(segs)-1]
	ufi, err := uparent.Lstat(name)
	if err != nil || ufi.IsDir() {
		return false
	}
	if mask == 0 {
		stamp := stampOf(ufi)
		s.mu.Lock()
		if !s.baselined {
			if s.baseline == nil {
				s.baseline = map[string]fileStamp{}
			}
			s.baseline[rel] = stamp
			s.mu.Unlock()
			return false
		}
		prev, known := s.baseline[rel]
		s.mu.Unlock()
		if known && prev == stamp {
			return false // unchanged since the supervision started
		}
	}
	k, err := s.m.attrs.classify(uparent, name, ufi, nil, rel)
	if err != nil || k.whiteout || (k.metacopy && !k.redirect) {
		return false // a deletion, or a metadata-only copy (same content)
	}
	switch kindOf(ufi) {
	case kindFile:
		if !isExecutableName(name) {
			head, err := readHead(uparent, name, 64)
			if err != nil || !startsExecutable(head) {
				return false
			}
		}
	case kindSymlink:
		if !isExecutableName(name) {
			return false
		}
	default:
		return false
	}
	return s.quarantineAndRevert(segs) == nil
}

func readHead(dir *os.Root, name string, n int) ([]byte, error) {
	f, ok, err := openRegular(dir, name)
	if err != nil || !ok {
		if err == nil {
			err = unsafePath("%s is not a regular file", name)
		}
		return nil, err
	}
	defer f.Close()
	return io.ReadAll(io.LimitReader(f, int64(n)))
}

func (s *supervisedSink) quarantineAndRevert(segs []string) error {
	ref := s.ref
	rel := strings.Join(segs, "/")
	name := segs[len(segs)-1]
	merged, err := s.m.openRel(s.m.layout.ReleaseRel(ref.AccountID, ref.SiteID, s.releaseNumber))
	if err != nil {
		return err
	}
	defer merged.Close()
	lower, err := s.m.openRel(s.m.layout.WindowLowerRel(ref.AccountID, ref.SiteID, ref.WindowID))
	if err != nil {
		return err
	}
	defer lower.Close()
	mparent, err := openPath(merged, segs[:len(segs)-1])
	if err != nil {
		return err
	}
	defer mparent.Close()
	mfi, err := mparent.Lstat(name)
	if err != nil {
		return err
	}
	lparent, err := openPath(lower, segs[:len(segs)-1])
	if err != nil && !errors.Is(err, fs.ErrNotExist) && !errors.Is(err, errUnsafePath) {
		return err
	}
	var lfi fs.FileInfo
	if lparent != nil {
		defer lparent.Close()
		lfi, _ = lstatIn(lparent, name)
	}
	// Content of the merged entry (its sha256: allow-list key, no-op check).
	var sum string
	if kindOf(mfi) == kindFile {
		if sum, err = hashIn(mparent, name); err != nil {
			return err
		}
		if lfi != nil && kindOf(lfi) == kindFile {
			if lsum, err := hashIn(lparent, name); err == nil && lsum == sum {
				return errNothingToDo // same as the release (our own revert)
			}
		}
	} else {
		target, err := mparent.Readlink(name)
		if err != nil {
			return err
		}
		sum, _ = hashReader(strings.NewReader(target), newSHA256())
	}
	if s.m.quarantine.allowed(ref.AccountID, allowEntry{Area: areaCode, Slug: ref.Slug, Path: rel, SHA256: sum}) {
		return errNothingToDo
	}
	e := QuarantineEntry{
		AccountID: ref.AccountID, SiteID: i64Ptr(ref.SiteID), Slug: strPtr(ref.Slug),
		Source: sourceSupervised, Area: areaCode, Path: rel,
		Reason: reasonExecutableWrite, Detail: strPtr("fenêtre supervisée #" + id(ref.WindowID)),
	}
	if kindOf(mfi) == kindFile {
		f, ok, err := openRegular(mparent, name)
		if err != nil || !ok {
			return ignoreVanished(err)
		}
		e, err = s.m.quarantine.copyIn(ref.AccountID, f, mfi, e)
		f.Close()
		if err != nil {
			return err
		}
	} else {
		// A symlink: stored as a symlink (copyEntry never follows it).
		e, err = s.m.quarantine.copyLinkIn(ref.AccountID, mparent, name, mfi, e)
		if err != nil {
			return err
		}
	}
	if err := s.revert(mparent, lparent, name, rel, lfi); err != nil {
		slog.Error("supervised window: executable quarantined but NOT reverted", "account", ref.AccountID, "site", ref.SiteID, "path", rel, "err", err)
		s.m.emit(Event{Kind: eventWatchError, AccountID: ref.AccountID, SiteID: i64Ptr(ref.SiteID), WindowID: i64Ptr(ref.WindowID),
			Message: strPtr("annulation impossible : " + rel)})
	}
	slog.Warn("supervised window: executable write quarantined", "account", ref.AccountID, "site", ref.SiteID, "path", rel, "entry", e.ID)
	s.m.emit(Event{Kind: eventQuarantined, AccountID: ref.AccountID, SiteID: i64Ptr(ref.SiteID), WindowID: i64Ptr(ref.WindowID),
		EntryID: strPtr(e.ID), Message: strPtr(reasonExecutableWrite + " : " + rel)})
	return nil
}

var errNothingToDo = errors.New("nothing to do")

// revert puts the release content back through the merged view (the lower
// layer itself is never written, M1): the lower file is copied over the
// entry, or the entry is removed when the release had none.
func (s *supervisedSink) revert(mparent, lparent *os.Root, name, rel string, lfi fs.FileInfo) error {
	if lfi == nil {
		return removeEntry(mparent, name)
	}
	tmp, err := applyTmpName()
	if err != nil {
		return err
	}
	tmpRel := joinRel(parentRel(rel), tmp)
	s.mu.Lock()
	s.writing[tmpRel] = true
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		delete(s.writing, tmpRel)
		s.mu.Unlock()
	}()
	if err := copyEntry(lparent, name, mparent, tmp, lfi); err != nil {
		_ = mparent.Remove(tmp)
		return err
	}
	if kindOf(lfi) == kindFile {
		f, ok, err := openRegular(mparent, tmp)
		if err == nil && ok {
			err = s.m.own(f, s.owner, lfi.Mode().Perm())
			f.Close()
		}
		if err != nil {
			_ = mparent.Remove(tmp)
			return err
		}
	} else if err := s.m.lchown(mparent, tmp, s.owner); err != nil {
		_ = mparent.Remove(tmp)
		return err
	}
	if fi, err := mparent.Lstat(name); err == nil && fi.IsDir() {
		_ = mparent.Remove(tmp)
		return unsafePath("%s became a directory", rel)
	}
	return mparent.Rename(tmp, name)
}

func parentRel(rel string) string {
	if i := strings.LastIndexByte(rel, '/'); i >= 0 {
		return rel[:i]
	}
	return ""
}
