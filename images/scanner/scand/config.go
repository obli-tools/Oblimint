package main

import (
	"errors"
	"fmt"
	"io"
	"net"
	"net/netip"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// Runtime configuration from the environment (set by the panel, see
// server/src/services/scan/scannerSpec.ts) and the clamd / freshclam
// configuration files rendered into /run at start (the root is read-only).

// ClamdTCPPort is the clamd TCP port opened by OBLIMINT_CLAMD_TCP=1 (panel:
// naming.ts SCANNER_CLAMD_PORT).
const ClamdTCPPort = 3310

// Config of scand.
type Config struct {
	Addr            string
	Key             string
	ClamAV          bool
	Yara            bool
	FreshclamChecks int
	MaxFileMB       int
	Concurrency     int
	ClamdAddr       string
	// ClamdTCP: clamd also listens on TCP ClamdTCPPort (OBLIMINT_CLAMD_TCP=1), for
	// Rspamd on oblimint-mail-core (P4, engine postfix-dovecot with mail.clamav).
	// Off by default: clamd has no authentication, the port only exists when
	// the panel asks, and only on the container's address inside
	// ClamdTCPNets (OBLIMINT_CLAMD_TCP_NETS, the subnets of oblimint-mail-core)
	// — never on the panel network (risk R-CLAMD-TCP).
	ClamdTCP     bool
	ClamdTCPNets []netip.Prefix
	// ClamdTCPAddr: the address clamd binds (resolved at start by
	// ResolveClamdTCPAddr); empty ⇒ no TCP socket at all (fail closed).
	ClamdTCPAddr string
	RunDir       string
	DatabaseDir  string
	SeedDir      string
	TmpDir       string
	YaraBin      string
	YaraRules    string
	RulesInfo    string
	ClamdBin     string
	FreshclamBin string
}

func envInt(get func(string) string, name string, def, min, max int) (int, error) {
	v := strings.TrimSpace(get(name))
	if v == "" {
		return def, nil
	}
	n, err := strconv.Atoi(v)
	if err != nil || n < min || n > max {
		return 0, fmt.Errorf("%s must be an integer in [%d, %d] (got %q)", name, min, max, v)
	}
	return n, nil
}

func envBool(get func(string) string, name string, def bool) (bool, error) {
	switch strings.TrimSpace(get(name)) {
	case "":
		return def, nil
	case "1", "true", "yes":
		return true, nil
	case "0", "false", "no":
		return false, nil
	}
	return false, fmt.Errorf("%s must be 0 or 1", name)
}

func envStr(get func(string) string, name, def string) string {
	if v := strings.TrimSpace(get(name)); v != "" {
		return v
	}
	return def
}

// LoadConfig reads the environment through get (os.Getenv in production).
func LoadConfig(get func(string) string) (Config, error) {
	c := Config{
		Addr:         envStr(get, "SCAND_ADDR", ":8080"),
		Key:          get("SCAND_KEY"),
		ClamdAddr:    envStr(get, "SCAND_CLAMD_ADDR", "unix:/run/clamav/clamd.sock"),
		RunDir:       envStr(get, "SCAND_RUN_DIR", "/run/oblimint-scanner"),
		DatabaseDir:  envStr(get, "SCAND_DATABASE_DIR", "/var/lib/clamav"),
		SeedDir:      envStr(get, "SCAND_SEED_DIR", "/usr/share/oblimint-scanner/clamav-seed"),
		TmpDir:       envStr(get, "SCAND_TMP_DIR", "/tmp"),
		YaraBin:      envStr(get, "SCAND_YARA_BIN", "yara"),
		YaraRules:    envStr(get, "SCAND_YARA_RULES", "/usr/share/oblimint-scanner/rules.yarc"),
		RulesInfo:    envStr(get, "SCAND_RULES_INFO", "/usr/share/oblimint-scanner/rules.json"),
		ClamdBin:     envStr(get, "SCAND_CLAMD_BIN", "clamd"),
		FreshclamBin: envStr(get, "SCAND_FRESHCLAM_BIN", "freshclam"),
	}
	if len(c.Key) < 16 {
		return c, errors.New("SCAND_KEY is required (≥ 16 characters)")
	}
	var err error
	if c.ClamAV, err = envBool(get, "SCAND_CLAMAV", true); err != nil {
		return c, err
	}
	if c.Yara, err = envBool(get, "SCAND_YARA", true); err != nil {
		return c, err
	}
	if c.ClamdTCP, err = envBool(get, "OBLIMINT_CLAMD_TCP", false); err != nil {
		return c, err
	}
	if c.ClamdTCP {
		raw := strings.TrimSpace(get("OBLIMINT_CLAMD_TCP_NETS"))
		if raw == "" {
			return c, errors.New("OBLIMINT_CLAMD_TCP_NETS is required with OBLIMINT_CLAMD_TCP=1")
		}
		for _, p := range strings.Split(raw, ",") {
			pfx, perr := netip.ParsePrefix(strings.TrimSpace(p))
			if perr != nil || pfx.Bits() == 0 {
				return c, fmt.Errorf("OBLIMINT_CLAMD_TCP_NETS: invalid subnet %q", p)
			}
			c.ClamdTCPNets = append(c.ClamdTCPNets, pfx.Masked())
		}
	}
	if c.FreshclamChecks, err = envInt(get, "FRESHCLAM_CHECKS", 12, 1, 24); err != nil {
		return c, err
	}
	if c.MaxFileMB, err = envInt(get, "SCAND_MAX_FILE_MB", 32, 1, 512); err != nil {
		return c, err
	}
	if c.Concurrency, err = envInt(get, "SCAND_CONCURRENCY", 4, 1, 32); err != nil {
		return c, err
	}
	if _, _, err = ParseClamdAddr(c.ClamdAddr); err != nil {
		return c, err
	}
	return c, nil
}

// MaxFileBytes accepted by POST /v1/scan.
func (c Config) MaxFileBytes() int64 { return int64(c.MaxFileMB) << 20 }

// ClamdConf renders clamd.conf. Limits cover the panel's maxFileSizeMb; no
// PUA; reloads are NOT concurrent (a concurrent reload holds two copies of the
// signatures in memory: ≈ 2 GiB, above the container limit).
//
// No LogFile: in the foreground clamd logs to its stdout / stderr, which the
// supervisor forwards to the container log. clamd opens LogFile with
// O_NOFOLLOW, so the obvious "LogFile /dev/stderr" (a symlink to
// /proc/self/fd/2) fails with ELOOP — "Can't initialize the internal logger"
// — and clamd exits at once, in a restart loop.
func (c Config) ClamdConf() string {
	_, sock, _ := ParseClamdAddr(c.ClamdAddr)
	maxMB := c.MaxFileMB + 1
	scanMB := 4 * c.MaxFileMB
	if scanMB < 100 {
		scanMB = 100
	}
	lines := []string{
		"# Rendered by scand at start (images/scanner) — do not edit.",
		"Foreground yes",
		"LogTime yes",
		"LogClean no",
		"LocalSocket " + sock,
		"LocalSocketMode 600",
		"FixStaleSocket yes",
		"DatabaseDirectory " + c.DatabaseDir,
		"TemporaryDirectory " + c.TmpDir,
		fmt.Sprintf("MaxThreads %d", c.Concurrency),
		"MaxQueue 32",
		"ReadTimeout 120",
		"CommandReadTimeout 30",
		"SelfCheck 3600",
		"ConcurrentDatabaseReload no",
		fmt.Sprintf("StreamMaxLength %dM", maxMB),
		fmt.Sprintf("MaxFileSize %dM", maxMB),
		fmt.Sprintf("MaxScanSize %dM", scanMB),
		"MaxRecursion 16",
		"MaxFiles 10000",
		"DetectPUA no",
		"HeuristicAlerts yes",
		"ScanPE yes",
		"ScanELF yes",
		"ScanArchive yes",
		"ScanHTML yes",
		"ScanPDF yes",
		"Bytecode yes",
	}
	if c.ClamdTCP && c.ClamdTCPAddr != "" {
		// Only the container's address on oblimint-mail-core (risk
		// R-CLAMD-TCP: clamd has no authentication; the panel network never
		// reaches it).
		lines = append(lines, fmt.Sprintf("TCPSocket %d", ClamdTCPPort), "TCPAddr "+c.ClamdTCPAddr)
	}
	return strings.Join(lines, "\n") + "\n"
}

// FreshclamConf renders freshclam.conf (one-shot runs driven by scand).
// TestDatabases no: testing a new database loads it in a second process
// (≈ 1 GiB more) — clamd validates it at reload anyway.
func (c Config) FreshclamConf() string {
	lines := []string{
		"# Rendered by scand at start (images/scanner) — do not edit.",
		"DatabaseDirectory " + c.DatabaseDir,
		"DatabaseOwner scand",
		"LogTime yes",
		"LogVerbose no",
		"DatabaseMirror database.clamav.net",
		"DNSDatabaseInfo current.cvd.clamav.net",
		"ConnectTimeout 30",
		"ReceiveTimeout 300",
		"MaxAttempts 3",
		"TestDatabases no",
		"Bytecode yes",
		"Foreground yes",
	}
	return strings.Join(lines, "\n") + "\n"
}

// WriteConfigs renders both files into RunDir (0600) and returns their paths.
func (c Config) WriteConfigs() (clamdConf, freshclamConf string, err error) {
	if err = os.MkdirAll(c.RunDir, 0o700); err != nil {
		return "", "", err
	}
	_, sock, _ := ParseClamdAddr(c.ClamdAddr)
	if strings.HasPrefix(c.ClamdAddr, "unix:") {
		if err = os.MkdirAll(filepath.Dir(sock), 0o700); err != nil {
			return "", "", err
		}
	}
	clamdConf = filepath.Join(c.RunDir, "clamd.conf")
	freshclamConf = filepath.Join(c.RunDir, "freshclam.conf")
	if err = os.WriteFile(clamdConf, []byte(c.ClamdConf()), 0o600); err != nil {
		return "", "", err
	}
	if err = os.WriteFile(freshclamConf, []byte(c.FreshclamConf()), 0o600); err != nil {
		return "", "", err
	}
	return clamdConf, freshclamConf, nil
}

// hasDatabase: a main and a daily database (.cvd or .cld) are present.
func hasDatabase(dir string) bool {
	has := func(base string) bool {
		for _, ext := range []string{".cvd", ".cld"} {
			if st, err := os.Stat(filepath.Join(dir, base+ext)); err == nil && st.Mode().IsRegular() && st.Size() > 0 {
				return true
			}
		}
		return false
	}
	return has("main") && has("daily")
}

// SeedDatabase copies the signatures baked in the image into an empty
// database directory (first start: clamd can load at once, freshclam then
// brings them up to date). Returns the number of files copied.
func SeedDatabase(dbDir, seedDir string) (int, error) {
	if hasDatabase(dbDir) {
		return 0, nil
	}
	entries, err := os.ReadDir(seedDir)
	if err != nil {
		return 0, err
	}
	n := 0
	for _, e := range entries {
		if !e.Type().IsRegular() {
			continue
		}
		name := e.Name()
		if !(strings.HasSuffix(name, ".cvd") || strings.HasSuffix(name, ".cld") || strings.HasSuffix(name, ".cdiff")) {
			continue
		}
		if err := copyFile(filepath.Join(seedDir, name), filepath.Join(dbDir, name)); err != nil {
			return n, err
		}
		n++
	}
	return n, nil
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	tmp := dst + ".seed-tmp"
	out, err := os.OpenFile(tmp, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		os.Remove(tmp)
		return err
	}
	if err := out.Close(); err != nil {
		os.Remove(tmp)
		return err
	}
	return os.Rename(tmp, dst)
}

// PickClamdTCPAddr returns the first address of addrs inside one of nets
// ("" when none): the container's address on oblimint-mail-core.
func PickClamdTCPAddr(addrs []net.Addr, nets []netip.Prefix) string {
	for _, a := range addrs {
		var ip net.IP
		switch v := a.(type) {
		case *net.IPNet:
			ip = v.IP
		case *net.IPAddr:
			ip = v.IP
		default:
			continue
		}
		addr, ok := netip.AddrFromSlice(ip)
		if !ok {
			continue
		}
		addr = addr.Unmap()
		if addr.IsLoopback() || addr.IsUnspecified() || addr.IsLinkLocalUnicast() {
			continue
		}
		for _, n := range nets {
			if n.Contains(addr) {
				return addr.String()
			}
		}
	}
	return ""
}

// ResolveClamdTCPAddr waits (up to wait) for an interface address inside
// c.ClamdTCPNets: the panel attaches oblimint-mail-core before starting the
// container, the wait only covers a slow interface. "" ⇒ clamd gets no TCP
// socket (the panel notices and recreates the container).
func (c Config) ResolveClamdTCPAddr(wait time.Duration, interfaceAddrs func() ([]net.Addr, error)) string {
	if !c.ClamdTCP || len(c.ClamdTCPNets) == 0 {
		return ""
	}
	deadline := time.Now().Add(wait)
	for {
		if addrs, err := interfaceAddrs(); err == nil {
			if a := PickClamdTCPAddr(addrs, c.ClamdTCPNets); a != "" {
				return a
			}
		}
		if time.Now().After(deadline) {
			return ""
		}
		time.Sleep(time.Second)
	}
}
