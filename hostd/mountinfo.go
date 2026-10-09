package main

import (
	"bufio"
	"fmt"
	"io"
	"path"
	"strconv"
	"strings"
)

// Mount is one line of /proc/<pid>/mountinfo (see proc(5)).
type Mount struct {
	// Dev is the superblock device "major:minor" (field 3): every copy of a
	// mount (bind, propagated slave in a container) shares it.
	Dev          string
	MountPoint   string
	Root         string
	FSType       string
	Source       string
	Options      []string // per-mount options (field 6)
	SuperOptions []string // per-superblock options (last field)
}

// ParseMountinfo parses the mountinfo format. It is OS independent so it can
// be unit tested anywhere; only reading the real file is Linux specific.
func ParseMountinfo(r io.Reader) ([]Mount, error) {
	var mounts []Mount
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 64*1024), 1024*1024)
	for n := 1; sc.Scan(); n++ {
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			continue
		}
		// "36 35 98:0 /mnt1 /mnt2 rw,noatime master:1 - ext3 /dev/root rw,errors=continue"
		pre, post, ok := strings.Cut(line, " - ")
		if !ok {
			return nil, fmt.Errorf("mountinfo line %d: missing separator", n)
		}
		f, g := strings.Fields(pre), strings.Fields(post)
		if len(f) < 6 || len(g) < 2 {
			return nil, fmt.Errorf("mountinfo line %d: too few fields", n)
		}
		m := Mount{
			Dev:        f[2],
			Root:       unescapeOctal(f[3]),
			MountPoint: unescapeOctal(f[4]),
			Options:    strings.Split(f[5], ","),
			FSType:     g[0],
			Source:     unescapeOctal(g[1]),
		}
		if len(g) > 2 {
			m.SuperOptions = strings.Split(g[2], ",")
		}
		mounts = append(mounts, m)
	}
	return mounts, sc.Err()
}

// unescapeOctal decodes the \ooo escapes the kernel uses for space, tab,
// newline and backslash in mountinfo paths.
func unescapeOctal(s string) string {
	if !strings.Contains(s, `\`) {
		return s
	}
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] == '\\' && i+4 <= len(s) {
			if v, err := strconv.ParseUint(s[i+1:i+4], 8, 8); err == nil {
				b.WriteByte(byte(v))
				i += 3
				continue
			}
		}
		b.WriteByte(s[i])
	}
	return b.String()
}

// FindMount returns the mount holding p: the longest mount point that is p or
// a parent directory of p. On ties the later entry wins (it is mounted on top).
func FindMount(mounts []Mount, p string) (Mount, bool) {
	p = path.Clean(p)
	best, found := Mount{}, false
	for _, m := range mounts {
		mp := m.MountPoint
		if mp != "/" && p != mp && !strings.HasPrefix(p, mp+"/") {
			continue
		}
		if !found || len(mp) >= len(best.MountPoint) {
			best, found = m, true
		}
	}
	return best, found
}

// AllOptions merges per-mount and superblock options, without duplicates.
func (m Mount) AllOptions() []string {
	seen := make(map[string]bool)
	out := []string{}
	for _, o := range append(append([]string{}, m.Options...), m.SuperOptions...) {
		if o != "" && !seen[o] {
			seen[o] = true
			out = append(out, o)
		}
	}
	return out
}

// ProjectQuota reports whether project quotas are enabled (XFS: prjquota/pquota,
// also "prjquota" on ext4 when mounted with it).
func (m Mount) ProjectQuota() bool {
	for _, o := range m.AllOptions() {
		switch o {
		case "prjquota", "pquota":
			return true
		}
	}
	return false
}

// devString is the "major:minor" of a Linux dev_t (the mountinfo format).
func devString(dev uint64) string {
	major := (dev>>8)&0xfff | (dev>>32)&0xfffff000
	minor := dev&0xff | (dev>>12)&0xffffff00
	return strconv.FormatUint(major, 10) + ":" + strconv.FormatUint(minor, 10)
}
