package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/netip"
	"os"
	"os/exec"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// ─────────────────────────────────────────────────────────────────────────────
// Public ports + dedicated IPs (migration 032 of the panel). The panel pushes
// the WHOLE publication state (PUT /v1/publish): the public addresses of the
// node (the managed dedicated IPs hostd adds to their interface), the
// account FRONT bridges, the bindings (public IP:port/proto → container
// fixed IPv4:port) and the outbound SNAT of the accounts with a dedicated IP.
// hostd validates it again (R2) and renders two tables replaced atomically
// with ONE `nft -f` (delete + recreate, like segments.go):
//
//   table ip oblimint_pub
//     chain prerouting (nat, priority -110: BEFORE Docker's DNAT at -100, so a
//       dedicated :80 taken over by an account wins over the edge's published
//       0.0.0.0:80, which keeps serving the shared IP)
//       fib daddr type != local return          only traffic TO the node
//       iifname lo / docker0 / <every bridge of the applied segment policy>
//               / omf* / omb* / omp-* / br-* return
//                                               no hairpin from the containers
//                                               (accounts, panel, mail, Obligate)
//       ip daddr @dedicated4 goto dedicated
//       tcp|udp dport @shared_<p>  ct mark |= M  counter  dnat → map @shared_<p>_to
//         (the shared IP = any local address that is not a dedicated one: the
//          same scope as a port Docker publishes, and it works behind a 1:1 NAT)
//     chain dedicated: ip daddr . dport @ded_<p> → map @ded_<p>_to
//     chain markcopy (filter forward -20): ct mark M → meta mark M (Docker's
//       nftables backend accepts the meta mark with bridge-accept-fwmark)
//   table ip oblimint_snat
//     chain postrouting (nat, priority 90 < Docker's MASQUERADE at 100)
//       ct direction original ip saddr @src_<account> oifname "<if>" snat ip to <dedicated>
//
// The source address of the client is preserved (DNAT only). Docker must
// accept the marked connections (dockeraccept.go). hostd never talks to
// Docker: the panel computes the container addresses (pinned since 031).
//
// R2 (defence in depth against a compromised panel): a rule targets an
// address inside the subnet of a FRONT bridge of the SAME account (bridge
// omf<accountId>, or a front bridge of that account in the applied segment
// policy), never the bridge gateway; dst is "*" (shared) or a declared
// dedicated address; a rule colliding with a listening socket of the node
// (any port of a wildcard socket, or of the same address) or a gateway port
// is SKIPPED and reported (the panel marks the binding portInUseOnHost),
// except 80 / 443 on a dedicated address (the takeover of the edge's ports).
// The socket check runs for the rules not in force yet: a rule already
// applied stays (a transient socket — an unconnected UDP one in the
// ephemeral range — never unpublishes an active binding behind the panel).
// The addresses are checked too: never on an internal interface (lo,
// docker*, br-*, omf*, omb*, omp-*, veth*), never inside the subnet of a
// bridge / veth / loopback of the node, and a managed address is a /32 or
// lies in a subnet already connected on its interface (no new connected
// route over the container ranges). A refused address is reported
// (state "refused"), its rules skipped (addressRefused), its SNAT left out.
//
// State persisted in <root>/run/hostd-publish.json (0600, atomic). Restore
// at start: managed addresses first, then the tables, then the Docker rule.
// A 60 s loop re-checks the addresses and the Docker rule (Docker restarted).
// ─────────────────────────────────────────────────────────────────────────────

const (
	pubTable          = "oblimint_pub"
	pubSnatTable      = "oblimint_snat"
	pubCounter        = "published"
	pubPriority       = -110
	pubSnatPriority   = 90
	pubMarkcopyPrio   = -20
	defaultPublishMrk = uint32(0x01000000)
	maxPubRules       = 65536
	maxPubAddresses   = 1024
	maxPubSnat        = 4096
	maxPubSources     = 256
	maxPubBodyBytes   = 16 << 20
	publishMarkEnv    = "OBLIMINT_PUBLISH_MARK"
	pubRecheckEvery   = 60 * time.Second
	pubDstShared      = "*"
)

var pubIfaceRe = regexp.MustCompile(`^[a-zA-Z0-9_.@:-]{1,15}$`)

// pubInternalIfaceRe: interfaces of loopback / the containers, never the interface of a public address.
var pubInternalIfaceRe = regexp.MustCompile(`^(lo|docker\d*|br-.*|omf\d+|omb\d+|omp-.*|veth.*)$`)

// PublishAddress is a public address of the node the panel wants present.
type PublishAddress struct {
	Address string `json:"address"`
	Prefix  int    `json:"prefix"`
	Iface   string `json:"iface"`
	// Managed: hostd adds it to Iface when absent (and removes it once it is no longer wanted, only when hostd added it).
	Managed bool `json:"managed"`
}

// PublishFront is a FRONT bridge of an account (the bindings target its subnet).
type PublishFront struct {
	Bridge    string `json:"bridge"`
	AccountID int64  `json:"accountId"`
}

