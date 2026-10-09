package main

import (
	"context"
	"errors"
	"io/fs"
	"log/slog"
	"os"
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
	err = walkLevel(ctx, dir, 0, visit, &tooDeep)
	return tooDeep, err
}

func walkLevel(ctx context.Context, dir *os.Root, depth int, visit visitFunc, tooDeep *int) error {
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
				err = walkLevel(ctx, sub, depth+1, visit, tooDeep)
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
func diskUsage(ctx context.Context, dir *os.Root) (int64, error) {
	seen := make(map[fileKey]bool)
	fi, err := dir.Stat(".")
	if err != nil {
		return 0, err
	}
	total := allocated(dir, ".", fi, seen)
	tooDeep, err := walkTree(ctx, dir, func(parent *os.Root, name string, fi fs.FileInfo, _ *os.Root) error {
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
