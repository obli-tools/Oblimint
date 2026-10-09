package main

import (
	"fmt"
	"net/netip"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"
)

// ─────────────────────────────────────────────────────────────────────────────
// Per-account allow-list, bans and egress filter (docs/P2-PLAN.md §9.4, W1,
// audit R-EGRESS). The panel pushes the FULL state of an account
// (HostdFirewallAccountState) and the platform-wide egress settings; hostd
// validates everything again (R2) and renders ONE nftables table,
// `inet oblimint`, applied atomically with `nft -f` (delete + recreate in a
// single transaction).
//
// The table only DROPS (W1): its base chains run before Docker's filter
// chains (priority -10 < 0), and an accept in a base chain would not stop
// Docker's own chains anyway — accepting stays Docker's job.
//
//   prerouting (priority -150, BEFORE Docker's DNAT at -100) egress of the
//            account networks to ANY address of the host itself (fib daddr
//            type local), except tcp 80/443. It must run before DNAT: a flow
//            to a Docker-published port of the host (another account's
//            external SQL, the panel, other apps) is rewritten to a container
//            address and then crosses FORWARD, never INPUT.
//   input    host ports owned by the hostd gateway (file servers): bans, and
//            in allowlist / auto-2fa modes everything not in the allow sets;
//            egress to the host itself again (defence in depth: flows DNAT-ed
//            TO a host address).
//   forward  host ports published by Docker (external SQL), matched on the
//            ORIGINAL destination port of DNAT-ed flows (ct original
//            proto-dst); egress of the account networks (metadata, private
//            ranges in strict mode; original direction only, a link-local
//            host resolver keeps port 53), never within the same account
//            subnet; and any forwarded flow to a PROXY-mode gateway backend
//            (file server :2022), which only hostd may reach.
//
// The renderer is a pure function of the state (renderRuleset, golden tests).
// ─────────────────────────────────────────────────────────────────────────────

// AccessMode mirrors shared/src/access.ts.
type AccessMode string

const (
	modeOpen      AccessMode = "open"
	modeAllowlist AccessMode = "allowlist"
	modeAuto2FA   AccessMode = "auto-2fa"
)

// EgressMode mirrors HostdFirewallGlobal.egress.
type EgressMode string

const (
	egressOff      EgressMode = "off"
	egressMetadata EgressMode = "metadata"
	egressStrict   EgressMode = "strict"
)

// Limits of a pushed state (defence in depth: the panel has its own).
const (
	maxAccountPorts   = 64
	maxAllowEntries   = 2000
	maxBanEntries     = 10000
	maxGlobalPrefixes = 4096
	// Narrowest prefix the panel accepts for a rule (cidrTooWide): /8 v4, /32 v6.
	minAllowBits4 = 8
	minAllowBits6 = 32
	// Bans: one address (v4) or its /64 (v6); a little slack for wider bans.
	minBanBits4 = 24
	minBanBits6 = 48
)

// FirewallAllow is one allow entry (rule or auto-2fa grant).
type FirewallAllow struct {
	CIDR      string  `json:"cidr"`
	ExpiresAt *string `json:"expiresAt"`
}

// FirewallBan is one ban (address, or the /64 of an IPv6 address).
type FirewallBan struct {
	IP        string `json:"ip"`
	ExpiresAt string `json:"expiresAt"`
}

// FirewallAccountState is the body of PUT /v1/firewall/accounts/{id}.
type FirewallAccountState struct {
	AccountID      int64           `json:"accountId"`
	Mode           AccessMode      `json:"mode"`
	GatewayPorts   []int           `json:"gatewayPorts"`
	PublishedPorts []int           `json:"publishedPorts"`
	Allow          []FirewallAllow `json:"allow"`
	Bans           []FirewallBan   `json:"bans"`
}

// FirewallGlobal is the body of PUT /v1/firewall/global.
type FirewallGlobal struct {
	Egress         EgressMode `json:"egress"`
	AccountSubnets []string   `json:"accountSubnets"`
	EgressAllow    []string   `json:"egressAllow"`
}

