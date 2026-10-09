//go:build !linux

package main

import (
	"io/fs"
	"os"
)

// fdOwner: ownership is Linux only (tests inject their own ownerFunc).
func fdOwner(*os.File, Owner, fs.FileMode) error { return errUnsupported }
