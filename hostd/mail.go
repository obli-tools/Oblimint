package main

import (
	"net/netip"
	"slices"
	"strings"
	"time"
)

// ─────────────────────────────────────────────────────────────────────────────
// P4 — bans on the SHARED mail ports (docs/P4-PLAN.md §8, invariant MA8). The
// panel pushes the whole state (PUT /v1/firewall/mail): the published mail
// ports and the banned addresses (IPv4 address, or IPv6 prefix between /48
// and /64) with their expiry. hostd validates it again (R2) and renders it in
// the same `inet oblimint` table as the P2 allow-lists (one atomic `nft -f`):
//
//   set mail_bans4 / mail_bans6   flags interval,timeout (the kernel expires
//                                 the elements by itself; hostd re-applies at
//                                 the next expiry anyway)
//   forward   DNAT-ed flows whose ORIGINAL destination port is a mail port
//             (Docker publishes 25 / 465 / 587 … to oblimint-mail): drop the
//             banned sources — before Docker's own chains (priority -10);
//   input     the same ports on the host itself (docker-proxy / userland
//             proxy, IPv6 without NAT, network_mode host).
//
// Drops only (W1). Never a loopback, link-local, private (Docker networks,
// LAN) or unspecified address: the panel never bans those, hostd refuses them.
// ─────────────────────────────────────────────────────────────────────────────

// mailPorts are the only ports a mail ban may cover (the shared mail service).
var mailPorts = []int{25, 110, 143, 465, 587, 993, 995, 4190}

const (
	// maxMailBans bounds the state (the panel caps its own list well below).
	maxMailBans = 10000
	// IPv6 bans: one subscriber holds a /64; a /48 at most (a site's allocation).
	minMailBanBits6 = 48
	maxMailBanBits6 = 64
)

// MailBanEntry is one ban of HostdMailFirewallState.bans.
type MailBanEntry struct {
	CIDR      string `json:"cidr"`
	ExpiresAt string `json:"expiresAt"`
}

// MailFirewallState is the body of PUT /v1/firewall/mail (replaces everything).
type MailFirewallState struct {
	Ports []int          `json:"ports"`
	Bans  []MailBanEntry `json:"bans"`
}

// mailRules is the validated form of a MailFirewallState.
type mailRules struct {
	Ports []int
	Bans  []timedPrefix
}

// validMailBanAddr refuses the addresses that are never a remote mail client:
// loopback, link-local, unspecified, multicast and private ranges (Docker
// bridge networks, LAN, ULA). Banning them would cut the platform's own
// containers (webmail, relay) or a whole LAN behind one gateway.
func validMailBanAddr(a netip.Addr) bool {
	return a.IsValid() && !a.IsLoopback() && !a.IsLinkLocalUnicast() && !a.IsLinkLocalMulticast() &&
		!a.IsUnspecified() && !a.IsMulticast() && !a.IsPrivate() && !a.IsInterfaceLocalMulticast()
}

func (s MailFirewallState) validate() (mailRules, error) {
	var r mailRules
	if len(s.Ports) > len(mailPorts) {
		return mailRules{}, badRequest("too many mail ports")
	}
	for _, p := range s.Ports {
		if !slices.Contains(mailPorts, p) {
			return mailRules{}, badRequest("port %d is not a mail port", p)
		}
		r.Ports = append(r.Ports, p)
	}
	slices.Sort(r.Ports)
	r.Ports = slices.Compact(r.Ports)
	if len(s.Bans) > maxMailBans {
		return mailRules{}, badRequest("too many mail bans (max %d)", maxMailBans)
	}
	for _, b := range s.Bans {
		// parsePrefix bounds the width (v4: an address only, v6: /48 or narrower)…
		p, err := parsePrefix(strings.TrimSpace(b.CIDR), 32, minMailBanBits6)
		if err != nil {
			return mailRules{}, err
		}
		// … and an IPv6 ban is a prefix of /48 … /64, never a single host
		// (a host rotates through its /64 at will).
		if p.Addr().Is6() && p.Bits() > maxMailBanBits6 {
			return mailRules{}, badRequest("IPv6 mail ban %q must be a /48 … /64 prefix", b.CIDR)
		}
		if !validMailBanAddr(p.Addr()) {
			return mailRules{}, badRequest("address %q may not be banned (loopback, link-local or private)", b.CIDR)
		}
		t, err := parseExpiry(b.ExpiresAt)
		if err != nil {
			return mailRules{}, err
		}
		r.Bans = append(r.Bans, timedPrefix{Prefix: p, Expires: &t})
	}
	return r, nil
}

// liveCount is the number of bans still in force at now.
func (r *mailRules) liveCount(now time.Time) int {
	if r == nil {
		return 0
	}
	n := 0
	for _, b := range r.Bans {
		if b.live(now) {
			n++
		}
	}
	return n
}

// renderMailSets writes the two ban sets (only when mail ports are protected).
func renderMailSets(w *nftWriter, m *mailRules, now time.Time) {
	if m == nil || len(m.Ports) == 0 {
		return
	}
	for _, v6 := range []bool{false, true} {
		addrType, _ := family(v6)
		name := "mail_bans4"
		if v6 {
			name = "mail_bans6"
		}
		var elems []string
		for _, e := range liveSet(m.Bans, v6, now) {
			elems = append(elems, elemString(e))
		}
		w.set(name, addrType, "interval,timeout", elems)
	}
}

// renderMailDrops writes the drops of one chain: input (host ports) or
// forward (DNAT-ed flows, matched on the original destination port).
func renderMailDrops(w *nftWriter, m *mailRules, chain string) {
	if m == nil || len(m.Ports) == 0 {
		return
	}
	var match string
	switch chain {
	case "input":
		match = "ct direction original tcp dport " + portList(m.Ports)
	case "forward":
		match = "ct direction original ct status dnat meta l4proto tcp ct original proto-dst " + portList(m.Ports)
	default:
		return
	}
	w.line(2, "# shared mail ports: bans")
	w.line(2, "%s ip saddr @mail_bans4 drop", match)
	w.line(2, "%s ip6 saddr @mail_bans6 drop", match)
}

// nextRenderExpiry is the earliest future expiry of the whole input (account
// entries and mail bans): the ruleset is re-rendered then.
func nextRenderExpiry(in renderInput, now time.Time) time.Time {
	next := nextExpiry(in.Accounts, now)
	if in.Mail != nil {
		for _, b := range in.Mail.Bans {
			if b.Expires != nil && b.Expires.After(now) && (next.IsZero() || b.Expires.Before(next)) {
				next = *b.Expires
			}
		}
	}
	return next
}
