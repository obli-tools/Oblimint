package main

import (
	"bufio"
	"encoding/json"
	"io"
	"log/slog"
	"net"
	"strconv"
	"strings"
	"sync"
	"time"
)

// ─────────────────────────────────────────────────────────────────────────────
// Postfix policy delegation (check_policy_service, SMTPD_POLICY_README) of the
// site relay. Postfix sends name=value lines ended by an empty line and
// expects "action=…" + an empty line; the connection is reused.
//
//   RCPT stage           authenticated user known? account outbound not
//                        suspended? envelope sender allowed for the site (MA3)?
//                        hourly limits of the site and of the account not
//                        reached (DEFER_IF_PERMIT)? → DUNNO (Postfix goes on)
//   END-OF-MESSAGE       same checks again (the policy may have changed), then
//                        the message is COUNTED (its recipients) in the
//                        sliding 1 h windows of the site and the account.
//
// One JSON line per decision on stdout (accepted messages, refusals):
// {"type":"decision","at":…,"stage":…,"decision":"accept|reject|defer",
//  "reason":…,"user":"site-12","site":12,"account":5,"sender":…,
//  "recipient":…,"recipients":N,"size":N,"queueId":…}. The panel follows the
// container log (server/src/services/mail/outbound/attribution.ts
// parseRelayLine). Never a credential, never a message content.
// ─────────────────────────────────────────────────────────────────────────────

const (
	windowLength = time.Hour
	// maxRequestBytes bounds one policy request (Postfix sends < 2 KiB).
	maxRequestBytes = 64 << 10
)

// Decision is the outcome of one policy request.
type Decision struct {
	Action string
	Event  *Event
}

// Event is one JSON log line.
type Event struct {
	Type       string `json:"type"`
	At         string `json:"at"`
	Stage      string `json:"stage"`
	Decision   string `json:"decision"`
	Reason     string `json:"reason,omitempty"`
	User       string `json:"user,omitempty"`
	Site       int64  `json:"site,omitempty"`
	Account    int64  `json:"account,omitempty"`
	Sender     string `json:"sender,omitempty"`
	Recipient  string `json:"recipient,omitempty"`
	Recipients int    `json:"recipients,omitempty"`
	Size       int64  `json:"size,omitempty"`
	QueueID    string `json:"queueId,omitempty"`
}

// Window counts weighted hits in a sliding window, per key.
type Window struct {
	mu   sync.Mutex
	hits map[string][]hit
}

type hit struct {
	at time.Time
	n  int
}

func NewWindow() *Window { return &Window{hits: map[string][]hit{}} }

func (w *Window) prune(key string, now time.Time) []hit {
	list := w.hits[key]
	i := 0
	for i < len(list) && !list[i].at.After(now.Add(-windowLength)) {
		i++
	}
	if i > 0 {
		list = append([]hit(nil), list[i:]...)
		if len(list) == 0 {
			delete(w.hits, key)
		} else {
			w.hits[key] = list
		}
	}
	return list
}

// Count is the weight of the hits of the last hour.
func (w *Window) Count(key string, now time.Time) int {
	w.mu.Lock()
	defer w.mu.Unlock()
	n := 0
	for _, h := range w.prune(key, now) {
		n += h.n
	}
	return n
}

// Add records n at now.
func (w *Window) Add(key string, n int, now time.Time) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.prune(key, now)
	w.hits[key] = append(w.hits[key], hit{now, n})
}

// Policy decides the requests of one relay.
type Policy struct {
	cfg    func() *Config
	window *Window
	now    func() time.Time
	emit   func(Event)
}

func NewPolicy(cfg func() *Config, emit func(Event)) *Policy {
	return &Policy{cfg: cfg, window: NewWindow(), now: time.Now, emit: emit}
}

func siteKey(id int64) string    { return "s:" + strconv.FormatInt(id, 10) }
func accountKey(id int64) string { return "a:" + strconv.FormatInt(id, 10) }

func over(limit *int, used, adding int) bool {
	return limit != nil && used+adding > *limit
}

