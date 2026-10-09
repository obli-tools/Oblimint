package main

import (
	"context"
	"sync"
	"time"
)

// eventRing keeps the last maxEvents P3 events (GET /v1/events?since=&wait=).
// Unlike the gateway queue it is not drained by a read: every reader asks for
// the events after the last seq it saw. seq is monotonic within the process and
// restarts at 1 with hostd: a reader whose since is beyond the last seq (hostd
// restarted) gets the whole ring and resyncs (docs/P3-PLAN.md §12).
type eventRing struct {
	mu     sync.Mutex
	max    int
	events []Event
	seq    int64
	notify chan struct{} // closed and replaced when an event is pushed
	now    func() time.Time
}

const (
	maxEvents = 10_000
	// maxEventsPerRead bounds one answer (the panel asks again with the new since).
	maxEventsPerRead = 1000
)

func newEventRing(max int, now func() time.Time) *eventRing {
	return &eventRing{max: max, notify: make(chan struct{}), now: now}
}

// push stamps e (seq, at) and queues it, dropping the oldest when full.
func (r *eventRing) push(e Event) Event {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.seq++
	e.Seq = r.seq
	e.At = r.now().UTC().Format(time.RFC3339)
	if len(r.events) >= r.max {
		r.events = append(r.events[:0], r.events[len(r.events)-r.max+1:]...)
	}
	r.events = append(r.events, e)
	close(r.notify)
	r.notify = make(chan struct{})
	return e
}

// after returns the events with seq > since (at most maxEventsPerRead) and the
// next since. A since beyond the last seq (hostd restarted) reads from 0.
func (r *eventRing) after(since int64) ([]Event, int64, chan struct{}) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if since > r.seq {
		since = 0
	}
	out := []Event{}
	for _, e := range r.events {
		if e.Seq > since {
			out = append(out, e)
			if len(out) == maxEventsPerRead {
				break
			}
		}
	}
	next := since
	if len(out) > 0 {
		next = out[len(out)-1].Seq
	}
	return out, next, r.notify
}

// Wait returns as soon as events after since exist, or an empty list after
// wait (or when ctx ends).
func (r *eventRing) Wait(ctx context.Context, since int64, wait time.Duration) ([]Event, int64) {
	events, next, ch := r.after(since)
	if len(events) > 0 || wait <= 0 {
		return events, next
	}
	t := time.NewTimer(wait)
	defer t.Stop()
	select {
	case <-ch:
		events, next, _ = r.after(since)
	case <-t.C:
	case <-ctx.Done():
	}
	return events, next
}
