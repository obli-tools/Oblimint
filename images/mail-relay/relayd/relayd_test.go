package main

import (
	"bufio"
	"encoding/json"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

const testPolicy = `{
  "version": 1,
  "users": {
    "site-12": { "site": 12, "account": 5, "defaultSender": "NoReply@Exemple.fr", "senders": ["noreply@exemple.fr"], "perHour": 3 },
    "site-13": { "site": 13, "account": 5, "defaultSender": "noreply@exemple.fr", "senders": [], "perHour": null },
    "site-20": { "site": 20, "account": 6, "defaultSender": "contact@autre.fr", "senders": ["contact@autre.fr"], "perHour": null }
  },
  "accounts": {
    "5": { "suspended": false, "perHour": 4, "domains": ["exemple.fr", "boutique.exemple.fr"] },
    "6": { "suspended": true, "perHour": null, "domains": ["autre.fr"] }
  }
}`

func mustConfig(t *testing.T, s string) *Config {
	t.Helper()
	c, err := parseConfig([]byte(s))
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func TestParseConfigValidation(t *testing.T) {
	c := mustConfig(t, testPolicy)
	if c.Users["site-12"].DefaultSender != "noreply@exemple.fr" {
		t.Errorf("default sender not normalized: %q", c.Users["site-12"].DefaultSender)
	}
	bad := map[string]string{
		"version":        `{"version":2,"users":{},"accounts":{}}`,
		"user name":      `{"version":1,"users":{"root":{"site":1,"account":1}},"accounts":{"1":{}}}`,
		"unknown acct":   `{"version":1,"users":{"site-1":{"site":1,"account":9}},"accounts":{"1":{}}}`,
		"domain":         `{"version":1,"users":{},"accounts":{"1":{"domains":["exemple.fr\nX"]}}}`,
		"sender":         `{"version":1,"users":{"site-1":{"site":1,"account":1,"senders":["a b@x.fr"]}},"accounts":{"1":{}}}`,
		"default sender": `{"version":1,"users":{"site-1":{"site":1,"account":1,"defaultSender":"<x@y.fr>"}},"accounts":{"1":{}}}`,
		"negative limit": `{"version":1,"users":{},"accounts":{"1":{"perHour":-1}}}`,
		"account id":     `{"version":1,"users":{},"accounts":{"x":{}}}`,
		"not json":       `{`,
	}
	for name, s := range bad {
		if _, err := parseConfig([]byte(s)); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestSenderAllowed(t *testing.T) {
	c := mustConfig(t, testPolicy)
	u := c.Users["site-12"]
	for _, s := range []string{"noreply@exemple.fr", "contact@exemple.fr", "x@boutique.exemple.fr"} {
		if !c.senderAllowed(u, s) {
			t.Errorf("%s refused", s)
		}
	}
	for _, s := range []string{"", "x@autre.fr", "x@sub.boutique.exemple.fr", "x@exemple.fr.evil.com", "x@evilexemple.fr"} {
		if c.senderAllowed(u, s) {
			t.Errorf("%s allowed", s)
		}
	}
}

type recorder struct {
	mu     sync.Mutex
	events []Event
}

func (r *recorder) emit(e Event) { r.mu.Lock(); r.events = append(r.events, e); r.mu.Unlock() }

func req(stage, user, sender string, extra ...string) map[string]string {
	m := map[string]string{"request": "smtpd_access_policy", "protocol_state": stage, "sasl_username": user, "sender": sender, "recipient": "dest@gmail.com"}
	for i := 0; i+1 < len(extra); i += 2 {
		m[extra[i]] = extra[i+1]
	}
	return m
}

func TestPolicyDecisions(t *testing.T) {
	c := mustConfig(t, testPolicy)
	rec := &recorder{}
	p := NewPolicy(func() *Config { return c }, rec.emit)
	now := time.Date(2026, 10, 9, 12, 0, 0, 0, time.UTC)
	p.now = func() time.Time { return now }

	cases := []struct {
		r      map[string]string
		action string
		reason string
	}{
		{req("RCPT", "", "noreply@exemple.fr"), "REJECT", "noAuth"},
		{req("RCPT", "site-99", "noreply@exemple.fr"), "REJECT", "unknownUser"},
		{req("RCPT", "site-20", "contact@autre.fr"), "REJECT", "suspended"},
		{req("RCPT", "site-12", "ceo@bank.com"), "REJECT", "senderNotAllowed"},
		{req("RCPT", "site-12", ""), "REJECT", "senderNotAllowed"},
		{req("RCPT", "site-12", "noreply@exemple.fr"), "DUNNO", ""},
		{req("CONNECT", "", ""), "DUNNO", ""},
		{map[string]string{"request": "junk"}, "DUNNO", ""},
	}
	for i, tc := range cases {
		d := p.Decide(tc.r)
		if !strings.HasPrefix(d.Action, tc.action) {
			t.Errorf("case %d: action %q, want %s", i, d.Action, tc.action)
		}
		if tc.reason != "" && (d.Event == nil || d.Event.Reason != tc.reason) {
			t.Errorf("case %d: event %+v, want reason %s", i, d.Event, tc.reason)
		}
		if tc.action == "DUNNO" && d.Event != nil {
			t.Errorf("case %d: a DUNNO at RCPT is not logged", i)
		}
	}

	// Site limit 3 (recipients counted at end of message).
	eom := func(user string, n string) Decision {
		return p.Decide(req("END-OF-MESSAGE", user, "noreply@exemple.fr", "recipient_count", n, "size", "1234", "queue_id", "ABC123"))
	}
	d := eom("site-12", "2")
	if d.Action != "DUNNO" || d.Event == nil || d.Event.Decision != "accept" || d.Event.Recipients != 2 || d.Event.Size != 1234 || d.Event.Site != 12 || d.Event.Account != 5 || d.Event.QueueID != "ABC123" {
		t.Fatalf("first message: %+v %+v", d, d.Event)
	}
	if d := p.Decide(req("RCPT", "site-12", "noreply@exemple.fr")); d.Action != "DUNNO" {
		t.Errorf("3rd recipient refused: %s", d.Action)
	}
	if d := eom("site-12", "2"); !strings.HasPrefix(d.Action, "DEFER ") || d.Event.Reason != "siteLimit" {
		t.Errorf("over the site limit: %+v", d)
	}
	if d := eom("site-12", "1"); d.Action != "DUNNO" {
		t.Errorf("exactly the site limit refused: %+v", d)
	}
	if d := p.Decide(req("RCPT", "site-12", "noreply@exemple.fr")); !strings.HasPrefix(d.Action, "DEFER_IF_PERMIT") {
		t.Errorf("site at its limit: %s", d.Action)
	}
	// Account limit 4 shared by its sites: site-13 (unlimited) has 1 left.
	if d := eom("site-13", "1"); d.Action != "DUNNO" {
		t.Errorf("account room refused: %+v", d)
	}
	if d := eom("site-13", "1"); d.Event == nil || d.Event.Reason != "accountLimit" {
		t.Errorf("over the account limit: %+v", d)
	}
	// One hour later the window is empty again.
	now = now.Add(time.Hour + time.Second)
	if d := eom("site-12", "3"); d.Action != "DUNNO" {
		t.Errorf("after the window: %+v", d)
	}

	// Suspension applies at the end of message too (policy changed meanwhile).
	c2 := mustConfig(t, strings.Replace(testPolicy, `"suspended": false`, `"suspended": true`, 1))
	p.cfg = func() *Config { return c2 }
	if d := eom("site-13", "1"); !strings.HasPrefix(d.Action, "REJECT") || d.Event.Reason != "suspended" {
		t.Errorf("suspended at end of message: %+v", d)
	}
}

func TestPolicyProtocolAndJSON(t *testing.T) {
	c := mustConfig(t, testPolicy)
	pr, pw := io.Pipe()
	p := NewPolicy(func() *Config { return c }, jsonEmitter(pw))
	server, client := net.Pipe()
	go p.ServeConn(server)
	lines := make(chan string, 4)
	go func() {
		s := bufio.NewScanner(pr)
		for s.Scan() {
			lines <- s.Text()
		}
	}()
	w := bufio.NewWriter(client)
	r := bufio.NewReader(client)
	send := func(attrs string) string {
		_, _ = w.WriteString(attrs + "\n")
		_ = w.Flush()
		var out strings.Builder
		for {
			l, err := r.ReadString('\n')
			if err != nil {
				t.Fatal(err)
			}
			if l == "\n" {
				return out.String()
			}
			out.WriteString(l)
		}
	}
	got := send("request=smtpd_access_policy\nprotocol_state=END-OF-MESSAGE\nsasl_username=site-12\nsender=noreply@exemple.fr\nrecipient_count=1\nsize=99\nqueue_id=4B2C1\n")
	if got != "action=DUNNO\n" {
		t.Fatalf("answer %q", got)
	}
	// Same connection, second request (Postfix reuses it).
	got = send("request=smtpd_access_policy\nprotocol_state=RCPT\nsasl_username=site-12\nsender=evil@bank.com\nrecipient=x@y.fr\n")
	if !strings.HasPrefix(got, "action=REJECT 5.7.1") {
		t.Fatalf("answer %q", got)
	}
	client.Close()
	for _, want := range []string{"accept", "senderNotAllowed"} {
		select {
		case l := <-lines:
			var e map[string]any
			if err := json.Unmarshal([]byte(l), &e); err != nil {
				t.Fatalf("not JSON: %q", l)
			}
			if e["type"] != "decision" || !strings.Contains(l, want) {
				t.Errorf("event %s, want %s", l, want)
			}
			if strings.Contains(strings.ToLower(l), "password") {
				t.Errorf("credential in the log: %s", l)
			}
		case <-time.After(2 * time.Second):
			t.Fatalf("no JSON line for %s", want)
		}
	}
	// Control characters never reach the JSON line unescaped (one event = one line).
	if got := truncate("a\nb\rc\x00d", 64); got != "abcd" {
		t.Errorf("truncate: %q", got)
	}
}

func TestConfigHolderReload(t *testing.T) {
	p := filepath.Join(t.TempDir(), "policy.json")
	h := newConfigHolder(p)
	if err := h.Refresh(); err != nil || len(h.Get().Users) != 0 {
		t.Fatalf("missing file: %v", err)
	}
	if err := os.WriteFile(p, []byte(testPolicy), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := h.Refresh(); err != nil || len(h.Get().Users) != 3 {
		t.Fatalf("load: %v", err)
	}
	// Invalid content: refused, previous policy kept.
	if err := os.WriteFile(p, []byte(`{"version":1,"users":{"bad user":{}}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	_ = os.Chtimes(p, time.Now().Add(time.Minute), time.Now().Add(time.Minute))
	if err := h.Refresh(); err == nil {
		t.Errorf("invalid file accepted")
	}
	if len(h.Get().Users) != 3 {
		t.Errorf("previous policy lost")
	}
	// Removed: nothing is relayed.
	_ = os.Remove(p)
	_ = h.Refresh()
	if len(h.Get().Users) != 0 {
		t.Errorf("policy kept after removal")
	}
}

func TestRewriteFrom(t *testing.T) {
	domains := []string{"exemple.fr"}
	keep := "Subject: hi\r\nFrom: \"Shop\" <Contact@Exemple.fr>\r\nTo: a@b.fr\r\n\r\nbody\r\n"
	if out, changed := rewriteFrom([]byte(keep), "noreply@exemple.fr", domains); changed || string(out) != keep {
		t.Errorf("own domain rewritten: %q", out)
	}
	foreign := "Subject: hi\r\nFrom: \"Bank\" <ceo@bank.com>\r\nTo: a@b.fr\r\n\r\nbody\r\n.line\r\n"
	out, changed := rewriteFrom([]byte(foreign), "noreply@exemple.fr", domains)
	want := "Subject: hi\r\nFrom: <noreply@exemple.fr>\r\nReply-To: \"Bank\" <ceo@bank.com>\r\nTo: a@b.fr\r\n\r\nbody\r\n.line\r\n"
	if !changed || string(out) != want {
		t.Errorf("foreign From:\n%q\nwant\n%q", out, want)
	}
	// Existing Reply-To kept; folded From removed entirely.
	folded := "From: \"Very long\"\r\n <x@evil.com>\r\nReply-To: r@evil.com\r\n\r\nb"
	out, _ = rewriteFrom([]byte(folded), "noreply@exemple.fr", domains)
	if string(out) != "From: <noreply@exemple.fr>\r\nReply-To: r@evil.com\r\n\r\nb" {
		t.Errorf("folded: %q", out)
	}
	// Two From headers / none / unparsable: rewritten, no Reply-To from garbage.
	for _, m := range []string{
		"From: a@exemple.fr\r\nFrom: b@evil.com\r\n\r\nb",
		"Subject: x\r\n\r\nb",
		"From: not an address\r\n\r\nb",
	} {
		out, changed := rewriteFrom([]byte(m), "noreply@exemple.fr", domains)
		if !changed || strings.Count(string(out), "From: <noreply@exemple.fr>\r\n") != 1 || strings.Contains(string(out), "Reply-To") {
			t.Errorf("%q → %q", m, out)
		}
	}
	// A hostile display name cannot inject a header through Reply-To.
	evil := "From: \"x\r\nBcc: victim@y.fr\" <a@evil.com>\r\n\r\nb"
	out, _ = rewriteFrom([]byte(evil), "noreply@exemple.fr", domains)
	if strings.Contains(string(out), "\r\nBcc:") && !strings.Contains(string(out), "From: <noreply@exemple.fr>") {
		t.Errorf("injection: %q", out)
	}
}

// End to end: Postfix → filter → reinjection server.
func TestFilterReinjects(t *testing.T) {
	c := mustConfig(t, testPolicy)
	sink, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer sink.Close()
	got := make(chan string, 1)
	go fakeSMTPSink(sink, got)
	rec := &recorder{}
	f := NewFilter(func() *Config { return c }, sink.Addr().String(), rec.emit)
	server, client := net.Pipe()
	go f.ServeConn(server)
	r := bufio.NewReader(client)
	expect := func(prefix string) {
		t.Helper()
		_ = client.SetReadDeadline(time.Now().Add(5 * time.Second))
		for {
			l, err := r.ReadString('\n')
			if err != nil {
				t.Fatalf("waiting for %s: %v", prefix, err)
			}
			if strings.HasPrefix(l, prefix+" ") {
				return
			}
			if !strings.HasPrefix(l, prefix+"-") {
				t.Fatalf("got %q, want %s", l, prefix)
			}
		}
	}
	write := func(s string) { _, _ = io.WriteString(client, s) }
	expect("220")
	write("EHLO relay\r\n")
	expect("250")
	write("MAIL FROM:<noreply@exemple.fr> SIZE=100\r\n")
	expect("250")
	write("RCPT TO:<dest@gmail.com> ORCPT=rfc822;dest@gmail.com\r\n")
	expect("250")
	write("DATA\r\n")
	expect("354")
	write("From: <ceo@bank.com>\r\nSubject: x\r\n\r\n..dot\r\nend\r\n.\r\n")
	expect("250")
	write("QUIT\r\n")
	expect("221")
	select {
	case msg := <-got:
		if !strings.Contains(msg, "MAIL FROM:<noreply@exemple.fr>") || !strings.Contains(msg, "RCPT TO:<dest@gmail.com>") ||
			!strings.Contains(msg, "From: <noreply@exemple.fr>\r\nReply-To: <ceo@bank.com>\r\n") || !strings.Contains(msg, "\r\n..dot\r\n") {
			t.Errorf("reinjected:\n%s", msg)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("nothing reinjected")
	}
	if len(rec.events) != 1 || rec.events[0].Type != "fromRewritten" {
		t.Errorf("events %+v", rec.events)
	}
}

// fakeSMTPSink accepts one message and sends the whole dialogue (client side) to got.
func fakeSMTPSink(ln net.Listener, got chan<- string) {
	c, err := ln.Accept()
	if err != nil {
		return
	}
	defer c.Close()
	r := bufio.NewReader(c)
	var log strings.Builder
	_, _ = io.WriteString(c, "220 sink ESMTP\r\n")
	inData := false
	for {
		l, err := r.ReadString('\n')
		if err != nil {
			got <- log.String()
			return
		}
		log.WriteString(l)
		if inData {
			if l == ".\r\n" {
				inData = false
				_, _ = io.WriteString(c, "250 queued\r\n")
			}
			continue
		}
		switch {
		case strings.HasPrefix(l, "EHLO"):
			_, _ = io.WriteString(c, "250-sink\r\n250 8BITMIME\r\n")
		case strings.HasPrefix(l, "DATA"):
			inData = true
			_, _ = io.WriteString(c, "354 go\r\n")
		case strings.HasPrefix(l, "QUIT"):
			_, _ = io.WriteString(c, "221 bye\r\n")
			got <- log.String()
			return
		default:
			_, _ = io.WriteString(c, "250 ok\r\n")
		}
	}
}
