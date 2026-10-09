//go:build !linux

package main

import "os"

// fsxattrProj: project quotas are Linux only.
type fsxattrProj struct{}

func (fsxattrProj) get(*os.File) (uint32, bool, error) { return 0, false, errUnsupported }
func (fsxattrProj) set(*os.File, uint32, bool) error   { return errUnsupported }
