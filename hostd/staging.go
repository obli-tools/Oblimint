package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"io"
	"io/fs"
	"os"
)

// ─────────────────────────────────────────────────────────────────────────────
// Reflection of a validated change into staging/<slug> (docs/P3-PLAN.md §8):
// the content comes from a window export (windows/<w>/export/files, root) or
// a workspace tree (work/<id>/tree, written by the tools container = tenant).
// The staging tree is the tenant's (SFTP): every parent is entered without
// following a link, a symlink or a file on the way is a conflict (never
// written through, R1), files are written to a temp name then renamed.
// Deletions run first (git checkout order: a file replacing a directory).
// ─────────────────────────────────────────────────────────────────────────────

const (
	maxStagingChanges   = 200_000
	maxStagingBodyBytes = 64 << 20
	stagingTmpPrefix    = ".oblimint-apply-"
)

type stagingApplier struct {
	src, dst *os.Root
	owner    Owner
	dirMode  fs.FileMode // of the directories it creates
	own      ownerFunc
	lchown   lchownFunc
	res      StagingApplyResult
}

// applyChanges applies changes from src into dst (both opened without
// following links).
func applyChanges(ctx context.Context, src, dst *os.Root, o Owner, own ownerFunc, lchown lchownFunc, changes []StagingChange) (StagingApplyResult, error) {
	a := &stagingApplier{src: src, dst: dst, owner: o, own: own, lchown: lchown,
		dirMode: 0o750, res: StagingApplyResult{Conflicts: []StagingConflict{}}}
	type item struct {
		segs []string
		c    StagingChange
	}
	var deletes, writes []item
	for _, c := range changes {
		segs, ok := splitRelPath(c.Path)
		if !ok || (c.Op != "write" && c.Op != "delete") {
			a.conflict(c.Path, conflictInvalid)
			continue
		}
		if c.Op == "delete" {
			deletes = append(deletes, item{segs, c})
		} else {
			writes = append(writes, item{segs, c})
		}
	}
	for _, it := range deletes {
		if err := ctx.Err(); err != nil {
			return a.res, err
		}
		if err := a.delete(it.c.Path, it.segs); err != nil {
			return a.res, err
		}
	}
	for _, it := range writes {
		if err := ctx.Err(); err != nil {
			return a.res, err
		}
		if err := a.write(it.c.Path, it.segs); err != nil {
			return a.res, err
		}
	}
	return a.res, nil
}

func (a *stagingApplier) conflict(p, reason string) {
	a.res.Conflicts = append(a.res.Conflicts, StagingConflict{Path: p, Reason: reason})
}

// conflictOf maps a traversal refusal to a conflict reason ("" = real error).
func conflictOf(err error) string {
	var pe *parentError
	if errors.As(err, &pe) {
		return pe.reason
	}
	return ""
}

// parentError: a component on the path is a symlink or not a directory.
type parentError struct{ reason string }

func (e *parentError) Error() string { return "staging path blocked: " + e.reason }

// enterParents walks segs below base component by component without following
// links. create: missing directories are created uid:gid dirMode; otherwise a
// missing one returns (nil, nil).
func (a *stagingApplier) enterParents(base *os.Root, segs []string, create bool) (*os.Root, error) {
	cur, err := base.OpenRoot(".")
	if err != nil {
		return nil, err
	}
	for _, s := range segs {
		fi, err := cur.Lstat(s)
		switch {
		case errors.Is(err, fs.ErrNotExist):
			if !create {
				cur.Close()
				return nil, nil
			}
			next, err := ensureDir(cur, s, a.owner, a.dirMode, a.own)
			cur.Close()
			if err != nil {
				if errors.Is(err, errUnsafePath) {
					return nil, &parentError{conflictSymlink}
				}
				return nil, err
			}
			cur = next
			continue
		case err != nil:
			cur.Close()
			return nil, err
		case fi.Mode()&fs.ModeSymlink != 0:
			cur.Close()
			return nil, &parentError{conflictSymlink}
		case !fi.IsDir():
			cur.Close()
			return nil, &parentError{conflictNotDirectory}
		}
		next, err := openDir(cur, s)
		cur.Close()
		if err != nil {
			if errors.Is(err, errUnsafePath) {
				return nil, &parentError{conflictSymlink}
			}
			return nil, err
		}
		cur = next
	}
	return cur, nil
}

