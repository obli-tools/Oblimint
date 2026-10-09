package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"net/http"
	"net/netip"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// ─────────────────────────────────────────────────────────────────────────────
// Firewall manager: holds the desired state (every account + the global
// egress settings), applies it with nft, persists it under <root>/run so a
// restarted hostd re-applies it before the panel pushes again, and re-applies
// at the next expiry of an entry. The last apply error stays visible
// (GET /v1/firewall, W1); a failed `nft -f` changes nothing in the kernel
// (one transaction), so the last good ruleset stays in force.
// ─────────────────────────────────────────────────────────────────────────────

// codeApplyFailed: nft refused the new state (502); the change is rolled back.
const codeApplyFailed = "applyFailed"

// nftRunner applies a ruleset (the real one pipes it into `nft -f -`).
type nftRunner interface {
	Available() bool
	Apply(ctx context.Context, ruleset string) error
}

type execNft struct{ path string }

func newExecNft() *execNft {
	p, err := exec.LookPath("nft")
	if err != nil {
		return &execNft{}
	}
	return &execNft{path: p}
}

func (n *execNft) Available() bool { return n.path != "" }

func (n *execNft) Apply(ctx context.Context, ruleset string) error {
	if n.path == "" {
		return fmt.Errorf("nft: %w (nftables is not installed)", errUnsupported)
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, n.path, "-f", "-")
	cmd.Stdin = strings.NewReader(ruleset)
	var out bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &out
	if err := cmd.Run(); err != nil {
		msg := strings.TrimSpace(out.String())
		if len(msg) > 2000 {
			msg = msg[:2000] + "…"
		}
		return fmt.Errorf("nft -f: %v: %s", err, msg)
	}
	return nil
}

// FirewallStatus is the answer of GET /v1/firewall.
type FirewallStatus struct {
	Backend          string  `json:"backend"`
	Accounts         int     `json:"accounts"`
	LastApplyAt      *string `json:"lastApplyAt"`
	LastApplyError   *string `json:"lastApplyError"`
	GatewayListeners int     `json:"gatewayListeners"`
	// AccountIDs / GatewayAccountIDs: accounts hostd holds a state for (the
	// panel removes those of deleted accounts).
	AccountIDs        []int64 `json:"accountIds"`
	GatewayAccountIDs []int64 `json:"gatewayAccountIds"`
	// MailBans: bans in force on the shared mail ports (P4).
	MailBans int `json:"mailBans"`
}

// persistedState is the state file (<root>/run/hostd-state.json, 0600).
type persistedState struct {
	Global   *FirewallGlobal                 `json:"global"`
	Accounts map[string]FirewallAccountState `json:"accounts"`
	Gateways map[string]GatewaySpec          `json:"gateways"`
	Mail     *MailFirewallState              `json:"mail,omitempty"`
}

type firewallManager struct {
	mu        sync.Mutex
	nft       nftRunner
	clock     clock
	statePath string
	resolvers func() []netip.Addr

	raw      map[int64]FirewallAccountState // as last APPLIED (persisted)
	accounts map[int64]accountRules         // validated, as last applied (rendered)
	global   *globalRules
	rawGlob  *FirewallGlobal
	// P4: bans on the shared mail ports (mail.go), as last applied.
	mail    *mailRules
	rawMail *MailFirewallState

	// desired: the validated state as last PUSHED, read lock-free by the
	// gateway's accept check (Allows) through an immutable copy-on-write
	// snapshot. Unlike raw/accounts it is NOT rolled back when nft refuses a
	// ruleset: the userspace check does not depend on nft, so a restriction
	// the kernel could not take (allowlist, ban) is still enforced by the
	// gateway instead of falling back to the older, more open state.
	desired atomic.Pointer[map[int64]accountRules]
	// pending: accounts whose desired state differs from the applied one
	// (their last push was refused by nft); a push of the same state is
	// then never skipped as "unchanged".
	pending map[int64]bool

	lastApplyAt    time.Time
	lastApplyError string
	expiryTimer    timer
	// appliedTargets: the PROXY-mode backends of the last render (a gateway
	// change re-applies only when they differ).
	appliedTargets string

	// gatewaySnapshot gives the persisted gateway specs (set by main).
	gatewaySnapshot func() map[int64]GatewaySpec
}

func newFirewallManager(nft nftRunner, c clock, statePath string) *firewallManager {
	m := &firewallManager{
		nft:       nft,
		clock:     c,
		statePath: statePath,
		resolvers: hostPrivateResolvers,
		raw:       map[int64]FirewallAccountState{},
		accounts:  map[int64]accountRules{},
		pending:   map[int64]bool{},
	}
	empty := map[int64]accountRules{}
	m.desired.Store(&empty)
	return m
}

