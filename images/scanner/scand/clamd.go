package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"strings"
	"time"
)

// clamd client: the 'z' (NUL-terminated) command variants of the clamd
// protocol on the local unix socket (tests: TCP loopback).
//
//	INSTREAM: "zINSTREAM\0", then chunks <uint32 big-endian length><bytes>,
//	          then a zero-length chunk; reply "stream: OK\0",
//	          "stream: <signature> FOUND\0" or "<message> ERROR\0".
//	VERSION:  "ClamAV 1.4.3/27420/Thu Oct  8 08:24:32 2026"
//	RELOAD:   "RELOADING"
//	PING:     "PONG"

const instreamChunk = 64 * 1024

// Clamd talks to one clamd daemon.
type Clamd struct {
	Network string // "unix" | "tcp"
	Address string
	// Timeout of a whole command (INSTREAM included).
	Timeout time.Duration
}

// ParseClamdAddr accepts "unix:/run/clamav/clamd.sock" or "tcp:127.0.0.1:3310".
func ParseClamdAddr(s string) (network, address string, err error) {
	switch {
	case strings.HasPrefix(s, "unix:") && len(s) > len("unix:"):
		return "unix", strings.TrimPrefix(s, "unix:"), nil
	case strings.HasPrefix(s, "tcp:") && len(s) > len("tcp:"):
		return "tcp", strings.TrimPrefix(s, "tcp:"), nil
	}
	return "", "", fmt.Errorf("invalid clamd address %q (unix:<path> or tcp:<host:port>)", s)
}

func (c *Clamd) dial(ctx context.Context) (net.Conn, error) {
	timeout := c.Timeout
	if timeout <= 0 {
		timeout = 60 * time.Second
	}
	d := net.Dialer{Timeout: 5 * time.Second}
	conn, err := d.DialContext(ctx, c.Network, c.Address)
	if err != nil {
		return nil, err
	}
	deadline := time.Now().Add(timeout)
	if dl, ok := ctx.Deadline(); ok && dl.Before(deadline) {
		deadline = dl
	}
	_ = conn.SetDeadline(deadline)
	return conn, nil
}

// readReply reads one NUL-terminated reply (or up to EOF), at most 4 KiB.
func readReply(r io.Reader) (string, error) {
	br := bufio.NewReader(io.LimitReader(r, 4096))
	s, err := br.ReadString(0)
	if err != nil && !(errors.Is(err, io.EOF) && s != "") {
		return "", err
	}
	return strings.TrimSpace(strings.TrimRight(s, "\x00")), nil
}

func (c *Clamd) command(ctx context.Context, cmd string) (string, error) {
	conn, err := c.dial(ctx)
	if err != nil {
		return "", err
	}
	defer conn.Close()
	if _, err := conn.Write([]byte("z" + cmd + "\x00")); err != nil {
		return "", err
	}
	return readReply(conn)
}

// Ping is true when clamd answers PONG (signatures loaded).
func (c *Clamd) Ping(ctx context.Context) bool {
	r, err := c.command(ctx, "PING")
	return err == nil && r == "PONG"
}

// Version returns the raw VERSION reply.
func (c *Clamd) Version(ctx context.Context) (string, error) {
	return c.command(ctx, "VERSION")
}

// Reload asks clamd to reload its databases.
func (c *Clamd) Reload(ctx context.Context) error {
	r, err := c.command(ctx, "RELOAD")
	if err != nil {
		return err
	}
	if r != "RELOADING" {
		return fmt.Errorf("unexpected RELOAD reply %q", truncate(r, 80))
	}
	return nil
}

// ClamResult of one INSTREAM scan.
type ClamResult struct {
	Found     bool
	Signature string
}

// Instream streams r to clamd and parses the verdict.
func (c *Clamd) Instream(ctx context.Context, r io.Reader) (ClamResult, error) {
	conn, err := c.dial(ctx)
	if err != nil {
		return ClamResult{}, err
	}
	defer conn.Close()
	if err := writeInstream(conn, r); err != nil {
		// clamd closes early on "size limit exceeded": its reply explains why.
		if reply, rerr := readReply(conn); rerr == nil && reply != "" {
			return ParseInstreamReply(reply)
		}
		return ClamResult{}, err
	}
	reply, err := readReply(conn)
	if err != nil {
		return ClamResult{}, err
	}
	return ParseInstreamReply(reply)
}

func writeInstream(w io.Writer, r io.Reader) error {
	if _, err := w.Write([]byte("zINSTREAM\x00")); err != nil {
		return err
	}
	buf := make([]byte, 4+instreamChunk)
	for {
		n, err := io.ReadFull(r, buf[4:])
		if n > 0 {
			binary.BigEndian.PutUint32(buf[:4], uint32(n))
			if _, werr := w.Write(buf[:4+n]); werr != nil {
				return werr
			}
		}
		if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
			break
		}
		if err != nil {
			return err
		}
	}
	_, err := w.Write([]byte{0, 0, 0, 0})
	return err
}

// ErrClamd is a clamd-side error reply ("... ERROR").
type ErrClamd struct{ Reply string }

func (e *ErrClamd) Error() string { return "clamd: " + e.Reply }

// ParseInstreamReply parses "stream: OK" / "stream: <sig> FOUND" / "<msg> ERROR"
// (an optional "<id>: " session prefix is ignored).
func ParseInstreamReply(reply string) (ClamResult, error) {
	s := strings.TrimSpace(reply)
	if i := strings.Index(s, "stream:"); i >= 0 {
		s = strings.TrimSpace(s[i+len("stream:"):])
	}
	switch {
	case s == "OK":
		return ClamResult{}, nil
	case strings.HasSuffix(s, " FOUND"):
		sig := strings.TrimSpace(strings.TrimSuffix(s, " FOUND"))
		if sig == "" {
			sig = "Unknown.Signature"
		}
		return ClamResult{Found: true, Signature: sig}, nil
	case strings.HasSuffix(s, "ERROR"):
		return ClamResult{}, &ErrClamd{Reply: truncate(s, 200)}
	}
	return ClamResult{}, &ErrClamd{Reply: "unexpected reply: " + truncate(s, 120)}
}

// ClamVersion is the parsed VERSION reply.
type ClamVersion struct {
	Engine         string
	Daily          string
	SignaturesDate time.Time
}

// ParseVersion parses "ClamAV 1.4.3/27420/Thu Oct  8 08:24:32 2026" (the
// daily part is absent while no daily database is loaded).
func ParseVersion(reply string) (ClamVersion, error) {
	s := strings.TrimSpace(reply)
	if !strings.HasPrefix(s, "ClamAV ") {
		return ClamVersion{}, fmt.Errorf("unexpected VERSION reply %q", truncate(s, 80))
	}
	parts := strings.SplitN(strings.TrimPrefix(s, "ClamAV "), "/", 3)
	v := ClamVersion{Engine: strings.TrimSpace(parts[0])}
	if len(parts) > 1 {
		v.Daily = strings.TrimSpace(parts[1])
	}
	if len(parts) > 2 {
		if t, err := time.Parse("Mon Jan _2 15:04:05 2006", strings.Join(strings.Fields(parts[2]), " ")); err == nil {
			v.SignaturesDate = t.UTC()
		} else if t, err := time.Parse("Mon Jan 2 15:04:05 2006", strings.Join(strings.Fields(parts[2]), " ")); err == nil {
			v.SignaturesDate = t.UTC()
		}
	}
	return v, nil
}

func truncate(s string, n int) string {
	s = string(bytes.ToValidUTF8([]byte(s), []byte("?")))
	if len(s) > n {
		return s[:n]
	}
	return s
}