// timedPrefix is a validated, normalized prefix with an optional expiry.
type timedPrefix struct {
	Prefix  netip.Prefix
	Expires *time.Time // nil = never
}

// accountRules is the validated form of an account state.
type accountRules struct {
	AccountID      int64
	Mode           AccessMode
	GatewayPorts   []int
	PublishedPorts []int
	Allow          []timedPrefix
	Bans           []timedPrefix
}

// globalRules is the validated form of the global state.
type globalRules struct {
	Egress         EgressMode
	AccountSubnets []netip.Prefix
	EgressAllow    []netip.Prefix
}

// ── Validation (R2) ──────────────────────────────────────────────────────────

func validatePorts(what string, ports []int) ([]int, error) {
	if len(ports) > maxAccountPorts {
		return nil, badRequest("too many %s", what)
	}
	out := make([]int, 0, len(ports))
	for _, p := range ports {
		if p < 1 || p > 65535 {
			return nil, badRequest("invalid %s %d", what, p)
		}
		out = append(out, p)
	}
	slices.Sort(out)
	return slices.Compact(out), nil
}

// parsePrefix accepts an address or a CIDR, v4 or v6 (no zone), and returns
// the masked prefix (v4-mapped v6 addresses become v4). minBits4/6 bound how
// wide it may be.
func parsePrefix(s string, minBits4, minBits6 int) (netip.Prefix, error) {
	if s == "" || len(s) > 64 || strings.ContainsAny(s, "% \t\n") {
		return netip.Prefix{}, badRequest("invalid address %q", s)
	}
	var p netip.Prefix
	if strings.Contains(s, "/") {
		pp, err := netip.ParsePrefix(s)
		if err != nil {
			return netip.Prefix{}, badRequest("invalid CIDR %q", s)
		}
		if pp.Addr().Is4In6() && pp.Bits() >= 96 {
			pp = netip.PrefixFrom(pp.Addr().Unmap(), pp.Bits()-96)
		}
		p = pp
	} else {
		a, err := netip.ParseAddr(s)
		if err != nil {
			return netip.Prefix{}, badRequest("invalid address %q", s)
		}
		a = a.Unmap()
		p = netip.PrefixFrom(a, a.BitLen())
	}
	p = p.Masked()
	if p.Addr().Is4() && p.Bits() < minBits4 || p.Addr().Is6() && p.Bits() < minBits6 {
		return netip.Prefix{}, badRequest("prefix %q is too wide", s)
	}
	return p, nil
}

func parseExpiry(s string) (time.Time, error) {
	t, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		return time.Time{}, badRequest("invalid expiresAt %q", s)
	}
	return t, nil
}

func (s FirewallAccountState) validate(accountID int64) (accountRules, error) {
	if err := validateID("account id", accountID); err != nil {
		return accountRules{}, err
	}
	if s.AccountID != 0 && s.AccountID != accountID {
		return accountRules{}, badRequest("accountId %d does not match the path", s.AccountID)
	}
	r := accountRules{AccountID: accountID, Mode: s.Mode}
	switch s.Mode {
	case modeOpen, modeAllowlist, modeAuto2FA:
	default:
		return accountRules{}, badRequest("invalid mode %q", s.Mode)
	}
	var err error
	if r.GatewayPorts, err = validatePorts("gateway port", s.GatewayPorts); err != nil {
		return accountRules{}, err
	}
	if r.PublishedPorts, err = validatePorts("published port", s.PublishedPorts); err != nil {
		return accountRules{}, err
	}
	if len(s.Allow) > maxAllowEntries || len(s.Bans) > maxBanEntries {
		return accountRules{}, badRequest("too many allow / ban entries")
	}
	for _, a := range s.Allow {
		p, err := parsePrefix(a.CIDR, minAllowBits4, minAllowBits6)
		if err != nil {
			return accountRules{}, err
		}
		tp := timedPrefix{Prefix: p}
		if a.ExpiresAt != nil {
			t, err := parseExpiry(*a.ExpiresAt)
			if err != nil {
				return accountRules{}, err
			}
			tp.Expires = &t
		}
		r.Allow = append(r.Allow, tp)
	}
	for _, b := range s.Bans {
		p, err := parsePrefix(b.IP, minBanBits4, minBanBits6)
		if err != nil {
			return accountRules{}, err
		}
		t, err := parseExpiry(b.ExpiresAt)
		if err != nil {
			return accountRules{}, err
		}
		r.Bans = append(r.Bans, timedPrefix{Prefix: p, Expires: &t})
	}
	return r, nil
}