// PublishRule is one binding.
type PublishRule struct {
	ID        int64  `json:"id"`
	AccountID int64  `json:"accountId"`
	Dst       string `json:"dst"`
	Protocol  string `json:"protocol"`
	Port      int    `json:"port"`
	ToAddr    string `json:"toAddr"`
	ToPort    int    `json:"toPort"`
}

// PublishSnat is the outbound SNAT of one account.
type PublishSnat struct {
	AccountID int64    `json:"accountId"`
	Sources   []string `json:"sources"`
	Iface     string   `json:"iface"`
	To        string   `json:"to"`
}

// PublishState is the body of PUT /v1/publish.
type PublishState struct {
	Mark      uint32           `json:"mark"`
	Addresses []PublishAddress `json:"addresses"`
	Dedicated []string         `json:"dedicated"`
	Fronts    []PublishFront   `json:"fronts"`
	Rules     []PublishRule    `json:"rules"`
	Snat      []PublishSnat    `json:"snat"`
}

// PublishAddressState is reported for every address of the state.
type PublishAddressState struct {
	Address string `json:"address"`
	// present (already on its interface), added (by hostd), missing (absent, external), otherInterface, error.
	State   string `json:"state"`
	Message string `json:"message,omitempty"`
}

// PublishSkipped: a rule not rendered.
type PublishSkipped struct {
	ID     int64  `json:"id"`
	Reason string `json:"reason"`
}

// PublishReply is the answer of PUT /v1/publish.
type PublishReply struct {
	OK        bool                  `json:"ok"`
	Addresses []PublishAddressState `json:"addresses"`
	Skipped   []PublishSkipped      `json:"skipped"`
}

// PublishStatus is the body of GET /v1/publish.
type PublishStatus struct {
	Backend        string                `json:"backend"`
	DockerAccept   string                `json:"dockerAccept"`
	Remediation    *string               `json:"remediation"`
	Rules          int                   `json:"rules"`
	Snat           int                   `json:"snat"`
	Published      *int64                `json:"published"`
	Mark           uint32                `json:"mark"`
	Addresses      []PublishAddressState `json:"addresses"`
	Skipped        []PublishSkipped      `json:"skipped"`
	LastApplyAt    *string               `json:"lastApplyAt"`
	LastApplyError *string               `json:"lastApplyError"`
}

// pubRule is a validated rule.
type pubRule struct {
	ID        int64
	AccountID int64
	Dst       netip.Addr // invalid = shared
	Proto     string
	Port      int
	To        netip.Addr
	ToPort    int
}

type pubSnat struct {
	AccountID int64
	Sources   []netip.Prefix
	Iface     string
	To        netip.Addr
}

type pubAddr struct {
	Addr    netip.Addr
	Prefix  int
	Iface   string
	Managed bool
}

// pubRules is the validated form of a PublishState.
type pubRules struct {
	Mark      uint32
	Addresses []pubAddr
	Dedicated []netip.Addr
	Rules     []pubRule
	Snat      []pubSnat
	Skipped   []PublishSkipped
	// Bridges: the bridges of the applied segment policy (no DNAT of what they send: no hairpin).
	Bridges []string
	// Refused: addresses of the state hostd will not manage nor publish on (reported).
	Refused []PublishAddressState
}

func (r pubRules) empty() bool { return len(r.Rules) == 0 && len(r.Snat) == 0 }

// publishMark: the mark of this hostd (OBLIMINT_PUBLISH_MARK, decimal or 0x…, else 0x01000000).
func publishMark() uint32 {
	if v := strings.TrimSpace(os.Getenv(publishMarkEnv)); v != "" {
		if n, err := strconv.ParseUint(v, 0, 32); err == nil && n != 0 {
			return uint32(n)
		}
		slog.Warn("invalid "+publishMarkEnv+" (default mark kept)", "value", v)
	}
	return defaultPublishMrk
}

func decodePublishState(w http.ResponseWriter, r *http.Request) (PublishState, error) {
	var s PublishState
	r.Body = http.MaxBytesReader(w, r.Body, maxPubBodyBytes)
	if err := json.NewDecoder(r.Body).Decode(&s); err != nil {
		return PublishState{}, badRequest("invalid JSON body: %v", err)
	}
	return s, nil
}

// pubEnv: what the validation reads from the host (kernel facts, the applied segment policy, the gateway).
type pubEnv struct {
	net netOps
	// frontOf: is bridge a FRONT bridge of accountId in the applied segment policy?
	frontOf func(bridge string, accountID int64) bool
	// gatewayPorts: host ports of the SFTP gateway (never DNAT-ed).
	gatewayPorts func() map[int]bool
	// listeners: listening sockets of the node (nil = not checked).
	listeners []HostListener
	// bridges: every bridge of the applied segment policy (nil = none known).
	bridges func() []string
	// applied: rules in force now (their socket check is not run again).
	applied map[pubRule]bool
}

