package main

import (
	"encoding/json"
	"reflect"
	"slices"
	"strings"
	"testing"
)

func TestOverlayOptions(t *testing.T) {
	w := "/srv/oblimint/accounts/7/sites/9/windows/5"
	rw, err := overlayOptions(w+"/lower", w+"/upper", w+"/work", false)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{
		"lowerdir=" + w + "/lower,upperdir=" + w + "/upper,workdir=" + w + "/work,metacopy=on,redirect_dir=on,index=off,xino=off",
		"lowerdir=" + w + "/lower,upperdir=" + w + "/upper,workdir=" + w + "/work,redirect_dir=on,index=off,xino=off",
	}
	if !slices.Equal(rw, want) {
		t.Errorf("rw options:\n got %q\nwant %q", rw, want)
	}
	ro, err := overlayOptions(w+"/lower", w+"/upper", w+"/work", true)
	if err != nil {
		t.Fatal(err)
	}
	// Freeze: no upper / work, the upper layer on top of the lower one.
	if !strings.HasPrefix(ro[0], "lowerdir="+w+"/upper:"+w+"/lower,metacopy=on,redirect_dir=on,index=off,xino=off") || len(ro) != 3 {
		t.Errorf("ro options: %q", ro)
	}
	for _, o := range ro {
		if strings.Contains(o, "upperdir") || strings.Contains(o, "workdir") {
			t.Errorf("ro option with an upper layer: %q", o)
		}
	}
	for _, bad := range []string{"/srv/a,b", "/srv/a:b", `/srv/a\b`, ""} {
		if _, err := overlayOptions(bad, w+"/upper", w+"/work", false); err == nil {
			t.Errorf("%q accepted in overlay options", bad)
		}
	}
}

const p3Mountinfo = `22 1 8:1 / / rw,relatime shared:1 - ext4 /dev/sda1 rw
30 22 8:16 / /srv/oblimint rw,relatime shared:2 - xfs /dev/sdb rw,prjquota
40 30 8:16 /accounts/7/sites/9/releases/3 /srv/oblimint/accounts/7/sites/9/windows/5/lower ro,nosuid,nodev shared:9 - xfs /dev/sdb rw,prjquota
41 30 0:50 / /srv/oblimint/accounts/7/sites/9/releases/3 rw,nosuid,nodev shared:10 - overlay oblimint-window-5 rw,lowerdir=/srv/oblimint/accounts/7/sites/9/windows/5/lower,upperdir=/srv/oblimint/accounts/7/sites/9/windows/5/upper,workdir=/srv/oblimint/accounts/7/sites/9/windows/5/work,metacopy=on
50 30 0:51 / /srv/oblimint/accounts/8/sites/12/releases/40 ro,nosuid,nodev shared:11 - overlay overlay ro,lowerdir=/srv/oblimint/accounts/8/sites/12/windows/77/upper:/srv/oblimint/accounts/8/sites/12/windows/77/lower,metacopy=on
51 30 0:52 / /srv/oblimint/accounts/8/sites/13/releases/2 rw - overlay other rw,lowerdir=/x,upperdir=/y,workdir=/z
52 30 0:53 / /srv/oblimint/accounts/8/sites/14/releases/current rw - overlay oblimint-window-9 rw
53 30 0:54 / /srv/oblimint/run/hostd-mnt rw shared:3 - xfs /dev/sdb rw
`

