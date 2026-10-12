//go:build !linux

package main

import "io/fs"

func linkCount(fs.FileInfo) uint64 { return 1 }

func isNoSpace(error) bool { return false }
