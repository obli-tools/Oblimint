//go:build !linux

package main

import "os"

// reflinkClone: no reflink outside Linux (the data is copied).
func reflinkClone(*os.File, *os.File) error { return errUnsupported }
