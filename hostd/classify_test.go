package main

import (
	"strings"
	"testing"
)

// Fixtures are assembled at run time from fragments with harmless payloads:
// literal webshell-looking strings make antivirus software quarantine the
// test file itself on a development box.
var (
	jpegHead = "\xff\xd8\xff\xe0\x00\x10JFIF\x00"
	pngHead  = "\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR"
	gifHead  = "GIF89a\x01\x00"
	webpHead = "RIFF\x24\x00\x00\x00WEBPVP8 "
	pdfHead  = "%PDF-1.7\n"
	zipHead  = "PK\x03\x04\x14\x00"
	elfHead  = "\x7fELF\x02\x01\x01"

	phpOpen  = "<" + "?" + "php"
	phpUpper = "<" + "?" + "PHP"
	phpEcho  = "<" + "?="
	phpShort = "<" + "? "
	phpTag   = "<script language=" + `"` + "php" + `"` + ">"
)

func TestClassifyTyped(t *testing.T) {
	media := normalizeExtensions([]string{"JPG", ".jpeg", "png", "gif", "webp", "pdf", "zip", "svg", "txt", "json", "mp4", "woff2", "csv"})
	cases := []struct {
		name, content string
		reason        string
		detected      string
	}{
		// Conforming.
		{"photo.jpg", jpegHead + "binary data", "", "jpeg"},
		{"PHOTO.JPG", jpegHead, "", "jpeg"},
		{"photo.jpg", pngHead + "really a png", "", "png"}, // same family: conforming
		{"anim.gif", gifHead, "", "gif"},
		{"img.webp", webpHead, "", "webp"},
		{"doc.pdf", pdfHead + "stream", "", "pdf"},
		{"archive.zip", zipHead + "word/document.xml", "", "zip"},
		{"logo.svg", `<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"></svg>`, "", "text"},
		{"notes.txt", "hello <?not php: no blank after the tag", "", "text"},
		{"data.json", `{"a":1}`, "", "text"},
		{"video.mp4", "\x00\x00\x00\x18ftypisom", "", "mp4"},
		{"font.woff2", "wOF2\x00\x01", "", "woff2"},
		{"photo.jpg", jpegHead + phpEcho + "\x01\x02", "", "jpeg"}, // '<?=' by chance in binary noise
		{"text.txt", "#!/bin/sh\necho hi", "", "shebang"},          // text types only get the PHP check
		// Extension.
		{"shell.php", phpOpen + " echo 1;", "extension", ""},
		{"x.php.jpg.phtml", jpegHead, "extension", "jpeg"},
		{"noext", "hello", "extension", ""},
		{".htaccess", "Options -Indexes", "extension", ""},
		// PHP content.
		{"x.jpg", phpOpen + " echo 1;", "php-content", ""},
		{"x.txt", "notes\n" + phpUpper + " echo 2;", "php-content", "text"},
		{"x.txt", "notes " + phpEcho + " $x ?>", "php-content", "text"},
		{"x.csv", "a,b\n" + phpShort + "echo 3; ?>", "php-content", "text"},
		{"x.svg", "<svg>" + phpTag + "echo 4;</script></svg>", "php-content", "text"},
		{"x.json", `{"a":"` + phpOpen + `"}`, "php-content", "text"},
		// Polyglots: a valid media signature carrying PHP.
		{"x.jpg", jpegHead + "\x00\x01" + phpOpen + " echo 5; ?>\x00", "polyglot", "jpeg"},
		{"x.gif", gifHead + phpEcho + "$a.$b.$c.$d;?>", "polyglot", "gif"},
		// PHP accepts any blank after '<?=' (newline, tab), also inside.
		{"x.jpg", jpegHead + phpEcho + "\n`$_GET[0]`?>", "polyglot", "jpeg"},
		{"x.jpg", jpegHead + phpEcho + "\t$_GET\t[0]\n?>", "polyglot", "jpeg"},
		{"x.png", pngHead + "\x00" + phpOpen, "polyglot", "png"},
		{"x.pdf", pdfHead + phpOpen + " echo 6;", "polyglot", "pdf"},
		// Executable / code real type.
		{"x.jpg", elfHead + "\x00\x00", "magic-mismatch", "elf"},
		{"x.pdf", "#!/usr/bin/env python3\nprint(1)", "magic-mismatch", "shebang"},
		{"x.zip", zipHead + "stuff .phar/stub.php more", "magic-mismatch", "phar"},
		{"x.jpg", "\xef\xbb\xbf  <html><script>void 0</script></html>", "magic-mismatch", "html"},
		{"x.png", "<svg><title>t</title></svg>", "magic-mismatch", "html"},
	}
	for _, c := range cases {
		v := classifyTyped(c.name, []byte(c.content), nil, media)
		if v.Reason != c.reason || (c.detected != "" && v.DetectedType != c.detected) {
			t.Errorf("%s %q: got %+v, want reason %q detected %q", c.name, c.content, v, c.reason, c.detected)
		}
	}
}

