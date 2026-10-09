package main

import (
	"errors"
	"fmt"
	"log/slog"
	"os"
	"strconv"
	"syscall"
	"time"
	"unsafe"
)

// kernelMounter is the real mounter (hostd runs privileged, pid host, with the
// hosting root bind-mounted rshared at the same path).
type kernelMounter struct{}

func readMountinfo(p string) ([]Mount, error) {
	f, err := os.Open(p)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return ParseMountinfo(f)
}

func (kernelMounter) mounts() ([]Mount, error) { return readMountinfo("/proc/self/mountinfo") }

func (kernelMounter) pidMounts(pid int) ([]Mount, error) {
	return readMountinfo("/proc/" + strconv.Itoa(pid) + "/mountinfo")
}

func (kernelMounter) pidExists(pid int) bool {
	_, err := os.Stat("/proc/" + strconv.Itoa(pid))
	return err == nil
}

func (m kernelMounter) privateArea(dir string) error {
	mounts, err := m.mounts()
	if err != nil {
		return err
	}
	if !isMountPoint(mounts, dir) {
		if err := syscall.Mount(dir, dir, "", syscall.MS_BIND, ""); err != nil {
			return fmt.Errorf("bind %s on itself: %w", dir, err)
		}
	}
	if err := syscall.Mount("", dir, "", syscall.MS_PRIVATE, ""); err != nil {
		return fmt.Errorf("make %s private: %w", dir, err)
	}
	return nil
}

func (m kernelMounter) privateBind(src, dst string) error {
	if err := syscall.Mount(src, dst, "", syscall.MS_BIND, ""); err != nil {
		return fmt.Errorf("bind %s on %s: %w", src, dst, err)
	}
	if err := syscall.Mount("", dst, "", syscall.MS_PRIVATE, ""); err != nil {
		_, _ = m.unmount(dst)
		return fmt.Errorf("make %s private: %w", dst, err)
	}
	return nil
}

// bindRO makes dst a read-only,nosuid,nodev bind of src in EVERY mount
// namespace dst propagates to (dst's parent is the rshared hosting root, so
// the bind also appears in the host's namespace). A per-mount remount
// (MS_REMOUNT|MS_BIND|MS_RDONLY) never propagates: done after the bind, it
// would leave the host's copy rw. So the flags are set BEFORE the mount is
// attached: open_tree(OPEN_TREE_CLONE) detaches a clone of src,
// mount_setattr makes it ro,nosuid,nodev, move_mount attaches it on dst; the
// copies propagated to dst's peers are cloned from it, flags included.
// Kernels without the new mount API (< 5.12, ENOSYS) fall back to the legacy
// bind + remount (read-only in hostd's namespace only), with a warning.
func (m kernelMounter) bindRO(src, dst string) error {
	err := bindROAttached(src, dst)
	if err == nil || !errors.Is(err, syscall.ENOSYS) {
		return err
	}
	slog.Warn("new mount API unavailable: read-only bind enforced in hostd's namespace only", "dst", dst)
	return m.bindROLegacy(src, dst)
}

func (m kernelMounter) bindROLegacy(src, dst string) error {
	if err := syscall.Mount(src, dst, "", syscall.MS_BIND, ""); err != nil {
		return fmt.Errorf("bind %s on %s: %w", src, dst, err)
	}
	flags := uintptr(syscall.MS_BIND | syscall.MS_REMOUNT | syscall.MS_RDONLY | syscall.MS_NOSUID | syscall.MS_NODEV)
	if err := syscall.Mount("", dst, "", flags, ""); err != nil {
		_, _ = m.unmount(dst)
		return fmt.Errorf("remount %s read-only: %w", dst, err)
	}
	return nil
}

// New mount API (uapi/linux/mount.h). The syscall numbers of the calls added
// after 5.1 are shared by every architecture (amd64, arm64...).
const (
	sysOpenTree         = 428
	sysMoveMount        = 429
	sysMountSetattr     = 442
	openTreeClone       = 0x1
	moveMountFEmptyPath = 0x4
	atEmptyPath         = 0x1000
	mountAttrRdonly     = 0x1
	mountAttrNosuid     = 0x2
	mountAttrNodev      = 0x4
)

// mountAttr is struct mount_attr (MOUNT_ATTR_SIZE_VER0 = 32).
type mountAttr struct {
	attrSet     uint64
	attrClr     uint64
	propagation uint64
	usernsFd    uint64
}

