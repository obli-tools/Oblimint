//go:build !linux

package main

import (
	"fmt"
	"net"
	"runtime"
)

// hostd only runs on Linux; these stubs keep the module buildable elsewhere.

func listenUnix(string) (net.Listener, error) {
	return nil, fmt.Errorf("hostd: %w (%s)", errUnsupported, runtime.GOOS)
}

func fsInfo(string) (FSInfo, error) {
	return FSInfo{}, errUnsupported
}
