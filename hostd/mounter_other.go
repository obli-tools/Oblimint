//go:build !linux

package main

import (
	"os"
	"path/filepath"
)

// Mounts only exist on Linux: every window operation answers 501 elsewhere.
type unsupportedMounter struct{}

func (unsupportedMounter) mounts() ([]Mount, error)       { return nil, errUnsupported }
func (unsupportedMounter) pidMounts(int) ([]Mount, error) { return nil, errUnsupported }
func (unsupportedMounter) pidExists(int) bool             { return false }
func (unsupportedMounter) privateArea(string) error       { return errUnsupported }
func (unsupportedMounter) privateBind(string, string) error {
	return errUnsupported
}
func (unsupportedMounter) bindRO(string, string) error { return errUnsupported }
func (unsupportedMounter) overlay(string, string, string, bool) error {
	return errUnsupported
}
func (unsupportedMounter) unmount(string) (bool, error)  { return false, errUnsupported }
func (unsupportedMounter) holders(string) ([]int, error) { return nil, errUnsupported }
func (unsupportedMounter) kill(int) error                { return errUnsupported }

func defaultMounter() mounter { return unsupportedMounter{} }

func rootLchown(*os.Root, string, Owner) error { return errUnsupported }

// renameAt: development fallback by path (tests only; hostd runs on Linux).
func renameAt(srcDir *os.Root, srcName string, dstDir *os.Root, dstName string) error {
	return os.Rename(filepath.Join(srcDir.Name(), srcName), filepath.Join(dstDir.Name(), dstName))
}

func isCrossDevice(error) bool { return false }
