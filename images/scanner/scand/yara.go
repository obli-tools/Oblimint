package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

// YARA through the yara CLI on the rules compiled by yarac at build time:
//
//	yara -C -g -m -w -a <timeout> <rules.yarc> <file>
//
// One line per matching rule: "<rule> [<tags>] [<meta>] <file>", tags
// comma-separated, meta as key="escaped string" / key=123 / key=true.

// Yara runs the CLI.
type Yara struct {
	Bin   string
	Rules string
	// PreArgs are inserted before the yara options (tests: helper process).
	PreArgs []string
	Env     []string
	Timeout time.Duration
}

// YaraMatch is one matching rule.
type YaraMatch struct {
	Rule string         `json:"rule"`
	Tags []string       `json:"tags"`
	Meta map[string]any `json:"meta"`
}

// Scan runs yara on one file.
func (y *Yara) Scan(ctx context.Context, file string) ([]YaraMatch, error) {
	timeout := y.Timeout
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	cctx, cancel := context.WithTimeout(ctx, timeout+5*time.Second)
	defer cancel()
	args := append(append([]string{}, y.PreArgs...), "-C", "-g", "-m", "-w", "-a", strconv.Itoa(int(timeout/time.Second)), y.Rules, file)
	cmd := exec.CommandContext(cctx, y.Bin, args...)
	if y.Env != nil {
		cmd.Env = append(os.Environ(), y.Env...)
	}
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &limitedBuffer{buf: &stdout, max: 1 << 20}
	cmd.Stderr = &limitedBuffer{buf: &stderr, max: 4096}
	err := cmd.Run()
	if cctx.Err() != nil {
		return nil, errors.New("yara timed out")
	}
	if err != nil {
		return nil, fmt.Errorf("yara failed: %s", truncate(strings.TrimSpace(stderr.String()), 200))
	}
	return ParseYaraOutput(stdout.String(), file)
}

// Version of the yara CLI ("4.5.2"), empty when it cannot run.
func (y *Yara) Version(ctx context.Context) string {
	cctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	args := append(append([]string{}, y.PreArgs...), "--version")
	cmd := exec.CommandContext(cctx, y.Bin, args...)
	if y.Env != nil {
		cmd.Env = append(os.Environ(), y.Env...)
	}
	out, err := cmd.Output()
	if err != nil {
		return ""
	}
	return truncate(strings.TrimSpace(string(out)), 40)
}

// ParseYaraOutput parses the -g -m output for `file`. Lines that do not end
// with the file name (warnings…) are ignored.
func ParseYaraOutput(out, file string) ([]YaraMatch, error) {
	var matches []YaraMatch
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimRight(line, "\r")
		if line == "" || !strings.HasSuffix(line, " "+file) {
			continue
		}
		m, err := parseYaraLine(strings.TrimSuffix(line, " "+file))
		if err != nil {
			return nil, err
		}
		matches = append(matches, m)
	}
	return matches, nil
}

func parseYaraLine(s string) (YaraMatch, error) {
	s = strings.TrimSpace(s)
	sp := strings.IndexByte(s, ' ')
	name := s
	rest := ""
	if sp >= 0 {
		name, rest = s[:sp], strings.TrimSpace(s[sp+1:])
	}
	if !validIdentifier(name) {
		return YaraMatch{}, fmt.Errorf("unexpected yara output %q", truncate(s, 80))
	}
	m := YaraMatch{Rule: name, Tags: []string{}, Meta: map[string]any{}}
	// Tags: first bracket group without '=' outside quotes.
	if strings.HasPrefix(rest, "[") {
		end := strings.IndexByte(rest, ']')
		if end < 0 {
			return YaraMatch{}, fmt.Errorf("unterminated yara tags in %q", truncate(s, 80))
		}
		inner := rest[1:end]
		if !strings.Contains(inner, "=") {
			for _, t := range strings.Split(inner, ",") {
				if t = strings.TrimSpace(t); validIdentifier(t) {
					m.Tags = append(m.Tags, t)
				}
			}
			rest = strings.TrimSpace(rest[end+1:])
		}
	}
	if strings.HasPrefix(rest, "[") {
		meta, err := parseYaraMeta(rest)
		if err != nil {
			return YaraMatch{}, err
		}
		m.Meta = meta
	}
	return m, nil
}