// internalPrefixes: the IPv4 prefixes of loopback, the bridges and veths of the node (internal interfaces,
// and the bridges of the segment policy whatever their name).
func (env pubEnv) internalPrefixes(bridges map[string]bool) (internal []netip.Prefix, byIface map[string][]netip.Prefix) {
	byIface = map[string][]netip.Prefix{}
	if env.net == nil {
		return nil, byIface
	}
	ifs, err := env.net.Interfaces()
	if err != nil {
		return nil, byIface
	}
	for _, i := range ifs {
		for _, a := range i.Addresses {
			p, err := netip.ParsePrefix(a)
			if err != nil || !p.Addr().Is4() {
				continue
			}
			byIface[i.Name] = append(byIface[i.Name], p)
			if pubInternalIfaceRe.MatchString(i.Name) || bridges[i.Name] {
				internal = append(internal, p.Masked())
			}
		}
	}
	return internal, byIface
}

func parsePubAddr(s string) (netip.Addr, error) {
	a, err := netip.ParseAddr(strings.TrimSpace(s))
	if err != nil || !a.Is4() || a.IsUnspecified() || a.IsLoopback() || a.IsMulticast() || a.IsLinkLocalUnicast() {
		return netip.Addr{}, fmt.Errorf("invalid IPv4 address %q", s)
	}
	return a, nil
}

