package main

import (
	"context"
	"errors"
	"flag"
	"net/http"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

var updateGolden = flag.Bool("update", false, "rewrite the testdata/*.nft golden files")

var fwNow = time.Date(2026, 10, 9, 12, 0, 0, 0, time.UTC)

func ts(d time.Duration) *string {
	s := fwNow.Add(d).Format(time.RFC3339)
	return &s
}

func mustRules(t *testing.T, id int64, s FirewallAccountState) accountRules {
	t.Helper()
	r, err := s.validate(id)
	if err != nil {
		t.Fatalf("validate %d: %v", id, err)
	}
	return r
}

func mustGlobal(t *testing.T, g FirewallGlobal) *globalRules {
	t.Helper()
	r, err := g.validate()
	if err != nil {
		t.Fatalf("validate global: %v", err)
	}
	return &r
}

func golden(t *testing.T, name, got string) {
	t.Helper()
	p := filepath.Join("testdata", name+".nft")
	if *updateGolden {
		if err := os.MkdirAll("testdata", 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(got), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	want, err := os.ReadFile(p)
	if err != nil {
		t.Fatalf("%s: %v (run go test -update)", p, err)
	}
	if strings.ReplaceAll(string(want), "\r\n", "\n") != got {
		t.Errorf("%s differs:\n--- got ---\n%s\n--- want ---\n%s", p, got, want)
	}
}

// The three modes, v4 + v6, gateway vs published ports, expiries and
// overlapping entries.
func TestRenderAccounts(t *testing.T) {
	accounts := []accountRules{
		mustRules(t, 9, FirewallAccountState{ // listed out of order: rendered sorted
			Mode: modeAuto2FA, GatewayPorts: []int{30009},
			Allow: []FirewallAllow{
				{CIDR: "198.51.100.7", ExpiresAt: ts(4 * time.Hour)},
				{CIDR: "2001:db8:1:2::abcd", ExpiresAt: ts(4 * time.Hour)},
				{CIDR: "198.51.100.8", ExpiresAt: ts(-time.Minute)}, // expired: absent
			},
		}),
		mustRules(t, 3, FirewallAccountState{
			Mode: modeOpen, GatewayPorts: []int{30003}, PublishedPorts: []int{33001, 33000},
			Bans: []FirewallBan{
				{IP: "203.0.113.9", ExpiresAt: *ts(time.Hour)},
				{IP: "2001:db8:aa:bb::/64", ExpiresAt: *ts(30 * time.Minute)},
				{IP: "203.0.113.10", ExpiresAt: *ts(-time.Second)}, // expired
			},
		}),
		mustRules(t, 5, FirewallAccountState{
			Mode: modeAllowlist, GatewayPorts: []int{30005}, PublishedPorts: []int{33005},
			Allow: []FirewallAllow{
				{CIDR: "10.0.0.0/8"},
				{CIDR: "10.1.2.3"}, // covered by 10/8: dropped (interval sets refuse overlaps)
				{CIDR: "::ffff:192.0.2.1"},
				{CIDR: "2001:db8::/32", ExpiresAt: ts(90 * time.Second)},
			},
			Bans: []FirewallBan{{IP: "192.0.2.66", ExpiresAt: *ts(time.Hour)}},
		}),
		// Allowlist WITHOUT any entry: everything refused on its ports.
		mustRules(t, 6, FirewallAccountState{Mode: modeAllowlist, GatewayPorts: []int{30006}}),
		// No port: no set, no rule.
		mustRules(t, 7, FirewallAccountState{Mode: modeAllowlist, Allow: []FirewallAllow{{CIDR: "192.0.2.1"}}}),
	}
	golden(t, "accounts", renderRuleset(renderInput{Accounts: accounts, Now: fwNow}))
}

func TestRenderEgress(t *testing.T) {
	g := FirewallGlobal{
		AccountSubnets: []string{"172.20.0.0/16", "172.21.0.0/16", "fd00:20::/64"},
		EgressAllow:    []string{"172.18.0.0/16", "1.1.1.1", "8.8.8.8"},
	}
	for _, mode := range []EgressMode{egressOff, egressMetadata, egressStrict} {
		g.Egress = mode
		in := renderInput{Global: mustGlobal(t, g), Now: fwNow, HostResolvers: []netip.Addr{netip.MustParseAddr("192.168.1.1")}}
		golden(t, "egress-"+string(mode), renderRuleset(in))
	}
	// No account network known yet: nothing to filter.
	g.Egress, g.AccountSubnets = egressStrict, nil
	out := renderRuleset(renderInput{Global: mustGlobal(t, g), Now: fwNow})
	if strings.Contains(out, "acct_nets") || strings.Contains(out, "drop") {
		t.Errorf("egress without subnets:\n%s", out)
	}
}

// The ruleset ALWAYS replaces the table atomically and never accepts (W1).
func TestRenderOnlyDrops(t *testing.T) {
	in := renderInput{
		Global:   mustGlobal(t, FirewallGlobal{Egress: egressStrict, AccountSubnets: []string{"172.20.0.0/16"}}),
		Accounts: []accountRules{mustRules(t, 1, FirewallAccountState{Mode: modeAllowlist, GatewayPorts: []int{30001}, PublishedPorts: []int{33001}})},
		Now:      fwNow,
	}
	out := renderRuleset(in)
	lines := strings.Split(out, "\n")
	if lines[1] != "table inet oblimint" || lines[2] != "delete table inet oblimint" {
		t.Errorf("not an atomic replace:\n%s", out)
	}
	for _, l := range lines {
		l = strings.TrimSpace(l)
		if strings.Contains(l, " accept") && !strings.HasPrefix(l, "type filter hook") || strings.Contains(l, "jump") || strings.Contains(l, "goto") {
			t.Errorf("non-drop verdict: %q", l)
		}
	}
	if !strings.Contains(out, "priority -10; policy accept;") {
		t.Error("base chains must run before Docker's (priority -10)")
	}
}

func TestValidateAccountState(t *testing.T) {
	ok := FirewallAccountState{Mode: modeOpen}
	if _, err := ok.validate(3); err != nil {
		t.Fatal(err)
	}
	bad := []FirewallAccountState{
		{Mode: "closed"},
		{AccountID: 4, Mode: modeOpen},
		{Mode: modeOpen, GatewayPorts: []int{0}},
		{Mode: modeOpen, PublishedPorts: []int{65536}},
		{Mode: modeOpen, Allow: []FirewallAllow{{CIDR: "0.0.0.0/0"}}},
		{Mode: modeOpen, Allow: []FirewallAllow{{CIDR: "10.0.0.0/7"}}},
		{Mode: modeOpen, Allow: []FirewallAllow{{CIDR: "::/0"}}},
		{Mode: modeOpen, Allow: []FirewallAllow{{CIDR: "2001::/31"}}},
		{Mode: modeOpen, Allow: []FirewallAllow{{CIDR: "1.2.3.4; flush ruleset"}}},
		{Mode: modeOpen, Allow: []FirewallAllow{{CIDR: "1.2.3.4 } drop"}}},
		{Mode: modeOpen, Allow: []FirewallAllow{{CIDR: "fe80::1%eth0"}}},
		{Mode: modeOpen, Allow: []FirewallAllow{{CIDR: "example.com"}}},
		{Mode: modeOpen, Allow: []FirewallAllow{{CIDR: "1.2.3.4", ExpiresAt: ptr("tomorrow")}}},
		{Mode: modeOpen, Bans: []FirewallBan{{IP: "1.2.3.4", ExpiresAt: ""}}},
		{Mode: modeOpen, Bans: []FirewallBan{{IP: "1.2.0.0/16", ExpiresAt: *ts(time.Hour)}}},
		{Mode: modeOpen, Bans: []FirewallBan{{IP: "2001:db8::/32", ExpiresAt: *ts(time.Hour)}}},
	}
	for _, s := range bad {
		if _, err := s.validate(3); !isBadRequest(err) {
			t.Errorf("%+v accepted", s)
		}
	}
	if _, err := ok.validate(0); !isBadRequest(err) {
		t.Error("account id 0 accepted")
	}
	// Normalization: masked, v4-mapped unmapped.
	r := mustRules(t, 3, FirewallAccountState{Mode: modeAllowlist, Allow: []FirewallAllow{{CIDR: "10.1.2.3/8"}, {CIDR: "::ffff:10.0.0.1"}}})
	if r.Allow[0].Prefix.String() != "10.0.0.0/8" || r.Allow[1].Prefix.String() != "10.0.0.1/32" {
		t.Errorf("normalized = %v", r.Allow)
	}
	for _, g := range []FirewallGlobal{{Egress: "on"}, {Egress: egressStrict, AccountSubnets: []string{"0.0.0.0/0"}}, {Egress: egressOff, EgressAllow: []string{"x"}}} {
		if _, err := g.validate(); !isBadRequest(err) {
			t.Errorf("global %+v accepted", g)
		}
	}
}

func ptr(s string) *string { return &s }

func TestAllowsDecision(t *testing.T) {
	ip := netip.MustParseAddr
	open := mustRules(t, 1, FirewallAccountState{Mode: modeOpen, Bans: []FirewallBan{{IP: "2001:db8:1:2::/64", ExpiresAt: *ts(time.Hour)}}})
	if ok, _ := open.allows(ip("203.0.113.1"), fwNow); !ok {
		t.Error("open refused")
	}
	if ok, why := open.allows(ip("2001:db8:1:2::99"), fwNow); ok || why != "banned" {
		t.Error("banned /64 accepted")
	}
	if ok, _ := open.allows(ip("2001:db8:1:2::99"), fwNow.Add(2*time.Hour)); !ok {
		t.Error("expired ban still applied")
	}
	al := mustRules(t, 1, FirewallAccountState{Mode: modeAuto2FA, Allow: []FirewallAllow{
		{CIDR: "198.51.100.0/24"}, {CIDR: "192.0.2.7", ExpiresAt: ts(time.Minute)},
	}, Bans: []FirewallBan{{IP: "198.51.100.66", ExpiresAt: *ts(time.Hour)}}})
	cases := []struct {
		ip   string
		at   time.Time
		want bool
	}{
		{"198.51.100.5", fwNow, true},
		{"::ffff:198.51.100.5", fwNow, true},
		{"198.51.100.66", fwNow, false}, // ban beats the allow-list
		{"192.0.2.7", fwNow, true},
		{"192.0.2.7", fwNow.Add(2 * time.Minute), false}, // grant expired
		{"203.0.113.1", fwNow, false},
		{"2001:db8::1", fwNow, false},
	}
	for _, c := range cases {
		if ok, _ := al.allows(ip(c.ip), c.at); ok != c.want {
			t.Errorf("%s at %v: %v", c.ip, c.at, ok)
		}
	}
}

// ── Manager ─────────────────────────────────────────────────────────────────

type fakeNft struct {
	mu        sync.Mutex
	available bool
	fail      error
	applied   []string
}

func (f *fakeNft) Available() bool { return f.available }
func (f *fakeNft) Apply(_ context.Context, rs string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.fail != nil {
		return f.fail
	}
	f.applied = append(f.applied, rs)
	return nil
}
func (f *fakeNft) last() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.applied) == 0 {
		return ""
	}
	return f.applied[len(f.applied)-1]
}
func (f *fakeNft) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.applied)
}

