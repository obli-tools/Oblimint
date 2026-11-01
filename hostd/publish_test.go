package main

import (
	"context"
	"errors"
	"fmt"
	"net/netip"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// ── fakes ────────────────────────────────────────────────────────────────────

type fakeNet struct {
	mu        sync.Mutex
	addrs     map[netip.Addr]string // address → interface
	bridges   map[string][]netip.Prefix
	listeners []HostListener
	ops       []string
	addErr    error
	eth0      []string // prefixes of eth0 (Interfaces)
}

func newFakeNet() *fakeNet {
	return &fakeNet{addrs: map[netip.Addr]string{}, bridges: map[string][]netip.Prefix{
		"omf5": {netip.MustParsePrefix("10.224.5.1/24")},
		"omf6": {netip.MustParsePrefix("10.224.6.1/24")},
	}}
}

func (f *fakeNet) Interfaces() ([]NetInterface, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := []NetInterface{{Name: "eth0", Up: true, DefaultRoute: true, Addresses: append([]string{}, f.eth0...)}}
	out = append(out, NetInterface{Name: "lo", Up: true, Addresses: []string{"127.0.0.1/8"}})
	for name, ps := range f.bridges {
		i := NetInterface{Name: name, Up: true}
		for _, p := range ps {
			i.Addresses = append(i.Addresses, p.String())
		}
		out = append(out, i)
	}
	return out, nil
}
func (f *fakeNet) AddrIface(a netip.Addr) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.addrs[a], nil
}
func (f *fakeNet) AddAddr(_ context.Context, iface string, a netip.Addr, p int) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.ops = append(f.ops, fmt.Sprintf("add %s/%d %s", a, p, iface))
	if f.addErr != nil {
		return f.addErr
	}
	f.addrs[a] = iface
	return nil
}
func (f *fakeNet) DelAddr(_ context.Context, iface string, a netip.Addr, p int) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.ops = append(f.ops, fmt.Sprintf("del %s/%d %s", a, p, iface))
	delete(f.addrs, a)
	return nil
}
func (f *fakeNet) Announce(_ context.Context, iface string, a netip.Addr) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.ops = append(f.ops, fmt.Sprintf("arp %s %s", a, iface))
}
func (f *fakeNet) DefaultRouteIface() (string, error) { return "eth0", nil }
func (f *fakeNet) BridgePrefixes(b string) ([]netip.Prefix, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.bridges[b], nil
}
func (f *fakeNet) Listeners() ([]HostListener, error) { return f.listeners, nil }

type recNft struct {
	mu      sync.Mutex
	applied []string
	fail    error
	log     *[]string
}

func (n *recNft) Available() bool { return true }
func (n *recNft) Apply(_ context.Context, s string) error {
	n.mu.Lock()
	defer n.mu.Unlock()
	if n.log != nil {
		*n.log = append(*n.log, "nft")
	}
	if n.fail != nil {
		return n.fail
	}
	n.applied = append(n.applied, s)
	return nil
}

// fakeRunner answers the iptables / nft calls of dockerAccept.
type fakeRunner struct {
	mu      sync.Mutex
	calls   []string
	chains  map[string]bool // binary → has DOCKER-USER
	rules   map[string]int  // binary → copies of our rule
	nftOut  string          // nft list table ip docker-bridges ("" = absent)
	present map[string]bool
}

func (r *fakeRunner) run(_ context.Context, name string, args ...string) ([]byte, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	line := name + " " + strings.Join(args, " ")
	r.calls = append(r.calls, line)
	switch {
	case name == "nft":
		if r.nftOut == "" {
			return nil, errors.New("no such table")
		}
		return []byte(r.nftOut), nil
	case strings.Contains(line, "-S DOCKER-USER"):
		if r.chains[name] {
			return []byte("-N DOCKER-USER\n"), nil
		}
		return nil, errors.New("chain not found")
	case strings.Contains(line, "-C DOCKER-USER"):
		if r.rules[name] > 0 {
			return nil, nil
		}
		return nil, errors.New("bad rule")
	case strings.Contains(line, "-I DOCKER-USER 1"):
		r.rules[name]++
		return nil, nil
	case strings.Contains(line, "-D DOCKER-USER"):
		if r.rules[name] == 0 {
			return nil, errors.New("bad rule")
		}
		r.rules[name]--
		return nil, nil
	}
	return nil, fmt.Errorf("unexpected %s", line)
}

