package main

import (
	"context"
	"errors"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
)

// fileKey identifies an inode (device + inode number) to count hard links once.
type fileKey struct{ Dev, Ino uint64 }

// maxWalkDepth bounds the recursion of the measuring / tagging walks. It is
// much larger than maxTreeDepth (copies) because these walks must see what a
// tenant hides deep down (usage in measured mode, quota project ids): one fd
// is held per level, Go raises RLIMIT_NOFILE to its hard limit at start-up.
// A variable so the tests can lower it.
var maxWalkDepth = 2048

// visitFunc receives every entry below the walked directory: its parent, its
// name and its lstat result. sub is the entered directory (nil for anything
// else, and for a directory that vanished or was swapped for a link).
type visitFunc func(parent *os.Root, name string, fi fs.FileInfo, sub *os.Root) error

// walkTree visits every entry below dir without following any symlink
// (directories are entered with openDir). Tenant-shaped content never fails
// the walk: vanished entries are ignored, swapped entries are not entered and
// directories deeper than maxWalkDepth are visited but not entered (counted in
// tooDeep). ctx is checked between entries.
func walkTree(ctx context.Context, dir *os.Root, visit visitFunc) (tooDeep int, err error) {
	return walkTreeSkip(ctx, dir, nil, visit)
}

// skipFunc reports whether the directory rel (relative to the walked root)
// must not be entered: P3, a mount point (window overlay, lower bind).
type skipFunc func(rel string) bool

// walkTreeSkip is walkTree without entering the directories skip names (they
// are not visited either).
func walkTreeSkip(ctx context.Context, dir *os.Root, skip skipFunc, visit visitFunc) (tooDeep int, err error) {
	err = walkLevel(ctx, dir, "", 0, skip, visit, &tooDeep)
	return tooDeep, err
}

func walkLevel(ctx context.Context, dir *os.Root, rel string, depth int, skip skipFunc, visit visitFunc, tooDeep *int) error {
	d, err := dir.Open(".")
	if err != nil {
		return err
	}
	entries, err := d.ReadDir(-1)
	d.Close()
	if err != nil {
		return err
	}
	for _, e := range entries {
		if err := ctx.Err(); err != nil {
			return err
		}
		fi, err := dir.Lstat(e.Name())
		if errors.Is(err, fs.ErrNotExist) {
			continue
		}
		if err != nil {
			return err
		}
		if !fi.IsDir() {
			if err := visit(dir, e.Name(), fi, nil); err != nil {
				return err
			}
			continue
		}
		if skip != nil && skip(joinRel(rel, e.Name())) {
			continue
		}
		sub, err := openDir(dir, e.Name())
		if errors.Is(err, fs.ErrNotExist) || errors.Is(err, errUnsafePath) {
			sub = nil // vanished or swapped for a link: never followed
		} else if err != nil {
			return err
		}
		err = visit(dir, e.Name(), fi, sub)
		if err == nil && sub != nil {
			if depth+1 > maxWalkDepth {
				*tooDeep++
			} else {
				err = walkLevel(ctx, sub, joinRel(rel, e.Name()), depth+1, skip, visit, tooDeep)
			}
		}
		if sub != nil {
			sub.Close()
		}
		if err != nil {
			return err
		}
	}
	return nil
}

// diskUsage sums the allocated bytes below dir without following any symlink.
// An inode with several links is counted once: releases share unchanged files
// through hard links. Entries that vanish during the walk (a tenant deleting
// files) are ignored, and a tree deeper than maxWalkDepth is measured down to
// that depth (logged): measuring never fails because of tenant content.
//
// P3: a window overlay mounted below dir is not entered (its content is
// counted once, through the pristine lower bind of the window and the upper
// layer); see mountSkipper.
func diskUsage(ctx context.Context, dir *os.Root) (int64, error) {
	seen := make(map[fileKey]bool)
	fi, err := dir.Stat(".")
	if err != nil {
		return 0, err
	}
	total := allocated(dir, ".", fi, seen)
	tooDeep, err := walkTreeSkip(ctx, dir, mountSkipper(dir.Name(), true), func(parent *os.Root, name string, fi fs.FileInfo, _ *os.Root) error {
		total += allocated(parent, name, fi, seen)
		return nil
	})
	if tooDeep > 0 {
		slog.Warn("usage: subtrees deeper than the walk limit were not measured", "dir", dir.Name(), "subtrees", tooDeep, "limit", maxWalkDepth)
	}
	return total, err
}

// allocated returns the bytes an entry occupies, 0 when its inode was
// already counted.
func allocated(dir *os.Root, name string, fi fs.FileInfo, seen map[fileKey]bool) int64 {
	bytes, key, linked := fileUsage(dir, name, fi)
	if linked {
		if seen[key] {
			return 0
		}
		seen[key] = true
	}
	return bytes
}

// mountsBelow lists the mount points below an absolute directory, relative to
// it (→ fstype). Linux reads /proc/self/mountinfo; a variable for the tests.
var mountsBelow = func(dir string) map[string]string {
	mounts, err := defaultMounter().mounts()
	if err != nil {
		return nil
	}
	resolved := dir
	if r, err := filepath.EvalSymlinks(dir); err == nil {
		resolved = filepath.ToSlash(r)
	}
	return mountsBelowIn(mounts, resolved)
}

// mountSkipper skips the mount points below dir: only the overlays when
// overlaysOnly (measuring: the lower bind of a window is the pristine release,
// hidden under the overlay, and is counted once through it), every one
// otherwise (quota tagging: nothing seen through an overlay or a read-only
// bind is ever re-tagged).
func mountSkipper(dir string, overlaysOnly bool) skipFunc {
	below := mountsBelow(dir)
	if len(below) == 0 {
		return nil
	}
	return func(rel string) bool {
		fstype, ok := below[rel]
		return ok && (!overlaysOnly || fstype == "overlay")
	}
}
