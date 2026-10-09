//go:build !linux

package main

import (
	"io/fs"
	"time"
)

// ownerOf: no POSIX owner outside Linux (development only).
func ownerOf(fs.FileInfo) Owner { return rootOwner }

// changeTime: no ctime outside Linux (development only): the mtime.
func changeTime(fi fs.FileInfo) time.Time { return fi.ModTime() }