// validate checks the state (400 for a malformed one). Rules that cannot be honoured on this host
// (target outside the account's front subnet, collision with a host socket…) are skipped, not refused.
func (s PublishState) validate(mark uint32, env pubEnv) (pubRules, error) {
	r := pubRules{Mark: mark}
	if s.Mark != 0 && s.Mark != mark {
		return r, badRequest("publish: mark 0x%08x differs from hostd's 0x%08x (%s)", s.Mark, mark, publishMarkEnv)
	}
	if len(s.Rules) > maxPubRules {
		return r, badRequest("publish: too many rules (%d > %d)", len(s.Rules), maxPubRules)
	}
	if len(s.Addresses) > maxPubAddresses || len(s.Dedicated) > maxPubAddresses {
		return r, badRequest("publish: too many addresses")
	}
	if len(s.Snat) > maxPubSnat {
		return r, badRequest("publish: too many SNAT entries")
	}
	if len(s.Fronts) > maxSegBridges {
		return r, badRequest("publish: too many fronts")
	}
	segBridges := map[string]bool{}
	if env.bridges != nil {
		for _, b := range env.bridges() {
			if segBridgeNameRe.MatchString(b) && !segBridges[b] {
				segBridges[b] = true
				r.Bridges = append(r.Bridges, b)
			}
		}
		sort.Strings(r.Bridges)
	}
	internal, byIface := env.internalPrefixes(segBridges)
	refused := map[netip.Addr]bool{}
	seenA := map[netip.Addr]bool{}
	for i, a := range s.Addresses {
		ip, err := parsePubAddr(a.Address)
		if err != nil {
			return r, badRequest("publish: address %d: %v", i, err)
		}
		if a.Prefix < 8 || a.Prefix > 32 {
			return r, badRequest("publish: address %s: invalid prefix %d", ip, a.Prefix)
		}
		if a.Iface != "" && !pubIfaceRe.MatchString(a.Iface) {
			return r, badRequest("publish: address %s: invalid interface %q", ip, a.Iface)
		}
		if a.Managed && a.Iface == "" {
			return r, badRequest("publish: address %s: a managed address needs an interface", ip)
		}
		if seenA[ip] {
			return r, badRequest("publish: address %s listed twice", ip)
		}
		seenA[ip] = true
		if reason := addressRefusal(ip, a, internal, byIface); reason != "" {
			refused[ip] = true
			r.Refused = append(r.Refused, PublishAddressState{Address: ip.String(), State: "refused", Message: reason})
			slog.Warn("publish: address refused", "address", ip, "iface", a.Iface, "reason", reason)
			continue
		}
		r.Addresses = append(r.Addresses, pubAddr{Addr: ip, Prefix: a.Prefix, Iface: a.Iface, Managed: a.Managed})
	}
	dedicated := map[netip.Addr]bool{}
	for i, d := range s.Dedicated {
		ip, err := parsePubAddr(d)
		if err != nil {
			return r, badRequest("publish: dedicated %d: %v", i, err)
		}
		// Still out of the shared scope (fail safe), but never a rule / SNAT on it.
		if !refused[ip] && inPrefixes(internal, ip) {
			refused[ip] = true
			r.Refused = append(r.Refused, PublishAddressState{Address: ip.String(), State: "refused", Message: "internalAddress"})
		}
		if !dedicated[ip] {
			dedicated[ip] = true
			r.Dedicated = append(r.Dedicated, ip)
		}
	}
	// Fronts: the bridges each account's rules may target.
	fronts := map[int64][]string{}
	for i, f := range s.Fronts {
		if !segBridgeNameRe.MatchString(f.Bridge) || f.AccountID <= 0 {
			return r, badRequest("publish: front %d: invalid bridge %q / account %d", i, f.Bridge, f.AccountID)
		}
		if f.Bridge != fmt.Sprintf("omf%d", f.AccountID) && (env.frontOf == nil || !env.frontOf(f.Bridge, f.AccountID)) {
			return r, badRequest("publish: front %d: %s is not a front bridge of account %d", i, f.Bridge, f.AccountID)
		}
		fronts[f.AccountID] = append(fronts[f.AccountID], f.Bridge)
	}
	prefixes := map[string][]netip.Prefix{}
	prefixOf := func(bridge string) []netip.Prefix {
		if p, ok := prefixes[bridge]; ok {
			return p
		}
		var p []netip.Prefix
		if env.net != nil {
			p, _ = env.net.BridgePrefixes(bridge)
		}
		prefixes[bridge] = p
		return p
	}
	gw := map[int]bool{}
	if env.gatewayPorts != nil {
		gw = env.gatewayPorts()
	}
	type key struct {
		dst   netip.Addr
		proto string
		port  int
	}
	seen := map[key]bool{}
	seenID := map[int64]bool{}
	for i, x := range s.Rules {
		if x.ID <= 0 || seenID[x.ID] {
			return r, badRequest("publish: rule %d: invalid or duplicate id %d", i, x.ID)
		}
		seenID[x.ID] = true
		if x.AccountID <= 0 {
			return r, badRequest("publish: rule %d: invalid account id", i)
		}
		if x.Protocol != "tcp" && x.Protocol != "udp" {
			return r, badRequest("publish: rule %d: invalid protocol %q", i, x.Protocol)
		}
		if x.Port < 1 || x.Port > 65535 || x.ToPort < 1 || x.ToPort > 65535 {
			return r, badRequest("publish: rule %d: invalid port", i)
		}
		v := pubRule{ID: x.ID, AccountID: x.AccountID, Proto: x.Protocol, Port: x.Port, ToPort: x.ToPort}
		if x.Dst != pubDstShared {
			d, err := parsePubAddr(x.Dst)
			if err != nil {
				return r, badRequest("publish: rule %d: dst: %v", i, err)
			}
			if !dedicated[d] {
				return r, badRequest("publish: rule %d: %s is not a declared dedicated address", i, d)
			}
			v.Dst = d
		}
		if v.Dst.IsValid() && refused[v.Dst] {
			r.Skipped = append(r.Skipped, PublishSkipped{ID: x.ID, Reason: "addressRefused"})
			continue
		}
		to, err := parsePubAddr(x.ToAddr)
		if err != nil {
			return r, badRequest("publish: rule %d: toAddr: %v", i, err)
		}
		v.To = to
		k := key{v.Dst, v.Proto, v.Port}
		if seen[k] {
			return r, badRequest("publish: rule %d: %s/%d on %s listed twice", i, v.Proto, v.Port, x.Dst)
		}
		seen[k] = true
		// R2: inside a front subnet of the same account, never its gateway.
		inFront := false
		for _, b := range fronts[x.AccountID] {
			for _, p := range prefixOf(b) {
				if p.Masked().Contains(to) && p.Addr() != to {
					inFront = true
				}
			}
		}
		if !inFront {
			r.Skipped = append(r.Skipped, PublishSkipped{ID: x.ID, Reason: "targetOutsideFront"})
			continue
		}
		listeners := env.listeners
		if env.applied[v] {
			listeners = nil // in force already: a socket opened since never unpublishes it
		}
		if reason := hostConflict(v, listeners, gw, dedicated); reason != "" {
			r.Skipped = append(r.Skipped, PublishSkipped{ID: x.ID, Reason: reason})
			continue
		}
		r.Rules = append(r.Rules, v)
	}
	for i, sn := range s.Snat {
		if sn.AccountID <= 0 || !pubIfaceRe.MatchString(sn.Iface) || len(sn.Sources) == 0 || len(sn.Sources) > maxPubSources {
			return r, badRequest("publish: snat %d: invalid entry", i)
		}
		to, err := parsePubAddr(sn.To)
		if err != nil || !dedicated[to] {
			return r, badRequest("publish: snat %d: %q is not a declared dedicated address", i, sn.To)
		}
		if refused[to] || pubInternalIfaceRe.MatchString(sn.Iface) {
			slog.Warn("publish: SNAT left out (refused address or internal interface)", "accountId", sn.AccountID, "to", to, "iface", sn.Iface)
			continue
		}
		v := pubSnat{AccountID: sn.AccountID, Iface: sn.Iface, To: to}
		for _, src := range sn.Sources {
			p, err := netip.ParsePrefix(strings.TrimSpace(src))
			if err != nil || !p.Addr().Is4() || p.Bits() < 8 {
				return r, badRequest("publish: snat %d: invalid source %q", i, src)
			}
			v.Sources = append(v.Sources, p.Masked())
		}
		sort.Slice(v.Sources, func(a, b int) bool { return v.Sources[a].String() < v.Sources[b].String() })
		r.Snat = append(r.Snat, v)
	}
	sort.Slice(r.Addresses, func(i, j int) bool { return r.Addresses[i].Addr.Less(r.Addresses[j].Addr) })
	sort.Slice(r.Dedicated, func(i, j int) bool { return r.Dedicated[i].Less(r.Dedicated[j]) })
	sort.Slice(r.Rules, func(i, j int) bool {
		a, b := r.Rules[i], r.Rules[j]
		if c := a.Dst.Compare(b.Dst); c != 0 {
			return c < 0
		}
		if a.Proto != b.Proto {
			return a.Proto < b.Proto
		}
		return a.Port < b.Port
	})
	sort.Slice(r.Snat, func(i, j int) bool { return r.Snat[i].AccountID < r.Snat[j].AccountID })
	sort.Slice(r.Skipped, func(i, j int) bool { return r.Skipped[i].ID < r.Skipped[j].ID })
	sort.Slice(r.Refused, func(i, j int) bool { return r.Refused[i].Address < r.Refused[j].Address })
	return r, nil
}

