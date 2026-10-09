package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"hash"
	"io"
	"io/fs"
	"log/slog"
	"os"
	"path"
	"slices"
	"unicode/utf8"
)

// ─────────────────────────────────────────────────────────────────────────────
// Window export (docs/P3-PLAN.md §4.1, §8): diff(lower, merged) restricted to
// the paths the upper layer touches, then copy of the new content into
// export/files/. Every tree is read without following a link (R1): the upper
// and merged trees are written by the tenant's application.
//
//   - whiteout (char device 0/0, or the xattr variant) ⇒ the path is deleted;
//   - directory with trusted.overlay.opaque=y or a redirect ⇒ its WHOLE
//     subtree is compared on both sides (a renamed / replaced directory);
//   - metadata-only copy (trusted.overlay.metacopy, no redirect) ⇒ content
//     unchanged: only a size / type / exec bit change makes it a modification
//     (the chown walk of an rw window creates one per entry);
//   - anything else ⇒ lower and merged entries compared by type, symlink
//     target, size, exec bit, then sha256.
// ─────────────────────────────────────────────────────────────────────────────

// upperKind is what overlayfs marked on one upper-layer entry.
type upperKind struct{ whiteout, opaque, redirect, metacopy bool }

// overlayAttrs reads the overlay markers of an upper-layer entry (fi: its
// lstat result, sub: the entered directory for a directory, rel: its path
// relative to the upper root).
type overlayAttrs interface {
	classify(parent *os.Root, name string, fi fs.FileInfo, sub *os.Root, rel string) (upperKind, error)
}

// errExportFull stops the walk once maxEntries / maxTotalBytes is reached.
var errExportFull = errors.New("export limits reached")

type exporter struct {
	ctx                  context.Context
	upper, lower, merged *os.Root
	out                  *os.Root // export/files
	attrs                overlayAttrs
	opts                 ExportOptions

	entries []DiffEntry
	res     ExportResult
	seen    map[string]bool
	dirs    map[string]bool // export dirs already created
}

// exportDiff walks the upper layer and fills out (export/files). lower and
// merged are the pristine release and the merged view.
func exportDiff(ctx context.Context, upper, lower, merged, out *os.Root, attrs overlayAttrs, opts ExportOptions) ([]DiffEntry, ExportResult, error) {
	e := &exporter{ctx: ctx, upper: upper, lower: lower, merged: merged, out: out, attrs: attrs, opts: opts,
		entries: []DiffEntry{}, seen: map[string]bool{}, dirs: map[string]bool{}}
	err := e.walkUpper(upper, lower, merged, "", 0)
	if errors.Is(err, errExportFull) {
		e.res.Truncated, err = true, nil
	}
	e.res.Entries = len(e.entries)
	return e.entries, e.res, err
}

// fileKind of an lstat result.
const (
	kindFile = iota
	kindSymlink
	kindDir
	kindSpecial
)

func kindOf(fi fs.FileInfo) int {
	switch t := fi.Mode().Type(); {
	case t == 0:
		return kindFile
	case t == fs.ModeSymlink:
		return kindSymlink
	case t == fs.ModeDir:
		return kindDir
	}
	return kindSpecial
}

func entryType(kind int) string {
	switch kind {
	case kindSymlink:
		return entrySymlink
	case kindDir:
		return entryDir
	}
	return entryFile
}

// lstatIn returns the lstat result of name in dir, nil when dir is nil or the
// entry does not exist.
func lstatIn(dir *os.Root, name string) (fs.FileInfo, error) {
	if dir == nil {
		return nil, nil
	}
	fi, err := dir.Lstat(name)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	return fi, err
}

// subdir enters name in dir when it is a real directory (nil otherwise).
func subdir(dir *os.Root, name string, fi fs.FileInfo) (*os.Root, error) {
	if dir == nil || fi == nil || !fi.IsDir() {
		return nil, nil
	}
	sub, err := openDir(dir, name)
	if errors.Is(err, fs.ErrNotExist) || errors.Is(err, errUnsafePath) {
		return nil, nil // vanished or swapped for a link: never followed
	}
	return sub, err
}

func closeRoot(r *os.Root) {
	if r != nil {
		r.Close()
	}
}

func readNames(dir *os.Root) ([]string, error) {
	if dir == nil {
		return nil, nil
	}
	f, err := dir.Open(".")
	if err != nil {
		return nil, err
	}
	defer f.Close()
	names, err := f.Readdirnames(-1)
	slices.Sort(names)
	return names, err
}

func joinRel(rel, name string) string {
	if rel == "" {
		return name
	}
	return rel + "/" + name
}