func TestFirewallManagerApplyPersistRestore(t *testing.T) {
	clk := newFakeClock(fwNow)
	nft := &fakeNft{available: true}
	state := filepath.Join(t.TempDir(), "run", "hostd-state.json")
	m := newFirewallManager(nft, clk, state)
	m.resolvers = nil

	s := FirewallAccountState{Mode: modeAllowlist, GatewayPorts: []int{30003}, Allow: []FirewallAllow{
		{CIDR: "198.51.100.0/24"},
		{CIDR: "198.51.100.7", ExpiresAt: ts(10 * time.Minute)},
	}}
	if err := m.SetAccount(bg, 3, s); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(nft.last(), "allow4_3") || strings.Contains(nft.last(), "198.51.100.7") {
		t.Errorf("covered entry rendered:\n%s", nft.last())
	}
	if ok, _ := m.Allows(3, netip.MustParseAddr("203.0.113.1")); ok {
		t.Error("gateway check accepts an address outside the allow-list")
	}
	if ok, _ := m.Allows(99, netip.MustParseAddr("203.0.113.1")); !ok {
		t.Error("an account without state must be open (no nft rule either)")
	}
	st := m.Status(2)
	if st.Backend != "nftables" || st.Accounts != 1 || st.LastApplyAt == nil || st.LastApplyError != nil || st.GatewayListeners != 2 {
		t.Errorf("status = %+v", st)
	}

	// The next expiry re-applies by itself.
	n := nft.count()
	clk.Advance(11 * time.Minute)
	if nft.count() != n+1 {
		t.Errorf("no re-apply at expiry (%d → %d)", n, nft.count())
	}

	// A failing nft: error surfaced (502 applyFailed), status shows it, and
	// the refused change is ROLLED BACK (stored + persisted state = the last
	// one that applied), so it blocks neither later changes nor a restart.
	nft.fail = errors.New("nft -f: Error: Could not process rule")
	err := m.SetGlobal(bg, FirewallGlobal{Egress: egressMetadata, AccountSubnets: []string{"172.20.0.0/16"}})
	if status, code := classify(err); status != http.StatusBadGateway || code != codeApplyFailed {
		t.Errorf("failed apply: %v", err)
	}
	if st := m.Status(0); st.LastApplyError == nil || !strings.Contains(*st.LastApplyError, "Could not process") {
		t.Errorf("status after failure = %+v", st)
	}
	err = m.SetAccount(bg, 4, FirewallAccountState{Mode: modeOpen, GatewayPorts: []int{30004}})
	if _, code := classify(err); code != codeApplyFailed {
		t.Errorf("failed apply: %v", err)
	}
	if st := m.Status(0); st.Accounts != 1 {
		t.Errorf("refused account kept: %+v", st)
	}
	if ok, _ := m.Allows(3, netip.MustParseAddr("203.0.113.1")); ok {
		t.Error("account 3 lost its state on a refused change of another account")
	}
	if p, _ := loadState(state); p.Global != nil || len(p.Accounts) != 1 {
		t.Errorf("refused state persisted: %+v", p)
	}
	nft.fail = nil
	if !strings.Contains(m.Ruleset(), "allow4_3") || strings.Contains(m.Ruleset(), "acct_nets4") {
		t.Errorf("ruleset after rollback:\n%s", m.Ruleset())
	}
	if err := m.SetGlobal(bg, FirewallGlobal{Egress: egressMetadata, AccountSubnets: []string{"172.20.0.0/16"}}); err != nil {
		t.Fatal(err)
	}

	// Restart: a new manager restores and applies the persisted state.
	loaded, err := loadState(state)
	if err != nil {
		t.Fatal(err)
	}
	nft2 := &fakeNft{available: true}
	m2 := newFirewallManager(nft2, clk, state)
	m2.resolvers = nil
	if err := m2.Restore(bg, loaded); err != nil {
		t.Fatal(err)
	}
	if got := nft2.last(); !strings.Contains(got, "allow4_3") || !strings.Contains(got, "acct_nets4") {
		t.Errorf("restored ruleset:\n%s", got)
	}

	if err := m2.RemoveAccount(bg, 3); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(nft2.last(), "allow4_3") {
		t.Error("removed account still rendered")
	}
	// Invalid input: 400, nothing applied.
	n = nft2.count()
	if err := m2.SetAccount(bg, 3, FirewallAccountState{Mode: "x"}); !isBadRequest(err) || nft2.count() != n {
		t.Errorf("invalid state: %v", err)
	}
}

