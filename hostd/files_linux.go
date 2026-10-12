package main

import (
	"errors"
	"io/fs"
	"syscall"
)

// linkCount is the number of hard links of a stat result.
func linkCount(fi fs.FileInfo) uint64 {
	if st, ok := fi.Sys().(*syscall.Stat_t); ok {
		return uint64(st.Nlink)
	}
	return 1
}

// isNoSpace: disk full or quota exceeded.
func isNoSpace(err error) bool {
	return errors.Is(err, syscall.ENOSPC) || errors.Is(err, syscall.EDQUOT)
}