func TestClassifyTypedTail(t *testing.T) {
	media := normalizeExtensions([]string{"jpg"})
	head := []byte(jpegHead + strings.Repeat("\x00", 100))
	if v := classifyTyped("big.jpg", head, []byte("...."+phpOpen+" echo 7; ?>"), media); v.Reason != reasonPolyglot {
		t.Errorf("PHP at the end of a big file: %+v", v)
	}
	if v := classifyTyped("big.jpg", head, []byte(strings.Repeat("\x01", 64)), media); !v.ok() {
		t.Errorf("clean big file: %+v", v)
	}
}

func TestExecutableRules(t *testing.T) {
	for _, n := range []string{"x.php", "X.PHP", "a.php5", "a.php8", "t.phtml", "t.pht", "t.phps", "t.phar", "c.inc", ".htaccess", ".user.ini", "s.cgi", "s.pl", "s.py", "s.sh"} {
		if !isExecutableName(n) {
			t.Errorf("%s not executable", n)
		}
	}
	for _, n := range []string{"x.js", "x.txt", "x.php.txt", "x.jpg", "htaccess.txt", "x.ini", "php", "x.php9"} {
		if isExecutableName(n) {
			t.Errorf("%s executable", n)
		}
	}
	for _, h := range []string{phpOpen + " echo 1;", "\xef\xbb\xbf" + phpUpper, "  \n" + phpOpen, "#!/bin/sh"} {
		if !startsExecutable([]byte(h)) {
			t.Errorf("%q not executable", h)
		}
	}
	for _, h := range []string{"<?xml", "hello " + phpOpen, "", "<?ph"} {
		if startsExecutable([]byte(h)) {
			t.Errorf("%q executable", h)
		}
	}
}

func TestDetectMagic(t *testing.T) {
	cases := map[string]string{
		jpegHead: "jpeg", pngHead: "png", gifHead: "gif", webpHead: "webp", "RIFF\x00\x00\x00\x00WAVEfmt ": "wav",
		"\x00\x00\x00\x1cftypavif": "avif", "\x00\x00\x00\x1cftypheic": "heic", "\x00\x00\x00\x14ftypqt  ": "mov",
		"BM\x00": "bmp", "II*\x00": "tiff", "MM\x00*": "tiff", "\x00\x00\x01\x00\x01": "ico", pdfHead: "pdf",
		zipHead: "zip", "\x1a\x45\xdf\xa3": "webm", "ID3\x04": "mp3", "\xff\xfb\x90": "mp3", "OggS\x00": "ogg",
		"wOFF": "woff", "wOF2": "woff2", "\x00\x01\x00\x00\x00": "ttf", "OTTO": "otf", elfHead: "elf", "#!/bin/sh": "shebang",
		"plain text": "", "": "",
	}
	for in, want := range cases {
		if got := detectMagic([]byte(in)); got != want {
			t.Errorf("detectMagic(%q) = %q, want %q", in, got, want)
		}
	}
}
