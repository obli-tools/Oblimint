package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync/atomic"
	"time"
)

// ─────────────────────────────────────────────────────────────────────────────
// Policy file of the site relay (docs/P4-PLAN.md §9.5), written by the panel
// (server/src/services/mail/outbound/relayConfig.ts renderRelayPolicy) into
// /etc/oblimint/relay/policy.json (read-only mount, 0640 root:relayd). Shape:
//
//	{ "version": 1,
//	  "users":    { "site-12": { "site": 12, "account": 5, "defaultSender": "noreply@exemple.fr",
//	                             "senders": ["noreply@exemple.fr"], "perHour": 100 } },
//	  "accounts": { "5": { "suspended": false, "perHour": 200, "domains": ["exemple.fr"] } } }
//
// perHour null = unlimited. A user absent from the file is refused (its
// credential is also absent from the passwd-file). The file is re-read when
// its modification time changes (no restart: rotate / suspend apply within
// seconds); an invalid file is refused and the previous policy stays.
// ─────────────────────────────────────────────────────────────────────────────

// User is one SASL user of the relay (one site).
type User struct {
	Site          int64    `json:"site"`
	Account       int64    `json:"account"`
	DefaultSender string   `json:"defaultSender"`
	Senders       []string `json:"senders"`
	PerHour       *int     `json:"perHour"`
}

// Account is the outbound state of one hosting account.
type Account struct {
	Suspended bool     `json:"suspended"`
	PerHour   *int     `json:"perHour"`
	Domains   []string `json:"domains"`
}

// Config is the whole policy file.
type Config struct {
	Version  int                `json:"version"`
	Users    map[string]User    `json:"users"`
	Accounts map[string]Account `json:"accounts"`

	// domainAccount: mail domain → account id (domains are unique platform-wide).
	domainAccount map[string]int64
}

var (
	userRe   = regexp.MustCompile(`^site-[1-9][0-9]{0,9}$`)
	domainRe = regexp.MustCompile(`^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$`)
	localRe  = regexp.MustCompile(`^[a-z0-9!#$%&'*+/=?^_{|}~.-]{1,64}$`)
)

const maxConfigBytes = 32 << 20

// normalizeAddress lower-cases an address and checks it (local@domain, no
// angle brackets, no spaces or control characters).
func normalizeAddress(s string) (string, bool) {
	s = strings.ToLower(strings.TrimSpace(s))
	at := strings.LastIndexByte(s, '@')
	if at <= 0 || len(s) > 254 {
		return "", false
	}
	if !localRe.MatchString(s[:at]) || !domainRe.MatchString(s[at+1:]) {
		return "", false
	}
	return s, true
}

func domainOf(addr string) string {
	if at := strings.LastIndexByte(addr, '@'); at >= 0 {
		return addr[at+1:]
	}
	return ""
}

// parseConfig validates a policy file.
func parseConfig(b []byte) (*Config, error) {
	if len(b) > maxConfigBytes {
		return nil, errors.New("policy file too large")
	}
	var c Config
	if err := json.Unmarshal(b, &c); err != nil {
		return nil, fmt.Errorf("policy file: %w", err)
	}
	if c.Version != 1 {
		return nil, fmt.Errorf("policy file: unsupported version %d", c.Version)
	}
	c.domainAccount = map[string]int64{}
	for key, a := range c.Accounts {
		id, err := strconv.ParseInt(key, 10, 64)
		if err != nil || id <= 0 {
			return nil, fmt.Errorf("policy file: invalid account id %q", key)
		}
		if a.PerHour != nil && *a.PerHour < 0 {
			return nil, fmt.Errorf("policy file: account %d: negative perHour", id)
		}
		for i, d := range a.Domains {
			d = strings.ToLower(d)
			if !domainRe.MatchString(d) {
				return nil, fmt.Errorf("policy file: account %d: invalid domain %q", id, d)
			}
			a.Domains[i] = d
			c.domainAccount[d] = id
		}
		c.Accounts[key] = a
	}
	for name, u := range c.Users {
		if !userRe.MatchString(name) {
			return nil, fmt.Errorf("policy file: invalid user %q", name)
		}
		if u.Site <= 0 || u.Account <= 0 {
			return nil, fmt.Errorf("policy file: user %s: invalid site / account", name)
		}
		if _, ok := c.Accounts[strconv.FormatInt(u.Account, 10)]; !ok {
			return nil, fmt.Errorf("policy file: user %s: unknown account %d", name, u.Account)
		}
		if u.PerHour != nil && *u.PerHour < 0 {
			return nil, fmt.Errorf("policy file: user %s: negative perHour", name)
		}
		if u.DefaultSender != "" {
			n, ok := normalizeAddress(u.DefaultSender)
			if !ok {
				return nil, fmt.Errorf("policy file: user %s: invalid default sender", name)
			}
			u.DefaultSender = n
		}
		for i, s := range u.Senders {
			n, ok := normalizeAddress(s)
			if !ok {
				return nil, fmt.Errorf("policy file: user %s: invalid sender %q", name, s)
			}
			u.Senders[i] = n
		}
		c.Users[name] = u
	}
	return &c, nil
}