// parseYaraMeta parses [k="v",k2=12,k3=true] (yara escapes \" \\ \n \t \xNN and
// octal \NNN in strings; the decoded bytes are forced to valid UTF-8).
func parseYaraMeta(s string) (map[string]any, error) {
	meta := map[string]any{}
	if !strings.HasPrefix(s, "[") {
		return meta, nil
	}
	i := 1
	for i < len(s) && s[i] != ']' {
		start := i
		for i < len(s) && s[i] != '=' {
			i++
		}
		if i >= len(s) {
			return nil, errors.New("unterminated yara meta")
		}
		key := strings.TrimSpace(s[start:i])
		i++
		var val any
		if i < len(s) && s[i] == '"' {
			i++
			var b strings.Builder
			for i < len(s) && s[i] != '"' {
				if s[i] == '\\' && i+1 < len(s) {
					i++
					switch s[i] {
					case 'n':
						b.WriteByte('\n')
					case 't':
						b.WriteByte('\t')
					case 'x':
						if i+2 < len(s) {
							if v, err := strconv.ParseUint(s[i+1:i+3], 16, 8); err == nil {
								b.WriteByte(byte(v))
								i += 2
								break
							}
						}
						b.WriteByte('x')
					case '0', '1', '2', '3', '4', '5', '6', '7':
						// \NNN octal (1 to 3 digits): how the yara CLI prints every
						// non-ASCII byte of a meta string (UTF-8 "…" ⇒ \342\200\246).
						v, n := 0, 0
						for n < 3 && i+n < len(s) && s[i+n] >= '0' && s[i+n] <= '7' {
							v = v*8 + int(s[i+n]-'0')
							n++
						}
						if v > 0xff {
							// 3 digits above \377: only the first two belong to the escape.
							v, n = v>>3, n-1
						}
						b.WriteByte(byte(v))
						i += n
						continue
					default:
						b.WriteByte(s[i])
					}
					i++
					continue
				}
				b.WriteByte(s[i])
				i++
			}
			if i >= len(s) {
				return nil, errors.New("unterminated yara meta string")
			}
			i++ // closing quote
			val = strings.ToValidUTF8(b.String(), "�")
		} else {
			start := i
			for i < len(s) && s[i] != ',' && s[i] != ']' {
				i++
			}
			raw := strings.TrimSpace(s[start:i])
			switch {
			case raw == "true" || raw == "false":
				val = raw == "true"
			default:
				if n, err := strconv.ParseInt(raw, 10, 64); err == nil {
					val = n
				} else {
					val = raw
				}
			}
		}
		if validIdentifier(key) {
			meta[key] = val
		}
		if i < len(s) && s[i] == ',' {
			i++
		}
	}
	return meta, nil
}

func validIdentifier(s string) bool {
	if s == "" || len(s) > 128 {
		return false
	}
	for i, r := range s {
		ok := r == '_' || (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (i > 0 && r >= '0' && r <= '9')
		if !ok {
			return false
		}
	}
	return true
}

// RulesInfo is written at build time next to the compiled rules.
type RulesInfo struct {
	Version string `json:"version"`
	Count   int    `json:"count"`
}

// ReadRulesInfo reads the build-time rules metadata.
func ReadRulesInfo(path string) (RulesInfo, error) {
	var info RulesInfo
	b, err := os.ReadFile(path)
	if err != nil {
		return info, err
	}
	err = json.Unmarshal(b, &info)
	return info, err
}

type limitedBuffer struct {
	buf *bytes.Buffer
	max int
}

func (l *limitedBuffer) Write(p []byte) (int, error) {
	if room := l.max - l.buf.Len(); room > 0 {
		if len(p) > room {
			l.buf.Write(p[:room])
		} else {
			l.buf.Write(p)
		}
	}
	return len(p), nil
}