func (g FirewallGlobal) validate() (globalRules, error) {
	r := globalRules{Egress: g.Egress}
	switch g.Egress {
	case egressOff, egressMetadata, egressStrict:
	default:
		return globalRules{}, badRequest("invalid egress mode %q", g.Egress)
	}
	if len(g.AccountSubnets) > maxGlobalPrefixes || len(g.EgressAllow) > maxGlobalPrefixes {
		return globalRules{}, badRequest("too many subnets")
	}
	for _, s := range g.AccountSubnets {
		// An account network is a Docker bridge subnet: never wider than /8 (v4) or /32 (v6).
		p, err := parsePrefix(s, 8, 32)
		if err != nil {
			return globalRules{}, err
		}
		r.AccountSubnets = append(r.AccountSubnets, p)
	}
	for _, s := range g.EgressAllow {
		p, err := parsePrefix(s, 0, 0)
		if err != nil {
			return globalRules{}, err
		}
		r.EgressAllow = append(r.EgressAllow, p)
	}
	r.AccountSubnets = uniquePrefixes(r.AccountSubnets)
	r.EgressAllow = uniquePrefixes(r.EgressAllow)
	return r, nil
}

// ── Decision (gateway accept, defence in depth) ─────────────────────────────

// live reports whether a timed entry is still valid at now.
func (t timedPrefix) live(now time.Time) bool { return t.Expires == nil || t.Expires.After(now) }

func containsLive(list []timedPrefix, ip netip.Addr, now time.Time) bool {
	for _, e := range list {
		if e.live(now) && e.Prefix.Contains(ip) {
			return true
		}
	}
	return false
}

// allows is the gateway decision for one client address: banned → no; open
// → yes; allowlist / auto-2fa → only when an allow entry contains it.
func (r *accountRules) allows(ip netip.Addr, now time.Time) (bool, string) {
	ip = ip.Unmap()
	if containsLive(r.Bans, ip, now) {
		return false, "banned"
	}
	if r.Mode == modeOpen {
		return true, ""
	}
	if containsLive(r.Allow, ip, now) {
		return true, ""
	}
	return false, "notAllowed"
}

// ── Rendering ────────────────────────────────────────────────────────────────

const (
	nftTable    = "oblimint"
	nftPriority = -10
	// Egress-to-host chain: after conntrack (-200), before Docker's DNAT
	// (dstnat, -100), so that the destination is still the ORIGINAL one.
	nftPreroutingPriority = -150
)

// renderInput is everything the ruleset depends on (pure function input).
type renderInput struct {
	Global   *globalRules
	Accounts []accountRules
	// HostResolvers: private / link-local DNS servers of the host. Strict
	// mode allows them (every port); in metadata and strict modes a resolver
	// inside the metadata range (GCP 169.254.169.254, AWS 169.254.169.253)
	// stays reachable on port 53 only.
	HostResolvers []netip.Addr
	// ProxiedTargets: backends of the hostd port gateway in PROXY protocol
	// mode (file servers). hostd reaches them from the host namespace
	// (output path); anything FORWARDED to them — another container of the
	// account network — is dropped, so a site can never talk to SFTPGo
	// without going through the gateway (allow-list, bans, PROXY header).
	ProxiedTargets []netip.AddrPort
	// Mail: bans on the shared mail ports (P4, mail.go), nil = none.
	Mail *mailRules
	Now  time.Time
}

