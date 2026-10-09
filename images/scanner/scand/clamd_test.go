package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeClamd speaks the 'z' commands of clamd on a TCP loopback port.
type fakeClamd struct {
	ln       net.Listener
	mu       sync.Mutex
	received [][]byte // INSTREAM payloads
	chunks   []int    // chunk sizes seen
	verdict  func(payload []byte) string
	version  string
	reloads  int
	maxBytes int // > 0: answer "size limit exceeded" past it
}

func startFakeClamd(t *testing.T) *fakeClamd {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	f := &fakeClamd{ln: ln, version: "ClamAV 1.4.3/27420/Thu Oct  8 08:24:32 2026", verdict: func([]byte) string { return "stream: OK" }}
	go f.serve()
	t.Cleanup(func() { ln.Close() })
	return f
}

func (f *fakeClamd) addr() string { return f.ln.Addr().String() }

func (f *fakeClamd) serve() {
	for {
		conn, err := f.ln.Accept()
		if err != nil {
			return
		}
		go f.handle(conn)
	}
}

func (f *fakeClamd) handle(conn net.Conn) {
	defer conn.Close()
	br := bufio.NewReader(conn)
	cmd, err := br.ReadString(0)
	if err != nil {
		return
	}
	reply := func(s string) { _, _ = conn.Write([]byte(s + "\x00")) }
	switch strings.TrimRight(cmd, "\x00") {
	case "zPING":
		reply("PONG")
	case "zVERSION":
		reply(f.version)
	case "zRELOAD":
		f.mu.Lock()
		f.reloads++
		f.mu.Unlock()
		reply("RELOADING")
	case "zINSTREAM":
		var payload bytes.Buffer
		var sizes []int
		hdr := make([]byte, 4)
		for {
			if _, err := io.ReadFull(br, hdr); err != nil {
				return
			}
			n := int(binary.BigEndian.Uint32(hdr))
			if n == 0 {
				break
			}
			sizes = append(sizes, n)
			if _, err := io.CopyN(&payload, br, int64(n)); err != nil {
				return
			}
			if f.maxBytes > 0 && payload.Len() > f.maxBytes {
				reply("INSTREAM size limit exceeded. ERROR")
				return
			}
		}
		f.mu.Lock()
		f.received = append(f.received, payload.Bytes())
		f.chunks = append(f.chunks, sizes...)
		f.mu.Unlock()
		reply(f.verdict(payload.Bytes()))
	default:
		reply("UNKNOWN COMMAND")
	}
}

func clamdFor(f *fakeClamd) *Clamd {
	return &Clamd{Network: "tcp", Address: f.addr(), Timeout: 5 * time.Second}
}

