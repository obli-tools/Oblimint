package main

import (
	"os"
	"syscall"
)

// ficlone = _IOW(0x94, 9, int): share src's extents with dst (XFS reflink=1,
// btrfs). EOPNOTSUPP / EXDEV / EINVAL make the caller copy the data.
const ficlone = 0x40049409

func reflinkClone(dst, src *os.File) error {
	if _, _, errno := syscall.Syscall(syscall.SYS_IOCTL, dst.Fd(), ficlone, src.Fd()); errno != 0 {
		return errno
	}
	return nil
}