func TestFirewallWithoutNft(t *testing.T) {
	m := newFirewallManager(&execNft{}, newFakeClock(fwNow), "")
	err := m.SetAccount(bg, 3, FirewallAccountState{Mode: modeOpen})
	if _, code := classify(err); code != codeUnsupported {
		t.Errorf("without nft: %v", err)
	}
	if st := m.Status(0); st.Backend != "none" || st.LastApplyError == nil {
		t.Errorf("status = %+v", st)
	}
	// The state is still used by the gateway.
	if m.Status(0).Accounts != 1 {
		t.Error("state dropped")
	}
}

func TestParseResolvConf(t *testing.T) {
	got := parseResolvConf(strings.NewReader("# x\nnameserver 192.168.1.1\nnameserver 1.1.1.1\nnameserver fe80::1%eth0\nnameserver 10.99.0.2\nsearch lan\n"))
	if len(got) != 2 || got[0].String() != "192.168.1.1" || got[1].String() != "10.99.0.2" {
		t.Errorf("resolvers = %v", got)
	}
}

// A host whose resolver is the metadata server (GCP 169.254.169.254): DNS
// stays reachable from the sites (port 53 only) in metadata AND strict mode;
// the PROXY-mode file servers are reachable only through hostd.
func TestRenderMetadataResolverAndProxiedTargets(t *testing.T) {
	g := FirewallGlobal{AccountSubnets: []string{"172.20.0.0/16"}}
	for _, mode := range []EgressMode{egressMetadata, egressStrict} {
		g.Egress = mode
		in := renderInput{
			Global: mustGlobal(t, g), Now: fwNow,
			HostResolvers: []netip.Addr{netip.MustParseAddr("169.254.169.254"), netip.MustParseAddr("10.99.0.2")},
			ProxiedTargets: []netip.AddrPort{
				netip.MustParseAddrPort("172.20.0.3:2022"), netip.MustParseAddrPort("[fd00:20::3]:2022"),
				netip.MustParseAddrPort("172.20.0.3:2022"), // duplicate
			},
		}
		golden(t, "egress-"+string(mode)+"-dns", renderRuleset(in))
	}
}