// liveSet returns the live entries of one family, sorted, without the
// entries covered by another live entry (an nftables interval set refuses
// overlapping elements), each with its remaining lifetime (0 = permanent).
type setElem struct {
	Prefix  netip.Prefix
	Timeout time.Duration
}

func liveSet(list []timedPrefix, v6 bool, now time.Time) []setElem {
	type cand struct {
		p   netip.Prefix
		exp *time.Time
	}
	var cs []cand
	for _, e := range list {
		if e.Prefix.Addr().Is6() != v6 || !e.live(now) {
			continue
		}
		// Shorter than a second: nft cannot express it, it is gone anyway.
		if e.Expires != nil && e.Expires.Sub(now) < time.Second {
			continue
		}
		cs = append(cs, cand{e.Prefix, e.Expires})
	}
	// Same prefix several times: keep the longest lifetime.
	byPrefix := map[netip.Prefix]*time.Time{}
	order := []netip.Prefix{}
	for _, c := range cs {
		prev, seen := byPrefix[c.p]
		if !seen {
			order = append(order, c.p)
			byPrefix[c.p] = c.exp
			continue
		}
		if prev != nil && (c.exp == nil || c.exp.After(*prev)) {
			byPrefix[c.p] = c.exp
		}
	}
	var out []setElem
	for _, p := range order {
		covered := false
		for _, q := range order {
			if q != p && q.Bits() < p.Bits() && q.Contains(p.Addr()) {
				covered = true
				break
			}
		}
		if covered {
			continue
		}
		var to time.Duration
		if exp := byPrefix[p]; exp != nil {
			to = exp.Sub(now).Truncate(time.Second)
		}
		out = append(out, setElem{p, to})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Prefix.Addr().Less(out[j].Prefix.Addr()) })
	return out
}

func uniquePrefixes(ps []netip.Prefix) []netip.Prefix {
	seen := map[netip.Prefix]bool{}
	var out []netip.Prefix
	for _, p := range ps {
		if !seen[p] {
			seen[p] = true
			out = append(out, p)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Addr() == out[j].Addr() {
			return out[i].Bits() < out[j].Bits()
		}
		return out[i].Addr().Less(out[j].Addr())
	})
	return out
}

// uniqueAddrPorts returns the valid entries, unmapped, deduplicated, sorted.
func uniqueAddrPorts(list []netip.AddrPort) []netip.AddrPort {
	seen := map[netip.AddrPort]bool{}
	var out []netip.AddrPort
	for _, t := range list {
		t = netip.AddrPortFrom(t.Addr().Unmap(), t.Port())
		if !t.IsValid() || t.Port() == 0 || t.Addr().Zone() != "" || seen[t] {
			continue
		}
		seen[t] = true
		out = append(out, t)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Compare(out[j]) < 0 })
	return out
}

// noOverlap drops the prefixes covered by another one (interval sets).
func noOverlap(ps []netip.Prefix) []netip.Prefix {
	var out []netip.Prefix
	for _, p := range ps {
		covered := false
		for _, q := range ps {
			if q != p && q.Bits() < p.Bits() && q.Contains(p.Addr()) {
				covered = true
				break
			}
		}
		if !covered {
			out = append(out, p)
		}
	}
	return out
}

func prefixString(p netip.Prefix) string {
	if p.Bits() == p.Addr().BitLen() {
		return p.Addr().String()
	}
	return p.String()
}

func elemString(e setElem) string {
	s := prefixString(e.Prefix)
	if e.Timeout > 0 {
		s += " timeout " + strconv.FormatInt(int64(e.Timeout/time.Second), 10) + "s"
	}
	return s
}

func family(v6 bool) (addrType, match string) {
	if v6 {
		return "ipv6_addr", "ip6"
	}
	return "ipv4_addr", "ip"
}

func portList(ports []int) string {
	parts := make([]string, len(ports))
	for i, p := range ports {
		parts[i] = strconv.Itoa(p)
	}
	if len(parts) == 1 {
		return parts[0]
	}
	return "{ " + strings.Join(parts, ", ") + " }"
}

