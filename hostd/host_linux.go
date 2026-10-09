package main

import (
	"errors"
	"fmt"
	"io/fs"
	"net"
	"os"
	"path/filepath"
)

// listenUnix creates the socket directory if needed, replaces a stale socket
// and restricts the socket to owner and group (0660).
func listenUnix(socket string) (net.Listener, error) {
	if err := os.MkdirAll(filepath.Dir(socket), 0o750); err != nil {
		return nil, err
	}
	if err := os.Remove(socket); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return nil, err
	}
	ln, err := net.Listen("unix", socket)
	if err != nil {
		return nil, err
	}
	if err := os.Chmod(socket, 0o660); err != nil {
		ln.Close()
		return nil, err
	}
	return ln, nil
}

// fsInfo resolves p (following symlinks when it exists) and looks it up in
// /proc/self/mountinfo. Only used on the configured root (an admin choice).
func fsInfo(p string) (FSInfo, error) {
	resolved := p
	if r, err := filepath.EvalSymlinks(p); err == nil {
		resolved = r
	}
	return mountInfoOf(resolved)
}

// mountInfoOf looks p up in /proc/self/mountinfo as given: no resolution, so
// it never follows a link a tenant planted below the root.
func mountInfoOf(p string) (FSInfo, error) {
	f, err := os.Open("/proc/self/mountinfo")
	if err != nil {
		return FSInfo{}, err
	}
	defer f.Close()
	mounts, err := ParseMountinfo(f)
	if err != nil {
		return FSInfo{}, err
	}
	m, ok := FindMount(mounts, p)
	if !ok {
		return FSInfo{}, fmt.Errorf("no mount found for %s", p)
	}
	return FSInfo{
		Path:         p,
		FSType:       m.FSType,
		MountPoint:   m.MountPoint,
		Options:      m.AllOptions(),
		ProjectQuota: m.ProjectQuota(),
	}, nil
}