// The gateway's onChange re-applies when the PROXY-mode backends change.
func TestFirewallFollowsGatewayTargets(t *testing.T) {
	nft := &fakeNft{available: true}
	m := newFirewallManager(nft, newFakeClock(fwNow), "")
	m.resolvers = nil
	specs := map[int64]GatewaySpec{}
	m.gatewaySnapshot = func() map[int64]GatewaySpec { return specs }
	if err := m.Reapply(bg); err != nil {
		t.Fatal(err)
	}
	n := nft.count()
	specs[3] = GatewaySpec{AccountID: 3, Port: 30003, ProxyProtocol: true}
	m.GatewayChanged() // no target yet: nothing to change
	if nft.count() != n {
		t.Error("re-applied without a target change")
	}
	specs[3] = GatewaySpec{AccountID: 3, Port: 30003, ProxyProtocol: true, Target: &GatewayTarget{IP: "172.20.0.3", Port: 2022}}
	specs[4] = GatewaySpec{AccountID: 4, Port: 30004, Target: &GatewayTarget{IP: "172.21.0.3", Port: 2022}} // no PROXY: published path, never dropped
	m.GatewayChanged()
	if nft.count() != n+1 || !strings.Contains(nft.last(), "ip daddr 172.20.0.3 tcp dport 2022 ct direction original drop") || strings.Contains(nft.last(), "172.21.0.3") {
		t.Errorf("ruleset after target push:\n%s", nft.last())
	}
	m.GatewayChanged()
	if nft.count() != n+1 {
		t.Error("re-applied for an unchanged target")
	}
}

