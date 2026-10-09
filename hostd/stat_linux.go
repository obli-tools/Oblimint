package main

import (
	"io/fs"
	"syscall"
	"time"
)

// ownerOf reads the owner of an lstat / stat result.
func ownerOf(fi fs.FileInfo) Owner {
	if st, ok := fi.Sys().(*syscall.Stat_t); ok {
		return Owner{UID: int(st.Uid), GID: int(st.Gid)}
	}
	return rootOwner
}

// changeTime is the inode change time (never settable from userspace).
func changeTime(fi fs.FileInfo) time.Time {
	if st, ok := fi.Sys().(*syscall.Stat_t); ok {
		return time.Unix(int64(st.Ctim.Sec), int64(st.Ctim.Nsec))
	}
	return fi.ModTime()
}