func (r *fakeRunner) lookPath(bin string) (string, error) {
	if r.present[bin] {
		return "/usr/sbin/" + bin, nil
	}
	return "", errors.New("not found")
}

func pubFixture() PublishState {
	return PublishState{
		Mark: defaultPublishMrk,
		Addresses: []PublishAddress{
			{Address: "203.0.113.10", Prefix: 32, Iface: "eth0", Managed: false},
			{Address: "203.0.113.20", Prefix: 32, Iface: "eth0", Managed: true},
		},
		Dedicated: []string{"203.0.113.20"},
		Fronts:    []PublishFront{{Bridge: "omf5", AccountID: 5}, {Bridge: "omf6", AccountID: 6}},
		Rules: []PublishRule{
			{ID: 1, AccountID: 5, Dst: "*", Protocol: "tcp", Port: 20000, ToAddr: "10.224.5.10", ToPort: 27015},
			{ID: 2, AccountID: 5, Dst: "*", Protocol: "udp", Port: 20000, ToAddr: "10.224.5.10", ToPort: 27015},
			{ID: 3, AccountID: 6, Dst: "203.0.113.20", Protocol: "tcp", Port: 80, ToAddr: "10.224.6.11", ToPort: 8080},
			{ID: 4, AccountID: 6, Dst: "203.0.113.20", Protocol: "udp", Port: 9987, ToAddr: "10.224.6.11", ToPort: 9987},
		},
		Snat: []PublishSnat{{AccountID: 6, Sources: []string{"10.224.6.0/24", "10.240.0.32/27"}, Iface: "eth0", To: "203.0.113.20"}},
	}
}

func mustPub(t *testing.T, s PublishState, env pubEnv) pubRules {
	t.Helper()
	r, err := s.validate(defaultPublishMrk, env)
	if err != nil {
		t.Fatal(err)
	}
	return r
}

// ── render ───────────────────────────────────────────────────────────────────

func TestPublishGolden(t *testing.T) {
	n := newFakeNet()
	golden(t, "publish", renderPublish(mustPub(t, pubFixture(), pubEnv{net: n}), segCounterValue{}))
	golden(t, "publish-empty", renderPublish(mustPub(t, PublishState{}, pubEnv{net: n}), segCounterValue{}))
	carried := renderPublish(mustPub(t, pubFixture(), pubEnv{net: n}), segCounterValue{Packets: 7, Bytes: 420})
	if !strings.Contains(carried, "packets 7 bytes 420") {
		t.Fatal("the published counter is carried over")
	}
}

// ── R2 ───────────────────────────────────────────────────────────────────────