// A ruleset refused by nft is rolled back for rendering only: the gateway
// accept check keeps the pushed (stricter) state, also for an account whose
// very first push was refused.
func TestFirewallRefusedApplyKeepsGatewayCheck(t *testing.T) {
	clk := newFakeClock(fwNow)
	nft := &fakeNft{available: true}
	state := filepath.Join(t.TempDir(), "run", "hostd-state.json")
	m := newFirewallManager(nft, clk, state)
	m.resolvers = nil
	outside := netip.MustParseAddr("203.0.113.1")

	if err := m.SetAccount(bg, 5, FirewallAccountState{Mode: modeOpen, GatewayPorts: []int{30005}}); err != nil {
		t.Fatal(err)
	}
	nft.fail = errors.New("nft -f: Error: Could not process rule")
	allow := FirewallAccountState{Mode: modeAllowlist, GatewayPorts: []int{30005}, Allow: []FirewallAllow{{CIDR: "198.51.100.0/24"}}}
	if _, code := classify(m.SetAccount(bg, 5, allow)); code != codeApplyFailed {
		t.Fatal("refused apply not reported")
	}
	if ok, _ := m.Allows(5, outside); ok {
		t.Error("refused allowlist: the gateway fell back to the old open state")
	}
	if ok, _ := m.Allows(5, netip.MustParseAddr("198.51.100.9")); !ok {
		t.Error("allow-listed address refused")
	}
	if strings.Contains(m.Ruleset(), "allow4_5") {
		t.Error("refused state rendered")
	}
	if p, _ := loadState(state); p.Accounts["5"].Mode != modeOpen {
		t.Errorf("refused state persisted: %+v", p.Accounts["5"])
	}
	// New account, first push refused: no fail-open default.
	allow6 := allow
	allow6.GatewayPorts = []int{30006}
	if _, code := classify(m.SetAccount(bg, 6, allow6)); code != codeApplyFailed {
		t.Fatal("refused apply not reported")
	}
	if ok, _ := m.Allows(6, outside); ok {
		t.Error("refused first push: the gateway check is fail-open")
	}
	// nft recovers: the identical push is NOT skipped (pending) and applies.
	nft.fail = nil
	n := nft.count()
	if err := m.SetAccount(bg, 5, allow); err != nil {
		t.Fatal(err)
	}
	if nft.count() != n+1 || !strings.Contains(nft.last(), "allow4_5") {
		t.Errorf("pending state not re-applied:\n%s", nft.last())
	}
	if m.pending[5] || !m.pending[6] {
		t.Errorf("pending = %v", m.pending)
	}
	// A refused removal still drops the gateway entry (the account is gone).
	nft.fail = errors.New("nft -f: boom")
	if _, code := classify(m.RemoveAccount(bg, 5)); code != codeApplyFailed {
		t.Fatal("refused apply not reported")
	}
	if ok, _ := m.Allows(5, outside); !ok {
		t.Error("removed account still checked")
	}
	if !strings.Contains(m.Ruleset(), "allow4_5") {
		t.Error("refused removal not rolled back for rendering")
	}
}

