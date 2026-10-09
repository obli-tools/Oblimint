package main

// customNginx — the site owner's own nginx rules (nginx bases only).
//
// They are written VERBATIM to <out>/custom.conf and included inside the
// site's server{} block: they only ever reach the site's own unprivileged
// container (H5), never the shared edge. Still, a few structural checks run
// before they are accepted, so that a rule set cannot close the server{}
// block and append a second server / http-level directive behind our back:
//
//   - ≤ 64 KiB, valid UTF-8, no control character except TAB / LF / CR;
//   - balanced braces (outside quotes and comments), never closing more than
//     it opened, every statement terminated, quotes closed;
//   - no `include` / `load_module` (no reading arbitrary container files into
//     the config, no module loading).
//
// When a check fails the site starts WITHOUT the custom rules and the reason
// goes to stderr (never a crash loop). The final judge remains `nginx -t`,
// run by the entrypoint / oblimint-reload with the same fallback.

import (
	"fmt"
	"strings"
	"unicode/utf8"
)

const maxCustomNginxBytes = 64 * 1024

var forbiddenCustomDirectives = map[string]bool{
	"include":     true,
	"load_module": true,
}

// CustomRules is the outcome of CheckCustomNginx.
type CustomRules struct {
	// Content to write to custom.conf ("" = none).
	Content string
	// TopLocations: argument strings of the top-level `location` blocks
	// ("/", "= /x", "~ \.php$"…), used to avoid duplicating our defaults.
	TopLocations []string
	// Rejected: why the rules were dropped ("" when accepted or absent).
	Rejected string
}

// DefinesLocation reports whether the rules contain `location <args> {` at
// the top level (args compared after whitespace normalization).
func (r CustomRules) DefinesLocation(args string) bool {
	for _, l := range r.TopLocations {
		if l == args {
			return true
		}
	}
	return false
}

// CheckCustomNginx validates the raw customNginx value.
func CheckCustomNginx(raw *string) CustomRules {
	if raw == nil || strings.TrimSpace(*raw) == "" {
		return CustomRules{}
	}
	s := strings.ReplaceAll(*raw, "\r\n", "\n")
	reject := func(format string, args ...any) CustomRules {
		return CustomRules{Rejected: fmt.Sprintf(format, args...)}
	}
	if len(s) > maxCustomNginxBytes {
		return reject("custom nginx rules larger than %d bytes", maxCustomNginxBytes)
	}
	if !utf8.ValidString(s) {
		return reject("custom nginx rules are not valid UTF-8")
	}
	for _, r := range s {
		if (r < 0x20 && r != '\t' && r != '\n' && r != '\r') || r == 0x7f {
			return reject("custom nginx rules contain a control character (U+%04X)", r)
		}
	}
	locs, err := scanNginx(s)
	if err != nil {
		return reject("custom nginx rules: %v", err)
	}
	if !strings.HasSuffix(s, "\n") {
		s += "\n"
	}
	return CustomRules{Content: s, TopLocations: locs}
}

// scanNginx is a small nginx-syntax lexer: words (bare, '…', "…" with
// backslash escapes, ${var} inside bare words), `;`, `{`, `}`, # comments.
// It returns the arguments of the top-level location blocks.
//
// It follows ngx_conf_read_token wherever the two could disagree on the
// block structure: inside a bare word, `{` belongs to the word ONLY right
// after an unescaped `$` (and we further require `${name}` with name in
// [A-Za-z0-9_]+, so nothing else can hide inside it); `;`, `{` and
// whitespace end a word; a `}` inside a word is an ordinary character (nginx
// closes a block only with a `}` at the start of a token).
func scanNginx(s string) ([]string, error) {
	var (
		words     []string
		depth     int
		line      = 1
		topLocs   []string
		cur       strings.Builder
		inWord    bool
		variable  bool     // previous byte was an unescaped '$' inside a bare word
		blockName []string // directive name per open block
	)
	flushWord := func() {
		if inWord {
			words = append(words, cur.String())
			cur.Reset()
			inWord = false
		}
	}
	endStatement := func(kind byte) error {
		flushWord()
		if len(words) == 0 {
			if kind == '{' {
				return fmt.Errorf("line %d: block without a directive", line)
			}
			if kind == ';' {
				return fmt.Errorf("line %d: empty statement", line)
			}
			return nil
		}
		name := words[0]
		if forbiddenCustomDirectives[name] {
			return fmt.Errorf("line %d: directive %q is not allowed", line, name)
		}
		if kind == '{' {
			if depth == 0 && name == "location" {
				topLocs = append(topLocs, strings.Join(words[1:], " "))
			}
			blockName = append(blockName, name)
			depth++
		}
		words = words[:0]
		return nil
	}

	for i := 0; i < len(s); i++ {
		c := s[i]
		afterDollar := variable
		variable = false
		switch {
		case c == '\n':
			flushWord()
			line++
		case c == ' ' || c == '\t' || c == '\r':
			flushWord()
		case c == '#' && !inWord:
			for i < len(s) && s[i] != '\n' {
				i++
			}
			i-- // let the newline be processed (line counter)
		case (c == '"' || c == '\'') && !inWord:
			quote := c
			var b strings.Builder
			closed := false
			for i++; i < len(s); i++ {
				ch := s[i]
				if ch == '\\' && i+1 < len(s) {
					b.WriteByte(ch)
					b.WriteByte(s[i+1])
					i++
					continue
				}
				if ch == '\n' {
					line++
				}
				if ch == quote {
					closed = true
					break
				}
				b.WriteByte(ch)
			}
			if !closed {
				return nil, fmt.Errorf("line %d: unterminated quoted string", line)
			}
			words = append(words, b.String())
		case c == ';':
			if err := endStatement(';'); err != nil {
				return nil, err
			}
		case c == '{':
			if inWord && afterDollar {
				// ${variable} inside a bare word: a variable name, then '}'.
				j := i + 1
				for j < len(s) && isVarNameByte(s[j]) {
					j++
				}
				if j == i+1 || j >= len(s) || s[j] != '}' {
					return nil, fmt.Errorf("line %d: invalid ${variable} (expected ${name})", line)
				}
				cur.WriteString(s[i : j+1])
				i = j
				continue
			}
			if err := endStatement('{'); err != nil {
				return nil, err
			}
		case c == '}' && inWord:
			// nginx: a '}' inside a word is part of the word.
			cur.WriteByte(c)
		case c == '}':
			flushWord()
			if len(words) > 0 {
				return nil, fmt.Errorf("line %d: unterminated statement %q before '}'", line, words[0])
			}
			if depth == 0 {
				return nil, fmt.Errorf("line %d: unexpected '}' (closes a block it did not open)", line)
			}
			depth--
			blockName = blockName[:len(blockName)-1]
		case c == '\\' && i+1 < len(s):
			cur.WriteByte(c)
			cur.WriteByte(s[i+1])
			inWord = true
			i++
		default:
			cur.WriteByte(c)
			inWord = true
			variable = c == '$'
		}
	}
	flushWord()
	if len(words) > 0 {
		return nil, fmt.Errorf("unterminated statement %q at end of rules", words[0])
	}
	if depth != 0 {
		return nil, fmt.Errorf("%d unclosed block(s) (%s)", depth, strings.Join(blockName, ", "))
	}
	return topLocs, nil
}

func isVarNameByte(b byte) bool {
	return b == '_' || (b >= 'a' && b <= 'z') || (b >= 'A' && b <= 'Z') || (b >= '0' && b <= '9')
}