func bindROAttached(src, dst string) error {
	srcp, err := syscall.BytePtrFromString(src)
	if err != nil {
		return err
	}
	dstp, err := syscall.BytePtrFromString(dst)
	if err != nil {
		return err
	}
	empty, _ := syscall.BytePtrFromString("")
	r, _, e := syscall.Syscall(sysOpenTree, uintptr(atFdCwd), uintptr(unsafe.Pointer(srcp)),
		uintptr(openTreeClone|syscall.O_CLOEXEC))
	if e != 0 {
		return fmt.Errorf("open_tree %s: %w", src, e)
	}
	fd := int(r)
	defer syscall.Close(fd) // a detached tree never attached is released here
	attr := mountAttr{attrSet: mountAttrRdonly | mountAttrNosuid | mountAttrNodev}
	if _, _, e := syscall.Syscall6(sysMountSetattr, uintptr(fd), uintptr(unsafe.Pointer(empty)),
		uintptr(atEmptyPath), uintptr(unsafe.Pointer(&attr)), unsafe.Sizeof(attr), 0); e != 0 {
		return fmt.Errorf("mount_setattr %s read-only: %w", src, e)
	}
	if _, _, e := syscall.Syscall6(sysMoveMount, uintptr(fd), uintptr(unsafe.Pointer(empty)),
		uintptr(atFdCwd), uintptr(unsafe.Pointer(dstp)), moveMountFEmptyPath, 0); e != 0 {
		return fmt.Errorf("move_mount %s on %s: %w", src, dst, e)
	}
	return nil
}

// atFdCwd is AT_FDCWD (-100) as a syscall argument.
var atFdCwd = func() uintptr { v := -100; return uintptr(v) }()

func (kernelMounter) overlay(source, target, options string, ro bool) error {
	flags := uintptr(syscall.MS_NOSUID | syscall.MS_NODEV)
	if ro {
		flags |= syscall.MS_RDONLY
	}
	if err := syscall.Mount(source, target, "overlay", flags, options); err != nil {
		return fmt.Errorf("mount overlay on %s (%s): %w", target, options, err)
	}
	return nil
}

func (kernelMounter) unmount(target string) (bool, error) {
	detached, err := unmountRetry(
		func() error { return syscall.Unmount(target, 0) },
		func() error { return syscall.Unmount(target, syscall.MNT_DETACH) },
		func(err error) bool { return errors.Is(err, syscall.EBUSY) },
		time.Sleep)
	if errors.Is(err, syscall.EINVAL) || errors.Is(err, syscall.ENOENT) {
		return false, nil // not a mount point (any more)
	}
	if err != nil {
		return false, fmt.Errorf("unmount %s: %w", target, err)
	}
	if detached {
		slog.Warn("mount still busy: lazily detached", "target", target)
	}
	return detached, nil
}

// holders scans /proc (hostd runs with pid host): cwd, root, every open fd
// and every mapped file of every process, stat'ed through the magic links
// (the target inode, even on a detached mount). An overlay whose layers all
// sit on one filesystem (the hosting root) reports its own device for every
// object. Processes that vanish meanwhile are skipped.
func (kernelMounter) holders(dev string) ([]int, error) {
	procs, err := os.ReadDir("/proc")
	if err != nil {
		return nil, err
	}
	self := os.Getpid()
	on := func(p string) bool {
		var st syscall.Stat_t
		return syscall.Stat(p, &st) == nil && devString(uint64(st.Dev)) == dev
	}
	var out []int
	for _, e := range procs {
		pid, err := strconv.Atoi(e.Name())
		if err != nil || pid == self {
			continue
		}
		base := "/proc/" + e.Name()
		held := on(base+"/cwd") || on(base+"/root")
		for _, sub := range []string{"/fd", "/map_files"} {
			if held {
				break
			}
			ents, err := os.ReadDir(base + sub)
			if err != nil {
				continue
			}
			for _, f := range ents {
				if on(base + sub + "/" + f.Name()) {
					held = true
					break
				}
			}
		}
		if held {
			out = append(out, pid)
		}
	}
	return out, nil
}

func (kernelMounter) kill(pid int) error {
	if err := syscall.Kill(pid, syscall.SIGKILL); err != nil && !errors.Is(err, syscall.ESRCH) {
		return fmt.Errorf("kill %d: %w", pid, err)
	}
	return nil
}

func defaultMounter() mounter { return kernelMounter{} }

// rootLchown: fchownat(dirfd, name, AT_SYMLINK_NOFOLLOW).
func rootLchown(dir *os.Root, name string, o Owner) error { return dir.Lchown(name, o.UID, o.GID) }

// renameAt moves srcName of srcDir to dstName of dstDir (renameat on the two
// opened directories: no path is resolved again, R1).
func renameAt(srcDir *os.Root, srcName string, dstDir *os.Root, dstName string) error {
	s, err := srcDir.Open(".")
	if err != nil {
		return err
	}
	defer s.Close()
	d, err := dstDir.Open(".")
	if err != nil {
		return err
	}
	defer d.Close()
	if err := syscall.Renameat(int(s.Fd()), srcName, int(d.Fd()), dstName); err != nil {
		return &os.LinkError{Op: "renameat", Old: srcName, New: dstName, Err: err}
	}
	return nil
}

// isCrossDevice reports EXDEV (rename across filesystems).
func isCrossDevice(err error) bool { return errors.Is(err, syscall.EXDEV) }
