package main

import (
	"bytes"
	"path"
	"regexp"
	"strings"
)

// ─────────────────────────────────────────────────────────────────────────────
// Typed data paths and supervised mode: what is "non-conforming"
// (docs/P3-PLAN.md §8). Pure functions over a file name and its bytes, table
// tested (classify_test.go).
//
// A file of a typed path is non-conforming when:
//   - extension (last one, case-insensitive) not in the whitelist ⇒ extension;
//   - PHP code anywhere ('<?php', '<?=', '<script language="php"', in a text
//     file also '<?' + blank) ⇒ php-content, or polyglot when the file starts
//     with a valid media signature (a JPEG carrying PHP);
//   - an executable / code real type (ELF, '#!', phar stub, HTML with script
//     behind an image extension) ⇒ magic-mismatch. A JPEG that is really a
//     PNG stays conforming (same family: nothing executable);
//   - not a regular file (symlink, fifo, socket, device) ⇒ special.
// Text types (svg, txt, csv, json, css, js, map…) only get the PHP check.
// ─────────────────────────────────────────────────────────────────────────────

const (
	// Files up to sniffWholeLimit are searched entirely; beyond, the first and
	// last sniffEdgeBytes.
	sniffWholeLimit = 32 << 20
	sniffEdgeBytes  = 1 << 20
)

type verdict struct {
	Reason       string // "" = conforming
	Detail       string
	DetectedType string
}

func (v verdict) ok() bool { return v.Reason == "" }

// normalizeExtensions lower-cases and strips the leading dot.
func normalizeExtensions(list []string) map[string]bool {
	out := make(map[string]bool, len(list))
	for _, e := range list {
		e = strings.ToLower(strings.TrimPrefix(strings.TrimSpace(e), "."))
		if e != "" {
			out[e] = true
		}
	}
	return out
}

// fileExtension is the last extension, lower-case, without the dot ("" when
// none; ".htaccess" → "htaccess").
func fileExtension(name string) string {
	return strings.ToLower(strings.TrimPrefix(path.Ext(name), "."))
}

var textExtensions = map[string]bool{
	"svg": true, "txt": true, "csv": true, "tsv": true, "json": true, "css": true, "js": true, "mjs": true,
	"map": true, "xml": true, "md": true, "html": true, "htm": true, "vtt": true, "srt": true, "ics": true,
	"log": true, "yml": true, "yaml": true, "ini": true,
}

var imageExtensions = map[string]bool{
	"jpg": true, "jpeg": true, "jpe": true, "png": true, "gif": true, "webp": true, "avif": true, "heic": true,
	"heif": true, "bmp": true, "tif": true, "tiff": true, "ico": true,
}

// detectMagic names the real type of a content from its first bytes ("" =
// unknown). Executable / code types: elf, shebang.
func detectMagic(b []byte) string {
	has := func(off int, sig string) bool {
		return len(b) >= off+len(sig) && string(b[off:off+len(sig)]) == sig
	}
	switch {
	case has(0, "\x7fELF"):
		return "elf"
	case has(0, "#!"):
		return "shebang"
	case has(0, "\xff\xd8\xff"):
		return "jpeg"
	case has(0, "\x89PNG"):
		return "png"
	case has(0, "GIF8"):
		return "gif"
	case has(0, "RIFF") && has(8, "WEBP"):
		return "webp"
	case has(0, "RIFF") && has(8, "WAVE"):
		return "wav"
	case has(4, "ftyp"):
		if len(b) >= 12 {
			switch string(b[8:12]) {
			case "avif", "avis":
				return "avif"
			case "heic", "heix", "heim", "heis", "mif1", "msf1":
				return "heic"
			case "qt  ":
				return "mov"
			}
		}
		return "mp4"
	case has(0, "BM"):
		return "bmp"
	case has(0, "II*\x00"), has(0, "MM\x00*"):
		return "tiff"
	case has(0, "\x00\x00\x01\x00"):
		return "ico"
	case has(0, "%PDF"):
		return "pdf"
	case has(0, "PK\x03\x04"), has(0, "PK\x05\x06"):
		return "zip"
	case has(0, "\x1a\x45\xdf\xa3"):
		return "webm"
	case has(0, "ID3"):
		return "mp3"
	case len(b) >= 2 && b[0] == 0xff && b[1]&0xe0 == 0xe0:
		return "mp3"
	case has(0, "OggS"):
		return "ogg"
	case has(0, "wOFF"):
		return "woff"
	case has(0, "wOF2"):
		return "woff2"
	case has(0, "\x00\x01\x00\x00"):
		return "ttf"
	case has(0, "OTTO"):
		return "otf"
	}
	return ""
}

// mediaTypes are the signatures that make a PHP-carrying file a polyglot.
func isMediaType(t string) bool {
	switch t {
	case "", "elf", "shebang":
		return false
	}
	return true
}

