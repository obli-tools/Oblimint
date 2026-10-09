//go:build !linux

package main

// inotify only exists on Linux: the watch routes answer 501 elsewhere.
func newNotifyHub() (notifyHub, error) { return nil, errUnsupported }