func (c *Config) account(id int64) (Account, bool) {
	a, ok := c.Accounts[strconv.FormatInt(id, 10)]
	return a, ok
}

// senderAllowed: the default sender, an explicitly allowed address, or any
// address of an active mail domain of the site's account (MA3).
func (c *Config) senderAllowed(u User, sender string) bool {
	if sender == "" {
		return false
	}
	if sender == u.DefaultSender {
		return true
	}
	for _, s := range u.Senders {
		if s == sender {
			return true
		}
	}
	a, ok := c.account(u.Account)
	if !ok {
		return false
	}
	d := domainOf(sender)
	for _, x := range a.Domains {
		if x == d {
			return true
		}
	}
	return false
}

// accountOfSender: the account an (allowed) envelope sender belongs to.
func (c *Config) accountOfSender(sender string) (Account, bool) {
	id, ok := c.domainAccount[domainOf(sender)]
	if !ok {
		return Account{}, false
	}
	return c.account(id)
}

// ── Reloading holder ─────────────────────────────────────────────────────────

// configHolder keeps the current policy and re-reads the file when it changes.
type configHolder struct {
	path    string
	cur     atomic.Pointer[Config]
	modTime time.Time
	size    int64
}

func newConfigHolder(path string) *configHolder {
	h := &configHolder{path: path}
	empty := &Config{Version: 1, Users: map[string]User{}, Accounts: map[string]Account{}, domainAccount: map[string]int64{}}
	h.cur.Store(empty)
	return h
}

func (h *configHolder) Get() *Config { return h.cur.Load() }

// Refresh reloads the file when its mtime / size changed. A missing file
// keeps an EMPTY policy (nothing is relayed); an invalid one keeps the last
// valid policy.
func (h *configHolder) Refresh() error {
	st, err := os.Stat(h.path)
	if errors.Is(err, os.ErrNotExist) {
		if !h.modTime.IsZero() {
			h.modTime, h.size = time.Time{}, 0
			h.cur.Store(&Config{Version: 1, Users: map[string]User{}, Accounts: map[string]Account{}, domainAccount: map[string]int64{}})
			slog.Warn("policy file removed: nothing is relayed", "path", h.path)
		}
		return nil
	}
	if err != nil {
		return err
	}
	if st.ModTime().Equal(h.modTime) && st.Size() == h.size {
		return nil
	}
	b, err := os.ReadFile(h.path)
	if err != nil {
		return err
	}
	c, err := parseConfig(b)
	if err != nil {
		return err
	}
	h.cur.Store(c)
	h.modTime, h.size = st.ModTime(), st.Size()
	slog.Info("policy loaded", "users", len(c.Users), "accounts", len(c.Accounts))
	return nil
}

// Watch polls the file until stop is closed.
func (h *configHolder) Watch(stop <-chan struct{}, every time.Duration) {
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-stop:
			return
		case <-t.C:
			if err := h.Refresh(); err != nil {
				slog.Error("policy file refused (the previous policy stays)", "err", err)
			}
		}
	}
}
