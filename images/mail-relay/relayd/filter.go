package main

import (
	"bufio"
	"bytes"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/mail"
	"net/smtp"
	"strings"
	"time"
)

// ─────────────────────────────────────────────────────────────────────────────
// After-queue content filter of the relay (Postfix content_filter, FILTER_README
// "simple" SMTP proxy): receives each relayed message on 127.0.0.1:10027,
// fixes the From header, reinjects it on 127.0.0.1:10026 (a Postfix smtpd
// without content filter, local clients only).
//
// From rewrite (risk R-HEADER-FROM, best effort): the ENVELOPE sender was
// checked by the policy service (an allowed address of the site's account);
// a From header whose address is not in one of that account's mail domains
// (or several / unparsable From headers) is replaced by the envelope sender
// and the original From becomes Reply-To (when the message has none), so
// DKIM signs a domain of the account and replies still reach the author.
// ─────────────────────────────────────────────────────────────────────────────

const (
	// maxMessageBytes bounds one message (Postfix message_size_limit ≤ 100 MiB + headers).
	maxMessageBytes = 110 << 20
	maxLineBytes    = 4096
	maxRecipients   = 1000
)

// headerField is one (unfolded-aware) header field: raw keeps its original lines.
type headerField struct {
	name string
	raw  string // "Name: value\r\n" including continuation lines
}

// splitMessage splits header fields and body (body starts after the empty line).
func splitMessage(msg []byte) ([]headerField, []byte) {
	var fields []headerField
	rest := msg
	for len(rest) > 0 {
		i := bytes.IndexByte(rest, '\n')
		var line []byte
		if i < 0 {
			line, rest = rest, nil
		} else {
			line, rest = rest[:i+1], rest[i+1:]
		}
		trimmed := bytes.TrimRight(line, "\r\n")
		if len(trimmed) == 0 {
			return fields, rest
		}
		if (trimmed[0] == ' ' || trimmed[0] == '\t') && len(fields) > 0 {
			fields[len(fields)-1].raw += string(line)
			continue
		}
		name, _, ok := bytes.Cut(trimmed, []byte(":"))
		if !ok {
			// Not a header line: the header block ended without an empty line.
			return fields, append(line, rest...)
		}
		fields = append(fields, headerField{name: strings.TrimSpace(string(name)), raw: string(line)})
	}
	return fields, nil
}

func fieldValue(f headerField) string {
	_, v, _ := strings.Cut(f.raw, ":")
	v = strings.ReplaceAll(v, "\r\n", "")
	v = strings.ReplaceAll(v, "\n", "")
	return strings.TrimSpace(v)
}

// rewriteFrom returns the message with its From header fixed (see above),
// and whether it changed. domains = mail domains of the sender's account.
func rewriteFrom(msg []byte, envelopeSender string, domains []string) ([]byte, bool) {
	fields, body := splitMessage(msg)
	var froms []int
	hasReplyTo := false
	for i, f := range fields {
		switch strings.ToLower(f.name) {
		case "from":
			froms = append(froms, i)
		case "reply-to":
			hasReplyTo = true
		}
	}
	var original []*mail.Address
	if len(froms) == 1 {
		if list, err := mail.ParseAddressList(fieldValue(fields[froms[0]])); err == nil && len(list) == 1 {
			original = list
			d := strings.ToLower(domainOf(list[0].Address))
			for _, x := range domains {
				if x == d {
					return msg, false
				}
			}
		}
	}
	var out bytes.Buffer
	out.Grow(len(msg) + 256)
	wrote := false
	writeNew := func() {
		fmt.Fprintf(&out, "From: <%s>\r\n", envelopeSender)
		if !hasReplyTo && len(original) == 1 {
			// Rebuilt from the parsed address: never a raw (injectable) value.
			fmt.Fprintf(&out, "Reply-To: %s\r\n", original[0].String())
		}
		wrote = true
	}
	for i, f := range fields {
		if strings.EqualFold(f.name, "from") {
			if !wrote && i == froms[0] {
				writeNew()
			}
			continue
		}
		out.WriteString(f.raw)
	}
	if !wrote {
		writeNew()
	}
	out.WriteString("\r\n")
	out.Write(body)
	return out.Bytes(), true
}

// ── SMTP side ────────────────────────────────────────────────────────────────

// Filter is the content filter server.
type Filter struct {
	cfg      func() *Config
	reinject string
	emit     func(Event)
	hostname string
}

func NewFilter(cfg func() *Config, reinject string, emit func(Event)) *Filter {
	return &Filter{cfg: cfg, reinject: reinject, emit: emit, hostname: "oblimint-relay-filter"}
}

// Serve accepts the Postfix smtp client connections.
func (f *Filter) Serve(ln net.Listener) error {
	for {
		c, err := ln.Accept()
		if err != nil {
			return err
		}
		go f.ServeConn(c)
	}
}

func pathArg(arg, verb string) (string, bool) {
	if len(arg) < len(verb) || !strings.EqualFold(arg[:len(verb)], verb) {
		return "", false
	}
	rest := strings.TrimSpace(arg[len(verb):])
	if !strings.HasPrefix(rest, "<") {
		return "", false
	}
	end := strings.IndexByte(rest, '>')
	if end < 0 {
		return "", false
	}
	return strings.ToLower(rest[1:end]), true
}

