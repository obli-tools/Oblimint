package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
)

// ─────────────────────────────────────────────────────────────────────────────
// No-follow filesystem primitives (invariant R1). hostd runs as root and the
// staging / data trees are written by tenants (PHP can create symlinks in
// data/), so a path is NEVER resolved by the kernel in one go:
//
//   - every directory is entered component by component with openDir:
//     Lstat (refuse symlinks and non-directories) → OpenRoot → Stat(".") and
//     os.SameFile against the Lstat result, so swapping the entry for a symlink
//     between the two calls is detected (lstat/open/fstat pattern);
//   - an os.Root additionally confines every name lookup to that directory;
//   - ownership and modes are applied through the opened descriptor
//     (fchown/fchmod), never by path;
//   - files are created with O_EXCL (never through an existing link) and read
//     only after the same lstat/open/fstat check (O_NOFOLLOW|O_NONBLOCK on
//     Linux, so a fifo swapped in cannot block hostd).
// ─────────────────────────────────────────────────────────────────────────────

// ownerFunc applies ownership and mode to an opened file or directory. The
// Linux default is fchown + fchmod; tests inject a recorder.
type ownerFunc func(f *os.File, o Owner, mode fs.FileMode) error

// maxTreeDepth bounds recursion in tenant-written trees.
const maxTreeDepth = 128

// openDir enters the directory name inside parent without following a symlink.
func openDir(parent *os.Root, name string) (*os.Root, error) {
	fi, err := parent.Lstat(name)
	if err != nil {
		return nil, err
	}
	if fi.Mode()&fs.ModeSymlink != 0 {
		return nil, unsafePath("%s is a symbolic link", path.Join(parent.Name(), name))
	}
	if fi.Mode().Type() != fs.ModeDir { // junctions, devices, files...
		return nil, unsafePath("%s is not a directory", path.Join(parent.Name(), name))
	}
	child, err := parent.OpenRoot(name)
	if err != nil {
		return nil, err
	}
	cfi, err := child.Stat(".")
	if err != nil {
		child.Close()
		return nil, err
	}
	if !os.SameFile(fi, cfi) {
		child.Close()
		return nil, unsafePath("%s changed during traversal", path.Join(parent.Name(), name))
	}
	return child, nil
}

// openPath enters rel (components) below base, component by component. The
// returned root is base itself (re-opened) when rel is empty.
func openPath(base *os.Root, rel []string) (*os.Root, error) {
	cur, err := base.OpenRoot(".")
	if err != nil {
		return nil, err
	}
	for _, name := range rel {
		next, err := openDir(cur, name)
		cur.Close()
		if err != nil {
			return nil, err
		}
		cur = next
	}
	return cur, nil
}

// ensureDir creates name inside parent when missing, enters it without
// following links and applies owner/mode through the descriptor.
func ensureDir(parent *os.Root, name string, o Owner, mode fs.FileMode, own ownerFunc) (*os.Root, error) {
	if err := parent.Mkdir(name, mode); err != nil && !errors.Is(err, fs.ErrExist) {
		return nil, err
	}
	dir, err := openDir(parent, name)
	if err != nil {
		return nil, err
	}
	if err := applyOwner(dir, o, mode, own); err != nil {
		dir.Close()
		return nil, fmt.Errorf("%s: %w", path.Join(parent.Name(), name), err)
	}
	return dir, nil
}

// applyOwner sets owner/mode of the directory a root points at, via its fd.
func applyOwner(dir *os.Root, o Owner, mode fs.FileMode, own ownerFunc) error {
	f, err := dir.Open(".")
	if err != nil {
		return err
	}
	defer f.Close()
	return own(f, o, mode)
}

// ensureTree creates the specs (parents first) below base. Every spec's
// parent must be an earlier spec or already exist: no implicit mkdir -p.
func ensureTree(base *os.Root, specs []dirSpec, own ownerFunc) error {
	for _, s := range specs {
		parent, err := openPath(base, s.Rel[:len(s.Rel)-1])
		if err != nil {
			return err
		}
		dir, err := ensureDir(parent, s.Rel[len(s.Rel)-1], s.Owner, fs.FileMode(s.Mode), own)
		parent.Close()
		if err != nil {
			return err
		}
		dir.Close()
	}
	return nil
}

