package main

import (
	"context"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func envOf(m map[string]string) func(string) string {
	return func(k string) string { return m[k] }
}

func TestLoadConfig(t *testing.T) {
	c, err := LoadConfig(envOf(map[string]string{"SCAND_KEY": testKey}))
	if err != nil {
		t.Fatal(err)
	}
	if !c.ClamAV || !c.Yara || c.FreshclamChecks != 12 || c.MaxFileMB != 32 || c.Concurrency != 4 || c.Addr != ":8080" {
		t.Fatalf("defaults: %+v", c)
	}
	if c.MaxFileBytes() != 32<<20 {
		t.Fatal(c.MaxFileBytes())
	}
	c, err = LoadConfig(envOf(map[string]string{"SCAND_KEY": testKey, "SCAND_CLAMAV": "0", "SCAND_YARA": "1", "FRESHCLAM_CHECKS": "24", "SCAND_MAX_FILE_MB": "64"}))
	if err != nil || c.ClamAV || !c.Yara || c.FreshclamChecks != 24 || c.MaxFileMB != 64 {
		t.Fatalf("%+v %v", c, err)
	}
	for _, bad := range []map[string]string{
		{},
		{"SCAND_KEY": "short"},
		{"SCAND_KEY": testKey, "SCAND_CLAMAV": "maybe"},
		{"SCAND_KEY": testKey, "FRESHCLAM_CHECKS": "0"},
		{"SCAND_KEY": testKey, "FRESHCLAM_CHECKS": "25"},
		{"SCAND_KEY": testKey, "SCAND_MAX_FILE_MB": "x"},
		{"SCAND_KEY": testKey, "SCAND_CLAMD_ADDR": "/x.sock"},
	} {
		if _, err := LoadConfig(envOf(bad)); err == nil {
			t.Errorf("accepted %v", bad)
		}
	}
}

func TestRenderedConfigs(t *testing.T) {
	c, _ := LoadConfig(envOf(map[string]string{"SCAND_KEY": testKey, "SCAND_MAX_FILE_MB": "32"}))
	conf := c.ClamdConf()
	for _, want := range []string{
		"Foreground yes", "LocalSocket /run/clamav/clamd.sock", "LocalSocketMode 600", "DatabaseDirectory /var/lib/clamav",
		"StreamMaxLength 33M", "MaxFileSize 33M", "MaxScanSize 128M", "DetectPUA no", "ConcurrentDatabaseReload no", "MaxThreads 4",
	} {
		if !strings.Contains(conf, want+"\n") {
			t.Errorf("clamd.conf lacks %q", want)
		}
	}
	// LogFile: clamd opens it with O_NOFOLLOW, /dev/stderr is a symlink ⇒ clamd
	// exits "Can't initialize the internal logger" (restart loop, regression P3).
	for _, never := range []string{"TCPSocket", "\nUser ", "LogFile", "/dev/std", "/proc/self"} {
		if strings.Contains(conf, never) {
			t.Errorf("clamd.conf must not contain %q", never)
		}
	}
	small, _ := LoadConfig(envOf(map[string]string{"SCAND_KEY": testKey, "SCAND_MAX_FILE_MB": "4"}))
	if !strings.Contains(small.ClamdConf(), "MaxScanSize 100M\n") {
		t.Error("MaxScanSize floor")
	}
	fc := c.FreshclamConf()
	for _, want := range []string{"DatabaseDirectory /var/lib/clamav", "TestDatabases no", "DatabaseMirror database.clamav.net"} {
		if !strings.Contains(fc, want+"\n") {
			t.Errorf("freshclam.conf lacks %q", want)
		}
	}
	if strings.Contains(fc, "NotifyClamd") || strings.Contains(fc, "Checks ") {
		t.Error("freshclam is driven by scand (no daemon settings)")
	}

	dir := t.TempDir()
	c.RunDir = filepath.Join(dir, "run")
	c.ClamdAddr = "unix:" + filepath.ToSlash(filepath.Join(dir, "clamav", "clamd.sock"))
	cd, fd, err := c.WriteConfigs()
	if err != nil {
		t.Fatal(err)
	}
	for _, p := range []string{cd, fd} {
		if st, err := os.Stat(p); err != nil || st.Size() == 0 {
			t.Fatalf("%s: %v", p, err)
		}
	}
	if st, err := os.Stat(filepath.Join(dir, "clamav")); err != nil || !st.IsDir() {
		t.Fatal("socket directory not created")
	}
}

// P4: clamd TCP for Rspamd, ONLY with OBLIMINT_CLAMD_TCP=1 and only bound to
// the container's address on oblimint-mail-core (OBLIMINT_CLAMD_TCP_NETS).
func TestClamdTCPOption(t *testing.T) {
	for _, v := range []string{"", "0", "false"} {
		c, err := LoadConfig(envOf(map[string]string{"SCAND_KEY": testKey, "OBLIMINT_CLAMD_TCP": v, "OBLIMINT_CLAMD_TCP_NETS": "172.30.0.0/16"}))
		if err != nil {
			t.Fatal(err)
		}
		c.ClamdTCPAddr = "172.30.0.5" // even if set, never without the flag
		if c.ClamdTCP || strings.Contains(c.ClamdConf(), "TCPSocket") || strings.Contains(c.ClamdConf(), "TCPAddr") {
			t.Fatalf("OBLIMINT_CLAMD_TCP=%q must not open a TCP socket", v)
		}
	}
	if _, err := LoadConfig(envOf(map[string]string{"SCAND_KEY": testKey, "OBLIMINT_CLAMD_TCP": "1"})); err == nil {
		t.Fatal("TCP without its subnets accepted")
	}
	for _, bad := range []string{"0.0.0.0/0", "nope", "172.30.0.0/16,::/0"} {
		if _, err := LoadConfig(envOf(map[string]string{"SCAND_KEY": testKey, "OBLIMINT_CLAMD_TCP": "1", "OBLIMINT_CLAMD_TCP_NETS": bad})); err == nil {
			t.Fatalf("subnets %q accepted", bad)
		}
	}
	c, err := LoadConfig(envOf(map[string]string{"SCAND_KEY": testKey, "OBLIMINT_CLAMD_TCP": "1", "OBLIMINT_CLAMD_TCP_NETS": "172.30.0.0/16, fd00:30::/64"}))
	if err != nil || !c.ClamdTCP || len(c.ClamdTCPNets) != 2 {
		t.Fatalf("%+v %v", c, err)
	}
	// no address on the mail back-end network ⇒ no TCP socket (fail closed)
	if strings.Contains(c.ClamdConf(), "TCPSocket") {
		t.Fatal("TCP socket opened without a resolved address")
	}
	panelAndCore := func() ([]net.Addr, error) {
		return []net.Addr{
			&net.IPNet{IP: net.ParseIP("127.0.0.1"), Mask: net.CIDRMask(8, 32)},
			&net.IPNet{IP: net.ParseIP("172.18.0.9"), Mask: net.CIDRMask(16, 32)}, // panel network
			&net.IPNet{IP: net.ParseIP("172.30.0.5"), Mask: net.CIDRMask(16, 32)}, // oblimint-mail-core
		}, nil
	}
	c.ClamdTCPAddr = c.ResolveClamdTCPAddr(0, panelAndCore)
	if c.ClamdTCPAddr != "172.30.0.5" {
		t.Fatalf("resolved %q", c.ClamdTCPAddr)
	}
	conf := c.ClamdConf()
	if !strings.Contains(conf, "\nTCPSocket 3310\nTCPAddr 172.30.0.5\n") {
		t.Fatalf("clamd.conf lacks TCPSocket 3310 bound to the mail-core address:\n%s", conf)
	}
	if strings.Count(conf, "TCPSocket") != 1 || !strings.Contains(conf, "LocalSocket /run/clamav/clamd.sock\n") {
		t.Fatal("the local socket used by scand must stay")
	}
	panelOnly := func() ([]net.Addr, error) {
		return []net.Addr{&net.IPNet{IP: net.ParseIP("172.18.0.9"), Mask: net.CIDRMask(16, 32)}}, nil
	}
	if a := c.ResolveClamdTCPAddr(0, panelOnly); a != "" {
		t.Fatalf("panel address %q picked", a)
	}
	if _, err := LoadConfig(envOf(map[string]string{"SCAND_KEY": testKey, "OBLIMINT_CLAMD_TCP": "yes please"})); err == nil {
		t.Fatal("invalid OBLIMINT_CLAMD_TCP accepted")
	}
}

func TestSeedDatabase(t *testing.T) {
	seed := t.TempDir()
	db := t.TempDir()
	for _, n := range []string{"main.cvd", "daily.cvd", "bytecode.cvd", "README"} {
		_ = os.WriteFile(filepath.Join(seed, n), []byte("db "+n), 0o644)
	}
	n, err := SeedDatabase(db, seed)
	if err != nil || n != 3 {
		t.Fatal(n, err)
	}
	if b, _ := os.ReadFile(filepath.Join(db, "daily.cvd")); string(b) != "db daily.cvd" {
		t.Fatal("content")
	}
	if _, err := os.Stat(filepath.Join(db, "README")); err == nil {
		t.Fatal("non-database file copied")
	}
	// Already seeded (or updated by freshclam): untouched.
	_ = os.WriteFile(filepath.Join(db, "daily.cld"), []byte("newer"), 0o644)
	_ = os.Remove(filepath.Join(db, "daily.cvd"))
	if n, err := SeedDatabase(db, seed); err != nil || n != 0 {
		t.Fatal(n, err)
	}
	if _, err := SeedDatabase(t.TempDir(), filepath.Join(seed, "missing")); err == nil {
		t.Fatal("missing seed dir must fail")
	}
}

func TestFreshclamUpdates(t *testing.T) {
	reloads := 0
	f := &Freshclam{
		Bin: os.Args[0], Config: "/run/freshclam.conf", PreArgs: []string{"-test.run=TestHelperProcess", "--"},
		Reload: func(context.Context) error { reloads++; return nil },
	}
	ctx := context.Background()
	t.Setenv("HELPER_MODE", "freshclam-updated")
	if err := f.UpdateNow(ctx); err != nil || reloads != 1 {
		t.Fatalf("updated: %v reloads=%d", err, reloads)
	}
	t.Setenv("HELPER_MODE", "freshclam-uptodate")
	if err := f.UpdateNow(ctx); err != nil || reloads != 1 {
		t.Fatalf("up to date: %v reloads=%d", err, reloads)
	}
	t.Setenv("HELPER_MODE", "freshclam-fail")
	if err := f.UpdateNow(ctx); err == nil || reloads != 1 {
		t.Fatalf("failure: %v reloads=%d", err, reloads)
	}
	if at, err := f.LastUpdate(); at.IsZero() || err == nil {
		t.Fatal("last update not recorded")
	}
	if UpdateInterval(12) != 2*time.Hour || UpdateInterval(0) != 24*time.Hour || UpdateInterval(99) != time.Hour {
		t.Fatal("interval")
	}
}
