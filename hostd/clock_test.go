package main

import (
	"sort"
	"sync"
	"time"
)

// fakeClock: time moves only with Advance, which runs the due timers in order.
type fakeClock struct {
	mu     sync.Mutex
	now    time.Time
	timers []*fakeTimer
}

type fakeTimer struct {
	c       *fakeClock
	at      time.Time
	f       func()
	stopped bool
}

func newFakeClock(t time.Time) *fakeClock { return &fakeClock{now: t} }

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *fakeClock) AfterFunc(d time.Duration, f func()) timer {
	c.mu.Lock()
	defer c.mu.Unlock()
	t := &fakeTimer{c: c, at: c.now.Add(d), f: f}
	c.timers = append(c.timers, t)
	return t
}

func (t *fakeTimer) Stop() bool {
	t.c.mu.Lock()
	defer t.c.mu.Unlock()
	was := !t.stopped
	t.stopped = true
	return was
}

// Advance moves the clock and runs (synchronously) every timer due by then.
func (c *fakeClock) Advance(d time.Duration) {
	c.mu.Lock()
	target := c.now.Add(d)
	c.mu.Unlock()
	for {
		c.mu.Lock()
		sort.SliceStable(c.timers, func(i, j int) bool { return c.timers[i].at.Before(c.timers[j].at) })
		var due *fakeTimer
		for i, t := range c.timers {
			if t.stopped {
				continue
			}
			if !t.at.After(target) {
				due = t
				c.timers = append(c.timers[:i], c.timers[i+1:]...)
				break
			}
		}
		if due == nil {
			c.now = target
			c.mu.Unlock()
			return
		}
		if due.at.After(c.now) {
			c.now = due.at
		}
		due.stopped = true
		c.mu.Unlock()
		due.f()
	}
}
