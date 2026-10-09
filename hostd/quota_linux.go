package main

import (
	"os"
	"syscall"
	"unsafe"
)

// struct fsxattr (linux/fs.h):
// FS_IOC_FSGETXATTR = _IOR('X', 31, struct fsxattr),
// FS_IOC_FSSETXATTR = _IOW('X', 32, struct fsxattr).
type fsxattr struct {
	XFlags     uint32
	ExtSize    uint32
	NExtents   uint32
	ProjID     uint32
	CowExtSize uint32
	Pad        [8]byte
}

const (
	fsIocFSGetXAttr    = 0x801c581f
	fsIocFSSetXAttr    = 0x401c5820
	fsXFlagProjInherit = 0x00000200
)

// fsxattrProj reads / sets the project id through an already opened
// descriptor (opened by hostd without following links): never by path.
type fsxattrProj struct{}

func getXAttr(f *os.File) (fsxattr, error) {
	var attr fsxattr
	if _, _, errno := syscall.Syscall(syscall.SYS_IOCTL, f.Fd(), fsIocFSGetXAttr, uintptr(unsafe.Pointer(&attr))); errno != 0 {
		return attr, errno
	}
	return attr, nil
}

func (fsxattrProj) get(f *os.File) (uint32, bool, error) {
	attr, err := getXAttr(f)
	if err != nil {
		return 0, false, err
	}
	return attr.ProjID, attr.XFlags&fsXFlagProjInherit != 0, nil
}

// set keeps every other flag (read-modify-write).
func (fsxattrProj) set(f *os.File, projectID uint32, inherit bool) error {
	attr, err := getXAttr(f)
	if err != nil {
		return err
	}
	attr.ProjID = projectID
	if inherit {
		attr.XFlags |= fsXFlagProjInherit
	}
	if _, _, errno := syscall.Syscall(syscall.SYS_IOCTL, f.Fd(), fsIocFSSetXAttr, uintptr(unsafe.Pointer(&attr))); errno != 0 {
		return errno
	}
	return nil
}