func prefixList(ps []netip.Prefix) string {
	parts := make([]string, len(ps))
	for i, p := range ps {
		parts[i] = prefixString(p)
	}
	return strings.Join(parts, ", ")
}

type nftWriter struct{ b strings.Builder }

func (w *nftWriter) line(indent int, format string, args ...any) {
	w.b.WriteString(strings.Repeat("\t", indent))
	fmt.Fprintf(&w.b, format, args...)
	w.b.WriteByte('\n')
}

func (w *nftWriter) set(name, addrType string, flags string, elems []string) {
	w.line(1, "set %s {", name)
	w.line(2, "type %s", addrType)
	w.line(2, "flags %s", flags)
	if len(elems) > 0 {
		w.line(2, "elements = { %s }", strings.Join(elems, ", "))
	}
	w.line(1, "}")
}

var (
	privateV4 = []netip.Prefix{
		netip.MustParsePrefix("10.0.0.0/8"),
		netip.MustParsePrefix("172.16.0.0/12"),
		netip.MustParsePrefix("192.168.0.0/16"),
		netip.MustParsePrefix("169.254.0.0/16"),
	}
	privateV6 = []netip.Prefix{
		netip.MustParsePrefix("fc00::/7"),
		netip.MustParsePrefix("fe80::/10"),
	}
	// Cloud metadata: 169.254.0.0/16 (169.254.169.254 everywhere) and the
	// IPv6 endpoint of EC2 (fd00:ec2::254).
	metadataV4 = netip.MustParsePrefix("169.254.0.0/16")
	metadataV6 = netip.MustParsePrefix("fd00:ec2::254/128")
)

