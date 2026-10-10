package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func mustWeb(t *testing.T, s WebFirewallState) webRules {
	t.Helper()
	r, err := s.validate()
	if err != nil {
		t.Fatalf("validate web state: %v", err)
	}
	return r
}

func newTestWebManager(nft nftRunner, clk clock, statePath string) *webBanManager {
	m := newWebBanManager(nft, statePath)
	m.clock = clk
	return m
}

func TestValidateWebState(t *testing.T) {
	exp := ts(time.Hour)
	ok := []WebFirewallState{
		{},
		{Ports: []int{80, 443}},
		{Ports: []int{443, 80, 80, 5432}, Bans: []WebBanEntry{{CIDR: "203.0.113.9", ExpiresAt: exp}, {CIDR: "203.0.113.10/32"}}},
		{Ports: []int{80}, Bans: []WebBanEntry{{CIDR: "2001:db8:aa:bb::/64", ExpiresAt: exp}, {CIDR: "2001:db8:cc::/48"}}},
		{Ports: []int{80}, Bans: []WebBanEntry{{CIDR: "::ffff:198.51.100.4"}}}, // v4-mapped → v4
		{Ports: []int{80}, Bans: []WebBanEntry{{CIDR: "100.128.0.1"}, {CIDR: "100.63.255.255"}}},
	}
	for i, s := range ok {
		if _, err := s.validate(); err != nil {
			t.Errorf("ok[%d]: %v", i, err)
		}
	}
	tooManyPorts := make([]int, 65)
	for i := range tooManyPorts {
		tooManyPorts[i] = 1000 + i
	}
	bad := map[string]WebFirewallState{
		"port 0":          {Ports: []int{0}},
		"port 65536":      {Ports: []int{65536}},
		"too many ports":  {Ports: tooManyPorts},
		"v4 range":        {Bans: []WebBanEntry{{CIDR: "203.0.113.0/24"}}},
		"v6 host":         {Bans: []WebBanEntry{{CIDR: "2001:db8::1"}}},
		"v6 /96":          {Bans: []WebBanEntry{{CIDR: "2001:db8::/96"}}},
		"v6 too wide":     {Bans: []WebBanEntry{{CIDR: "2001:db8::/32"}}},
		"loopback v4":     {Bans: []WebBanEntry{{CIDR: "127.0.0.1"}}},
		"loopback v6":     {Bans: []WebBanEntry{{CIDR: "::1"}}},
		"link-local v4":   {Bans: []WebBanEntry{{CIDR: "169.254.1.2"}}},
		"link-local v6":   {Bans: []WebBanEntry{{CIDR: "fe80::/64"}}},
		"docker bridge":   {Bans: []WebBanEntry{{CIDR: "172.18.0.5"}}},
		"rfc1918":         {Bans: []WebBanEntry{{CIDR: "10.224.3.4"}}},
		"lan":             {Bans: []WebBanEntry{{CIDR: "192.168.1.10"}}},
		"cgnat":           {Bans: []WebBanEntry{{CIDR: "100.64.0.1"}}},
		"cgnat top":       {Bans: []WebBanEntry{{CIDR: "100.127.255.254"}}},
		"cgnat mapped":    {Bans: []WebBanEntry{{CIDR: "::ffff:100.100.1.1"}}},
		"ula":             {Bans: []WebBanEntry{{CIDR: "fd00:1:2:3::/64"}}},
		"unspecified":     {Bans: []WebBanEntry{{CIDR: "0.0.0.0"}}},
		"multicast v4":    {Bans: []WebBanEntry{{CIDR: "224.0.0.1"}}},
		"multicast v6":    {Bans: []WebBanEntry{{CIDR: "ff02::/64"}}},
		"injection":       {Bans: []WebBanEntry{{CIDR: "1.2.3.4; flush ruleset"}}},
		"newline":         {Bans: []WebBanEntry{{CIDR: "1.2.3.4\nadd rule"}}},
		"bad expiry":      {Bans: []WebBanEntry{{CIDR: "203.0.113.9", ExpiresAt: strp("tomorrow")}}},
		"empty address":   {Bans: []WebBanEntry{{CIDR: ""}}},
		"zone identifier": {Bans: []WebBanEntry{{CIDR: "2001:db8::1%eth0"}}},
	}
	for name, s := range bad {
		if _, err := s.validate(); err == nil {
			t.Errorf("%s: accepted", name)
		} else {
			var ae *apiError
			if !errors.As(err, &ae) || ae.Status != http.StatusBadRequest {
				t.Errorf("%s: want a 400, got %v", name, err)
			}
		}
	}
	tooMany := WebFirewallState{Ports: []int{80}}
	for i := 0; i <= maxWebBans; i++ {
		tooMany.Bans = append(tooMany.Bans, WebBanEntry{CIDR: "203.0.113.9"})
	}
	if _, err := tooMany.validate(); err == nil {
		t.Error("more than 50000 bans accepted")
	}
}