func (e *exporter) walkUpper(u, l, m *os.Root, rel string, depth int) error {
	if depth > maxWalkDepth {
		slog.Warn("window export: upper subtree deeper than the walk limit not compared", "path", rel)
		return nil
	}
	names, err := readNames(u)
	if err != nil {
		return err
	}
	for _, name := range names {
		if err := e.ctx.Err(); err != nil {
			return err
		}
		p := joinRel(rel, name)
		ufi, err := lstatIn(u, name)
		if err != nil || ufi == nil {
			if err != nil {
				return err
			}
			continue
		}
		usub, err := subdir(u, name, ufi)
		if err != nil {
			return err
		}
		err = e.upperEntry(u, l, m, usub, name, p, ufi, depth)
		closeRoot(usub)
		if err != nil {
			return err
		}
	}
	return nil
}

func (e *exporter) upperEntry(u, l, m, usub *os.Root, name, p string, ufi fs.FileInfo, depth int) error {
	k, err := e.attrs.classify(u, name, ufi, usub, p)
	if err != nil {
		return err
	}
	lfi, err := lstatIn(l, name)
	if err != nil {
		return err
	}
	mfi, err := lstatIn(m, name)
	if err != nil {
		return err
	}
	switch {
	case k.whiteout:
		return e.pair(l, m, name, p, lfi, mfi, true, depth)
	case ufi.IsDir() && (k.opaque || k.redirect):
		return e.pair(l, m, name, p, lfi, mfi, true, depth)
	case ufi.IsDir():
		if err := e.pair(l, m, name, p, lfi, mfi, false, depth); err != nil {
			return err
		}
		if usub == nil || mfi == nil || !mfi.IsDir() {
			return nil
		}
		lsub, err := subdir(l, name, lfi)
		if err != nil {
			return err
		}
		defer closeRoot(lsub)
		msub, err := subdir(m, name, mfi)
		if err != nil {
			return err
		}
		defer closeRoot(msub)
		return e.walkUpper(usub, lsub, msub, p, depth+1)
	case ufi.Mode().IsRegular() && k.metacopy && !k.redirect:
		// Metadata-only copy-up: the data is the lower one.
		if lfi != nil && mfi != nil && kindOf(lfi) == kindFile && kindOf(mfi) == kindFile &&
			lfi.Size() == mfi.Size() && execBit(lfi) == execBit(mfi) {
			return nil
		}
		return e.pair(l, m, name, p, lfi, mfi, true, depth)
	default:
		return e.pair(l, m, name, p, lfi, mfi, true, depth)
	}
}

func execBit(fi fs.FileInfo) bool { return fi.Mode().Perm()&0o111 != 0 }

// pair compares one path on both sides (lfi / mfi nil = absent). deep: when a
// side is a directory, its whole subtree is compared too.
func (e *exporter) pair(l, m *os.Root, name, p string, lfi, mfi fs.FileInfo, deep bool, depth int) error {
	switch {
	case lfi == nil && mfi == nil:
		return nil
	case lfi == nil:
		return e.added(m, name, p, mfi, changeAdded, deep, depth)
	case mfi == nil:
		return e.deleted(l, name, p, lfi, depth)
	}
	lk, mk := kindOf(lfi), kindOf(mfi)
	if lk != mk {
		if lk == kindDir {
			if err := e.deletedChildren(l, name, p, lfi, depth); err != nil {
				return err
			}
		}
		return e.added(m, name, p, mfi, changeTypechange, deep, depth)
	}
	switch lk {
	case kindDir:
		if !deep {
			return nil
		}
		return e.bothDirs(l, m, name, p, lfi, mfi, depth)
	case kindSymlink:
		lt, err := l.Readlink(name)
		if err != nil {
			return ignoreVanished(err)
		}
		mt, err := m.Readlink(name)
		if err != nil {
			return ignoreVanished(err)
		}
		if lt == mt {
			return nil
		}
		return e.content(m, name, p, mfi, changeModified)
	case kindFile:
		if lfi.Size() == mfi.Size() && execBit(lfi) == execBit(mfi) {
			same, err := sameContent(l, m, name)
			if err != nil || same {
				return ignoreVanished(err)
			}
		}
		return e.content(m, name, p, mfi, changeModified)
	}
	return nil // two special files: nothing to publish
}

func ignoreVanished(err error) error {
	if errors.Is(err, fs.ErrNotExist) || errors.Is(err, errUnsafePath) {
		return nil
	}
	return err
}

