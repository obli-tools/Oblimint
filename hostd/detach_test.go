package main

import (
	"errors"
	"slices"
	"strings"
	"testing"
	"time"
)

var errBusyTest = errors.New("EBUSY")

func isBusyTest(err error) bool { return errors.Is(err, errBusyTest) }

// The plain umount is retried with back-off while busy; MNT_DETACH only as a
// last resort, reported to the caller.
func TestUnmountRetry(t *testing.T) {
	var slept []time.Duration
	sleep := func(d time.Duration) { slept = append(slept, d) }

	// Busy twice, then free: no detach.
	plains, detaches := 0, 0
	plain := func() error {
		plains++
		if plains <= 2 {
			return errBusyTest
		}
		return nil
	}
	detach := func() error { detaches++; return nil }
	if d, err := unmountRetry(plain, detach, isBusyTest, sleep); d || err != nil || plains != 3 || detaches != 0 || len(slept) != 2 {
		t.Errorf("busy twice: detached %v err %v plains %d detaches %d slept %v", d, err, plains, detaches, slept)
	}

	// Always busy: every back-off, then a detach reported.
	slept, plains, detaches = nil, 0, 0
	always := func() error { plains++; return errBusyTest }
	if d, err := unmountRetry(always, detach, isBusyTest, sleep); !d || err != nil || detaches != 1 ||
		plains != len(unmountBackoff)+1 || !slices.Equal(slept, unmountBackoff) {
		t.Errorf("always busy: detached %v err %v plains %d detaches %d slept %v", d, err, plains, detaches, slept)
	}

	// Another error: returned at once, never detached.
	slept, detaches = nil, 0
	other := errors.New("EPERM")
	if d, err := unmountRetry(func() error { return other }, detach, isBusyTest, sleep); d || !errors.Is(err, other) || detaches != 0 || len(slept) != 0 {
		t.Errorf("other error: detached %v err %v", d, err)
	}

	// The detach itself fails: not reported as detached.
	if d, err := unmountRetry(always, func() error { return other }, isBusyTest, sleep); d || !errors.Is(err, other) {
		t.Errorf("failed detach: detached %v err %v", d, err)
	}
}

func TestDevString(t *testing.T) {
	for _, c := range []struct {
		dev  uint64
		want string
	}{
		{0x0803, "8:3"},
		{0x2e, "0:46"},
		{(259 << 8) | 5, "259:5"},
		// major 0x1234 (high bits at 32+), minor 0x56789 (high bits at 12+)
		{(uint64(0x1234&^0xfff) << 32) | uint64(0x234)<<8 | uint64(0x56789&^0xff)<<12 | 0x89, "4660:354185"},
	} {
		if got := devString(c.dev); got != c.want {
			t.Errorf("devString(%#x) = %s, want %s", c.dev, got, c.want)
		}
	}
}

func TestParseMountinfoDev(t *testing.T) {
	mounts, err := ParseMountinfo(strings.NewReader("36 35 0:52 / /srv/x rw - overlay ovl-w5 rw,lowerdir=a\n"))
	if err != nil || len(mounts) != 1 || mounts[0].Dev != "0:52" {
		t.Fatalf("%+v %v", mounts, err)
	}
}

// freezeSetup: a rw window whose overlay (device 0:1) is busy at the freeze.
func freezeSetup(t *testing.T, pids ...int) (*testManager, WindowSpec) {
	t.Helper()
	tm := newTestManager(t)
	tm.mkSite(t, 7, 9, 3, map[string]string{"index.php": phpOpen})
	if _, err := tm.EnsureWindow(bg, rwSpec(5)); err != nil {
		t.Fatal(err)
	}
	mounts, _ := tm.mnt.mounts()
	top, ok := topMountAt(mounts, tm.layout.Release(7, 9, 3))
	if !ok || top.Dev == "" {
		t.Fatalf("no overlay device: %+v", top)
	}
	tm.mnt.detach = map[string]bool{tm.layout.Release(7, 9, 3): true}
	tm.mnt.holding = map[string][]int{top.Dev: pids}
	tm.mnt.calls = nil
	ro := rwSpec(5)
	ro.Mode = windowModeRO
	return tm, ro
}

func indexOfPrefix(calls []string, prefix string) int {
	return slices.IndexFunc(calls, func(c string) bool { return strings.HasPrefix(c, prefix) })
}

// A freeze that could only detach the rw overlay drains its writers (killed
// after the grace period) BEFORE the ro overlay is mounted over upper/.
func TestFreezeDrainsDetachedWriters(t *testing.T) {
	tm, ro := freezeSetup(t, 1, 4242, 4243)
	st, err := tm.EnsureWindow(bg, ro)
	if err != nil {
		t.Fatal(err)
	}
	if st.Mode == nil || *st.Mode != windowModeRO || st.WritersDetached {
		t.Errorf("status %+v", st)
	}
	if !slices.Equal(tm.mnt.killed, []int{4242, 4243}) {
		t.Errorf("killed %v (pid 1 must never be killed)", tm.mnt.killed)
	}
	h, o := indexOfPrefix(tm.mnt.calls, "holders 0:1"), indexOfPrefix(tm.mnt.calls, "overlay ")
	if h < 0 || o < 0 || h > o {
		t.Errorf("writers not drained before the ro mount: %q", tm.mnt.calls)
	}
	if state, ok := tm.readState(7, 9, 5); !ok || state.writersDetached() || state.Mode != windowModeRO {
		t.Errorf("state %+v", state)
	}
}