// unchangedSkipWindow: a push identical to the applied state of an account
// is not re-applied when the last successful apply is more recent than this
// (the panel's periodic resync pushes every account in turn: the first push
// of a pass re-applies the whole ruleset, which heals a kernel table changed
// behind hostd's back, the following identical ones are no-ops).
const unchangedSkipWindow = time.Minute

// Allows is the gateway's accept check. It never waits for an nft run: it
// reads the immutable snapshot of the desired state. No state pushed for the
// account = no rule in nftables either: open (the panel pushes the state
// right after the gateway).
func (m *firewallManager) Allows(accountID int64, ip netip.Addr) (bool, string) {
	r, ok := (*m.desired.Load())[accountID]
	if !ok {
		return true, ""
	}
	return r.allows(ip, m.clock.Now())
}

// setDesiredLocked publishes a new snapshot with the entry of one account
// replaced (r != nil) or removed (r == nil). Copy-on-write: a snapshot is
// never modified once stored.
func (m *firewallManager) setDesiredLocked(accountID int64, r *accountRules) {
	cur := *m.desired.Load()
	next := make(map[int64]accountRules, len(cur)+1)
	for id, v := range cur {
		next[id] = v
	}
	if r != nil {
		next[accountID] = *r
	} else {
		delete(next, accountID)
	}
	m.desired.Store(&next)
}

// SetAccount validates, stores and applies the state of one account.
func (m *firewallManager) SetAccount(ctx context.Context, accountID int64, s FirewallAccountState) error {
	r, err := s.validate(accountID)
	if err != nil {
		return err
	}
	s.AccountID = accountID
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.unchangedLocked(accountID, s) {
		return nil
	}
	// The gateway enforces the new state right away, whatever nft says.
	m.setDesiredLocked(accountID, &r)
	undo := m.accountUndoLocked(accountID)
	m.raw[accountID] = s
	m.accounts[accountID] = r
	return m.commitAccountLocked(ctx, accountID, undo)
}

// unchangedLocked: the pushed state is the one already applied, nothing is
// pending for the account, and the ruleset was applied successfully a short
// while ago, so a new `nft -f` would change nothing.
func (m *firewallManager) unchangedLocked(accountID int64, s FirewallAccountState) bool {
	prev, ok := m.raw[accountID]
	if !ok || m.pending[accountID] || m.lastApplyError != "" || m.lastApplyAt.IsZero() {
		return false
	}
	if m.clock.Now().Sub(m.lastApplyAt) >= unchangedSkipWindow {
		return false
	}
	return reflect.DeepEqual(prev, s)
}