// bothDirs compares the union of the children of two directories.
func (e *exporter) bothDirs(l, m *os.Root, name, p string, lfi, mfi fs.FileInfo, depth int) error {
	if depth > maxWalkDepth {
		return nil
	}
	lsub, err := subdir(l, name, lfi)
	if err != nil {
		return err
	}
	defer closeRoot(lsub)
	msub, err := subdir(m, name, mfi)
	if err != nil {
		return err
	}
	defer closeRoot(msub)
	ln, err := readNames(lsub)
	if err != nil {
		return err
	}
	mn, err := readNames(msub)
	if err != nil {
		return err
	}
	names := append(ln, mn...)
	slices.Sort(names)
	names = slices.Compact(names)
	for _, n := range names {
		if err := e.ctx.Err(); err != nil {
			return err
		}
		lc, err := lstatIn(lsub, n)
		if err != nil {
			return err
		}
		mc, err := lstatIn(msub, n)
		if err != nil {
			return err
		}
		if err := e.pair(lsub, msub, n, joinRel(p, n), lc, mc, true, depth+1); err != nil {
			return err
		}
	}
	return nil
}

// added reports a new entry (change added / typechange); a directory only
// through its content (git has no directories) unless it is a typechange.
func (e *exporter) added(m *os.Root, name, p string, mfi fs.FileInfo, change string, deep bool, depth int) error {
	if kindOf(mfi) != kindDir {
		return e.content(m, name, p, mfi, change)
	}
	if change == changeTypechange {
		if err := e.emit(DiffEntry{Path: p, Change: change, Type: entryDir}); err != nil {
			return err
		}
	}
	if !deep || depth > maxWalkDepth {
		return nil
	}
	sub, err := subdir(m, name, mfi)
	if err != nil || sub == nil {
		return err
	}
	defer sub.Close()
	names, err := readNames(sub)
	if err != nil {
		return err
	}
	for _, n := range names {
		fi, err := lstatIn(sub, n)
		if err != nil {
			return err
		}
		if fi == nil {
			continue
		}
		if err := e.added(sub, n, joinRel(p, n), fi, changeAdded, true, depth+1); err != nil {
			return err
		}
	}
	return nil
}

// deleted reports a removed entry; a directory as one 'dir' entry + its content.
func (e *exporter) deleted(l *os.Root, name, p string, lfi fs.FileInfo, depth int) error {
	if err := e.emit(DiffEntry{Path: p, Change: changeDeleted, Type: entryType(kindOf(lfi))}); err != nil {
		return err
	}
	if kindOf(lfi) != kindDir {
		return nil
	}
	return e.deletedChildren(l, name, p, lfi, depth)
}

func (e *exporter) deletedChildren(l *os.Root, name, p string, lfi fs.FileInfo, depth int) error {
	if depth > maxWalkDepth {
		return nil
	}
	sub, err := subdir(l, name, lfi)
	if err != nil || sub == nil {
		return err
	}
	defer sub.Close()
	names, err := readNames(sub)
	if err != nil {
		return err
	}
	for _, n := range names {
		fi, err := lstatIn(sub, n)
		if err != nil {
			return err
		}
		if fi == nil {
			continue
		}
		if err := e.deleted(sub, n, joinRel(p, n), fi, depth+1); err != nil {
			return err
		}
	}
	return nil
}

// emit appends an entry (once per path) within maxEntries.
func (e *exporter) emit(d DiffEntry) error {
	if !utf8.ValidString(d.Path) {
		slog.Warn("window export: path is not valid UTF-8, not exported", "path", d.Path)
		return nil
	}
	if e.seen[d.Path] {
		return nil
	}
	if len(e.entries) >= e.opts.MaxEntries {
		return errExportFull
	}
	e.seen[d.Path] = true
	e.entries = append(e.entries, d)
	switch d.Change {
	case changeAdded:
		e.res.Added++
	case changeDeleted:
		e.res.Deleted++
	default:
		e.res.Modified++
	}
	return nil
}

// content reports an added / modified / typechanged file or symlink and copies
// its new content into the export.
func (e *exporter) content(m *os.Root, name, p string, mfi fs.FileInfo, change string) error {
	if e.seen[p] || !utf8.ValidString(p) {
		return e.emit(DiffEntry{Path: p, Change: change, Type: entryFile}) // logs / dedupes
	}
	switch kindOf(mfi) {
	case kindSymlink:
		target, err := m.Readlink(name)
		if err != nil {
			return ignoreVanished(err)
		}
		exported := e.writeLink(p, target) == nil
		return e.emit(DiffEntry{Path: p, Change: change, Type: entrySymlink, LinkTarget: &target, Exported: exported})
	case kindFile:
		return e.file(m, name, p, mfi, change)
	}
	return e.emit(DiffEntry{Path: p, Change: change, Type: entryFile, Skipped: strPtr(skipSpecial)})
}