func TestPublishValidateR2(t *testing.T) {
	n := newFakeNet()
	env := pubEnv{net: n}
	// A target outside the account's front subnet (PostgreSQL on a platform network, another account) is skipped.
	s := pubFixture()
	s.Rules = append(s.Rules,
		PublishRule{ID: 10, AccountID: 5, Dst: "*", Protocol: "tcp", Port: 20001, ToAddr: "172.18.0.5", ToPort: 5432},
		PublishRule{ID: 11, AccountID: 5, Dst: "*", Protocol: "tcp", Port: 20002, ToAddr: "10.224.6.11", ToPort: 80},
		PublishRule{ID: 12, AccountID: 5, Dst: "*", Protocol: "tcp", Port: 20003, ToAddr: "10.224.5.1", ToPort: 80},
	)
	r := mustPub(t, s, env)
	if len(r.Rules) != 4 || len(r.Skipped) != 3 {
		t.Fatalf("rules %d skipped %v", len(r.Rules), r.Skipped)
	}
	for _, sk := range r.Skipped {
		if sk.Reason != "targetOutsideFront" {
			t.Fatalf("reason %v", sk)
		}
	}
	bad := []func(*PublishState){
		func(s *PublishState) { s.Mark = 0x2 },
		func(s *PublishState) { s.Rules[1].Protocol = "sctp" },
		func(s *PublishState) { s.Rules[1].Port = 70000 },
		func(s *PublishState) { s.Rules[1] = s.Rules[0]; s.Rules[1].ID = 99 },                     // duplicate (dst, proto, port)
		func(s *PublishState) { s.Rules[1].ID = 1 },                                               // duplicate id
		func(s *PublishState) { s.Rules[2].Dst = "198.51.100.1" },                                 // not a dedicated address
		func(s *PublishState) { s.Fronts = append(s.Fronts, PublishFront{"br-0123456789ab", 5}) }, // not a front of 5
		func(s *PublishState) { s.Fronts[0].Bridge = "omf6" },                                     // the front of ANOTHER account
		func(s *PublishState) { s.Addresses[1].Iface = "" },                                       // managed without interface
		func(s *PublishState) { s.Addresses[0].Address = "127.0.0.1" },
		func(s *PublishState) { s.Snat[0].To = "203.0.113.10" }, // SNAT to a non-dedicated address
		func(s *PublishState) { s.Snat[0].Sources = []string{"0.0.0.0/0"} },
	}
	for i, mutate := range bad {
		st := pubFixture()
		mutate(&st)
		if _, err := st.validate(defaultPublishMrk, env); err == nil {
			t.Errorf("case %d accepted", i)
		}
	}
	// A legacy front bridge of the account in the applied segment policy is accepted.
	st := pubFixture()
	st.Fronts = append(st.Fronts, PublishFront{"br-0123456789ab", 5})
	env.frontOf = func(b string, a int64) bool { return b == "br-0123456789ab" && a == 5 }
	if _, err := st.validate(defaultPublishMrk, env); err != nil {
		t.Fatal(err)
	}
}

func TestPublishHostConflicts(t *testing.T) {
	n := newFakeNet()
	env := pubEnv{net: n, listeners: []HostListener{
		{Protocol: "tcp", Address: "0.0.0.0", Port: 20000},   // custom sshd on every address
		{Protocol: "udp", Address: "127.0.0.1", Port: 20000}, // loopback only: no conflict
		{Protocol: "tcp", Address: "0.0.0.0", Port: 80},      // docker-proxy of the edge (takeover allowed)
		{Protocol: "udp", Address: "203.0.113.20", Port: 9987},
	}, gatewayPorts: func() map[int]bool { return map[int]bool{} }}
	r := mustPub(t, pubFixture(), env)
	got := map[int64]string{}
	for _, s := range r.Skipped {
		got[s.ID] = s.Reason
	}
	if got[1] != "portInUseOnHost" || got[4] != "portInUseOnHost" || len(got) != 2 {
		t.Fatalf("skipped %v", r.Skipped)
	}
	env.listeners = nil
	env.gatewayPorts = func() map[int]bool { return map[int]bool{20000: true} }
	r = mustPub(t, pubFixture(), env)
	if len(r.Skipped) != 1 || r.Skipped[0].ID != 1 {
		t.Fatalf("gateway port: %v", r.Skipped)
	}
}

// ── manager: addresses, order, persistence ───────────────────────────────────