func TestWindowOverlaysFromMountinfo(t *testing.T) {
	mounts, err := ParseMountinfo(strings.NewReader(p3Mountinfo))
	if err != nil {
		t.Fatal(err)
	}
	got := windowOverlays(mounts, "/srv/oblimint")
	want := []mountedOverlay{
		{MountedWindow{7, 9, 5, "rw", 3}, "/srv/oblimint/accounts/7/sites/9/releases/3"},
		{MountedWindow{8, 12, 77, "ro", 40}, "/srv/oblimint/accounts/8/sites/12/releases/40"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("overlays:\n got %+v\nwant %+v", got, want)
	}
	// A frozen window stacked over a rw one: the top mount decides.
	stacked := append(slices.Clone(mounts), Mount{MountPoint: "/srv/oblimint/accounts/7/sites/9/releases/3", FSType: "overlay", Source: "oblimint-window-5", Options: []string{"ro"}})
	if got := windowOverlays(stacked, "/srv/oblimint"); got[0].Mode != "ro" {
		t.Errorf("top mount ignored: %+v", got[0])
	}
	if !isMountPoint(mounts, "/srv/oblimint/accounts/7/sites/9/windows/5/lower") || isMountPoint(mounts, "/srv/oblimint/accounts/7") {
		t.Error("isMountPoint")
	}
	below := mountsBelowIn(mounts, "/srv/oblimint/accounts/7/")
	if below["sites/9/releases/3"] != "overlay" || below["sites/9/windows/5/lower"] != "xfs" || len(below) != 2 {
		t.Errorf("mountsBelow: %v", below)
	}
}

func TestPropagationResult(t *testing.T) {
	container := `100 90 0:60 / / rw - overlay overlay rw
101 100 8:16 /accounts/7/sites/9/releases /srv/releases ro,relatime master:2 - xfs /dev/sdb rw
102 101 0:50 / /srv/releases/3 rw,nosuid,nodev master:10 - overlay oblimint-window-5 rw
103 100 8:16 /accounts/7/data/blog /srv/data rw - xfs /dev/sdb rw
`
	mounts, err := ParseMountinfo(strings.NewReader(container))
	if err != nil {
		t.Fatal(err)
	}
	r := propagationResult(4242, mounts, 3)
	if !r.Visible || r.Mode == nil || *r.Mode != "rw" || r.Error != nil || r.PID != 4242 {
		t.Errorf("visible rw: %+v", r)
	}
	if r := propagationResult(4242, mounts, 4); r.Visible || r.Mode != nil {
		t.Errorf("other release: %+v", r)
	}
	frozen := append(mounts, Mount{MountPoint: "/srv/releases/3", FSType: "overlay", Options: []string{"ro", "nosuid"}})
	if r := propagationResult(1, frozen, 3); !r.Visible || *r.Mode != "ro" {
		t.Errorf("frozen: %+v", r)
	}
}

func TestWindowIDOfMount(t *testing.T) {
	cases := []struct {
		m    Mount
		id   int64
		ok   bool
		name string
	}{
		{Mount{Source: "oblimint-window-12"}, 12, true, "source"},
		{Mount{Source: "overlay", SuperOptions: []string{"rw", "lowerdir=/r/accounts/1/sites/2/windows/33/lower", "upperdir=/r/accounts/1/sites/2/windows/33/upper"}}, 33, true, "upperdir"},
		{Mount{Source: "overlay", SuperOptions: []string{"lowerdir=/r/accounts/1/sites/2/windows/34/upper:/r/accounts/1/sites/2/windows/34/lower"}}, 34, true, "frozen"},
		{Mount{Source: "overlay", SuperOptions: []string{"lowerdir=/x,upperdir=/y"}}, 0, false, "foreign"},
		{Mount{Source: "oblimint-window-0"}, 0, false, "zero"},
	}
	for _, c := range cases {
		if id, ok := windowIDOfMount(c.m); id != c.id || ok != c.ok {
			t.Errorf("%s: %d %v", c.name, id, ok)
		}
	}
}

// The P3 JSON shapes are those of client.ts (keys and null-ability).
func TestP3JSONShapes(t *testing.T) {
	keys := func(v any) []string {
		b, err := json.Marshal(v)
		if err != nil {
			t.Fatal(err)
		}
		var m map[string]any
		_ = json.Unmarshal(b, &m)
		var out []string
		for k := range m {
			out = append(out, k)
		}
		slices.Sort(out)
		return out
	}
	cases := []struct {
		v    any
		want string
	}{
		{WindowStatus{}, "accountId,exportReady,mode,mounted,quarantineExecutables,releaseNumber,siteId,upperBytes,upperEntries,windowId"},
		{DiffEntry{}, "change,exported,linkTarget,mode,path,sha256,size,skipped,type"},
		{WindowManifest{}, "createdAt,entries,releaseNumber,truncated,version,windowId"},
		{ExportResult{}, "added,bytes,deleted,entries,modified,truncated"},
		{PropagationResult{}, "error,mode,pid,visible"},
		{MountedWindow{}, "accountId,mode,releaseNumber,siteId,windowId"},
		{StagingApplyResult{}, "conflicts,deleted,written"},
		{StagingConflict{}, "path,reason"},
		{QuarantineEntry{}, "accountId,area,dataPath,detail,detectedType,id,path,quarantinedAt,reason,restoredAt,sha256,siteId,size,slug,source"},
		{Event{}, "accountId,at,entryId,kind,message,seq,siteId,windowId"},
		{WorkspaceResult{}, "bytes,files"},
		{WatchResult{}, "quarantined,watching"},
		{RestoreResult{}, "path,restored"},
		{Preview{}, "base64,size,truncated"},
	}
	for _, c := range cases {
		if got := strings.Join(keys(c.v), ","); got != c.want {
			t.Errorf("%T keys:\n got %s\nwant %s", c.v, got, c.want)
		}
	}
	b, _ := json.Marshal(WindowStatus{AccountID: 1})
	if !strings.Contains(string(b), `"mode":null`) || !strings.Contains(string(b), `"releaseNumber":null`) {
		t.Errorf("nullable fields: %s", b)
	}
}