func (m *firewallManager) RemoveAccount(ctx context.Context, accountID int64) error {
	if err := validateID("account id", accountID); err != nil {
		return err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.setDesiredLocked(accountID, nil)
	undo := m.accountUndoLocked(accountID)
	delete(m.raw, accountID)
	delete(m.accounts, accountID)
	return m.commitAccountLocked(ctx, accountID, undo)
}

// commitAccountLocked commits a change of one account and tracks whether its
// desired state (kept for Allows) is now the applied one.
func (m *firewallManager) commitAccountLocked(ctx context.Context, accountID int64, undo func()) error {
	err := m.commitLocked(ctx, undo)
	var ae *apiError
	if errors.As(err, &ae) && ae.Code == codeApplyFailed {
		m.pending[accountID] = true
	} else {
		delete(m.pending, accountID)
	}
	return err
}

func (m *firewallManager) SetGlobal(ctx context.Context, g FirewallGlobal) error {
	r, err := g.validate()
	if err != nil {
		return err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	prevGlobal, prevRaw := m.global, m.rawGlob
	m.global = &r
	m.rawGlob = &g
	return m.commitLocked(ctx, func() { m.global, m.rawGlob = prevGlobal, prevRaw })
}

// SetMail validates, stores and applies the bans on the shared mail ports
// (replaces the whole mail state).
func (m *firewallManager) SetMail(ctx context.Context, s MailFirewallState) error {
	r, err := s.validate()
	if err != nil {
		return err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	prev, prevRaw := m.mail, m.rawMail
	m.mail, m.rawMail = &r, &s
	return m.commitLocked(ctx, func() { m.mail, m.rawMail = prev, prevRaw })
}

// accountUndoLocked returns the function that puts back the current entry
// of an account (or its absence).
func (m *firewallManager) accountUndoLocked(accountID int64) func() {
	prevRaw, had := m.raw[accountID]
	prevRules := m.accounts[accountID]
	return func() {
		if had {
			m.raw[accountID], m.accounts[accountID] = prevRaw, prevRules
		} else {
			delete(m.raw, accountID)
			delete(m.accounts, accountID)
		}
	}
}

// commitLocked applies the changed desired state. When nft REFUSES it
// (codeApplyFailed), the change is rolled back for RENDERING only: the
// stored (and persisted) state must always be one that applies, otherwise
// one bad account would block every later change of every account, and come
// back after a restart. The gateway accept check keeps the refused desired
// state (m.desired, never rolled back), so a refused restriction fails
// closed on the userspace layer. The error stays visible (lastApplyError,
// 502). Without nft at all (errUnsupported) the state is kept.
func (m *firewallManager) commitLocked(ctx context.Context, undo func()) error {
	err := m.applyLocked(ctx)
	var ae *apiError
	if errors.As(err, &ae) && ae.Code == codeApplyFailed {
		undo()
		now := m.clock.Now()
		m.scheduleExpiryLocked(nextRenderExpiry(m.inputLocked(now), now), now)
	}
	m.persistLocked()
	return err
}

// Reapply renders and applies the current state again (expiry, start).
func (m *firewallManager) Reapply(ctx context.Context) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.applyLocked(ctx)
}

func (m *firewallManager) Status(gatewayListeners int) FirewallStatus {
	m.mu.Lock()
	defer m.mu.Unlock()
	st := FirewallStatus{Backend: "none", Accounts: len(m.accounts), GatewayListeners: gatewayListeners, AccountIDs: []int64{}, GatewayAccountIDs: []int64{}}
	for id := range m.accounts {
		st.AccountIDs = append(st.AccountIDs, id)
	}
	slices.Sort(st.AccountIDs)
	if m.nft.Available() {
		st.Backend = "nftables"
	}
	st.MailBans = m.mail.liveCount(m.clock.Now())
	if !m.lastApplyAt.IsZero() {
		s := m.lastApplyAt.UTC().Format(time.RFC3339)
		st.LastApplyAt = &s
	}
	if m.lastApplyError != "" {
		e := m.lastApplyError
		st.LastApplyError = &e
	}
	return st
}

// Ruleset renders the current state (tests, debugging).
func (m *firewallManager) Ruleset() string {
	m.mu.Lock()
	defer m.mu.Unlock()
	return renderRuleset(m.inputLocked(m.clock.Now()))
}

func (m *firewallManager) inputLocked(now time.Time) renderInput {
	accounts := make([]accountRules, 0, len(m.accounts))
	for _, a := range m.accounts {
		accounts = append(accounts, a)
	}
	in := renderInput{Global: m.global, Accounts: accounts, Now: now, ProxiedTargets: m.proxiedTargetsLocked(), Mail: m.mail}
	// Resolvers: allowed in strict mode, and kept on port 53 when they sit
	// in the metadata range (metadata mode too).
	if m.global != nil && m.global.Egress != egressOff && m.resolvers != nil {
		in.HostResolvers = m.resolvers()
	}
	return in
}

// proxiedTargetsLocked: the backends of the PROXY-mode gateways (only hostd
// may reach them, see renderInput.ProxiedTargets).
func (m *firewallManager) proxiedTargetsLocked() []netip.AddrPort {
	if m.gatewaySnapshot == nil {
		return nil
	}
	var out []netip.AddrPort
	for _, s := range m.gatewaySnapshot() {
		if !s.ProxyProtocol || s.Target == nil {
			continue
		}
		a, err := netip.ParseAddr(s.Target.IP)
		if err != nil || s.Target.Port < 1 || s.Target.Port > 65535 {
			continue
		}
		out = append(out, netip.AddrPortFrom(a.Unmap(), uint16(s.Target.Port)))
	}
	return uniqueAddrPorts(out)
}

// GatewayChanged is the gateway's onChange: persists, and re-applies the
// ruleset when the set of PROXY-mode backends changed.
func (m *firewallManager) GatewayChanged() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.persistLocked()
	if fmt.Sprint(m.proxiedTargetsLocked()) == m.appliedTargets {
		return
	}
	if err := m.applyLocked(context.Background()); err != nil {
		slog.Warn("firewall re-apply after a gateway change failed", "err", err)
	}
}

func (m *firewallManager) applyLocked(ctx context.Context) error {
	now := m.clock.Now()
	in := m.inputLocked(now)
	m.scheduleExpiryLocked(nextRenderExpiry(in, now), now)
	m.appliedTargets = fmt.Sprint(in.ProxiedTargets)
	err := m.nft.Apply(ctx, renderRuleset(in))
	if err != nil {
		m.lastApplyError = err.Error()
		slog.Error("firewall apply failed (the previous ruleset stays in force)", "err", err)
		if errors.Is(err, errUnsupported) {
			return err
		}
		return &apiError{http.StatusBadGateway, codeApplyFailed, err.Error()}
	}
	m.lastApplyAt = now
	m.lastApplyError = ""
	return nil
}

// scheduleExpiryLocked re-applies one second after the next expiry: covered
// entries come back, expired ones leave (also the panel's job every 5 min).
func (m *firewallManager) scheduleExpiryLocked(next, now time.Time) {
	if m.expiryTimer != nil {
		m.expiryTimer.Stop()
		m.expiryTimer = nil
	}
	if next.IsZero() {
		return
	}
	m.expiryTimer = m.clock.AfterFunc(next.Sub(now)+time.Second, func() {
		if err := m.Reapply(context.Background()); err != nil {
			slog.Warn("firewall re-apply at expiry failed", "err", err)
		}
	})
}

// ── Persistence ──────────────────────────────────────────────────────────────

func (m *firewallManager) persistLocked() {
	if m.statePath == "" {
		return
	}
	st := persistedState{Global: m.rawGlob, Accounts: map[string]FirewallAccountState{}, Mail: m.rawMail}
	for id, s := range m.raw {
		st.Accounts[fmt.Sprint(id)] = s
	}
	if m.gatewaySnapshot != nil {
		st.Gateways = map[string]GatewaySpec{}
		for id, g := range m.gatewaySnapshot() {
			st.Gateways[fmt.Sprint(id)] = g
		}
	}
	if err := writeFileAtomic(m.statePath, st); err != nil {
		slog.Warn("hostd state not persisted", "path", m.statePath, "err", err)
	}
}

// Persist saves the state now (gateway changes).
func (m *firewallManager) Persist() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.persistLocked()
}