func strp(s string) *string { return &s }

func TestRenderWebRulesetGolden(t *testing.T) {
	r := mustWeb(t, WebFirewallState{
		Ports: []int{443, 80},
		Bans: []WebBanEntry{
			{CIDR: "203.0.113.9", ExpiresAt: ts(time.Hour)},
			{CIDR: "198.51.100.7"},                           // permanent
			{CIDR: "192.0.2.1", ExpiresAt: ts(-time.Minute)}, // expired: not rendered
			{CIDR: "2001:db8:aa:bb::/64", ExpiresAt: ts(90 * time.Minute)},
			{CIDR: "2001:db8:aa:bb::/64", ExpiresAt: ts(3 * time.Hour)}, // duplicate: the longest lifetime
			{CIDR: "2001:db8:cc::/48"},
			{CIDR: "2001:db8:cc:1::/64", ExpiresAt: ts(time.Hour)}, // covered by the /48
		},
	})
	golden(t, "webbans", renderWebRuleset(r, fwNow))
	golden(t, "webbans-empty", renderWebRuleset(webRules{}, fwNow))
	got := renderWebRuleset(mustWeb(t, WebFirewallState{Ports: []int{80, 443}}), fwNow)
	if !strings.Contains(got, "set web_bans4 {") || strings.Contains(got, "elements") {
		t.Errorf("no ban: empty sets expected\n%s", got)
	}
	// Only drops, nothing else (BN3).
	for _, line := range strings.Split(renderWebRuleset(r, fwNow), "\n") {
		l := strings.TrimSpace(line)
		if strings.HasPrefix(l, "ct ") && !strings.HasSuffix(l, " drop") {
			t.Errorf("non-drop rule: %s", l)
		}
		// `ct status dnat` is a match; no verdict / NAT statement but drop.
		for _, bad := range []string{" accept", " snat", " masquerade", " redirect", " jump", " goto"} {
			if strings.HasPrefix(l, "ct ") && strings.Contains(l, bad) {
				t.Errorf("rule with%s: %s", bad, l)
			}
		}
	}
}

