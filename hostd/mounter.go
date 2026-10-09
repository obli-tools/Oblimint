package main

import (
	"os"
	"time"
)

// mounter is every mount-namespace operation of the window overlays
// (mounter_linux.go). Tests inject a fake: no mount ever happens on a
// development box.
type mounter interface {
	// mounts reads /proc/self/mountinfo (hostd's namespace = the host's view
	// of the hosting root, which is bind-mounted rshared at the same path).
	mounts() ([]Mount, error)
	// pidMounts reads /proc/<pid>/mountinfo (hostd runs with pid host).
	pidMounts(pid int) ([]Mount, error)
	pidExists(pid int) bool
	// privateArea makes dir a private mount (bind on itself when it is not a
	// mount point yet): binds made below it never propagate anywhere.
	privateArea(dir string) error
	// privateBind binds src (non recursive) onto dst, then makes dst private.
	privateBind(src, dst string) error
	// bindRO binds src (non recursive) onto dst read-only,nosuid,nodev, in
	// every namespace the bind propagates to (the flags are set before the
	// mount is attached: a later remount would stay local to hostd).
	bindRO(src, dst string) error
	// overlay mounts an overlay (source names it in mountinfo) onto target
	// with nosuid,nodev (+ rdonly when ro).
	overlay(source, target, options string, ro bool) error
	// unmount unmounts target: plain umount, retried with a short back-off
	// while busy (an open file / cwd here or in a container's slave copy),
	// then MNT_DETACH as a last resort. detached=true reports that last
	// resort: the old mount is gone from every mount table but lives on (and
	// a rw overlay stays WRITABLE) for every fd, mapping or cwd still on it.
	// Not mounted is not an error.
	unmount(target string) (detached bool, err error)
	// holders lists the processes (pid host) holding the filesystem whose
	// superblock device is dev ("major:minor", Mount.Dev): an open file, a
	// memory mapping, a cwd or a root on it. hostd's own pid is never listed.
	holders(dev string) ([]int, error)
	// kill sends SIGKILL to pid.
	kill(pid int) error
}

// unmountBackoff is the wait before each plain umount retry (about 1.5 s in
// all) before falling back to a lazy detach.
var unmountBackoff = []time.Duration{50 * time.Millisecond, 100 * time.Millisecond, 200 * time.Millisecond, 400 * time.Millisecond, 750 * time.Millisecond}

// unmountRetry runs plain() until it is not busy (back-off between tries);
// still busy after the last one: detach(), reported as detached=true. OS
// independent so the policy is unit tested anywhere.
func unmountRetry(plain, detach func() error, isBusy func(error) bool, sleep func(time.Duration)) (bool, error) {
	err := plain()
	for _, d := range unmountBackoff {
		if !isBusy(err) {
			return false, err
		}
		sleep(d)
		err = plain()
	}
	if !isBusy(err) {
		return false, err
	}
	if err := detach(); err != nil {
		return false, err
	}
	return true, nil
}

// lchownFunc changes the owner of name inside dir WITHOUT following a symlink
// (fchownat AT_SYMLINK_NOFOLLOW relative to the opened directory).
type lchownFunc func(dir *os.Root, name string, o Owner) error
