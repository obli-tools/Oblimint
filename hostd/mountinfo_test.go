package main

import (
	"slices"
	"strings"
	"testing"
)

// Realistic sample: ext4 root, XFS data volume with project quotas, a Docker
// overlay, a bind mount whose paths contain spaces (\040) and a stacked mount.
const sampleMountinfo = `22 1 8:1 / / rw,relatime shared:1 - ext4 /dev/sda1 rw,errors=remount-ro
23 22 0:21 / /proc rw,nosuid,nodev,noexec,relatime shared:12 - proc proc rw
24 22 0:5 / /dev rw,nosuid,relatime shared:2 - devtmpfs udev rw,size=4012345k,nr_inodes=1003086,mode=755
30 22 0:25 / /run rw,nosuid,nodev,noexec,relatime shared:5 - tmpfs tmpfs rw,size=812345k,mode=755
41 22 253:2 / /srv/oblimint rw,noatime shared:30 - xfs /dev/mapper/vg0-oblimint rw,attr2,inode64,logbufs=8,logbsize=32k,prjquota
42 22 253:3 / /srv/oblimint-old rw,relatime shared:31 - ext4 /dev/mapper/vg0-old rw
55 41 253:2 /accounts/acme\040corp/sites/www /srv/oblimint/mounts/acme\040corp/www rw,noatime shared:30 - xfs /dev/mapper/vg0-oblimint rw,attr2,inode64,logbufs=8,logbsize=32k,prjquota
61 22 0:52 / /var/lib/docker/overlay2/3f2a/merged rw,relatime shared:40 - overlay overlay rw,lowerdir=/var/lib/docker/overlay2/l/ABC:/var/lib/docker/overlay2/l/DEF,upperdir=/var/lib/docker/overlay2/3f2a/diff,workdir=/var/lib/docker/overlay2/3f2a/work
62 41 0:53 / /srv/oblimint/tmp rw,nosuid,nodev,relatime shared:41 - tmpfs tmpfs rw,size=1048576k
63 41 0:54 / /srv/oblimint/tmp rw,relatime shared:42 - tmpfs tmpfs2 rw,size=2048k
70 22 253:4 / /mnt/pq rw,relatime - xfs /dev/sdb1 rw,attr2,inode64,pquota
`

func parseSample(t *testing.T) []Mount {
	t.Helper()
	mounts, err := ParseMountinfo(strings.NewReader(sampleMountinfo))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(mounts) != 11 {
		t.Fatalf("got %d mounts, want 11", len(mounts))
	}
	return mounts
}

func TestFindMount(t *testing.T) {
	mounts := parseSample(t)
	tests := []struct {
		path, mountPoint, fsType, source string
		prjquota                         bool
	}{
		{"/srv/oblimint", "/srv/oblimint", "xfs", "/dev/mapper/vg0-oblimint", true},
		{"/srv/oblimint/", "/srv/oblimint", "xfs", "/dev/mapper/vg0-oblimint", true},
		{"/srv/oblimint/accounts/a", "/srv/oblimint", "xfs", "/dev/mapper/vg0-oblimint", true},
		// Prefix match must stop at a path boundary.
		{"/srv/oblimint-old/x", "/srv/oblimint-old", "ext4", "/dev/mapper/vg0-old", false},
		{"/srv/oblimintx", "/", "ext4", "/dev/sda1", false},
		{"/etc/hostname", "/", "ext4", "/dev/sda1", false},
		{"/srv/oblimint/mounts/acme corp/www/index.php", "/srv/oblimint/mounts/acme corp/www", "xfs", "/dev/mapper/vg0-oblimint", true},
		{"/var/lib/docker/overlay2/3f2a/merged/etc", "/var/lib/docker/overlay2/3f2a/merged", "overlay", "overlay", false},
		// Stacked mounts: the last one wins.
		{"/srv/oblimint/tmp/a", "/srv/oblimint/tmp", "tmpfs", "tmpfs2", false},
		{"/mnt/pq", "/mnt/pq", "xfs", "/dev/sdb1", true},
	}
	for _, tt := range tests {
		m, ok := FindMount(mounts, tt.path)
		if !ok {
			t.Errorf("%s: no mount", tt.path)
			continue
		}
		if m.MountPoint != tt.mountPoint || m.FSType != tt.fsType || m.Source != tt.source || m.ProjectQuota() != tt.prjquota {
			t.Errorf("%s: got (%q, %s, %s, prj=%v), want (%q, %s, %s, prj=%v)", tt.path,
				m.MountPoint, m.FSType, m.Source, m.ProjectQuota(), tt.mountPoint, tt.fsType, tt.source, tt.prjquota)
		}
	}
}

func TestParseFields(t *testing.T) {
	m := parseSample(t)[6]
	if m.Root != "/accounts/acme corp/sites/www" {
		t.Errorf("root = %q", m.Root)
	}
	want := []string{"rw", "noatime", "attr2", "inode64", "logbufs=8", "logbsize=32k", "prjquota"}
	if got := m.AllOptions(); !slices.Equal(got, want) {
		t.Errorf("options = %v, want %v", got, want)
	}
}

func TestParseErrors(t *testing.T) {
	for _, in := range []string{"22 1 8:1 / / rw shared:1 ext4 /dev/sda1 rw", "22 1 - ext4 /dev/sda1 rw"} {
		if _, err := ParseMountinfo(strings.NewReader(in)); err == nil {
			t.Errorf("expected error for %q", in)
		}
	}
}

func TestUnescapeOctal(t *testing.T) {
	cases := map[string]string{`a\040b`: "a b", `tab\011x`: "tab\tx", `back\134slash`: `back\slash`, `trail\04`: `trail\04`, "plain": "plain"}
	for in, want := range cases {
		if got := unescapeOctal(in); got != want {
			t.Errorf("unescapeOctal(%q) = %q, want %q", in, got, want)
		}
	}
}