// A push identical to the applied state does not re-run nft while the last
// successful apply is recent; a changed one, or an old apply, does.
func TestFirewallSkipsUnchangedPush(t *testing.T) {
	clk := newFakeClock(fwNow)
	nft := &fakeNft{available: true}
	m := newFirewallManager(nft, clk, "")
	m.resolvers = nil
	s := FirewallAccountState{Mode: modeAllowlist, GatewayPorts: []int{30007}, Allow: []FirewallAllow{{CIDR: "198.51.100.0/24"}}}
	if err := m.SetAccount(bg, 7, s); err != nil {
		t.Fatal(err)
	}
	n := nft.count()
	same := FirewallAccountState{Mode: modeAllowlist, GatewayPorts: []int{30007}, Allow: []FirewallAllow{{CIDR: "198.51.100.0/24"}}}
	if err := m.SetAccount(bg, 7, same); err != nil || nft.count() != n {
		t.Errorf("unchanged push re-applied (%d → %d, %v)", n, nft.count(), err)
	}
	clk.Advance(2 * unchangedSkipWindow)
	if err := m.SetAccount(bg, 7, same); err != nil || nft.count() != n+1 {
		t.Errorf("resync after the window not applied (%d → %d)", n, nft.count())
	}
	same.Allow = append(same.Allow, FirewallAllow{CIDR: "192.0.2.0/24"})
	if err := m.SetAccount(bg, 7, same); err != nil || nft.count() != n+2 {
		t.Errorf("changed push skipped (%d → %d)", n, nft.count())
	}
}