func (a *stagingApplier) delete(p string, segs []string) error {
	parent, err := a.enterParents(a.dst, segs[:len(segs)-1], false)
	if r := conflictOf(err); r == conflictSymlink {
		a.conflict(p, r)
		return nil
	} else if r != "" {
		a.res.Deleted++ // a file where a parent should be: the path cannot exist
		return nil
	}
	if err != nil {
		return err
	}
	if parent == nil { // a parent is missing: already gone
		a.res.Deleted++
		return nil
	}
	defer parent.Close()
	if err := removeEntry(parent, segs[len(segs)-1]); err != nil {
		return err
	}
	a.res.Deleted++
	return nil
}

func (a *stagingApplier) write(p string, segs []string) error {
	name := segs[len(segs)-1]
	// Source first: nothing is created in the staging for a missing source.
	srcParent, err := a.enterParents(a.src, segs[:len(segs)-1], false)
	if conflictOf(err) != "" || (err == nil && srcParent == nil) {
		a.conflict(p, conflictMissingSource)
		return nil
	}
	if err != nil {
		return err
	}
	defer srcParent.Close()
	sfi, err := srcParent.Lstat(name)
	if errors.Is(err, fs.ErrNotExist) {
		a.conflict(p, conflictMissingSource)
		return nil
	}
	if err != nil {
		return err
	}
	if !sfi.Mode().IsRegular() && sfi.Mode()&fs.ModeSymlink == 0 {
		a.conflict(p, conflictMissingSource)
		return nil
	}

	dstParent, err := a.enterParents(a.dst, segs[:len(segs)-1], true)
	if r := conflictOf(err); r != "" {
		a.conflict(p, r)
		return nil
	}
	if err != nil {
		return err
	}
	defer dstParent.Close()
	// A directory in the way: removed only when empty (a typechange whose
	// files were deleted above), otherwise a conflict.
	if dfi, err := dstParent.Lstat(name); err == nil && dfi.IsDir() {
		if err := dstParent.Remove(name); err != nil {
			a.conflict(p, conflictNotDirectory)
			return nil
		}
	}

	tmp, err := applyTmpName()
	if err != nil {
		return err
	}
	if sfi.Mode()&fs.ModeSymlink != 0 {
		err = a.writeLink(srcParent, dstParent, name, tmp)
	} else {
		err = a.writeFile(srcParent, dstParent, name, tmp, sfi)
	}
	if err != nil {
		_ = dstParent.Remove(tmp)
		if errors.Is(err, fs.ErrNotExist) || errors.Is(err, errUnsafePath) {
			a.conflict(p, conflictMissingSource) // the source vanished / changed meanwhile
			return nil
		}
		return err
	}
	// rename(2) replaces the final entry itself (a symlink there is replaced,
	// never followed).
	if err := dstParent.Rename(tmp, name); err != nil {
		_ = dstParent.Remove(tmp)
		return err
	}
	a.res.Written++
	return nil
}

func (a *stagingApplier) writeFile(srcParent, dstParent *os.Root, name, tmp string, sfi fs.FileInfo) error {
	in, ok, err := openRegular(srcParent, name)
	if err != nil {
		return err
	}
	if !ok {
		return unsafePath("%s is not a regular file", name)
	}
	defer in.Close()
	out, err := dstParent.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	_, err = io.Copy(out, in)
	if err == nil {
		mode := fs.FileMode(0o644)
		if execBit(sfi) {
			mode = 0o755
		}
		err = a.own(out, a.owner, mode)
	}
	if cerr := out.Close(); err == nil {
		err = cerr
	}
	return err
}

func (a *stagingApplier) writeLink(srcParent, dstParent *os.Root, name, tmp string) error {
	target, err := srcParent.Readlink(name)
	if err != nil {
		return err
	}
	if err := dstParent.Symlink(target, tmp); err != nil {
		return err
	}
	return a.lchown(dstParent, tmp, a.owner)
}

func applyTmpName() (string, error) {
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return stagingTmpPrefix + hex.EncodeToString(b[:]), nil
}

// validStagingChanges is the handler-side bound (an invalid path or op is
// reported as an 'invalid' conflict, never applied, R2).
func validStagingChanges(changes []StagingChange) error {
	if len(changes) > maxStagingChanges {
		return badRequest("too many changes (max %d)", maxStagingChanges)
	}
	return nil
}
