package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func mustMail(t *testing.T, s MailFirewallState) *mailRules {
	t.Helper()
	r, err := s.validate()
	if err != nil {
		t.Fatalf("validate mail state: %v", err)
	}
	return &r
}

func TestValidateMailState(t *testing.T) {
	exp := *ts(time.Hour)
	ok := []MailFirewallState{
		{},
		{Ports: []int{25, 465, 587, 143, 993, 110, 995, 4190}},
		{Ports: []int{25, 25}, Bans: []MailBanEntry{{CIDR: "203.0.113.9", ExpiresAt: exp}}},
		{Ports: []int{25}, Bans: []MailBanEntry{{CIDR: "2001:db8:aa:bb::/64", ExpiresAt: exp}, {CIDR: "2001:db8:cc::/48", ExpiresAt: exp}}},
		{Ports: []int{25}, Bans: []MailBanEntry{{CIDR: "::ffff:198.51.100.4", ExpiresAt: exp}}}, // v4-mapped → v4
	}
	for i, s := range ok {
		if _, err := s.validate(); err != nil {
			t.Errorf("ok[%d]: %v", i, err)
		}
	}
	bad := map[string]MailFirewallState{
		"non-mail port":   {Ports: []int{22}},
		"https port":      {Ports: []int{25, 443}},
		"v4 range":        {Bans: []MailBanEntry{{CIDR: "203.0.113.0/24", ExpiresAt: exp}}},
		"v6 host":         {Bans: []MailBanEntry{{CIDR: "2001:db8::1", ExpiresAt: exp}}},
		"v6 /96":          {Bans: []MailBanEntry{{CIDR: "2001:db8::/96", ExpiresAt: exp}}},
		"v6 too wide":     {Bans: []MailBanEntry{{CIDR: "2001:db8::/32", ExpiresAt: exp}}},
		"loopback v4":     {Bans: []MailBanEntry{{CIDR: "127.0.0.1", ExpiresAt: exp}}},
		"loopback v6":     {Bans: []MailBanEntry{{CIDR: "::1", ExpiresAt: exp}}},
		"link-local v4":   {Bans: []MailBanEntry{{CIDR: "169.254.1.2", ExpiresAt: exp}}},
		"link-local v6":   {Bans: []MailBanEntry{{CIDR: "fe80::/64", ExpiresAt: exp}}},
		"docker bridge":   {Bans: []MailBanEntry{{CIDR: "172.18.0.5", ExpiresAt: exp}}},
		"rfc1918":         {Bans: []MailBanEntry{{CIDR: "10.1.2.3", ExpiresAt: exp}}},
		"ula":             {Bans: []MailBanEntry{{CIDR: "fd00:1:2:3::/64", ExpiresAt: exp}}},
		"unspecified":     {Bans: []MailBanEntry{{CIDR: "0.0.0.0", ExpiresAt: exp}}},
		"multicast":       {Bans: []MailBanEntry{{CIDR: "224.0.0.1", ExpiresAt: exp}}},
		"injection":       {Bans: []MailBanEntry{{CIDR: "1.2.3.4; flush ruleset", ExpiresAt: exp}}},
		"newline":         {Bans: []MailBanEntry{{CIDR: "1.2.3.4\nadd rule", ExpiresAt: exp}}},
		"bad expiry":      {Bans: []MailBanEntry{{CIDR: "203.0.113.9", ExpiresAt: "tomorrow"}}},
		"missing expiry":  {Bans: []MailBanEntry{{CIDR: "203.0.113.9"}}},
		"empty address":   {Bans: []MailBanEntry{{CIDR: "", ExpiresAt: exp}}},
		"zone identifier": {Bans: []MailBanEntry{{CIDR: "2001:db8::1%eth0", ExpiresAt: exp}}},
	}
	for name, s := range bad {
		_, err := s.validate()
		var ae *apiError
		if err == nil || !errors.As(err, &ae) || ae.Status != http.StatusBadRequest {
			t.Errorf("%s: want 400, got %v", name, err)
		}
	}
	// Size limit.
	big := MailFirewallState{Ports: []int{25}}
	for i := 0; i <= maxMailBans; i++ {
		big.Bans = append(big.Bans, MailBanEntry{CIDR: "203.0.113.9", ExpiresAt: exp})
	}
	if _, err := big.validate(); err == nil {
		t.Errorf("more than %d bans accepted", maxMailBans)
	}
}

