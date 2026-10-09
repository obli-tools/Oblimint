package main

import (
	"io/fs"
	"os"
	"syscall"
)

// openNoFollowFlags: never open through a symlink, never block on a fifo.
const openNoFollowFlags = syscall.O_NOFOLLOW | syscall.O_NONBLOCK

// fileUsage returns the allocated size (st_blocks * 512) of an lstat result and
// its inode identity when it has several links.
func fileUsage(_ *os.Root, _ string, fi fs.FileInfo) (int64, fileKey, bool) {
	st, ok := fi.Sys().(*syscall.Stat_t)
	if !ok {
		return fi.Size(), fileKey{}, false
	}
	return int64(st.Blocks) * 512, fileKey{uint64(st.Dev), uint64(st.Ino)}, st.Nlink > 1 && !fi.IsDir()
}