func TestPublishManagerAddressesAndRestore(t *testing.T) {
	dir := t.TempDir()
	statePath := filepath.Join(dir, "hostd-publish.json")
	var order []string
	n := newFakeNet()
	n.addrs[netip.MustParseAddr("203.0.113.10")] = "eth0"
	nft := &recNft{log: &order}
	fr := &fakeRunner{chains: map[string]bool{"iptables-nft": true}, rules: map[string]int{}, present: map[string]bool{"iptables-nft": true, "nft": true}}
	m := newPublishManager(nft, n, &dockerAccept{run: fr.run, lookPath: fr.lookPath}, statePath)
	res, err := m.Apply(context.Background(), pubFixture())
	if err != nil {
		t.Fatal(err)
	}
	states := map[string]string{}
	for _, a := range res.Addresses {
		states[a.Address] = a.State
	}
	if states["203.0.113.10"] != "present" || states["203.0.113.20"] != "added" {
		t.Fatalf("address states %v", res.Addresses)
	}
	if fr.rules["iptables-nft"] != 1 {
		t.Fatal("DOCKER-USER rule inserted")
	}
	// Idempotent: a second apply inserts nothing more, adds no address.
	if _, err := m.Apply(context.Background(), pubFixture()); err != nil {
		t.Fatal(err)
	}
	if fr.rules["iptables-nft"] != 1 || strings.Count(strings.Join(n.ops, "\n"), "add ") != 1 {
		t.Fatalf("not idempotent: rules %d ops %v", fr.rules["iptables-nft"], n.ops)
	}
	st := m.Status()
	if st.Backend != backendIptablesNft || st.DockerAccept != acceptOK || st.Rules != 4 || st.Snat != 1 {
		t.Fatalf("status %+v", st)
	}

	// Restart: the managed address is gone (reboot); Restore re-adds it BEFORE the tables.
	delete(n.addrs, netip.MustParseAddr("203.0.113.20"))
	n.ops = nil
	order = nil
	n2 := n
	m2 := newPublishManager(&recNft{log: &order}, &orderNet{fakeNet: n2, order: &order}, &dockerAccept{run: fr.run, lookPath: fr.lookPath}, statePath)
	if err := m2.Restore(context.Background()); err != nil {
		t.Fatal(err)
	}
	if strings.Join(order, ",") != "addr,nft" {
		t.Fatalf("restore order %v", order)
	}
	// The dedicated IP is no longer wanted: removed (hostd added it), the external one never is.
	s := pubFixture()
	s.Addresses = s.Addresses[:1]
	s.Dedicated = nil
	s.Rules = s.Rules[:2]
	s.Snat = nil
	n.ops = nil
	if _, err := m2.Apply(context.Background(), s); err != nil {
		t.Fatal(err)
	}
	if strings.Join(n.ops, ";") != "del 203.0.113.20/32 eth0" {
		t.Fatalf("ops %v", n.ops)
	}
	// Nothing published: the Docker rule goes.
	if _, err := m2.Apply(context.Background(), PublishState{}); err != nil {
		t.Fatal(err)
	}
	if fr.rules["iptables-nft"] != 0 {
		t.Fatal("DOCKER-USER rule removed when nothing is published")
	}
}

func TestPublishNeverRemovesAnAddressItDidNotAdd(t *testing.T) {
	n := newFakeNet()
	n.addrs[netip.MustParseAddr("203.0.113.20")] = "eth0" // already configured by the owner
	m := newPublishManager(&recNft{}, n, nil, "")
	if _, err := m.Apply(context.Background(), pubFixture()); err != nil {
		t.Fatal(err)
	}
	if _, err := m.Apply(context.Background(), PublishState{}); err != nil {
		t.Fatal(err)
	}
	for _, op := range n.ops {
		if strings.HasPrefix(op, "del") || strings.HasPrefix(op, "add") {
			t.Fatalf("touched an address it did not add: %v", n.ops)
		}
	}
}

func TestPublishOtherInterfaceAndSnatOmitted(t *testing.T) {
	n := newFakeNet()
	n.addrs[netip.MustParseAddr("203.0.113.20")] = "eth1"
	nft := &recNft{}
	m := newPublishManager(nft, n, nil, "")
	res, err := m.Apply(context.Background(), pubFixture())
	if err != nil {
		t.Fatal(err)
	}
	for _, a := range res.Addresses {
		if a.Address == "203.0.113.20" && a.State != "otherInterface" {
			t.Fatalf("state %v", a)
		}
	}
	if strings.Contains(nft.applied[len(nft.applied)-1], "snat ip to") {
		t.Fatal("SNAT to an address that is not where it should be is omitted")
	}
	// External address missing: DNAT harmless, SNAT omitted.
	n2 := newFakeNet()
	s := pubFixture()
	s.Addresses[1].Managed = false
	nft2 := &recNft{}
	m2 := newPublishManager(nft2, n2, nil, "")
	res, err = m2.Apply(context.Background(), s)
	if err != nil {
		t.Fatal(err)
	}
	if res.Addresses[1].State != "missing" || strings.Contains(nft2.applied[0], "snat ip to") {
		t.Fatalf("external missing: %v", res.Addresses)
	}
}

