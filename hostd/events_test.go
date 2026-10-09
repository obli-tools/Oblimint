package main

import (
	"context"
	"testing"
	"time"
)

func TestEventRingSeqAndBound(t *testing.T) {
	r := newEventRing(3, func() time.Time { return p3Now })
	for i := range 5 {
		e := r.push(Event{Kind: eventQuarantined, AccountID: int64(i + 1)})
		if e.Seq != int64(i+1) || e.At != "2026-10-09T03:15:00Z" {
			t.Fatalf("push %d: %+v", i, e)
		}
	}
	evs, next, _ := r.after(0)
	if len(evs) != 3 || evs[0].Seq != 3 || evs[2].Seq != 5 || next != 5 {
		t.Fatalf("ring keeps the last 3: %+v next %d", evs, next)
	}
	evs, next, _ = r.after(4)
	if len(evs) != 1 || evs[0].Seq != 5 || next != 5 {
		t.Fatalf("after 4: %+v next %d", evs, next)
	}
	evs, next, _ = r.after(5)
	if len(evs) != 0 || next != 5 || evs == nil {
		t.Fatalf("nothing new: %+v next %d (must be an empty list, not null)", evs, next)
	}
	// A reader ahead of hostd (hostd restarted, seq back to 1): everything again.
	evs, next, _ = r.after(500)
	if len(evs) != 3 || next != 5 {
		t.Fatalf("since beyond the last seq resyncs: %+v next %d", evs, next)
	}
}

func TestEventRingLongPoll(t *testing.T) {
	r := newEventRing(maxEvents, time.Now)
	start := time.Now()
	evs, next := r.Wait(context.Background(), 0, 50*time.Millisecond)
	if len(evs) != 0 || next != 0 || time.Since(start) < 40*time.Millisecond {
		t.Fatalf("empty wait: %v %d after %v", evs, next, time.Since(start))
	}
	go func() {
		time.Sleep(30 * time.Millisecond)
		r.push(Event{Kind: eventWindowLost, AccountID: 7})
	}()
	start = time.Now()
	evs, next = r.Wait(context.Background(), 0, 5*time.Second)
	if len(evs) != 1 || evs[0].Kind != eventWindowLost || next != 1 || time.Since(start) > 2*time.Second {
		t.Fatalf("woken by a push: %+v %d after %v", evs, next, time.Since(start))
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if evs, next := r.Wait(ctx, 1, 5*time.Second); len(evs) != 0 || next != 1 {
		t.Fatalf("cancelled wait: %v %d", evs, next)
	}
	// Bounded answer.
	for range maxEventsPerRead + 10 {
		r.push(Event{Kind: eventQuarantined})
	}
	evs, next = r.Wait(context.Background(), 1, 0)
	if len(evs) != maxEventsPerRead || next != int64(1+maxEventsPerRead) {
		t.Fatalf("bounded read: %d events, next %d", len(evs), next)
	}
}
