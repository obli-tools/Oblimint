package main

import (
	"bytes"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"unsafe"
)

// inotifyHub is the one inotify instance of hostd. Directories are added
// through /proc/self/fd/<fd> of a descriptor opened without following links:
// the watch is on exactly the directory hostd checked, never on whatever a
// path resolves to later (R1).
type inotifyHub struct {
	fd   int
	mu   sync.Mutex
	subs map[int][]*treeWatch
}

const (
	inotifyMask = syscall.IN_CREATE | syscall.IN_CLOSE_WRITE | syscall.IN_MOVED_TO | syscall.IN_MOVED_FROM |
		syscall.IN_DELETE_SELF | syscall.IN_ONLYDIR | 0x04000000 /* IN_EXCL_UNLINK */
	maxUserWatchesPath = "/proc/sys/fs/inotify/max_user_watches"
	wantedUserWatches  = 1 << 20
)

func newNotifyHub() (notifyHub, error) {
	raiseInotifyWatches()
	fd, err := syscall.InotifyInit1(syscall.IN_CLOEXEC)
	if err != nil {
		return nil, fmt.Errorf("inotify_init1: %w", err)
	}
	h := &inotifyHub{fd: fd, subs: map[int][]*treeWatch{}}
	go h.read()
	return h, nil
}

// raiseInotifyWatches lifts fs.inotify.max_user_watches to 1 048 576 when lower
// (a big upload tree has one watch per directory).
func raiseInotifyWatches() {
	b, err := os.ReadFile(maxUserWatchesPath)
	if err != nil {
		return
	}
	cur, err := strconv.Atoi(strings.TrimSpace(string(b)))
	if err != nil || cur >= wantedUserWatches {
		return
	}
	if err := os.WriteFile(maxUserWatchesPath, []byte(strconv.Itoa(wantedUserWatches)), 0o644); err != nil {
		slog.Warn("inotify: max_user_watches not raised", "current", cur, "err", err)
		return
	}
	slog.Info("inotify: max_user_watches raised", "from", cur, "to", wantedUserWatches)
}

func (h *inotifyHub) add(dir *os.Root, w *treeWatch) (int, error) {
	f, err := dir.Open(".")
	if err != nil {
		return 0, err
	}
	defer f.Close()
	wd, err := syscall.InotifyAddWatch(h.fd, "/proc/self/fd/"+strconv.Itoa(int(f.Fd())), inotifyMask)
	if err != nil {
		if errors.Is(err, syscall.ENOSPC) {
			return 0, fmt.Errorf("inotify watch limit reached (%s): %w", maxUserWatchesPath, err)
		}
		return 0, err
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, s := range h.subs[wd] {
		if s == w {
			return wd, nil
		}
	}
	h.subs[wd] = append(h.subs[wd], w)
	return wd, nil
}

func (h *inotifyHub) remove(wd int, w *treeWatch) {
	h.mu.Lock()
	defer h.mu.Unlock()
	subs := h.subs[wd]
	for i, s := range subs {
		if s == w {
			subs = append(subs[:i], subs[i+1:]...)
			break
		}
	}
	if len(subs) > 0 {
		h.subs[wd] = subs
		return
	}
	delete(h.subs, wd)
	_, _ = syscall.InotifyRmWatch(h.fd, uint32(wd))
}

func (h *inotifyHub) read() {
	buf := make([]byte, 64<<10)
	for {
		n, err := syscall.Read(h.fd, buf)
		if err != nil {
			if errors.Is(err, syscall.EINTR) {
				continue
			}
			slog.Error("inotify: read failed, watchers stopped", "err", err)
			return
		}
		for off := 0; off+syscall.SizeofInotifyEvent <= n; {
			raw := (*syscall.InotifyEvent)(unsafe.Pointer(&buf[off]))
			nameLen := int(raw.Len)
			start := off + syscall.SizeofInotifyEvent
			if start+nameLen > n {
				break
			}
			name := string(bytes.TrimRight(buf[start:start+nameLen], "\x00"))
			off = start + nameLen
			h.dispatch(fsEvent{wd: int(raw.Wd), mask: raw.Mask, name: name})
		}
	}
}

func (h *inotifyHub) dispatch(ev fsEvent) {
	h.mu.Lock()
	var subs []*treeWatch
	if ev.mask&evOverflow != 0 {
		seen := map[*treeWatch]bool{}
		for _, l := range h.subs {
			for _, s := range l {
				if !seen[s] {
					seen[s] = true
					subs = append(subs, s)
				}
			}
		}
	} else {
		subs = append(subs, h.subs[ev.wd]...)
		if ev.mask&syscall.IN_IGNORED != 0 {
			delete(h.subs, ev.wd)
		}
	}
	h.mu.Unlock()
	for _, s := range subs {
		s.deliver(ev)
	}
}