func TestRenderMailBans(t *testing.T) {
	mail := mustMail(t, MailFirewallState{
		Ports: []int{587, 25, 465, 143, 993, 110, 995, 4190},
		Bans: []MailBanEntry{
			{CIDR: "203.0.113.9", ExpiresAt: *ts(time.Hour)},
			{CIDR: "198.51.100.4", ExpiresAt: *ts(-time.Minute)}, // expired: absent
			{CIDR: "2001:db8:aa:bb::/64", ExpiresAt: *ts(30 * time.Minute)},
			{CIDR: "2001:db8:aa:bb::/64", ExpiresAt: *ts(90 * time.Minute)}, // duplicate: longest kept
			{CIDR: "2001:db8:cc::/48", ExpiresAt: *ts(2 * time.Hour)},
			{CIDR: "2001:db8:cc:1::/64", ExpiresAt: *ts(time.Hour)}, // covered by the /48
		},
	})
	got := renderRuleset(renderInput{Mail: mail, Now: fwNow})
	golden(t, "mail", got)
	for _, want := range []string{
		"set mail_bans4 {",
		"flags interval,timeout",
		"203.0.113.9 timeout 3600s",
		"2001:db8:aa:bb::/64 timeout 5400s",
		"2001:db8:cc::/48 timeout 7200s",
		"ct direction original tcp dport { 25, 110, 143, 465, 587, 993, 995, 4190 } ip saddr @mail_bans4 drop",
		"ct direction original ct status dnat meta l4proto tcp ct original proto-dst { 25, 110, 143, 465, 587, 993, 995, 4190 } ip6 saddr @mail_bans6 drop",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("missing %q in\n%s", want, got)
		}
	}
	for _, unwanted := range []string{"198.51.100.4", "2001:db8:cc:1::"} {
		if strings.Contains(got, unwanted) {
			t.Errorf("%q should not be rendered:\n%s", unwanted, got)
		}
	}
	// Drops only (W1), never an accept / a policy drop.
	for _, l := range strings.Split(got, "\n") {
		l = strings.TrimSpace(l)
		if strings.HasSuffix(l, " accept") || strings.Contains(l, "policy drop") {
			t.Errorf("non-drop rule: %q", l)
		}
	}
	// No mail port = nothing rendered (and the P2 goldens stay unchanged).
	empty := renderRuleset(renderInput{Mail: mustMail(t, MailFirewallState{Bans: []MailBanEntry{{CIDR: "203.0.113.9", ExpiresAt: *ts(time.Hour)}}}), Now: fwNow})
	if strings.Contains(empty, "mail_bans") {
		t.Errorf("mail sets without ports:\n%s", empty)
	}
	if empty != renderRuleset(renderInput{Now: fwNow}) {
		t.Errorf("an empty mail state changes the ruleset")
	}
}

func TestRenderMailWithAccounts(t *testing.T) {
	// Same table as the P2 allow-lists: both coexist in one ruleset.
	acct := mustRules(t, 3, FirewallAccountState{Mode: modeOpen, GatewayPorts: []int{30003}, Bans: []FirewallBan{{IP: "203.0.113.20", ExpiresAt: *ts(time.Hour)}}})
	mail := mustMail(t, MailFirewallState{Ports: []int{25}, Bans: []MailBanEntry{{CIDR: "203.0.113.9", ExpiresAt: *ts(time.Hour)}}})
	got := renderRuleset(renderInput{Accounts: []accountRules{acct}, Mail: mail, Now: fwNow})
	for _, want := range []string{"set ban4_3 {", "set mail_bans4 {", "ct direction original tcp dport 25 ip saddr @mail_bans4 drop", "ip saddr @ban4_3 drop"} {
		if !strings.Contains(got, want) {
			t.Errorf("missing %q in\n%s", want, got)
		}
	}
	if strings.Count(got, "table inet oblimint {") != 1 {
		t.Errorf("one table expected:\n%s", got)
	}
}