func TestPublishApplyFailureKeepsPrevious(t *testing.T) {
	n := newFakeNet()
	nft := &recNft{}
	m := newPublishManager(nft, n, nil, "")
	if _, err := m.Apply(context.Background(), pubFixture()); err != nil {
		t.Fatal(err)
	}
	nft.fail = errors.New("syntax error")
	if _, err := m.Apply(context.Background(), PublishState{}); err == nil {
		t.Fatal("failure reported")
	}
	if st := m.Status(); st.Rules != 4 || st.LastApplyError == nil {
		t.Fatalf("status after failure %+v", st)
	}
}

func TestPublishRecheckAppliesWhenTheBridgeAppears(t *testing.T) {
	n := newFakeNet()
	delete(n.bridges, "omf5") // boot: Docker has not recreated the bridge yet
	nft := &recNft{}
	m := newPublishManager(nft, n, nil, "")
	if _, err := m.Apply(context.Background(), pubFixture()); err != nil {
		t.Fatal(err)
	}
	if st := m.Status(); st.Rules != 2 {
		t.Fatalf("rules before %d", st.Rules)
	}
	n.bridges["omf5"] = []netip.Prefix{netip.MustParsePrefix("10.224.5.1/24")}
	m.Recheck(context.Background())
	if st := m.Status(); st.Rules != 4 || len(st.Skipped) != 0 {
		t.Fatalf("after recheck %+v", st)
	}
}