// renderRuleset renders the whole `inet oblimint` table, preceded by the
// lines that make `nft -f` replace it atomically.
func renderRuleset(in renderInput) string {
	var w nftWriter
	w.line(0, "# Generated by oblimint-hostd: do not edit (replaced on every apply).")
	w.line(0, "table inet %s", nftTable)
	w.line(0, "delete table inet %s", nftTable)
	w.line(0, "table inet %s {", nftTable)

	accounts := slices.Clone(in.Accounts)
	sort.Slice(accounts, func(i, j int) bool { return accounts[i].AccountID < accounts[j].AccountID })

	// Per-account sets (only for accounts that have ports to protect).
	for _, a := range accounts {
		if len(a.GatewayPorts) == 0 && len(a.PublishedPorts) == 0 {
			continue
		}
		for _, v6 := range []bool{false, true} {
			addrType, _ := family(v6)
			suffix := "4"
			if v6 {
				suffix = "6"
			}
			var allow, ban []string
			for _, e := range liveSet(a.Allow, v6, in.Now) {
				allow = append(allow, elemString(e))
			}
			for _, e := range liveSet(a.Bans, v6, in.Now) {
				ban = append(ban, elemString(e))
			}
			if a.Mode != modeOpen {
				w.set(fmt.Sprintf("allow%s_%d", suffix, a.AccountID), addrType, "interval,timeout", allow)
			}
			w.set(fmt.Sprintf("ban%s_%d", suffix, a.AccountID), addrType, "interval,timeout", ban)
		}
	}

	renderMailSets(&w, in.Mail, in.Now)

	egress := egressOff
	var subnets4, subnets6, allow4, allow6 []netip.Prefix
	if in.Global != nil {
		egress = in.Global.Egress
		for _, p := range in.Global.AccountSubnets {
			if p.Addr().Is6() {
				subnets6 = append(subnets6, p)
			} else {
				subnets4 = append(subnets4, p)
			}
		}
		for _, p := range in.Global.EgressAllow {
			if p.Addr().Is6() {
				allow6 = append(allow6, p)
			} else {
				allow4 = append(allow4, p)
			}
		}
	}
	var metaDNS4, metaDNS6 []netip.Prefix
	for _, a := range in.HostResolvers {
		a = a.Unmap()
		p := netip.PrefixFrom(a, a.BitLen())
		if a.Is6() {
			allow6 = append(allow6, p)
			if metadataV6.Contains(a) {
				metaDNS6 = append(metaDNS6, p)
			}
		} else {
			allow4 = append(allow4, p)
			if metadataV4.Contains(a) {
				metaDNS4 = append(metaDNS4, p)
			}
		}
	}
	metaDNS4, metaDNS6 = uniquePrefixes(metaDNS4), uniquePrefixes(metaDNS6)
	allow4, allow6 = noOverlap(uniquePrefixes(allow4)), noOverlap(uniquePrefixes(allow6))
	egressOn := egress != egressOff && len(subnets4)+len(subnets6) > 0
	if egressOn {
		if len(subnets4) > 0 {
			w.set("acct_nets4", "ipv4_addr", "interval", []string{prefixList(noOverlap(subnets4))})
		}
		if len(subnets6) > 0 {
			w.set("acct_nets6", "ipv6_addr", "interval", []string{prefixList(noOverlap(subnets6))})
		}
		if egress == egressStrict {
			w.set("egress_allow4", "ipv4_addr", "interval", nonEmpty(prefixList(allow4)))
			w.set("egress_allow6", "ipv6_addr", "interval", nonEmpty(prefixList(allow6)))
		}
		if len(subnets4) > 0 && len(metaDNS4) > 0 {
			w.set("meta_dns4", "ipv4_addr", "interval", []string{prefixList(metaDNS4)})
		}
		if len(subnets6) > 0 && len(metaDNS6) > 0 {
			w.set("meta_dns6", "ipv6_addr", "interval", []string{prefixList(metaDNS6)})
		}
	}

	// hostDrops writes the "account networks → the host itself" drops for a
	// destination match: only the edge ports, and only new connections
	// (replies to the hostd gateway are established).
	hostDrops := func(dst string) {
		for _, v6 := range []bool{false, true} {
			if v6 && len(subnets6) == 0 || !v6 && len(subnets4) == 0 {
				continue
			}
			_, m := family(v6)
			set, icmp := "@acct_nets4", "icmp"
			if v6 {
				set, icmp = "@acct_nets6", "ipv6-icmp"
			}
			w.line(2, "%s saddr %s %sct state new meta l4proto != { tcp, %s } drop", m, set, dst, icmp)
			w.line(2, "%s saddr %s %sct state new tcp dport != { 80, 443 } drop", m, set, dst)
		}
	}

	// ── prerouting: egress to the host itself, BEFORE Docker's DNAT ──
	// Every local address (public, LAN, bridge gateways): Docker publishes
	// ports on all of them, and a published port is DNAT-ed to a container
	// (FORWARD path) before INPUT could ever see it. Container ↔ container
	// traffic (same account network) never has a local destination.
	if egressOn {
		w.line(1, "chain prerouting {")
		w.line(2, "type filter hook prerouting priority %d; policy accept;", nftPreroutingPriority)
		hostDrops("fib daddr type local ")
		w.line(1, "}")
	}

	// ── input: gateway ports + egress to the host itself ──
	w.line(1, "chain input {")
	w.line(2, "type filter hook input priority %d; policy accept;", nftPriority)
	renderMailDrops(&w, in.Mail, "input")
	for _, a := range accounts {
		// Gateway ports, and the published ports too: Docker relays some
		// published flows through docker-proxy (IPv6, userland proxy), which
		// arrive on INPUT instead of being DNAT-ed. Original direction only:
		// the DB port range overlaps the ephemeral ports of the host's own
		// outgoing connections, whose replies must never match.
		ports := slices.Concat(a.GatewayPorts, a.PublishedPorts)
		if len(ports) == 0 {
			continue
		}
		slices.Sort(ports)
		match := "ct direction original tcp dport " + portList(slices.Compact(ports))
		writeAccountDrops(&w, a, match)
	}
	if egressOn {
		// Defence in depth (flows DNAT-ed to a host address).
		hostDrops("")
	}
	w.line(1, "}")

	// ── forward: published ports + egress of the account networks ──
	w.line(1, "chain forward {")
	w.line(2, "type filter hook forward priority %d; policy accept;", nftPriority)
	renderMailDrops(&w, in.Mail, "forward")
	for _, t := range uniqueAddrPorts(in.ProxiedTargets) {
		_, m := family(t.Addr().Is6())
		w.line(2, "%s daddr %s tcp dport %d ct direction original drop", m, t.Addr(), t.Port())
	}
	for _, a := range accounts {
		if len(a.PublishedPorts) == 0 {
			continue
		}
		match := "ct direction original ct status dnat meta l4proto tcp ct original proto-dst " + portList(a.PublishedPorts)
		writeAccountDrops(&w, a, match)
	}
	if egressOn {
		// Original direction only: the replies of inbound flows (a LAN / VPN
		// client of a published port) must never match.
		metadataDrops := func(m, set, meta, dnsSet string, hasDNS bool) {
			if !hasDNS {
				w.line(2, "%s saddr %s ct direction original %s daddr %s drop", m, set, m, meta)
				return
			}
			// The host's resolver lives in the metadata range (GCP, AWS):
			// Docker's embedded DNS forwards from the container namespace,
			// so it stays reachable — on port 53 only.
			w.line(2, "%s saddr %s ct direction original %s daddr %s %s daddr != %s drop", m, set, m, meta, m, dnsSet)
			w.line(2, "%s saddr %s ct direction original %s daddr %s meta l4proto != { tcp, udp } drop", m, set, m, dnsSet)
			w.line(2, "%s saddr %s ct direction original %s daddr %s th dport != 53 drop", m, set, m, dnsSet)
		}
		if len(subnets4) > 0 {
			metadataDrops("ip", "@acct_nets4", metadataV4.String(), "@meta_dns4", len(metaDNS4) > 0)
		}
		if len(subnets6) > 0 {
			metadataDrops("ip6", "@acct_nets6", prefixString(metadataV6), "@meta_dns6", len(metaDNS6) > 0)
		}
		if egress == egressStrict {
			// Per subnet: private destinations outside the account's own
			// subnet and not explicitly allowed (panel network, resolvers).
			for _, s := range noOverlap(subnets4) {
				w.line(2, "ip saddr %s ct direction original ip daddr != %s ip daddr { %s } ip daddr != @egress_allow4 drop", s, s, prefixList(privateV4))
			}
			for _, s := range noOverlap(subnets6) {
				w.line(2, "ip6 saddr %s ct direction original ip6 daddr != %s ip6 daddr { %s } ip6 daddr != @egress_allow6 drop", s, s, prefixList(privateV6))
			}
		}
	}
	w.line(1, "}")
	w.line(0, "}")
	return w.b.String()
}