func inPrefixes(list []netip.Prefix, ip netip.Addr) bool {
	for _, p := range list {
		if p.Contains(ip) {
			return true
		}
	}
	return false
}

// addressRefusal: why hostd will not manage / publish on this address ("" = acceptable).
func addressRefusal(ip netip.Addr, a PublishAddress, internal []netip.Prefix, byIface map[string][]netip.Prefix) string {
	if a.Iface != "" && pubInternalIfaceRe.MatchString(a.Iface) {
		return "internalInterface"
	}
	if inPrefixes(internal, ip) {
		return "internalAddress"
	}
	if !a.Managed || a.Prefix == 32 {
		return ""
	}
	// A managed address wider than /32 adds a connected route: only inside a subnet the interface already has.
	want := netip.PrefixFrom(ip, a.Prefix).Masked()
	for _, p := range internal {
		if p.Overlaps(want) {
			return "internalAddress"
		}
	}
	for _, p := range byIface[a.Iface] {
		if p.Bits() == a.Prefix && p.Masked() == want {
			return ""
		}
	}
	return "prefixNotConnected"
}

// hostConflict: a rule that would hijack a socket of the node ("" = none). 80 / 443 of a dedicated address
// are the edge's (docker-proxy): the takeover is decided by the panel.
func hostConflict(v pubRule, listeners []HostListener, gw map[int]bool, dedicated map[netip.Addr]bool) string {
	if gw[v.Port] && v.Proto == "tcp" {
		return "portInUseOnHost"
	}
	if v.Dst.IsValid() && (v.Port == 80 || v.Port == 443) {
		return ""
	}
	for _, l := range listeners {
		if l.Protocol != v.Proto || l.Port != v.Port {
			continue
		}
		if listenerWildcard(l) {
			return "portInUseOnHost"
		}
		la, err := netip.ParseAddr(l.Address)
		if err != nil || la.IsLoopback() {
			continue // 127.0.0.1 / ::1: not reachable from outside, DNAT does not hit it
		}
		if v.Dst.IsValid() {
			if la == v.Dst {
				return "portInUseOnHost"
			}
		} else if la.Is4() && !dedicated[la] {
			return "portInUseOnHost"
		}
	}
	return ""
}