func TestFirewallManagerMailPersistRestoreExpiry(t *testing.T) {
	clk := newFakeClock(fwNow)
	nft := &fakeNft{available: true}
	state := filepath.Join(t.TempDir(), "hostd-state.json")
	m := newFirewallManager(nft, clk, state)
	m.resolvers = nil
	s := MailFirewallState{Ports: []int{25, 587}, Bans: []MailBanEntry{
		{CIDR: "203.0.113.9", ExpiresAt: *ts(10 * time.Minute)},
		{CIDR: "2001:db8:aa:bb::/64", ExpiresAt: *ts(time.Hour)},
	}}
	if err := m.SetMail(context.Background(), s); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(nft.last(), "203.0.113.9 timeout 600s") {
		t.Fatalf("not applied:\n%s", nft.last())
	}
	if st := m.Status(0); st.MailBans != 2 {
		t.Errorf("mailBans = %d", st.MailBans)
	}
	// Invalid state: refused, the previous one stays.
	if err := m.SetMail(context.Background(), MailFirewallState{Ports: []int{22}}); err == nil {
		t.Errorf("port 22 accepted")
	}
	// nft refuses: rolled back, error visible (W1).
	nft.fail = errors.New("nft: syntax error")
	err := m.SetMail(context.Background(), MailFirewallState{Ports: []int{25}})
	var ae *apiError
	if !errors.As(err, &ae) || ae.Code != codeApplyFailed {
		t.Fatalf("want applyFailed, got %v", err)
	}
	if st := m.Status(0); st.LastApplyError == nil || st.MailBans != 2 {
		t.Errorf("after a refused apply: %+v", st)
	}
	nft.fail = nil

	// Restart: the persisted state comes back.
	m2 := newFirewallManager(&fakeNft{available: true}, clk, state)
	m2.resolvers = nil
	st, err := loadState(state)
	if err != nil {
		t.Fatal(err)
	}
	if st.Mail == nil || len(st.Mail.Bans) != 2 {
		t.Fatalf("mail state not persisted: %+v", st.Mail)
	}
	if err := m2.Restore(context.Background(), st); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(m2.Ruleset(), "set mail_bans6") {
		t.Errorf("not restored:\n%s", m2.Ruleset())
	}

	// Expiry: re-applied one second after the first ban expires, without it.
	before := nft.count()
	clk.Advance(10*time.Minute + time.Second)
	if nft.count() == before {
		t.Fatalf("no re-apply at expiry")
	}
	if strings.Contains(nft.last(), "203.0.113.9") || !strings.Contains(nft.last(), "2001:db8:aa:bb::/64") {
		t.Errorf("after expiry:\n%s", nft.last())
	}
	if got := m.Status(0).MailBans; got != 1 {
		t.Errorf("mailBans after expiry = %d", got)
	}
}

func TestMailFirewallRoute(t *testing.T) {
	clk := newFakeClock(fwNow)
	nft := &fakeNft{available: true}
	fw := newFirewallManager(nft, clk, "")
	fw.resolvers = nil
	g, _ := testGateway(t, fw.Allows)
	mux := newMux(&fakeOps{}, newLayout("/srv/oblimint"), fw, g, nil)
	call := func(method, target, body string) (int, string) {
		rec := httptest.NewRecorder()
		req, _ := http.NewRequest(method, target, strings.NewReader(body))
		mux.ServeHTTP(rec, req)
		return rec.Code, rec.Body.String()
	}
	body, _ := json.Marshal(MailFirewallState{Ports: []int{25, 993}, Bans: []MailBanEntry{{CIDR: "203.0.113.9", ExpiresAt: *ts(time.Hour)}}})
	steps := []struct {
		method, target, body string
		status               int
		contains             string
	}{
		{"PUT", "/v1/firewall/mail", string(body), 200, `"ok":true`},
		{"GET", "/v1/firewall", "", 200, `"mailBans":1`},
		{"PUT", "/v1/firewall/mail", `{"ports":[25],"bans":[{"cidr":"10.0.0.1","expiresAt":"2026-10-09T13:00:00Z"}]}`, 400, `"code":"invalid"`},
		{"PUT", "/v1/firewall/mail", `{"ports":[8080]}`, 400, `"code":"invalid"`},
		{"PUT", "/v1/firewall/mail", `not json`, 400, `"code":"invalid"`},
		{"PUT", "/v1/firewall/mail", `{"ports":[25],"bans":[]}`, 200, `"ok":true`},
		{"GET", "/v1/firewall", "", 200, `"mailBans":0`},
	}
	for _, s := range steps {
		code, out := call(s.method, s.target, s.body)
		if code != s.status || !strings.Contains(out, s.contains) {
			t.Errorf("%s %s %s: %d %s", s.method, s.target, s.body, code, out)
		}
	}
	if !strings.Contains(nft.applied[0], "set mail_bans4") {
		t.Errorf("first apply:\n%s", nft.applied[0])
	}
	// Without managers (P1 wiring): 501.
	rec := httptest.NewRecorder()
	req, _ := http.NewRequest("PUT", "/v1/firewall/mail", strings.NewReader(`{"ports":[]}`))
	newMux(&fakeOps{}, newLayout("/srv/oblimint"), nil, nil, nil).ServeHTTP(rec, req)
	if rec.Code != http.StatusNotImplemented {
		t.Errorf("no managers: %d", rec.Code)
	}
}
