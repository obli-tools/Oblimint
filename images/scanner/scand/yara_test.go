package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// TestHelperProcess is not a test: it impersonates the yara / freshclam CLIs
// when the tests exec the test binary itself (HELPER_MODE selects the behaviour).
func TestHelperProcess(t *testing.T) {
	mode := os.Getenv("HELPER_MODE")
	if mode == "" {
		return
	}
	args := os.Args
	for i, a := range args {
		if a == "--" {
			args = args[i+1:]
			break
		}
	}
	file := args[len(args)-1]
	switch mode {
	case "yara-version":
		fmt.Println("4.5.2")
	case "yara-match":
		fmt.Fprintf(os.Stdout, "Oblimint_Php_EvalDecode [php,obfuscation] [description=\"eval of \\\"decoded\\\" data\",score=70,severity=\"critical\"] %s\n", file)
		fmt.Fprintf(os.Stdout, "Oblimint_Webshell_Marker [] [score=80] %s\n", file)
		fmt.Fprintln(os.Stdout, "warning: something unrelated")
	case "yara-clean":
	case "yara-fail":
		fmt.Fprintln(os.Stderr, "error: could not open file")
		os.Exit(1)
	case "yara-hang":
		time.Sleep(30 * time.Second)
	case "yara-args":
		fmt.Fprintf(os.Stdout, "Args_%d [] [joined=\"%s\"] %s\n", len(args), strings.Join(args[:len(args)-1], " "), file)
	case "freshclam-updated":
	case "freshclam-uptodate":
		os.Exit(1)
	case "freshclam-fail":
		fmt.Println("ERROR: Can't download daily.cvd")
		os.Exit(55)
	}
	os.Exit(0)
}

func helperYara(t *testing.T, mode string) *Yara {
	t.Setenv("HELPER_MODE", mode)
	return &Yara{Bin: os.Args[0], Rules: "/rules.yarc", PreArgs: []string{"-test.run=TestHelperProcess", "--"}, Timeout: 2 * time.Second}
}

func tempFile(t *testing.T) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "scan-1")
	if err := os.WriteFile(p, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestYaraScanMatches(t *testing.T) {
	file := tempFile(t)
	m, err := helperYara(t, "yara-match").Scan(context.Background(), file)
	if err != nil {
		t.Fatal(err)
	}
	if len(m) != 2 {
		t.Fatalf("matches: %+v", m)
	}
	if m[0].Rule != "Oblimint_Php_EvalDecode" || strings.Join(m[0].Tags, ",") != "php,obfuscation" {
		t.Fatalf("first: %+v", m[0])
	}
	if m[0].Meta["description"] != `eval of "decoded" data` || m[0].Meta["score"] != int64(70) || m[0].Meta["severity"] != "critical" {
		t.Fatalf("meta: %#v", m[0].Meta)
	}
	if m[1].Rule != "Oblimint_Webshell_Marker" || len(m[1].Tags) != 0 || m[1].Meta["score"] != int64(80) {
		t.Fatalf("second: %+v", m[1])
	}
}

func TestYaraArguments(t *testing.T) {
	file := tempFile(t)
	m, err := helperYara(t, "yara-args").Scan(context.Background(), file)
	if err != nil || len(m) != 1 {
		t.Fatal(m, err)
	}
	if got := m[0].Meta["joined"]; got != "-C -g -m -w -a 2 /rules.yarc" {
		t.Fatalf("argv: %q", got)
	}
}

func TestYaraCleanFailTimeout(t *testing.T) {
	file := tempFile(t)
	if m, err := helperYara(t, "yara-clean").Scan(context.Background(), file); err != nil || len(m) != 0 {
		t.Fatal(m, err)
	}
	if _, err := helperYara(t, "yara-fail").Scan(context.Background(), file); err == nil || !strings.Contains(err.Error(), "could not open") {
		t.Fatalf("fail: %v", err)
	}
	y := helperYara(t, "yara-hang")
	y.Timeout = time.Second
	start := time.Now()
	if _, err := y.Scan(context.Background(), file); err == nil || err.Error() != "yara timed out" {
		t.Fatalf("hang: %v", err)
	}
	if time.Since(start) > 15*time.Second {
		t.Fatal("timeout not enforced")
	}
}

func TestYaraVersion(t *testing.T) {
	if v := helperYara(t, "yara-version").Version(context.Background()); v != "4.5.2" {
		t.Fatalf("version %q", v)
	}
	y := &Yara{Bin: filepath.Join(t.TempDir(), "missing-yara")}
	if v := y.Version(context.Background()); v != "" {
		t.Fatalf("missing binary: %q", v)
	}
}

func TestParseYaraOutput(t *testing.T) {
	const f = "/tmp/scan-42"
	out := strings.Join([]string{
		"Rule_A [] [] " + f,
		"Rule_B [t1] " + f,
		`Rule_C [x="a\\b,c]d",n=-3,b=false,hex="\x41"] ` + f,
		"Rule_D " + f,
		// the yara CLI prints non-ASCII meta bytes in octal (UTF-8 "…" = \342\200\246)
		`Rule_F [d="str_rot13\342\200\246",o="\101\0619\400",bad="\377"] ` + f,
		"Rule_E [] [] /tmp/other-file",
		"",
	}, "\n")
	m, err := ParseYaraOutput(out, f)
	if err != nil {
		t.Fatal(err)
	}
	if len(m) != 5 {
		t.Fatalf("%+v", m)
	}
	if m[1].Tags[0] != "t1" || len(m[1].Meta) != 0 {
		t.Fatalf("B: %+v", m[1])
	}
	if m[2].Meta["x"] != `a\b,c]d` || m[2].Meta["n"] != int64(-3) || m[2].Meta["b"] != false || m[2].Meta["hex"] != "A" {
		t.Fatalf("C: %#v", m[2].Meta)
	}
	// \400 is not a byte: \40 (space) then a literal 0; invalid UTF-8 ⇒ U+FFFD.
	if m[4].Rule != "Rule_F" || m[4].Meta["d"] != "str_rot13…" || m[4].Meta["o"] != "A19 0" || m[4].Meta["bad"] != "�" {
		t.Fatalf("F: %#v", m[4].Meta)
	}
	if _, err := ParseYaraOutput("1bad [] [] "+f, f); err == nil {
		t.Fatal("invalid rule name accepted")
	}
	if _, err := ParseYaraOutput(`Rule_X [a="unterminated] `+f, f); err == nil {
		t.Fatal("unterminated meta accepted")
	}
}

func TestReadRulesInfo(t *testing.T) {
	p := filepath.Join(t.TempDir(), "rules.json")
	_ = os.WriteFile(p, []byte(`{"version":"oblimint-1","count":33}`), 0o600)
	info, err := ReadRulesInfo(p)
	if err != nil || info.Count != 33 || info.Version != "oblimint-1" {
		t.Fatal(info, err)
	}
	if _, err := ReadRulesInfo(p + ".missing"); err == nil {
		t.Fatal("missing file accepted")
	}
}