// renderPublish renders both tables, preceded by the lines that make `nft -f` replace them atomically
// (nothing to publish: delete only).
func renderPublish(r pubRules, carry segCounterValue) string {
	var w nftWriter
	w.line(0, "# Generated by oblimint-hostd: do not edit (replaced on every apply).")
	w.line(0, "table ip %s", pubTable)
	w.line(0, "delete table ip %s", pubTable)
	w.line(0, "table ip %s", pubSnatTable)
	w.line(0, "delete table ip %s", pubSnatTable)
	if r.empty() {
		return w.b.String()
	}
	mark := fmt.Sprintf("0x%08x", r.Mark)
	elems := func(indent int, list []string) {
		if len(list) == 0 {
			return
		}
		w.line(indent, "elements = {")
		for i, e := range list {
			sep := ","
			if i == len(list)-1 {
				sep = ""
			}
			w.line(indent+1, "%s%s", e, sep)
		}
		w.line(indent, "}")
	}
	if len(r.Rules) > 0 {
		w.line(0, "table ip %s {", pubTable)
		writeSegCounter(&w, pubCounter, carry)
		w.line(1, "set dedicated4 {")
		w.line(2, "type ipv4_addr")
		var ded []string
		for _, d := range r.Dedicated {
			ded = append(ded, d.String())
		}
		if len(ded) > 0 {
			w.line(2, "elements = { %s }", strings.Join(ded, ", "))
		}
		w.line(1, "}")
		for _, proto := range []string{"tcp", "udp"} {
			var ports, portsTo, dports, dportsTo []string
			for _, x := range r.Rules {
				if x.Proto != proto {
					continue
				}
				if x.Dst.IsValid() {
					dports = append(dports, fmt.Sprintf("%s . %d", x.Dst, x.Port))
					dportsTo = append(dportsTo, fmt.Sprintf("%s . %d : %s . %d", x.Dst, x.Port, x.To, x.ToPort))
				} else {
					ports = append(ports, strconv.Itoa(x.Port))
					portsTo = append(portsTo, fmt.Sprintf("%d : %s . %d", x.Port, x.To, x.ToPort))
				}
			}
			w.line(1, "set shared_%s {", proto)
			w.line(2, "type inet_service")
			elems(2, ports)
			w.line(1, "}")
			w.line(1, "map shared_%s_to {", proto)
			w.line(2, "type inet_service : ipv4_addr . inet_service")
			elems(2, portsTo)
			w.line(1, "}")
			w.line(1, "set ded_%s {", proto)
			w.line(2, "type ipv4_addr . inet_service")
			elems(2, dports)
			w.line(1, "}")
			w.line(1, "map ded_%s_to {", proto)
			w.line(2, "type ipv4_addr . inet_service : ipv4_addr . inet_service")
			elems(2, dportsTo)
			w.line(1, "}")
		}
		w.line(1, "chain prerouting {")
		w.line(2, "type nat hook prerouting priority %d; policy accept;", pubPriority)
		w.line(2, "fib daddr type != local return")
		ifs := []string{`"lo"`, `"docker0"`}
		for _, b := range r.Bridges {
			if b != "lo" && b != "docker0" {
				ifs = append(ifs, strconv.Quote(b))
			}
		}
		w.line(2, "iifname { %s } return", strings.Join(ifs, ", "))
		w.line(2, `iifname "omf*" return`)
		w.line(2, `iifname "omb*" return`)
		w.line(2, `iifname "omp-*" return`)
		w.line(2, `iifname "br-*" return`)
		w.line(2, "ip daddr @dedicated4 goto dedicated")
		for _, proto := range []string{"tcp", "udp"} {
			w.line(2, "%s dport @shared_%s ct mark set ct mark or %s counter name %q dnat ip to %s dport map @shared_%s_to", proto, proto, mark, pubCounter, proto, proto)
		}
		w.line(1, "}")
		w.line(1, "chain dedicated {")
		for _, proto := range []string{"tcp", "udp"} {
			w.line(2, "ip daddr . %s dport @ded_%s ct mark set ct mark or %s counter name %q dnat ip to ip daddr . %s dport map @ded_%s_to", proto, proto, mark, pubCounter, proto, proto)
		}
		w.line(1, "}")
		w.line(1, "chain markcopy {")
		w.line(2, "type filter hook forward priority %d; policy accept;", pubMarkcopyPrio)
		w.line(2, "ct mark and %s == %s meta mark set meta mark or %s", mark, mark, mark)
		w.line(1, "}")
		w.line(0, "}")
	}
	if len(r.Snat) > 0 {
		w.line(0, "table ip %s {", pubSnatTable)
		for _, sn := range r.Snat {
			w.line(1, "set src_%d {", sn.AccountID)
			w.line(2, "type ipv4_addr")
			w.line(2, "flags interval")
			var src []string
			for _, p := range sn.Sources {
				src = append(src, p.String())
			}
			w.line(2, "elements = { %s }", strings.Join(src, ", "))
			w.line(1, "}")
		}
		w.line(1, "chain postrouting {")
		w.line(2, "type nat hook postrouting priority %d; policy accept;", pubSnatPriority)
		for _, sn := range r.Snat {
			w.line(2, "ct direction original ip saddr @src_%d oifname %q snat ip to %s", sn.AccountID, sn.Iface, sn.To)
		}
		w.line(1, "}")
		w.line(0, "}")
	}
	return w.b.String()
}

// pubPersisted is the content of hostd-publish.json.
type pubPersisted struct {
	State PublishState `json:"state"`
	// Added: addresses hostd itself put on an interface (the only ones it ever removes).
	Added []PublishAddress `json:"added"`
}

type publishManager struct {
	mu        sync.Mutex
	nft       nftRunner
	net       netOps
	accept    *dockerAccept
	statePath string
	mark      uint32
	now       func() time.Time
	counter   segCounterReader
	frontOf   func(bridge string, accountID int64) bool
	gwPorts   func() map[int]bool
	bridges   func() []string

	raw            *PublishState
	applied        *pubRules
	added          map[netip.Addr]PublishAddress
	addrStates     []PublishAddressState
	acceptRes      acceptResult
	lastApplyAt    time.Time
	lastApplyError string
}

func newPublishManager(nft nftRunner, n netOps, accept *dockerAccept, statePath string) *publishManager {
	m := &publishManager{nft: nft, net: n, accept: accept, statePath: statePath, mark: publishMark(), now: time.Now,
		added: map[netip.Addr]PublishAddress{}}
	if e, ok := nft.(*execNft); ok && e.path != "" {
		m.counter = execSegCounter(e.path, "ip", pubTable, pubCounter)
	}
	return m
}

func newRealDockerAccept() *dockerAccept {
	return &dockerAccept{run: execRunner, lookPath: exec.LookPath}
}

func (m *publishManager) env() pubEnv {
	env := pubEnv{net: m.net, frontOf: m.frontOf, gatewayPorts: m.gwPorts, bridges: m.bridges}
	if m.applied != nil {
		env.applied = map[pubRule]bool{}
		for _, x := range m.applied.Rules {
			env.applied[x] = true
		}
	}
	if m.net != nil {
		if l, err := m.net.Listeners(); err == nil {
			env.listeners = l
		} else {
			slog.Debug("publish: host listeners unreadable", "err", err)
		}
	}
	return env
}