// mkdirAll creates every component of rel below dir (mkdir -p), each one
// owned o with mode, and returns the last one.
func mkdirAll(dir *os.Root, rel []string, o Owner, mode fs.FileMode, own ownerFunc) (*os.Root, error) {
	cur, err := dir.OpenRoot(".")
	if err != nil {
		return nil, err
	}
	for _, name := range rel {
		next, err := ensureDir(cur, name, o, mode, own)
		cur.Close()
		if err != nil {
			return nil, err
		}
		cur = next
	}
	return cur, nil
}

// removeEntry removes name inside parent: a directory tree with RemoveAll
// (which never follows links), a symlink only as the link itself.
func removeEntry(parent *os.Root, name string) error {
	fi, err := parent.Lstat(name)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if fi.Mode().Type() != fs.ModeDir {
		return parent.Remove(name)
	}
	return parent.RemoveAll(name)
}

// clearDir empties a directory and keeps it. ctx is checked between the
// top-level entries (a single RemoveAll is not interruptible).
func clearDir(ctx context.Context, dir *os.Root) error {
	f, err := dir.Open(".")
	if err != nil {
		return err
	}
	entries, err := f.ReadDir(-1)
	f.Close()
	if err != nil {
		return err
	}
	for _, e := range entries {
		if err := ctx.Err(); err != nil {
			return err
		}
		if err := removeEntry(dir, e.Name()); err != nil {
			return err
		}
	}
	return nil
}

// isEmptyDir reports whether dir has no entry.
func isEmptyDir(dir *os.Root) (bool, error) {
	f, err := dir.Open(".")
	if err != nil {
		return false, err
	}
	defer f.Close()
	names, err := f.Readdirnames(1)
	if errors.Is(err, io.EOF) {
		return true, nil
	}
	return len(names) == 0, err
}

// openRegular opens name inside dir for reading, only if it is (and stays) a
// regular file. ok=false means "not a regular file, skip it".
func openRegular(dir *os.Root, name string) (f *os.File, ok bool, err error) {
	fi, err := dir.Lstat(name)
	if err != nil {
		return nil, false, err
	}
	if !fi.Mode().IsRegular() {
		return nil, false, nil
	}
	f, err = dir.OpenFile(name, os.O_RDONLY|openNoFollowFlags, 0)
	if err != nil {
		return nil, false, err
	}
	ffi, err := f.Stat()
	if err != nil {
		f.Close()
		return nil, false, err
	}
	if !ffi.Mode().IsRegular() || !os.SameFile(fi, ffi) {
		f.Close()
		return nil, false, unsafePath("%s changed during copy", path.Join(dir.Name(), name))
	}
	return f, true, nil
}

// copyTree copies regular files and directories from src into dst (seed of a
// data path). Symlinks, devices, fifos and sockets are skipped; files that
// already exist in dst are kept. Copies are owned o (files 0640, dirs 0750).
// ctx is checked between entries (the caller gave up: stop copying).
func copyTree(ctx context.Context, src, dst *os.Root, o Owner, own ownerFunc, depth int) (files int, err error) {
	if depth > maxTreeDepth {
		return 0, unsafePath("%s: tree deeper than %d levels", src.Name(), maxTreeDepth)
	}
	d, err := src.Open(".")
	if err != nil {
		return 0, err
	}
	entries, err := d.ReadDir(-1)
	d.Close()
	if err != nil {
		return 0, err
	}
	for _, e := range entries {
		if err := ctx.Err(); err != nil {
			return files, err
		}
		name := e.Name()
		switch t := e.Type(); {
		case t.IsDir():
			n, err := copyDir(ctx, src, dst, name, o, own, depth)
			files += n
			if err != nil {
				return files, err
			}
		case t.IsRegular():
			copied, err := copyFile(src, dst, name, o, own)
			if err != nil {
				return files, err
			}
			if copied {
				files++
			}
		}
	}
	return files, nil
}

func copyDir(ctx context.Context, src, dst *os.Root, name string, o Owner, own ownerFunc, depth int) (int, error) {
	s, err := openDir(src, name)
	if err != nil {
		return 0, err
	}
	defer s.Close()
	t, err := ensureDir(dst, name, o, 0o750, own)
	if err != nil {
		return 0, err
	}
	defer t.Close()
	return copyTree(ctx, s, t, o, own, depth+1)
}

func copyFile(src, dst *os.Root, name string, o Owner, own ownerFunc) (bool, error) {
	in, ok, err := openRegular(src, name)
	if err != nil || !ok {
		return false, err
	}
	defer in.Close()
	out, err := dst.OpenFile(name, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if errors.Is(err, fs.ErrExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return false, err
	}
	if err := own(out, o, 0o640); err != nil {
		out.Close()
		return false, err
	}
	return true, out.Close()
}