// blockingNft holds every Apply until released.
type blockingNft struct {
	started chan struct{}
	release chan struct{}
}

func (b *blockingNft) Available() bool { return true }
func (b *blockingNft) Apply(context.Context, string) error {
	b.started <- struct{}{}
	<-b.release
	return nil
}

// The gateway accept check never waits behind a running `nft -f`, and it
// already enforces the state being applied.
func TestFirewallAllowsDoesNotWaitForNft(t *testing.T) {
	nft := &blockingNft{started: make(chan struct{}, 1), release: make(chan struct{})}
	m := newFirewallManager(nft, newFakeClock(fwNow), "")
	m.resolvers = nil
	done := make(chan error, 1)
	go func() {
		done <- m.SetAccount(bg, 8, FirewallAccountState{Mode: modeAllowlist, GatewayPorts: []int{30008}, Allow: []FirewallAllow{{CIDR: "198.51.100.0/24"}}})
	}()
	<-nft.started
	res := make(chan bool, 1)
	go func() {
		ok, _ := m.Allows(8, netip.MustParseAddr("203.0.113.1"))
		res <- ok
	}()
	select {
	case ok := <-res:
		if ok {
			t.Error("state being applied not enforced by the gateway")
		}
	case <-time.After(2 * time.Second):
		t.Error("Allows blocked behind the nft run")
	}
	close(nft.release)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

// R-EGRESS regression (P2 Linux run): a Docker-published port of the host
// (another account's external SQL, the panel, other apps) is DNAT-ed in
// prerouting and then crosses FORWARD, never INPUT. The "account networks →
// host" drops must therefore also run in a prerouting chain placed BEFORE
// Docker's DNAT (-100), matching every local destination address.
func TestRenderEgressToHostBeforeDNAT(t *testing.T) {
	for _, mode := range []EgressMode{egressMetadata, egressStrict} {
		in := renderInput{
			Global: mustGlobal(t, FirewallGlobal{Egress: mode, AccountSubnets: []string{"172.20.0.0/16", "fd00:20::/64"}}),
			Now:    fwNow,
		}
		out := renderRuleset(in)
		i := strings.Index(out, "chain prerouting {")
		if i < 0 {
			t.Fatalf("%s: no prerouting chain:\n%s", mode, out)
		}
		chain := out[i : i+strings.Index(out[i:], "\n\t}")]
		if nftPreroutingPriority <= -200 || nftPreroutingPriority >= -100 {
			t.Errorf("prerouting priority %d must be after conntrack (-200) and before dstnat (-100)", nftPreroutingPriority)
		}
		for _, want := range []string{
			"type filter hook prerouting priority -150; policy accept;",
			"ip saddr @acct_nets4 fib daddr type local ct state new tcp dport != { 80, 443 } drop",
			"ip saddr @acct_nets4 fib daddr type local ct state new meta l4proto != { tcp, icmp } drop",
			"ip6 saddr @acct_nets6 fib daddr type local ct state new tcp dport != { 80, 443 } drop",
		} {
			if !strings.Contains(chain, want) {
				t.Errorf("%s: prerouting lacks %q:\n%s", mode, want, chain)
			}
		}
	}
	// Egress off: no prerouting chain at all.
	off := renderRuleset(renderInput{Global: mustGlobal(t, FirewallGlobal{Egress: egressOff, AccountSubnets: []string{"172.20.0.0/16"}}), Now: fwNow})
	if strings.Contains(off, "prerouting") {
		t.Errorf("egress off renders a prerouting chain:\n%s", off)
	}
}