var (
	// In a text file: any PHP open tag, including the short '<?' + blank.
	phpTextRe = regexp.MustCompile(`(?i)<\?php|<\?=|<script\s+language\s*=\s*["']?php|<\?\s`)
	// In a binary file '<?=' alone is 3 bytes a photo carries by chance: it
	// counts only followed by 8 printable characters or blanks (code, not
	// noise; PHP accepts any blank after the tag, tab / CR / LF included).
	phpBinaryRe = regexp.MustCompile(`(?i)<\?php|<\?=[\t\n\r\x20-\x7e]{8}|<script\s+language\s*=\s*["']?php`)
)

// findPHP returns the PHP marker found in b ("" = none).
func findPHP(b []byte, text bool) string {
	re := phpBinaryRe
	if text {
		re = phpTextRe
	}
	loc := re.FindIndex(b)
	if loc == nil {
		return ""
	}
	m := b[loc[0]:min(loc[1], loc[0]+24)]
	return strings.ToLower(strings.TrimSpace(string(m)))
}

// looksText: no NUL byte in the first 8 KiB.
func looksText(head []byte) bool {
	return bytes.IndexByte(head[:min(len(head), 8192)], 0) < 0
}

var htmlMarkers = [][]byte{[]byte("<script"), []byte("<html"), []byte("<!doctype html"), []byte("<iframe"), []byte("<svg"), []byte("javascript:")}

// looksHTML: markup with active content (a browser sniffing it would run it).
func looksHTML(head []byte) bool {
	h := bytes.TrimLeft(bytes.TrimPrefix(head, []byte("\xef\xbb\xbf")), " \t\r\n")
	if len(h) == 0 || h[0] != '<' {
		return false
	}
	low := bytes.ToLower(h[:min(len(h), 64<<10)])
	for _, m := range htmlMarkers {
		if bytes.Contains(low, m) {
			return true
		}
	}
	return false
}

var pharMarkers = [][]byte{[]byte("__HALT_COMPILER"), []byte(".phar/stub.php")}

func hasPhar(b []byte) bool {
	for _, m := range pharMarkers {
		if bytes.Contains(b, m) {
			return true
		}
	}
	return false
}

// classifyTyped decides whether a regular file of a typed path conforms.
// head is the whole content (≤ 32 MiB) or its first MiB, tail its last MiB
// (nil when head is the whole content).
func classifyTyped(name string, head, tail []byte, allowed map[string]bool) verdict {
	ext := fileExtension(name)
	if !allowed[ext] {
		detail := "." + ext
		if ext == "" {
			detail = "sans extension"
		}
		return verdict{Reason: reasonExtension, Detail: detail, DetectedType: detectMagic(head)}
	}
	detected := detectMagic(head)
	text := textExtensions[ext] || (detected == "" && looksText(head))
	marker := findPHP(head, text)
	if marker == "" && tail != nil {
		marker = findPHP(tail, text)
	}
	if marker != "" {
		if isMediaType(detected) {
			return verdict{Reason: reasonPolyglot, Detail: marker, DetectedType: detected}
		}
		return verdict{Reason: reasonPHPContent, Detail: marker, DetectedType: orText(detected, text)}
	}
	if textExtensions[ext] {
		return verdict{DetectedType: orText(detected, true)}
	}
	switch {
	case detected == "elf" || detected == "shebang":
		return verdict{Reason: reasonMagicMismatch, Detail: detected, DetectedType: detected}
	case hasPhar(head) || (tail != nil && hasPhar(tail)):
		return verdict{Reason: reasonMagicMismatch, Detail: "phar", DetectedType: "phar"}
	case imageExtensions[ext] && looksHTML(head):
		return verdict{Reason: reasonMagicMismatch, Detail: "html", DetectedType: "html"}
	}
	return verdict{DetectedType: detected}
}

func orText(detected string, text bool) string {
	if detected == "" && text {
		return "text"
	}
	return detected
}

// ── Supervised mode ──────────────────────────────────────────────────────────

var executableExtensions = map[string]bool{
	"php": true, "php3": true, "php4": true, "php5": true, "php6": true, "php7": true, "php8": true,
	"phtml": true, "pht": true, "phps": true, "phar": true, "inc": true, "cgi": true, "pl": true, "py": true, "sh": true,
}

// isExecutableName: a name the site would execute (or that changes how it executes).
func isExecutableName(name string) bool {
	low := strings.ToLower(name)
	if low == ".htaccess" || low == ".user.ini" || strings.HasSuffix(low, ".htaccess") || strings.HasSuffix(low, ".user.ini") {
		return true
	}
	return executableExtensions[fileExtension(low)]
}

// startsExecutable: content starting with '<?php' (after a BOM / blanks) or '#!'.
func startsExecutable(head []byte) bool {
	if bytes.HasPrefix(head, []byte("#!")) {
		return true
	}
	h := bytes.TrimLeft(bytes.TrimPrefix(head, []byte("\xef\xbb\xbf")), " \t\r\n")
	return len(h) >= 5 && strings.EqualFold(string(h[:5]), "<?php")
}
