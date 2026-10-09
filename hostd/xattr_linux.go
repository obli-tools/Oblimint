package main

import (
	"errors"
	"io/fs"
	"os"
	"syscall"
	"unsafe"
)

// Overlay markers of the upper layer (Documentation/filesystems/overlayfs.rst).
const (
	xattrOpaque   = "trusted.overlay.opaque"
	xattrRedirect = "trusted.overlay.redirect"
	xattrMetacopy = "trusted.overlay.metacopy"
	// Since 6.7: a whiteout may be a zero-size regular file with this xattr
	// (used when the upper layer itself lives on an overlay).
	xattrWhiteout = "trusted.overlay.whiteout"
)

// fgetxattr reads an xattr through an opened descriptor (never by path, R1):
// ok=false when absent. Only the first 64 bytes of the value are returned.
func fgetxattr(f *os.File, name string) (value []byte, ok bool, err error) {
	p, err := syscall.BytePtrFromString(name)
	if err != nil {
		return nil, false, err
	}
	buf := make([]byte, 64)
	n, _, errno := syscall.Syscall6(syscall.SYS_FGETXATTR, f.Fd(), uintptr(unsafe.Pointer(p)),
		uintptr(unsafe.Pointer(&buf[0])), uintptr(len(buf)), 0, 0)
	switch {
	case errno == 0:
		return buf[:n], true, nil
	case errno == syscall.ERANGE:
		return buf, true, nil // longer value (a redirect path): present
	case errno == syscall.ENODATA || errno == syscall.ENOTSUP:
		return nil, false, nil
	}
	return nil, false, errno
}

// kernelOverlayAttrs reads the markers overlayfs writes in the upper layer.
type kernelOverlayAttrs struct{}

func (kernelOverlayAttrs) classify(parent *os.Root, name string, fi fs.FileInfo, sub *os.Root, _ string) (upperKind, error) {
	var k upperKind
	switch {
	case fi.Mode()&fs.ModeCharDevice != 0:
		if st, ok := fi.Sys().(*syscall.Stat_t); ok && st.Rdev == 0 {
			k.whiteout = true
		}
		return k, nil
	case fi.IsDir():
		if sub == nil {
			return k, nil
		}
		f, err := sub.Open(".")
		if err != nil {
			return k, err
		}
		defer f.Close()
		v, ok, err := fgetxattr(f, xattrOpaque)
		if err != nil {
			return k, err
		}
		k.opaque = ok && len(v) > 0 && v[0] == 'y'
		_, k.redirect, err = fgetxattr(f, xattrRedirect)
		return k, err
	case fi.Mode().IsRegular():
		f, ok, err := openRegular(parent, name)
		if err != nil || !ok {
			if errors.Is(err, fs.ErrNotExist) {
				err = nil
			}
			return k, err
		}
		defer f.Close()
		if fi.Size() == 0 {
			if _, k.whiteout, err = fgetxattr(f, xattrWhiteout); err != nil || k.whiteout {
				return k, err
			}
		}
		if _, k.metacopy, err = fgetxattr(f, xattrMetacopy); err != nil {
			return k, err
		}
		_, k.redirect, err = fgetxattr(f, xattrRedirect)
		return k, err
	}
	return k, nil
}

func defaultOverlayAttrs() overlayAttrs { return kernelOverlayAttrs{} }