func TestInstreamOKAndFound(t *testing.T) {
	f := startFakeClamd(t)
	f.verdict = func(p []byte) string {
		if bytes.Contains(p, []byte("MARKER")) {
			return "stream: Oblimint.Test.Marker FOUND"
		}
		return "stream: OK"
	}
	c := clamdFor(f)
	ctx := context.Background()
	res, err := c.Instream(ctx, strings.NewReader("clean content"))
	if err != nil || res.Found {
		t.Fatalf("clean: %+v %v", res, err)
	}
	res, err = c.Instream(ctx, strings.NewReader("xx MARKER xx"))
	if err != nil || !res.Found || res.Signature != "Oblimint.Test.Marker" {
		t.Fatalf("found: %+v %v", res, err)
	}
	// A payload larger than one chunk is split into 64 KiB chunks and reassembled.
	big := bytes.Repeat([]byte("a"), 3*instreamChunk+10)
	if _, err := c.Instream(ctx, bytes.NewReader(big)); err != nil {
		t.Fatal(err)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if got := f.received[len(f.received)-1]; !bytes.Equal(got, big) {
		t.Fatalf("payload mismatch: %d bytes", len(got))
	}
	if n := len(f.chunks); n < 4 || f.chunks[n-1] != 10 || f.chunks[n-2] != instreamChunk {
		t.Fatalf("chunks: %v", f.chunks)
	}
}

func TestInstreamEmptyAndErrors(t *testing.T) {
	f := startFakeClamd(t)
	c := clamdFor(f)
	if res, err := c.Instream(context.Background(), strings.NewReader("")); err != nil || res.Found {
		t.Fatalf("empty: %+v %v", res, err)
	}
	f.maxBytes = 10
	_, err := c.Instream(context.Background(), strings.NewReader(strings.Repeat("x", 100)))
	var ce *ErrClamd
	if !errors.As(err, &ce) || !strings.Contains(ce.Reply, "size limit") {
		t.Fatalf("size limit: %v", err)
	}
	f.ln.Close()
	if _, err := c.Instream(context.Background(), strings.NewReader("x")); err == nil {
		t.Fatal("closed clamd must fail")
	}
}

func TestVersionPingReload(t *testing.T) {
	f := startFakeClamd(t)
	c := clamdFor(f)
	ctx := context.Background()
	if !c.Ping(ctx) {
		t.Fatal("ping")
	}
	raw, err := c.Version(ctx)
	if err != nil {
		t.Fatal(err)
	}
	v, err := ParseVersion(raw)
	if err != nil || v.Engine != "1.4.3" || v.Daily != "27420" || v.SignaturesDate.Format(time.RFC3339) != "2026-10-08T08:24:32Z" {
		t.Fatalf("version: %+v %v", v, err)
	}
	if err := c.Reload(ctx); err != nil || f.reloads != 1 {
		t.Fatalf("reload: %v %d", err, f.reloads)
	}
}

func TestParseInstreamReply(t *testing.T) {
	cases := []struct {
		in    string
		found bool
		sig   string
		err   bool
	}{
		{"stream: OK", false, "", false},
		{"1: stream: OK", false, "", false},
		{"stream: Win.Test.EICAR_HDB-1 FOUND", true, "Win.Test.EICAR_HDB-1", false},
		{"stream: Php.Malware.Agent-123 FOUND\n", true, "Php.Malware.Agent-123", false},
		{"INSTREAM size limit exceeded. ERROR", false, "", true},
		{"stream: Can't allocate memory ERROR", false, "", true},
		{"garbage", false, "", true},
	}
	for _, c := range cases {
		res, err := ParseInstreamReply(c.in)
		if (err != nil) != c.err || res.Found != c.found || res.Signature != c.sig {
			t.Errorf("%q: %+v %v", c.in, res, err)
		}
	}
}

func TestParseVersionVariants(t *testing.T) {
	v, err := ParseVersion("ClamAV 1.4.3")
	if err != nil || v.Engine != "1.4.3" || v.Daily != "" || !v.SignaturesDate.IsZero() {
		t.Fatalf("%+v %v", v, err)
	}
	v, err = ParseVersion("ClamAV 1.5.0/27999/Mon Dec 14 09:05:00 2026")
	if err != nil || v.Daily != "27999" || v.SignaturesDate.Day() != 14 {
		t.Fatalf("%+v %v", v, err)
	}
	if _, err := ParseVersion("something else"); err == nil {
		t.Fatal("must fail")
	}
}

func TestParseClamdAddr(t *testing.T) {
	if n, a, err := ParseClamdAddr("unix:/run/clamav/clamd.sock"); err != nil || n != "unix" || a != "/run/clamav/clamd.sock" {
		t.Fatal(n, a, err)
	}
	if n, a, err := ParseClamdAddr("tcp:127.0.0.1:3310"); err != nil || n != "tcp" || a != "127.0.0.1:3310" {
		t.Fatal(n, a, err)
	}
	for _, bad := range []string{"", "unix:", "/run/x.sock", "http://x"} {
		if _, _, err := ParseClamdAddr(bad); err == nil {
			t.Errorf("%q accepted", bad)
		}
	}
}