// readData reads the DATA payload up to the lone "." line (dot-unstuffed).
func readData(r *bufio.Reader) ([]byte, error) {
	var buf bytes.Buffer
	tooBig := false
	for {
		line, err := r.ReadSlice('\n')
		if err != nil && !errors.Is(err, bufio.ErrBufferFull) {
			return nil, err
		}
		full := append([]byte(nil), line...)
		for errors.Is(err, bufio.ErrBufferFull) {
			line, err = r.ReadSlice('\n')
			if err != nil && !errors.Is(err, bufio.ErrBufferFull) {
				return nil, err
			}
			full = append(full, line...)
		}
		if bytes.Equal(bytes.TrimRight(full, "\r\n"), []byte(".")) {
			break
		}
		if len(full) > 0 && full[0] == '.' {
			full = full[1:]
		}
		if buf.Len()+len(full) > maxMessageBytes {
			tooBig = true
			continue
		}
		buf.Write(full)
	}
	if tooBig {
		return nil, errTooBig
	}
	return buf.Bytes(), nil
}

var errTooBig = errors.New("message too large")

// ServeConn speaks the minimal SMTP the Postfix smtp client needs.
func (f *Filter) ServeConn(c net.Conn) {
	defer c.Close()
	r := bufio.NewReaderSize(c, maxLineBytes)
	w := bufio.NewWriter(c)
	say := func(s string) bool {
		_ = c.SetWriteDeadline(time.Now().Add(time.Minute))
		if _, err := w.WriteString(s + "\r\n"); err != nil {
			return false
		}
		return w.Flush() == nil
	}
	if !say("220 " + f.hostname + " ESMTP") {
		return
	}
	var from string
	var rcpts []string
	haveFrom := false
	for {
		_ = c.SetReadDeadline(time.Now().Add(5 * time.Minute))
		line, err := r.ReadString('\n')
		if err != nil {
			return
		}
		line = strings.TrimRight(line, "\r\n")
		verb, arg, _ := strings.Cut(line, " ")
		switch strings.ToUpper(verb) {
		case "EHLO":
			if !say("250-" + f.hostname + "\r\n250-8BITMIME\r\n250-SMTPUTF8\r\n250 SIZE " + fmt.Sprint(maxMessageBytes)) {
				return
			}
		case "HELO":
			if !say("250 " + f.hostname) {
				return
			}
		case "MAIL":
			a, ok := pathArg(arg, "FROM:")
			if !ok {
				say("501 5.5.4 Syntax: MAIL FROM:<address>")
				continue
			}
			from, rcpts, haveFrom = a, nil, true
			say("250 2.1.0 Ok")
		case "RCPT":
			a, ok := pathArg(arg, "TO:")
			if !haveFrom || !ok || a == "" {
				say("503 5.5.1 Bad sequence or syntax")
				continue
			}
			if len(rcpts) >= maxRecipients {
				say("452 4.5.3 Too many recipients")
				continue
			}
			rcpts = append(rcpts, a)
			say("250 2.1.5 Ok")
		case "DATA":
			if !haveFrom || len(rcpts) == 0 {
				say("503 5.5.1 Bad sequence of commands")
				continue
			}
			if !say("354 End data with <CR><LF>.<CR><LF>") {
				return
			}
			msg, err := readData(r)
			if errors.Is(err, errTooBig) {
				say("552 5.3.4 Message too big")
				from, rcpts, haveFrom = "", nil, false
				continue
			}
			if err != nil {
				return
			}
			if err := f.handle(from, rcpts, msg); err != nil {
				slog.Error("reinjection failed", "err", err)
				say("451 4.3.0 Reinjection failed, try again later")
			} else {
				say("250 2.0.0 Ok: queued")
			}
			from, rcpts, haveFrom = "", nil, false
		case "RSET":
			from, rcpts, haveFrom = "", nil, false
			say("250 2.0.0 Ok")
		case "NOOP":
			say("250 2.0.0 Ok")
		case "QUIT":
			say("221 2.0.0 Bye")
			return
		default:
			say("502 5.5.2 Command not recognized")
		}
	}
}

// handle rewrites (when needed) and reinjects one message.
func (f *Filter) handle(from string, rcpts []string, msg []byte) error {
	out := msg
	if acct, ok := f.cfg().accountOfSender(from); ok && from != "" {
		if rewritten, changed := rewriteFrom(msg, from, acct.Domains); changed {
			out = rewritten
			if f.emit != nil {
				f.emit(Event{Type: "fromRewritten", At: time.Now().UTC().Format(time.RFC3339Nano), Sender: truncate(from, 254)})
			}
		}
	}
	return reinject(f.reinject, from, rcpts, out)
}

func reinject(addr, from string, rcpts []string, msg []byte) error {
	conn, err := net.DialTimeout("tcp", addr, 30*time.Second)
	if err != nil {
		return err
	}
	_ = conn.SetDeadline(time.Now().Add(10 * time.Minute))
	cl, err := smtp.NewClient(conn, "127.0.0.1")
	if err != nil {
		conn.Close()
		return err
	}
	defer cl.Close()
	if err := cl.Hello("oblimint-relay-filter"); err != nil {
		return err
	}
	if err := cl.Mail(from); err != nil {
		return err
	}
	for _, r := range rcpts {
		if err := cl.Rcpt(r); err != nil {
			return err
		}
	}
	wc, err := cl.Data()
	if err != nil {
		return err
	}
	if _, err := io.Copy(wc, bytes.NewReader(msg)); err != nil {
		wc.Close()
		return err
	}
	if err := wc.Close(); err != nil {
		return err
	}
	return cl.Quit()
}