func (e *exporter) file(m *os.Root, name, p string, mfi fs.FileInfo, change string) error {
	if len(e.entries) >= e.opts.MaxEntries {
		return errExportFull
	}
	f, ok, err := openRegular(m, name)
	if err != nil || !ok {
		return ignoreVanished(err)
	}
	defer f.Close()
	mode := int(mfi.Mode().Perm())
	if mfi.Size() > e.opts.MaxFileBytes {
		h := sha256.New()
		n, err := io.Copy(h, f)
		if err != nil {
			return err
		}
		sum := hex.EncodeToString(h.Sum(nil))
		return e.emit(DiffEntry{Path: p, Change: change, Type: entryFile, Size: &n, Mode: &mode, SHA256: &sum, Skipped: strPtr(skipTooLarge)})
	}
	if e.res.Bytes+mfi.Size() > e.opts.MaxTotalBytes {
		return errExportFull
	}
	n, sum, err := e.writeFile(p, f, execBit(mfi))
	if err != nil {
		return err
	}
	e.res.Bytes += n
	return e.emit(DiffEntry{Path: p, Change: change, Type: entryFile, Size: &n, Mode: &mode, SHA256: &sum, Exported: true})
}

// outParent creates (root 0700, never through a link) and enters the export
// directory of p.
func (e *exporter) outParent(p string) (*os.Root, string, error) {
	segs, ok := splitRelPath(p)
	if !ok {
		return nil, "", badRequest("invalid export path %q", p)
	}
	cur, err := e.out.OpenRoot(".")
	if err != nil {
		return nil, "", err
	}
	for i, s := range segs[:len(segs)-1] {
		dirRel := path.Join(segs[:i+1]...)
		if !e.dirs[dirRel] {
			if err := cur.Mkdir(s, 0o700); err != nil && !errors.Is(err, fs.ErrExist) {
				cur.Close()
				return nil, "", err
			}
			e.dirs[dirRel] = true
		}
		next, err := openDir(cur, s)
		cur.Close()
		if err != nil {
			return nil, "", err
		}
		cur = next
	}
	return cur, segs[len(segs)-1], nil
}

// writeFile copies one exported file (root 0600, or 0700 when the source has
// an exec bit: the staging apply reads the exec bit from the export file).
func (e *exporter) writeFile(p string, in io.Reader, exec bool) (int64, string, error) {
	dir, name, err := e.outParent(p)
	if err != nil {
		return 0, "", err
	}
	defer dir.Close()
	perm := fs.FileMode(0o600)
	if exec {
		perm = 0o700
	}
	out, err := dir.OpenFile(name, os.O_WRONLY|os.O_CREATE|os.O_EXCL, perm)
	if err != nil {
		return 0, "", err
	}
	if exec {
		// The umask may have cleared the bit: set through the descriptor.
		if err := out.Chmod(perm); err != nil {
			out.Close()
			return 0, "", err
		}
	}
	h := sha256.New()
	n, err := io.Copy(io.MultiWriter(out, h), in)
	if cerr := out.Close(); err == nil {
		err = cerr
	}
	return n, hex.EncodeToString(h.Sum(nil)), err
}

func (e *exporter) writeLink(p, target string) error {
	dir, name, err := e.outParent(p)
	if err != nil {
		return err
	}
	defer dir.Close()
	if err := dir.Symlink(target, name); err != nil {
		slog.Warn("window export: symlink not recreated", "path", p, "err", err)
		return err
	}
	return nil
}

// sameContent compares the sha256 of name in two directories (regular files).
func sameContent(a, b *os.Root, name string) (bool, error) {
	ha, err := hashIn(a, name)
	if err != nil {
		return false, err
	}
	hb, err := hashIn(b, name)
	if err != nil {
		return false, err
	}
	return ha == hb, nil
}

// hashIn returns the sha256 of a regular file (errUnsafePath when name is not one).
func hashIn(dir *os.Root, name string) (string, error) {
	f, ok, err := openRegular(dir, name)
	if err != nil {
		return "", err
	}
	if !ok {
		return "", unsafePath("%s is not a regular file", name)
	}
	defer f.Close()
	return hashReader(f, sha256.New())
}

func newSHA256() hash.Hash { return sha256.New() }

func hashReader(r io.Reader, h hash.Hash) (string, error) {
	if _, err := io.Copy(h, r); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}
