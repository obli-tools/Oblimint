package main

// Writing a render to disk: every file atomically (temp + rename, so a
// graceful reload never reads a half-written config), the placeholder marker
// added / removed, and the nginx basePath tree (<out>/www) rebuilt aside then
// swapped in.

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

func safeOutName(name string) error {
	if name == "" || strings.Contains(name, "..") || filepath.IsAbs(name) || strings.HasPrefix(name, "/") {
		return fmt.Errorf("%w: %q", errUnsafeName, name)
	}
	return nil
}

// WriteOutput materializes a render under dir (host path of Options.Out).
func WriteOutput(dir string, res *Output) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	for _, f := range res.Files {
		if err := safeOutName(f.Name); err != nil {
			return err
		}
		if err := writeAtomic(filepath.Join(dir, filepath.FromSlash(f.Name)), []byte(f.Content)); err != nil {
			return err
		}
	}
	if !res.Placeholder {
		if err := os.Remove(filepath.Join(dir, placeholderMarker)); err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	return writeLinks(dir, res.Links)
}

func writeAtomic(target string, data []byte) error {
	tmp, err := os.CreateTemp(filepath.Dir(target), "."+filepath.Base(target)+".*.tmp")
	if err != nil {
		return err
	}
	name := tmp.Name()
	cleanup := func() { _ = os.Remove(name) }
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		cleanup()
		return err
	}
	if err := tmp.Close(); err != nil {
		cleanup()
		return err
	}
	if err := os.Chmod(name, 0o644); err != nil {
		cleanup()
		return err
	}
	if err := os.Rename(name, target); err != nil {
		cleanup()
		return err
	}
	return nil
}

// writeLinks rebuilds <dir>/www from scratch: www.new is populated, then
// swapped with the current www (two renames; nginx resolves the root per
// request, the window without www is a few microseconds and only matters
// during a reload, which re-renders the same tree anyway).
func writeLinks(dir string, links []OutLink) error {
	www := filepath.Join(dir, "www")
	if len(links) == 0 {
		return os.RemoveAll(www)
	}
	next := www + ".new"
	old := www + ".old"
	_ = os.RemoveAll(next)
	_ = os.RemoveAll(old)
	if err := os.MkdirAll(next, 0o755); err != nil {
		return err
	}
	for _, l := range links {
		if err := safeOutName(l.Path); err != nil {
			return err
		}
		rel, found := strings.CutPrefix(l.Path, "www/")
		if !found || rel == "" {
			return fmt.Errorf("%w: link %q outside www/", errUnsafeName, l.Path)
		}
		p := filepath.Join(next, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			return err
		}
		if err := os.Symlink(l.Target, p); err != nil {
			return err
		}
	}
	if _, err := os.Lstat(www); err == nil {
		if err := os.Rename(www, old); err != nil {
			return err
		}
	}
	if err := os.Rename(next, www); err != nil {
		return err
	}
	return os.RemoveAll(old)
}