func TestPublishAddressRefusals(t *testing.T) {
	n := newFakeNet()
	n.eth0 = []string{"203.0.113.1/24"}
	n.bridges["custombr"] = []netip.Prefix{netip.MustParsePrefix("172.30.0.1/16")}
	env := pubEnv{net: n, bridges: func() []string { return []string{"custombr"} }}
	s := pubFixture()
	s.Addresses = append(s.Addresses,
		PublishAddress{Address: "198.51.100.5", Prefix: 32, Iface: "lo", Managed: true},   // internal interface
		PublishAddress{Address: "10.224.5.77", Prefix: 32, Iface: "eth0", Managed: true},  // inside a bridge subnet
		PublishAddress{Address: "172.30.9.9", Prefix: 32, Iface: "eth0", Managed: true},   // a bridge of the policy, any name
		PublishAddress{Address: "198.51.100.7", Prefix: 16, Iface: "eth0", Managed: true}, // new connected route
		PublishAddress{Address: "203.0.113.30", Prefix: 24, Iface: "eth0", Managed: true}, // inside the subnet of eth0: fine
		PublishAddress{Address: "10.1.2.3", Prefix: 8, Iface: "eth0", Managed: true},      // /8 over the containers
	)
	s.Dedicated = append(s.Dedicated, "10.224.5.77")
	s.Rules = append(s.Rules, PublishRule{ID: 20, AccountID: 5, Dst: "10.224.5.77", Protocol: "tcp", Port: 25565, ToAddr: "10.224.5.10", ToPort: 25565})
	s.Snat = append(s.Snat, PublishSnat{AccountID: 5, Sources: []string{"10.224.5.0/24"}, Iface: "eth0", To: "10.224.5.77"})
	r := mustPub(t, s, env)
	got := map[string]string{}
	for _, x := range r.Refused {
		got[x.Address] = x.Message
	}
	want := map[string]string{"198.51.100.5": "internalInterface", "10.224.5.77": "internalAddress", "172.30.9.9": "internalAddress", "198.51.100.7": "prefixNotConnected", "10.1.2.3": "internalAddress"}
	if len(got) != len(want) {
		t.Fatalf("refused %v", r.Refused)
	}
	for a, m := range want {
		if got[a] != m {
			t.Fatalf("%s: %q, want %q (%v)", a, got[a], m, r.Refused)
		}
	}
	for _, a := range r.Addresses {
		if want[a.Addr.String()] != "" {
			t.Fatalf("refused address kept: %v", a)
		}
	}
	skipped := false
	for _, k := range r.Skipped {
		if k.ID == 20 && k.Reason == "addressRefused" {
			skipped = true
		}
	}
	if !skipped || len(r.Snat) != 1 {
		t.Fatalf("rule on a refused address skipped %v, snat %v", r.Skipped, r.Snat)
	}
	// The manager reports them and never adds them.
	m := newPublishManager(&recNft{}, n, nil, "")
	m.bridges = env.bridges
	res, err := m.Apply(context.Background(), s)
	if err != nil {
		t.Fatal(err)
	}
	refused := 0
	for _, a := range res.Addresses {
		if a.State == "refused" {
			refused++
		}
	}
	if refused != 5 || strings.Contains(strings.Join(n.ops, ";"), "10.224.5.77") || strings.Contains(strings.Join(n.ops, ";"), "198.51.100.5") {
		t.Fatalf("reply %v ops %v", res.Addresses, n.ops)
	}
	if !strings.Contains(strings.Join(n.ops, ";"), "add 203.0.113.30/24 eth0") {
		t.Fatalf("a managed /24 inside the subnet of eth0 is added: %v", n.ops)
	}
	// An internal SNAT interface: left out, not refused as a whole.
	s2 := pubFixture()
	s2.Snat[0].Iface = "docker0"
	if r2 := mustPub(t, s2, pubEnv{net: n}); len(r2.Snat) != 0 {
		t.Fatalf("SNAT through an internal interface kept: %v", r2.Snat)
	}
}

func TestPublishAppliedRuleSurvivesANewSocket(t *testing.T) {
	n := newFakeNet()
	nft := &recNft{}
	m := newPublishManager(nft, n, nil, "")
	if _, err := m.Apply(context.Background(), pubFixture()); err != nil {
		t.Fatal(err)
	}
	// A socket appears on the port of an active binding (unconnected UDP in the ephemeral range, a test sshd…).
	n.listeners = []HostListener{{Protocol: "tcp", Address: "0.0.0.0", Port: 20000}, {Protocol: "udp", Address: "0.0.0.0", Port: 20000}}
	before := len(nft.applied)
	m.Recheck(context.Background())
	if st := m.Status(); st.Rules != 4 || len(st.Skipped) != 0 || len(nft.applied) != before {
		t.Fatalf("recheck unpublished an active rule: %+v", st)
	}
	// The same state pushed again: kept too. A NEW rule on a port in use is skipped.
	s := pubFixture()
	s.Rules = append(s.Rules, PublishRule{ID: 9, AccountID: 5, Dst: "*", Protocol: "tcp", Port: 20007, ToAddr: "10.224.5.10", ToPort: 22})
	n.listeners = append(n.listeners, HostListener{Protocol: "tcp", Address: "0.0.0.0", Port: 20007})
	res, err := m.Apply(context.Background(), s)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Skipped) != 1 || res.Skipped[0].ID != 9 || res.Skipped[0].Reason != "portInUseOnHost" {
		t.Fatalf("skipped %v", res.Skipped)
	}
	if st := m.Status(); st.Rules != 4 {
		t.Fatalf("rules %d", st.Rules)
	}
	// A fresh hostd (Restore, nothing applied yet) checks every rule.
	r := mustPub(t, pubFixture(), pubEnv{net: n, listeners: n.listeners})
	if len(r.Skipped) != 2 {
		t.Fatalf("fresh validation skipped %v", r.Skipped)
	}
}