func writeFileAtomic(p string, v any) error {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o750); err != nil {
		return err
	}
	tmp := p + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, p)
}

// loadState reads the state file (missing = empty). Entries that no longer
// validate are skipped (logged).
func loadState(p string) (persistedState, error) {
	var st persistedState
	b, err := os.ReadFile(p)
	if errors.Is(err, fs.ErrNotExist) {
		return st, nil
	}
	if err != nil {
		return st, err
	}
	if err := json.Unmarshal(b, &st); err != nil {
		return st, fmt.Errorf("%s: %w", p, err)
	}
	return st, nil
}

// Restore loads the persisted firewall state and applies it (hostd start).
func (m *firewallManager) Restore(ctx context.Context, st persistedState) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if st.Global != nil {
		if r, err := st.Global.validate(); err == nil {
			m.global, m.rawGlob = &r, st.Global
		} else {
			slog.Warn("persisted global firewall state skipped", "err", err)
		}
	}
	if st.Mail != nil {
		if r, err := st.Mail.validate(); err == nil {
			m.mail, m.rawMail = &r, st.Mail
		} else {
			slog.Warn("persisted mail firewall state skipped", "err", err)
		}
	}
	for key, s := range st.Accounts {
		id, err := parseID(key)
		if err != nil {
			continue
		}
		r, err := s.validate(id)
		if err != nil {
			slog.Warn("persisted firewall state skipped", "accountId", id, "err", err)
			continue
		}
		m.raw[id], m.accounts[id] = s, r
		m.setDesiredLocked(id, &r)
	}
	return m.applyLocked(ctx)
}

// hostPrivateResolvers: private name servers of the host (resolv.conf, and
// systemd-resolved's real upstreams), allowed in strict egress mode (and on
// port 53 when link-local, metadata mode too) so the
// containers' DNS (Docker forwards from the container namespace) keeps working.
func hostPrivateResolvers() []netip.Addr {
	var out []netip.Addr
	for _, p := range []string{"/etc/resolv.conf", "/run/systemd/resolve/resolv.conf"} {
		f, err := os.Open(p)
		if err != nil {
			continue
		}
		out = append(out, parseResolvConf(f)...)
		f.Close()
	}
	return out
}

func parseResolvConf(r io.Reader) []netip.Addr {
	var out []netip.Addr
	sc := bufio.NewScanner(r)
	for sc.Scan() {
		fields := strings.Fields(sc.Text())
		if len(fields) < 2 || fields[0] != "nameserver" {
			continue
		}
		a, err := netip.ParseAddr(fields[1])
		if err != nil || a.Zone() != "" {
			continue
		}
		a = a.Unmap()
		if a.IsPrivate() || a.IsLinkLocalUnicast() {
			out = append(out, a)
		}
	}
	return out
}
