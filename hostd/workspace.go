package main

import (
	"context"
	"errors"
	"io"
	"io/fs"
	"log/slog"
	"os"
)

// ─────────────────────────────────────────────────────────────────────────────
// Adapter workspaces (docs/P3-PLAN.md §4, §11): a copy of a release in
// sites/<s>/work/<id>/tree, owned by the account uid (the tools container
// writes into it). Files are cloned (FICLONE: XFS reflink, no data copied)
// when the filesystem allows it, copied otherwise. The source is root-owned
// (a release), the tree is tenant-written once the tools ran: it is removed
// without following any link.
// ─────────────────────────────────────────────────────────────────────────────

// cloneFunc clones src into dst (reflink); any error = fall back to a copy.
type cloneFunc func(dst, src *os.File) error

type treeCopier struct {
	ctx     context.Context
	owner   Owner
	own     ownerFunc
	lchown  lchownFunc
	clone   cloneFunc
	files   int64
	bytes   int64
	noClone bool // the first clone failed: do not try again
}

// copyTree copies src into dst (dirs 0755, files 0644/0755, symlinks
// recreated as they are, everything owned owner; fifos / sockets / devices
// skipped).
func (c *treeCopier) copyTree(src, dst *os.Root, depth int) error {
	if depth > maxWalkDepth {
		return unsafePath("%s: tree deeper than %d levels", src.Name(), maxWalkDepth)
	}
	names, err := readNames(src)
	if err != nil {
		return err
	}
	for _, name := range names {
		if err := c.ctx.Err(); err != nil {
			return err
		}
		fi, err := lstatIn(src, name)
		if err != nil {
			return err
		}
		if fi == nil {
			continue
		}
		switch kindOf(fi) {
		case kindDir:
			s, err := subdir(src, name, fi)
			if err != nil || s == nil {
				return err
			}
			d, err := ensureDir(dst, name, c.owner, 0o755, c.own)
			if err != nil {
				s.Close()
				return err
			}
			err = c.copyTree(s, d, depth+1)
			s.Close()
			d.Close()
			if err != nil {
				return err
			}
		case kindFile:
			if err := c.copyFile(src, dst, name, fi); err != nil {
				return err
			}
		case kindSymlink:
			target, err := src.Readlink(name)
			if err != nil {
				return err
			}
			if err := dst.Symlink(target, name); err != nil {
				return err
			}
			if err := c.lchown(dst, name, c.owner); err != nil {
				return err
			}
			c.files++
		}
	}
	return nil
}

func (c *treeCopier) copyFile(src, dst *os.Root, name string, fi fs.FileInfo) error {
	in, ok, err := openRegular(src, name)
	if err != nil || !ok {
		return ignoreVanished(err)
	}
	defer in.Close()
	out, err := dst.OpenFile(name, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	cloned := false
	if !c.noClone && c.clone != nil {
		if cerr := c.clone(out, in); cerr == nil {
			cloned = true
		} else {
			c.noClone = true
			slog.Info("workspace: reflink unavailable, copying data", "err", cerr)
		}
	}
	var n int64 = fi.Size()
	if !cloned {
		n, err = io.Copy(out, in)
	}
	if err == nil {
		mode := fs.FileMode(0o644)
		if execBit(fi) {
			mode = 0o755
		}
		err = c.own(out, c.owner, mode)
	}
	if cerr := out.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return err
	}
	c.files++
	c.bytes += n
	return nil
}

// removeTree removes name in parent (a tenant-written tree) without following
// links; missing is fine.
func removeTree(parent *os.Root, name string) error {
	err := removeEntry(parent, name)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	return err
}