// Apply validates and applies the whole publication state.
func (m *publishManager) Apply(ctx context.Context, s PublishState) (PublishReply, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	r, err := s.validate(m.mark, m.env())
	if err != nil {
		return PublishReply{}, err
	}
	if err := m.applyLocked(ctx, r); err != nil {
		return PublishReply{}, err
	}
	raw := s
	m.raw = &raw
	m.persistLocked()
	return PublishReply{OK: true, Addresses: m.addrStates, Skipped: nonNilSkipped(r.Skipped)}, nil
}

func nonNilSkipped(s []PublishSkipped) []PublishSkipped {
	if s == nil {
		return []PublishSkipped{}
	}
	return s
}

// ensureAddressesLocked puts the wanted managed addresses on their interface and reports every address.
func (m *publishManager) ensureAddressesLocked(ctx context.Context, r pubRules) []PublishAddressState {
	out := make([]PublishAddressState, 0, len(r.Addresses))
	for _, a := range r.Addresses {
		st := PublishAddressState{Address: a.Addr.String()}
		if m.net == nil {
			st.State, st.Message = "error", "network operations unavailable"
			out = append(out, st)
			continue
		}
		on, err := m.net.AddrIface(a.Addr)
		switch {
		case err != nil:
			st.State, st.Message = "error", err.Error()
		case on != "" && (a.Iface == "" || on == a.Iface):
			st.State = "present"
			if _, ours := m.added[a.Addr]; ours && a.Managed {
				st.State = "added"
			}
		case on != "":
			st.State, st.Message = "otherInterface", fmt.Sprintf("the address is on %s, not on %s", on, a.Iface)
		case !a.Managed:
			st.State = "missing"
		default:
			if err := m.net.AddAddr(ctx, a.Iface, a.Addr, a.Prefix); err != nil {
				st.State, st.Message = "error", err.Error()
				slog.Warn("publish: dedicated address not added", "address", a.Addr, "iface", a.Iface, "err", err)
			} else {
				m.added[a.Addr] = PublishAddress{Address: a.Addr.String(), Prefix: a.Prefix, Iface: a.Iface, Managed: true}
				m.net.Announce(ctx, a.Iface, a.Addr)
				st.State = "added"
				slog.Info("publish: dedicated address added", "address", a.Addr, "iface", a.Iface)
			}
		}
		out = append(out, st)
	}
	out = append(out, r.Refused...)
	return out
}

// removeStaleLocked removes the addresses hostd added that the state no longer wants (managed).
func (m *publishManager) removeStaleLocked(ctx context.Context, r pubRules) {
	want := map[netip.Addr]bool{}
	for _, a := range r.Addresses {
		if a.Managed {
			want[a.Addr] = true
		}
	}
	for ip, a := range m.added {
		if want[ip] {
			continue
		}
		if m.net != nil {
			if on, err := m.net.AddrIface(ip); err == nil && on == a.Iface {
				if err := m.net.DelAddr(ctx, a.Iface, ip, a.Prefix); err != nil {
					slog.Warn("publish: dedicated address not removed", "address", ip, "iface", a.Iface, "err", err)
					continue
				}
				slog.Info("publish: dedicated address removed", "address", ip, "iface", a.Iface)
			}
		}
		delete(m.added, ip)
	}
}

// presentLocked: is the dedicated address on the node now? (SNAT to an absent address is left out.)
func (m *publishManager) presentLocked(states []PublishAddressState, ip netip.Addr) bool {
	for _, s := range states {
		if s.Address == ip.String() {
			return s.State == "present" || s.State == "added"
		}
	}
	if m.net == nil {
		return false
	}
	on, err := m.net.AddrIface(ip)
	return err == nil && on != ""
}

func (m *publishManager) applyLocked(ctx context.Context, r pubRules) error {
	if m.nft == nil {
		m.lastApplyError = "nftables is not available"
		return fmt.Errorf("publish: %w (nftables is not available)", errUnsupported)
	}
	// 1. addresses (managed ones added before the rules that use them).
	m.addrStates = m.ensureAddressesLocked(ctx, r)
	snat := r.Snat[:0:0]
	for _, sn := range r.Snat {
		if m.presentLocked(m.addrStates, sn.To) {
			snat = append(snat, sn)
		} else {
			slog.Warn("publish: SNAT left out (the dedicated address is not on the node)", "accountId", sn.AccountID, "to", sn.To)
		}
	}
	r.Snat = snat
	// 2. tables.
	var carry segCounterValue
	if m.counter != nil {
		cctx, cancel := context.WithTimeout(ctx, 5*time.Second)
		if out, err := m.counter(cctx); err == nil {
			if v, ok := parseSegCounterValue(out); ok {
				carry = v
			}
		}
		cancel()
	}
	if err := m.nft.Apply(ctx, renderPublish(r, carry)); err != nil {
		m.lastApplyError = err.Error()
		slog.Error("publish apply failed (the previous tables stay in force)", "err", err)
		if errors.Is(err, errUnsupported) {
			return err
		}
		return &apiError{http.StatusBadGateway, codeApplyFailed, err.Error()}
	}
	applied := r
	m.applied = &applied
	m.lastApplyAt = m.now()
	m.lastApplyError = ""
	// 3. Docker accepts the marked connections (or our rule goes when nothing is published).
	if m.accept != nil {
		m.acceptRes = m.accept.Ensure(ctx, m.mark, len(r.Rules) > 0)
		if m.acceptRes.Err != nil {
			slog.Warn("publish: Docker accept rule", "err", m.acceptRes.Err)
		}
	}
	// 4. managed addresses no longer wanted.
	m.removeStaleLocked(ctx, r)
	return nil
}