func nonEmpty(s string) []string {
	if s == "" {
		return nil
	}
	return []string{s}
}

// writeAccountDrops writes the drop rules of one account for a port match:
// bans in every mode, everything not allowed in allowlist / auto-2fa.
func writeAccountDrops(w *nftWriter, a accountRules, match string) {
	w.line(2, "# account %d (%s)", a.AccountID, a.Mode)
	w.line(2, "%s ip saddr @ban4_%d drop", match, a.AccountID)
	w.line(2, "%s ip6 saddr @ban6_%d drop", match, a.AccountID)
	if a.Mode != modeOpen {
		w.line(2, "%s ip saddr != @allow4_%d drop", match, a.AccountID)
		w.line(2, "%s ip6 saddr != @allow6_%d drop", match, a.AccountID)
	}
}

// nextExpiry is the earliest future expiry of any entry (zero = none): the
// ruleset is re-rendered then (covered entries come back, gone ones leave).
func nextExpiry(accounts []accountRules, now time.Time) time.Time {
	var next time.Time
	consider := func(list []timedPrefix) {
		for _, e := range list {
			if e.Expires != nil && e.Expires.After(now) && (next.IsZero() || e.Expires.Before(next)) {
				next = *e.Expires
			}
		}
	}
	for _, a := range accounts {
		consider(a.Allow)
		consider(a.Bans)
	}
	return next
}