// Decide handles one request (attribute map).
func (p *Policy) Decide(req map[string]string) Decision {
	if req["request"] != "smtpd_access_policy" {
		return Decision{Action: "DUNNO"}
	}
	stage := strings.ToUpper(req["protocol_state"])
	if stage != "RCPT" && stage != "END-OF-MESSAGE" {
		return Decision{Action: "DUNNO"}
	}
	now := p.now()
	cfg := p.cfg()
	user := strings.ToLower(strings.TrimSpace(req["sasl_username"]))
	sender, _ := normalizeAddress(req["sender"])
	rawSender := strings.ToLower(strings.TrimSpace(req["sender"]))
	ev := Event{
		Type: "decision", At: now.UTC().Format(time.RFC3339Nano), Stage: strings.ToLower(stage), User: user, Sender: truncate(rawSender, 254),
		QueueID: truncate(req["queue_id"], 64),
	}
	if stage == "RCPT" {
		ev.Recipient = truncate(strings.ToLower(req["recipient"]), 254)
	}
	refuse := func(action, decision, reason string) Decision {
		ev.Decision, ev.Reason = decision, reason
		return Decision{Action: action, Event: &ev}
	}
	if user == "" {
		return refuse("REJECT 5.7.1 Authentication required", "reject", "noAuth")
	}
	u, ok := cfg.Users[user]
	if !ok {
		return refuse("REJECT 5.7.1 This site may not send mail", "reject", "unknownUser")
	}
	ev.Site, ev.Account = u.Site, u.Account
	acct, ok := cfg.account(u.Account)
	if !ok {
		return refuse("REJECT 5.7.1 This site may not send mail", "reject", "unknownUser")
	}
	if acct.Suspended {
		return refuse("REJECT 5.7.1 Outbound mail of this account is suspended", "reject", "suspended")
	}
	if sender == "" || !cfg.senderAllowed(u, sender) {
		return refuse("REJECT 5.7.1 Sender address not allowed for this site", "reject", "senderNotAllowed")
	}
	recipients := 1
	if stage == "END-OF-MESSAGE" {
		if n, err := strconv.Atoi(req["recipient_count"]); err == nil && n > 0 {
			recipients = n
		}
		if n, err := strconv.ParseInt(req["size"], 10, 64); err == nil && n > 0 {
			ev.Size = n
		}
		ev.Recipients = recipients
	}
	defer1 := "DEFER_IF_PERMIT"
	if stage == "END-OF-MESSAGE" {
		defer1 = "DEFER"
	}
	if over(u.PerHour, p.window.Count(siteKey(u.Site), now), recipients) {
		return refuse(defer1+" 4.7.1 Hourly sending limit of this site reached", "defer", "siteLimit")
	}
	if over(acct.PerHour, p.window.Count(accountKey(u.Account), now), recipients) {
		return refuse(defer1+" 4.7.1 Hourly sending limit of this account reached", "defer", "accountLimit")
	}
	if stage == "RCPT" {
		return Decision{Action: "DUNNO"}
	}
	p.window.Add(siteKey(u.Site), recipients, now)
	p.window.Add(accountKey(u.Account), recipients, now)
	ev.Decision = "accept"
	return Decision{Action: "DUNNO", Event: &ev}
}

func truncate(s string, n int) string {
	s = strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return -1
		}
		return r
	}, s)
	if len(s) > n {
		return s[:n]
	}
	return s
}

// readRequest reads one request (empty line terminated). io.EOF at a clean end.
func readRequest(r *bufio.Reader) (map[string]string, error) {
	req := map[string]string{}
	total := 0
	for {
		line, err := r.ReadString('\n')
		total += len(line)
		if total > maxRequestBytes {
			return nil, io.ErrUnexpectedEOF
		}
		if err != nil {
			if err == io.EOF && line == "" && len(req) == 0 {
				return nil, io.EOF
			}
			return nil, io.ErrUnexpectedEOF
		}
		line = strings.TrimRight(line, "\r\n")
		if line == "" {
			return req, nil
		}
		if k, v, ok := strings.Cut(line, "="); ok {
			req[k] = v
		}
	}
}

// ServeConn answers the requests of one Postfix connection.
func (p *Policy) ServeConn(c net.Conn) {
	defer c.Close()
	r := bufio.NewReader(c)
	for {
		_ = c.SetReadDeadline(time.Now().Add(10 * time.Minute))
		req, err := readRequest(r)
		if err != nil {
			return
		}
		d := p.Decide(req)
		if d.Event != nil && p.emit != nil {
			p.emit(*d.Event)
		}
		if _, err := io.WriteString(c, "action="+d.Action+"\n\n"); err != nil {
			return
		}
	}
}

// Serve accepts policy connections until the listener is closed.
func (p *Policy) Serve(ln net.Listener) error {
	for {
		c, err := ln.Accept()
		if err != nil {
			return err
		}
		go p.ServeConn(c)
	}
}

// jsonEmitter writes one JSON line per event (serialized).
func jsonEmitter(w io.Writer) func(Event) {
	var mu sync.Mutex
	return func(e Event) {
		b, err := json.Marshal(e)
		if err != nil {
			slog.Error("event not encoded", "err", err)
			return
		}
		mu.Lock()
		defer mu.Unlock()
		_, _ = w.Write(append(b, '\n'))
	}
}