// Recheck re-runs the address / Docker checks of the applied state (60 s loop, Docker restarted…).
func (m *publishManager) Recheck(ctx context.Context) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.applied == nil {
		return
	}
	// A bridge created after the last apply (boot: Docker restores its networks after hostd started) or a
	// socket closed since: the raw state validates to other rules now, re-applied as a whole.
	if m.raw != nil {
		r, err := m.raw.validate(m.mark, m.env())
		snatNow := 0
		if err == nil && m.net != nil {
			for _, sn := range r.Snat {
				if on, e := m.net.AddrIface(sn.To); e == nil && on != "" {
					snatNow++
				}
			}
		}
		if err == nil && (!sameRules(r, *m.applied) || snatNow != len(m.applied.Snat)) {
			if err := m.applyLocked(ctx, r); err != nil {
				slog.Warn("publish: re-apply after a host change failed", "err", err)
			} else {
				m.persistLocked()
			}
			return
		}
	}
	before := len(m.added)
	m.addrStates = m.ensureAddressesLocked(ctx, *m.applied)
	if m.accept != nil {
		m.acceptRes = m.accept.Ensure(ctx, m.mark, len(m.applied.Rules) > 0)
	}
	if len(m.added) != before {
		m.persistLocked()
	}
}

// sameRules: same rendered rules and skipped list (SNAT compared by count: its presence depends on the addresses).
func sameRules(a, b pubRules) bool {
	if len(a.Rules) != len(b.Rules) || len(a.Skipped) != len(b.Skipped) || len(a.Refused) != len(b.Refused) || strings.Join(a.Bridges, ",") != strings.Join(b.Bridges, ",") {
		return false
	}
	for i := range a.Rules {
		if a.Rules[i] != b.Rules[i] {
			return false
		}
	}
	for i := range a.Skipped {
		if a.Skipped[i] != b.Skipped[i] {
			return false
		}
	}
	return true
}

// Run is the periodic re-check loop (returns when ctx is done).
func (m *publishManager) Run(ctx context.Context) {
	t := time.NewTicker(pubRecheckEvery)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			m.Recheck(ctx)
		}
	}
}

func (m *publishManager) Status() PublishStatus {
	m.mu.Lock()
	defer m.mu.Unlock()
	st := PublishStatus{Backend: m.acceptRes.Backend, DockerAccept: m.acceptRes.State, Mark: m.mark,
		Addresses: m.addrStates, Skipped: []PublishSkipped{}}
	if st.Backend == "" {
		st.Backend = backendNone
	}
	if st.DockerAccept == "" {
		st.DockerAccept = acceptMissing
	}
	if st.Addresses == nil {
		st.Addresses = []PublishAddressState{}
	}
	if m.acceptRes.Remediation != "" {
		rem := m.acceptRes.Remediation
		st.Remediation = &rem
	}
	if m.applied != nil {
		st.Rules = len(m.applied.Rules)
		st.Snat = len(m.applied.Snat)
		st.Skipped = nonNilSkipped(m.applied.Skipped)
		if m.counter != nil && len(m.applied.Rules) > 0 {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			if out, err := m.counter(ctx); err == nil {
				if n, ok := parseSegCounter(out); ok {
					st.Published = &n
				}
			}
			cancel()
		}
	}
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

func (m *publishManager) persistLocked() {
	if m.statePath == "" || m.raw == nil {
		return
	}
	p := pubPersisted{State: *m.raw, Added: []PublishAddress{}}
	for _, a := range m.added {
		p.Added = append(p.Added, a)
	}
	sort.Slice(p.Added, func(i, j int) bool { return p.Added[i].Address < p.Added[j].Address })
	if err := writeFileAtomic(m.statePath, p); err != nil {
		slog.Warn("publish state not persisted", "path", m.statePath, "err", err)
	}
}

// Restore re-applies the persisted state at start: the managed addresses, then the tables, then the
// Docker rule (one applyLocked). A missing file is not an error.
func (m *publishManager) Restore(ctx context.Context) error {
	if m.statePath == "" {
		return nil
	}
	b, err := os.ReadFile(m.statePath)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	var p pubPersisted
	if err := json.Unmarshal(b, &p); err != nil {
		return fmt.Errorf("%s: %w", m.statePath, err)
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, a := range p.Added {
		if ip, err := parsePubAddr(a.Address); err == nil {
			m.added[ip] = a
		}
	}
	r, err := p.State.validate(m.mark, m.env())
	if err != nil {
		return fmt.Errorf("%s: %w", m.statePath, err)
	}
	if err := m.applyLocked(ctx, r); err != nil {
		return err
	}
	m.raw = &p.State
	return nil
}
