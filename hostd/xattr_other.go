//go:build !linux

package main

import (
	"io/fs"
	"os"
)

// Overlay markers are xattrs of a Linux upper layer: nothing to read elsewhere
// (tests inject a fake overlayAttrs).
type noOverlayAttrs struct{}

func (noOverlayAttrs) classify(*os.Root, string, fs.FileInfo, *os.Root, string) (upperKind, error) {
	return upperKind{}, nil
}

func defaultOverlayAttrs() overlayAttrs { return noOverlayAttrs{} }
