package main

import "time"

// clock abstracts time for the firewall expiry and the gateway timers (tests
// use a fake clock advanced by hand).
type clock interface {
	Now() time.Time
	AfterFunc(d time.Duration, f func()) timer
}

type timer interface{ Stop() bool }

type realClock struct{}

func (realClock) Now() time.Time { return time.Now() }

func (realClock) AfterFunc(d time.Duration, f func()) timer { return time.AfterFunc(d, f) }