func TestPublishNoHairpinFromPolicyBridges(t *testing.T) {
	n := newFakeNet()
	r := mustPub(t, pubFixture(), pubEnv{net: n, bridges: func() []string { return []string{"omp-panel", "custombr", "omf5", "bad name!"} }})
	out := renderPublish(r, segCounterValue{})
	if !strings.Contains(out, `iifname { "lo", "docker0", "custombr", "omf5", "omp-panel" } return`) || !strings.Contains(out, `iifname "omp-*" return`) {
		t.Fatal(out)
	}
	// A bridge appearing in the segment policy re-renders at the next re-check.
	bridges := []string{}
	nft := &recNft{}
	m := newPublishManager(nft, n, nil, "")
	m.bridges = func() []string { return bridges }
	if _, err := m.Apply(context.Background(), pubFixture()); err != nil {
		t.Fatal(err)
	}
	bridges = []string{"omp-mail"}
	m.Recheck(context.Background())
	if last := nft.applied[len(nft.applied)-1]; !strings.Contains(last, `"omp-mail"`) {
		t.Fatal("re-rendered with the new bridge")
	}
}

// orderNet records the address additions in the shared order log.
type orderNet struct {
	*fakeNet
	order *[]string
}

func (o *orderNet) AddAddr(ctx context.Context, iface string, a netip.Addr, p int) error {
	*o.order = append(*o.order, "addr")
	return o.fakeNet.AddAddr(ctx, iface, a, p)
}

// ── Docker accept detection ──────────────────────────────────────────────────

func TestDockerAcceptBackends(t *testing.T) {
	ctx := context.Background()
	// iptables-nft (default Docker backend).
	fr := &fakeRunner{chains: map[string]bool{"iptables-nft": true}, rules: map[string]int{}, present: map[string]bool{"iptables-nft": true, "iptables-legacy": true, "nft": true}}
	d := &dockerAccept{run: fr.run, lookPath: fr.lookPath}
	if r := d.Ensure(ctx, defaultPublishMrk, true); r.Backend != backendIptablesNft || r.State != acceptOK || fr.rules["iptables-nft"] != 1 {
		t.Fatalf("nft: %+v %v", r, fr.rules)
	}
	if !strings.Contains(strings.Join(fr.calls, "\n"), "-I DOCKER-USER 1 -m connmark --mark 0x01000000/0x01000000 -m comment --comment oblimint-publish -j ACCEPT") {
		t.Fatalf("rule text: %v", fr.calls)
	}
	// legacy + nft both have the chain: the rule goes in both.
	fr = &fakeRunner{chains: map[string]bool{"iptables-nft": true, "iptables-legacy": true}, rules: map[string]int{}, present: map[string]bool{"iptables-nft": true, "iptables-legacy": true}}
	d = &dockerAccept{run: fr.run, lookPath: fr.lookPath}
	if r := d.Ensure(ctx, defaultPublishMrk, true); r.State != acceptOK || fr.rules["iptables-nft"] != 1 || fr.rules["iptables-legacy"] != 1 {
		t.Fatalf("both: %+v %v", r, fr.rules)
	}
	// Docker nftables backend, with and without bridge-accept-fwmark.
	fr = &fakeRunner{chains: map[string]bool{}, rules: map[string]int{}, present: map[string]bool{"iptables-nft": true, "nft": true},
		nftOut: "table ip docker-bridges {\n chain filter-forward {\n  meta mark & 0x01000000 == 0x01000000 counter accept comment \"ALLOW FW MARK\"\n }\n}"}
	d = &dockerAccept{run: fr.run, lookPath: fr.lookPath}
	if r := d.Ensure(ctx, defaultPublishMrk, true); r.Backend != backendDockerNft || r.State != acceptOK {
		t.Fatalf("docker nft with fwmark: %+v", r)
	}
	fr.nftOut = "table ip docker-bridges {\n chain filter-forward {\n  counter drop comment \"UNPUBLISHED PORT DROP\"\n }\n}"
	if r := d.Ensure(ctx, defaultPublishMrk, true); r.State != acceptFwmarkMissing || !strings.Contains(r.Remediation, "bridge-accept-fwmark") {
		t.Fatalf("docker nft without fwmark: %+v", r)
	}
	// Nothing at all.
	fr = &fakeRunner{chains: map[string]bool{}, rules: map[string]int{}, present: map[string]bool{}}
	d = &dockerAccept{run: fr.run, lookPath: fr.lookPath}
	if r := d.Ensure(ctx, defaultPublishMrk, true); r.Backend != backendNone {
		t.Fatalf("none: %+v", r)
	}
}