func TestWebBanManagerApplyPersistRestore(t *testing.T) {
	clk := newFakeClock(fwNow)
	nft := &fakeNft{available: true}
	state := filepath.Join(t.TempDir(), "run", "hostd-webbans.json")
	m := newTestWebManager(nft, clk, state)

	s := WebFirewallState{Ports: []int{80, 443}, Bans: []WebBanEntry{
		{CIDR: "203.0.113.9", ExpiresAt: ts(time.Hour)},
		{CIDR: "198.51.100.7"},
	}}
	if err := m.Apply(context.Background(), s); err != nil {
		t.Fatal(err)
	}
	if nft.count() != 1 || !strings.Contains(nft.last(), "elements = { 198.51.100.7, 203.0.113.9 timeout 3600s }") {
		t.Fatalf("applied ruleset:\n%s", nft.last())
	}
	if !strings.HasPrefix(nft.last(), "# Generated") || !strings.Contains(nft.last(), "delete table inet oblimint_web\n") {
		t.Fatal("not an atomic table replacement")
	}
	info, err := os.Stat(state)
	if err != nil {
		t.Fatalf("state not persisted: %v", err)
	}
	if info.Mode().Perm()&0o077 != 0 && runtime.GOOS != "windows" {
		t.Errorf("state file mode %v", info.Mode().Perm())
	}

	// Expiry: re-rendered one second after the ban ends, without it.
	clk.Advance(time.Hour + time.Second)
	if nft.count() != 2 {
		t.Fatalf("no re-apply at expiry (%d applies)", nft.count())
	}
	if strings.Contains(nft.last(), "203.0.113.9") || !strings.Contains(nft.last(), "198.51.100.7") {
		t.Errorf("after expiry:\n%s", nft.last())
	}

	// A restarted hostd re-applies the persisted state (expired entries left out).
	nft2 := &fakeNft{available: true}
	m2 := newTestWebManager(nft2, clk, state)
	if err := m2.Restore(context.Background()); err != nil {
		t.Fatal(err)
	}
	if nft2.count() != 1 || !strings.Contains(nft2.last(), "198.51.100.7") || strings.Contains(nft2.last(), "203.0.113.9") {
		t.Fatalf("restored ruleset:\n%s", nft2.last())
	}
	if m2.Ruleset() != nft2.last() {
		t.Error("Ruleset() differs from the applied one")
	}

	// Missing file: nothing to do; corrupt file: an error, nothing applied.
	m3 := newTestWebManager(&fakeNft{available: true}, clk, filepath.Join(t.TempDir(), "none.json"))
	if err := m3.Restore(context.Background()); err != nil {
		t.Errorf("missing state: %v", err)
	}
	bad := filepath.Join(t.TempDir(), "bad.json")
	if err := os.WriteFile(bad, []byte(`{"ports":[80],"bans":[{"cidr":"10.0.0.1"}]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	nft4 := &fakeNft{available: true}
	if err := newTestWebManager(nft4, clk, bad).Restore(context.Background()); err == nil || nft4.count() != 0 {
		t.Errorf("invalid persisted state applied (err %v, %d applies)", err, nft4.count())
	}
}

func TestWebBanManagerRefusedRulesetKeepsPrevious(t *testing.T) {
	clk := newFakeClock(fwNow)
	nft := &fakeNft{available: true}
	state := filepath.Join(t.TempDir(), "hostd-webbans.json")
	m := newTestWebManager(nft, clk, state)
	first := WebFirewallState{Ports: []int{80, 443}, Bans: []WebBanEntry{{CIDR: "198.51.100.7"}}}
	if err := m.Apply(context.Background(), first); err != nil {
		t.Fatal(err)
	}
	nft.fail = errors.New("nft: syntax error")
	err := m.Apply(context.Background(), WebFirewallState{Ports: []int{80, 443}, Bans: []WebBanEntry{{CIDR: "198.51.100.8"}}})
	var ae *apiError
	if !errors.As(err, &ae) || ae.Status != http.StatusBadGateway || ae.Code != codeApplyFailed {
		t.Fatalf("want 502 applyFailed, got %v", err)
	}
	b, _ := os.ReadFile(state)
	if !strings.Contains(string(b), "198.51.100.7") || strings.Contains(string(b), "198.51.100.8") {
		t.Errorf("refused state persisted:\n%s", b)
	}
	if !strings.Contains(m.Ruleset(), "198.51.100.7") {
		t.Error("previous rules lost")
	}
	// Invalid input never reaches nft.
	nft.fail = nil
	before := nft.count()
	if err := m.Apply(context.Background(), WebFirewallState{Bans: []WebBanEntry{{CIDR: "127.0.0.1"}}}); err == nil || nft.count() != before {
		t.Error("invalid state applied")
	}
	// nft missing: errUnsupported (501 through the API).
	unsupported := newTestWebManager(&fakeNft{available: false, fail: errUnsupported}, clk, "")
	if err := unsupported.Apply(context.Background(), first); !errors.Is(err, errUnsupported) {
		t.Errorf("want errUnsupported, got %v", err)
	}
}

func TestWebFirewallRoute(t *testing.T) {
	clk := newFakeClock(fwNow)
	nft := &fakeNft{available: true}
	prev := p4bManagers.webBans
	t.Cleanup(func() { p4bManagers.webBans = prev })

	p4bManagers.webBans = nil
	rec := httptest.NewRecorder()
	setWebFirewall(rec, httptest.NewRequest(http.MethodPut, "/v1/firewall/web", strings.NewReader(`{"ports":[80],"bans":[]}`)))
	if rec.Code != http.StatusNotImplemented {
		t.Errorf("nil manager: %d", rec.Code)
	}

	p4bManagers.webBans = newTestWebManager(nft, clk, "")
	body, _ := json.Marshal(WebFirewallState{Ports: []int{80, 443}, Bans: []WebBanEntry{{CIDR: "2001:db8:aa:bb::/64", ExpiresAt: ts(time.Hour)}}})
	rec = httptest.NewRecorder()
	setWebFirewall(rec, httptest.NewRequest(http.MethodPut, "/v1/firewall/web", strings.NewReader(string(body))))
	if rec.Code != http.StatusOK || !strings.Contains(nft.last(), "2001:db8:aa:bb::/64 timeout 3600s") {
		t.Fatalf("route: %d %s\n%s", rec.Code, rec.Body.String(), nft.last())
	}
	rec = httptest.NewRecorder()
	setWebFirewall(rec, httptest.NewRequest(http.MethodPut, "/v1/firewall/web", strings.NewReader(`{"ports":[80],"bans":[{"cidr":"192.168.1.1"}]}`)))
	if rec.Code != http.StatusBadRequest {
		t.Errorf("private ban: %d", rec.Code)
	}
}

// The largest state the panel may push (maxWebBans entries of the worst size)
// exceeds the generic 1 MiB body limit and must still decode and apply.
func TestWebFirewallMaxStateBody(t *testing.T) {
	exp := "2026-10-10T12:34:56.789Z"
	st := WebFirewallState{Ports: []int{80, 443}, Bans: make([]WebBanEntry, 0, maxWebBans)}
	for i := 0; i < maxWebBans; i++ {
		st.Bans = append(st.Bans, WebBanEntry{CIDR: fmt.Sprintf("2a01:4f8:%x:%x::/64", 0x1000+i/0x1000, 0x1000+i%0x1000), ExpiresAt: &exp})
	}
	body, err := json.Marshal(st)
	if err != nil {
		t.Fatal(err)
	}
	if len(body) <= maxBodyBytes || len(body) > maxWebBodyBytes {
		t.Fatalf("max state is %d bytes: want > %d (generic limit) and <= %d", len(body), maxBodyBytes, maxWebBodyBytes)
	}
	rec := httptest.NewRecorder()
	got, err := decodeWebFirewallState(rec, httptest.NewRequest(http.MethodPut, "/v1/firewall/web", strings.NewReader(string(body))))
	if err != nil || len(got.Bans) != maxWebBans {
		t.Fatalf("decode: %v (%d bans)", err, len(got.Bans))
	}
	if _, err := got.validate(); err != nil {
		t.Fatalf("validate: %v", err)
	}
	// Past the limit: refused, never truncated into a partial state.
	huge := `{"ports":[80],"bans":[{"cidr":"8.8.8.8","expiresAt":"` + strings.Repeat("x", maxWebBodyBytes) + `"}]}`
	if _, err := decodeWebFirewallState(httptest.NewRecorder(), httptest.NewRequest(http.MethodPut, "/v1/firewall/web", strings.NewReader(huge))); err == nil {
		t.Error("oversized body accepted")
	}
}
