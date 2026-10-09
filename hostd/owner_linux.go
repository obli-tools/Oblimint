package main

import (
	"io/fs"
	"os"
)

// fdOwner applies ownership then mode through the descriptor (fchown, fchmod):
// never by path, so a symlink can never redirect it.
func fdOwner(f *os.File, o Owner, mode fs.FileMode) error {
	if err := f.Chown(o.UID, o.GID); err != nil {
		return err
	}
	return f.Chmod(mode)
}