// ── /proc parsing ────────────────────────────────────────────────────────────

func TestParseProcNet(t *testing.T) {
	tcp := `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000:0016 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 1 1
   1: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 2 1
   2: 0A00A8C0:0016 0B00A8C0:D431 01 00000000:00000000 00:00000000 00000000     0        0 3 1
`
	got := parseProcNet(tcp, "tcp")
	if len(got) != 2 || got[0] != (HostListener{"tcp", "0.0.0.0", 22}) || got[1] != (HostListener{"tcp", "127.0.0.1", 8080}) {
		t.Fatalf("tcp %v", got)
	}
	udp := `  sl  local_address rem_address   st
   0: 00000000:0035 00000000:0000 07 x
   1: 0A00A8C0:9C40 08080808:0035 01 x
   2: 0A00A8C0:9C41 08080808:0035 07 x
`
	got = parseProcNet(udp, "udp")
	if len(got) != 1 || got[0].Port != 53 {
		t.Fatalf("udp %v (a connected client socket is not a listener)", got)
	}
	tcp6 := `  sl  local_address                         remote_address                        st
   0: 00000000000000000000000000000000:0050 00000000000000000000000000000000:0000 0A x
`
	got = parseProcNet(tcp6, "tcp")
	if len(got) != 1 || got[0].Address != "::" || got[0].Port != 80 {
		t.Fatalf("tcp6 %v", got)
	}
	route := "Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\nomf5\t0005E00A\t00000000\t0001\t0\t0\t0\t00FFFFFF\neth0\t00000000\t0100A8C0\t0003\t0\t0\t0\t00000000\n"
	if parseDefaultRoute(route) != "eth0" {
		t.Fatal("default route")
	}
}

// ── segments: inbound guard ──────────────────────────────────────────────────

func TestSegmentInboundGuard(t *testing.T) {
	s := segFixture(segModeEnforce)
	s.InboundGuard = segModeEnforce
	golden(t, "segments-guard-enforce", renderSegments(mustSeg(t, s)))
	s.InboundGuard = segModeMonitor
	golden(t, "segments-guard-monitor", renderSegments(mustSeg(t, s)))
	p := segPlatformFixture(segModeEnforce)
	p.InboundGuard = segModeEnforce
	out := renderSegments(mustSeg(t, p))
	if strings.Count(out, "table inet oblimint_seghost {") != 1 || !strings.Contains(out, "chain inbound") {
		t.Fatal("guard inside the single seghost table with the platform host filter")
	}
	s.InboundGuard = "drop"
	if _, err := s.validate(); err == nil {
		t.Fatal("invalid guard mode accepted")
	}
	s.InboundGuard = ""
	if strings.Contains(renderSegments(mustSeg(t, s)), "chain inbound") {
		t.Fatal("no guard by default (older panels)")
	}
}

func TestSegmentFrontOf(t *testing.T) {
	m := newSegmentManager(&recNft{}, "")
	if err := m.Apply(context.Background(), segFixture(segModeEnforce)); err != nil {
		t.Fatal(err)
	}
	var front SegmentBridge
	for _, b := range segFixture(segModeEnforce).Bridges {
		if b.Fabric == segFabricFront {
			front = b
			break
		}
	}
	if !m.FrontOf(front.Name, front.AccountID) || m.FrontOf(front.Name, front.AccountID+1) {
		t.Fatal("FrontOf")
	}
}
