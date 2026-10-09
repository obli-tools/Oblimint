package main

import (
	"io/fs"
	"os"
	"syscall"
)

// Windows is a development target only (unit tests); see fileid_linux.go.

const openNoFollowFlags = 0

// fileUsage returns the apparent size and, for regular files with several
// links, the volume serial + file index (so the hard-link dedupe logic is
// exercised by the tests on Windows too).
func fileUsage(dir *os.Root, name string, fi fs.FileInfo) (int64, fileKey, bool) {
	if !fi.Mode().IsRegular() {
		return fi.Size(), fileKey{}, false
	}
	f, err := dir.Open(name)
	if err != nil {
		return fi.Size(), fileKey{}, false
	}
	defer f.Close()
	var info syscall.ByHandleFileInformation
	if err := syscall.GetFileInformationByHandle(syscall.Handle(f.Fd()), &info); err != nil || info.NumberOfLinks < 2 {
		return fi.Size(), fileKey{}, false
	}
	return fi.Size(), fileKey{uint64(info.VolumeSerialNumber), uint64(info.FileIndexHigh)<<32 | uint64(info.FileIndexLow)}, true
}
