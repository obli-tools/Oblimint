//go:build !linux && !windows

package main

import (
	"io/fs"
	"os"
)

const openNoFollowFlags = 0

// fileUsage: apparent size, no hard-link identity (hostd only runs on Linux).
func fileUsage(_ *os.Root, _ string, fi fs.FileInfo) (int64, fileKey, bool) {
	return fi.Size(), fileKey{}, false
}