// Detached without any holder left: no kill, frozen normally.
func TestFreezeDetachedWithoutHolders(t *testing.T) {
	tm, ro := freezeSetup(t)
	if _, err := tm.EnsureWindow(bg, ro); err != nil {
		t.Fatal(err)
	}
	if len(tm.mnt.killed) != 0 || tm.mnt.holderScan != 1 {
		t.Errorf("killed %v scans %d", tm.mnt.killed, tm.mnt.holderScan)
	}
}

// A plain unmount never scans for holders.
func TestFreezeWithoutDetachSkipsScan(t *testing.T) {
	tm, ro := freezeSetup(t, 4242)
	tm.mnt.detach = nil
	if _, err := tm.EnsureWindow(bg, ro); err != nil {
		t.Fatal(err)
	}
	if tm.mnt.holderScan != 0 || len(tm.mnt.killed) != 0 {
		t.Errorf("scans %d killed %v", tm.mnt.holderScan, tm.mnt.killed)
	}
}

// A holder that survives the kill: the freeze answers windowWriters, the ro
// overlay is mounted all the same, the state records the detached device,
// status / export refuse until it is gone; then everything clears.
func TestFreezeDetachedWritersSurvive(t *testing.T) {
	tm, ro := freezeSetup(t, 4242)
	tm.mnt.unkillable = map[int]bool{4242: true}
	if _, err := tm.EnsureWindow(bg, ro); codeOf(err) != codeWindowWriters {
		t.Fatalf("freeze with a surviving writer: %v", err)
	}
	mounts, _ := tm.mnt.mounts()
	ov, ok := tm.findOverlay(mounts, 7, 9, 5)
	if !ok || ov.Mode != windowModeRO {
		t.Errorf("ro overlay not mounted: %+v %v", ov, ok)
	}
	state, ok := tm.readState(7, 9, 5)
	if !ok || state.DetachedDev != "0:1" || state.Mode != windowModeRO {
		t.Errorf("state %+v", state)
	}
	st, err := tm.WindowStatus(bg, 7, 9, 5)
	if err != nil || !st.WritersDetached || st.ExportReady {
		t.Errorf("status %+v %v", st, err)
	}
	killsBefore := len(tm.mnt.killed)
	if _, err := tm.ExportWindow(bg, WindowRef{7, 9, 5, "blog"}, bigOpts); codeOf(err) != codeWindowWriters {
		t.Errorf("export with live writers: %v", err)
	}
	if len(tm.mnt.killed) != killsBefore {
		t.Errorf("export killed processes: %v", tm.mnt.killed)
	}
	// Re-ensuring retries the drain (and still refuses).
	if _, err := tm.EnsureWindow(bg, ro); codeOf(err) != codeWindowWriters {
		t.Errorf("re-ensure: %v", err)
	}

	// The writer is gone: export proceeds and the record is cleared.
	tm.mnt.holding = nil
	if _, err := tm.ExportWindow(bg, WindowRef{7, 9, 5, "blog"}, bigOpts); err != nil {
		t.Fatalf("export once released: %v", err)
	}
	if state, _ := tm.readState(7, 9, 5); state.writersDetached() {
		t.Errorf("record not cleared: %+v", state)
	}
	if st, _ := tm.WindowStatus(bg, 7, 9, 5); st.WritersDetached {
		t.Errorf("status %+v", st)
	}
}

// Detached but the old overlay's device is unknown: refused for good.
func TestFreezeDetachedUnknownDevice(t *testing.T) {
	tm, ro := freezeSetup(t)
	tm.mnt.mu.Lock()
	for i := range tm.mnt.table {
		if tm.mnt.table[i].FSType == "overlay" {
			tm.mnt.table[i].Dev = ""
		}
	}
	tm.mnt.mu.Unlock()
	if _, err := tm.EnsureWindow(bg, ro); codeOf(err) != codeWindowWriters {
		t.Fatalf("unknown device: %v", err)
	}
	if state, _ := tm.readState(7, 9, 5); !state.DetachedUnknown {
		t.Errorf("state %+v", state)
	}
	if _, err := tm.ExportWindow(bg, WindowRef{7, 9, 5, "blog"}, bigOpts); codeOf(err) != codeWindowWriters {
		t.Errorf("export: %v", err)
	}
	// Removal still works (and clears everything).
	if err := tm.RemoveWindow(bg, WindowRef{7, 9, 5, "blog"}, false); err != nil {
		t.Fatal(err)
	}
}
