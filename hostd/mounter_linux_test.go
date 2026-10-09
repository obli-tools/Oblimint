//go:build linux

package main

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"syscall"
	"testing"
)

// Regression (P3 Linux run): windows/<w>/lower showed up rw in the host's
// namespace. hostd's bind propagated to the host through the rshared hosting
// root, but its MS_REMOUNT|MS_RDONLY stayed local to hostd. bindRO must leave
// every propagated copy ro,nosuid,nodev.
//
// Needs root (real mounts). Everything happens in a private mount namespace
// owned by this test's locked OS thread (discarded with the thread): the
// host's mount table is never touched. Layout: tmpfs a/ made shared, b/ a peer
// of a/ (stands for the host's view), a/priv/ a private area (the private
// clone of releases/), bindRO(a/priv/src, a/lower) then b/lower is inspected.
func TestBindROPropagatesReadOnly(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("needs root (real mounts)")
	}
	runtime.LockOSThread() // never unlocked: the thread (and its namespace) dies with the test goroutine
	if err := syscall.Unshare(syscall.CLONE_NEWNS); err != nil {
		t.Skipf("unshare(CLONE_NEWNS): %v", err)
	}
	must := func(what string, err error) {
		t.Helper()
		if err != nil {
			t.Fatalf("%s: %v", what, err)
		}
	}
	must("make / rprivate", syscall.Mount("", "/", "", syscall.MS_REC|syscall.MS_PRIVATE, ""))
	base := t.TempDir()
	a, b := filepath.Join(base, "a"), filepath.Join(base, "b")
	must("mkdir a", os.Mkdir(a, 0o755))
	must("mkdir b", os.Mkdir(b, 0o755))
	must("tmpfs a", syscall.Mount("tmpfs", a, "tmpfs", 0, "size=1m"))
	must("a shared", syscall.Mount("", a, "", syscall.MS_SHARED, ""))
	must("bind a b", syscall.Mount(a, b, "", syscall.MS_BIND, "")) // b: peer of a
	// Runs before TempDir's RemoveAll (cleanups are LIFO).
	t.Cleanup(func() {
		_ = syscall.Unmount(b, syscall.MNT_DETACH)
		_ = syscall.Unmount(a, syscall.MNT_DETACH)
	})
	priv := filepath.Join(a, "priv")
	must("mkdir priv", os.Mkdir(priv, 0o700))
	must("bind priv", syscall.Mount(priv, priv, "", syscall.MS_BIND, ""))
	must("priv private", syscall.Mount("", priv, "", syscall.MS_PRIVATE, ""))
	src := filepath.Join(priv, "src")
	must("mkdir src", os.Mkdir(src, 0o755))
	must("write src/f", os.WriteFile(filepath.Join(src, "f"), []byte("x"), 0o644))
	for _, d := range []string{"lower", "legacy"} {
		must("mkdir "+d, os.Mkdir(filepath.Join(a, d), 0o700))
	}

	km := kernelMounter{}
	must("bindRO", km.bindRO(src, filepath.Join(a, "lower")))
	// Control: the legacy bind + remount reproduces the bug on this kernel.
	must("bindROLegacy", km.bindROLegacy(src, filepath.Join(a, "legacy")))

	mounts, err := readMountinfo("/proc/thread-self/mountinfo")
	must("mountinfo", err)
	opts := func(mp string) []string {
		t.Helper()
		m, ok := topMountAt(mounts, mp)
		if !ok {
			t.Fatalf("%s: not a mount point", mp)
		}
		return m.Options
	}
	for _, mp := range []string{filepath.Join(a, "lower"), filepath.Join(b, "lower")} {
		o := opts(mp)
		for _, want := range []string{"ro", "nosuid", "nodev"} {
			if !slices.Contains(o, want) {
				t.Errorf("%s: options %v lack %q", mp, o, want)
			}
		}
	}
	if err := os.WriteFile(filepath.Join(b, "lower", "f"), []byte("y"), 0o644); !errors.Is(err, syscall.EROFS) {
		t.Errorf("write through the propagated copy: err=%v, want EROFS", err)
	}
	if o := opts(filepath.Join(b, "legacy")); !slices.Contains(o, "ro") {
		t.Logf("control: legacy remount left the peer copy %v (the bug this test guards)", o)
	} else {
		t.Logf("control: this kernel propagated the legacy remount too (%v)", o)
	}
}
