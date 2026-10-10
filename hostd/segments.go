package main

import (
	"bytes"
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
// Segment policy of the account fabrics (docs/P4b-PLAN.md §4.4, SG1–SG6).
// OWNED BY MODULE `segmentation`.
//
// The panel pushes the WHOLE policy (PUT /v1/segments): the bridges of the
// account fabrics (omf<id> / omb<id>, legacy br-<12 hex>) and the allowed
// (bridge, src, dst, proto, dport) tuples between containers. hostd validates
// it again (R2) and renders ONE table, `bridge oblimint_seg`, replaced
// atomically with `nft -f` (delete + recreate in a single transaction): a
// refused ruleset changes nothing in the kernel, the last applied policy stays
// in force (and in the state file).
//
//   chain forward (bridge family, hook forward, priority -200, policy accept)
//     meta ibrname != @fabrics accept     frames of other bridges: untouched
//     ether type arp accept               neighbour resolution
//     allowed tuple (ip . ip . proto . dport @allow4)            accept
//     stateless reply (swapped, sport = port @reply4; TCP: never a bare SYN)
//     ICMP destination-unreachable / time-exceeded (PMTU, errors) accept
//     everything else (IPv4, IPv6, other ethertypes) between two ports:
//       enforce → counter drop; monitor → counter + rate-limited log, accept
//   mode off → the table is deleted.
//   The named counters (`dropped`, `host_dropped`) are read just before each
//   replacement and re-declared with their values (segCarry): cumulative
//   across pushes and hostd restarts, reset only by mode off.
//
// The bridge family's forward hook only sees frames bridged between two
// PORTS of a bridge: frames to / from the bridge itself (the gateway: the
// Internet, the host, published ports) go through input / output and are
// never touched here — egress filtering stays the `inet oblimint` table (P2).
// Per-IP rules hold because no tenant container has NET_RAW / NET_ADMIN
// (sites CapDrop ALL, apps: an allow-list that excludes them, SG3).
//
// The renderer is a pure function of the validated state (renderSegments,
// golden tests). State persisted in <root>/run/hostd-segments.json (0600,
// atomic write), re-applied by Restore at start.
//
// PLATFORM bridges (fabric "platform", accountId 0: the panel network
// 'oblimint', 'oblimint-mail', 'oblimint-mail-core', 'oblimint-auth'; Docker
// names their bridge br-<12 hex>). The edge, phpMyAdmin / Adminer… sit on
// them next to PostgreSQL, PowerDNS, the mail engine and the panel's internal
// listener. Two extra controls:
//
//   isolation "all" (default)   same default deny as an account fabric.
//   isolation "listed"          frames between two NON-restricted containers
//                               pass (trusted platform components); a frame
//                               from or to a RESTRICTED address (Restricted:
//                               the internet-facing containers) passes only as
//                               an allowed tuple or its reply. IPv6 / other
//                               ethertypes between ports: default verdict.
//
//   host access: table inet oblimint_seghost (same nft -f transaction). A NEW
//   connection entering the host from a platform bridge to ANY local address
//   (bridge gateway, LAN / public address, Docker-published ports: prerouting
//   priority -150, before Docker's DNAT) is dropped (enforce) or logged
//   (monitor) unless (bridge, proto, port) or (src, proto, port) is in Host.
//   The same filter applies to a RESTRICTED address entering from any
//   interface (the edge also sits on every account FRONT fabric, whose
//   gateway would otherwise lead to the node's ports when the P2 egress
//   filter is off). ICMP and established / related traffic pass. The other
//   containers of the account fabrics keep the P2 egress filter (inet oblimint).
// ─────────────────────────────────────────────────────────────────────────────

const (
	segTable      = "oblimint_seg"
	segCounter    = "dropped"
	maxSegBridges = 4096
	maxSegFlows   = 100000
	// maxSegBodyBytes bounds PUT /v1/segments: the generic 1 MiB limit
	// (maxBodyBytes) holds only ~10 000 flows (a flow of the worst size —
	// 15-char bridge, two dotted-quad /32 addresses, a 5-digit port — is
	// about 100 bytes of JSON), i.e. 100–200 accounts. maxSegFlows of them
	// plus maxSegBridges bridges need about 10.3 MB.
	maxSegBodyBytes = 16 << 20
	segLogPrefix    = "oblimint-seg "
	segModeEnforce  = "enforce"
	segModeMonitor  = "monitor"
	segModeOff      = "off"
	segHostTable    = "oblimint_seghost"
	segHostCounter  = "host_dropped"
	segHostLog      = "oblimint-seghost "
	maxSegRestrict  = 4096
	maxSegHost      = 4096
	segFabricFront  = "front"
	segFabricBack   = "back"
	segFabricPlat   = "platform"
	segIsolateAll   = "all"
	segIsolateList  = "listed"
	// segHostPriority: after conntrack (-200), before Docker's DNAT (-100),
	// like the P2 egress-to-host chain (nftPreroutingPriority).
	segHostPriority = -150
)

var segBridgeNameRe = regexp.MustCompile(`^[a-zA-Z0-9_.-]{1,15}$`)

// SegmentBridge mirrors HostdSegmentState.bridges[] (server/src/services/hostd/client.ts).
type SegmentBridge struct {
	Name      string `json:"name"`
	AccountID int64  `json:"accountId"`
	// Fabric: "front" / "back" (account fabric, accountId > 0) or "platform"
	// (platform network, accountId 0).
	Fabric string `json:"fabric"`
	// Isolation: "all" (default, the only value of an account fabric) or
	// "listed" (platform bridges only, see the header).
	Isolation string `json:"isolation,omitempty"`
}

// SegmentHostAccess is one port of the node itself reachable from a platform
// bridge (every container of it, or only Src when set).
type SegmentHostAccess struct {
	Bridge   string `json:"bridge"`
	Src      string `json:"src,omitempty"`
	Protocol string `json:"protocol"`
	Port     int    `json:"port"`
}

// SegmentFlow mirrors HostdSegmentState.allow[].
type SegmentFlow struct {
	Bridge   string `json:"bridge"`
	Src      string `json:"src"`
	Dst      string `json:"dst"`
	Protocol string `json:"protocol"`
	Port     int    `json:"port"`
}

// SegmentState is the body of PUT /v1/segments.
type SegmentState struct {
	Mode    string          `json:"mode"`
	Bridges []SegmentBridge `json:"bridges"`
	Allow   []SegmentFlow   `json:"allow"`
	// Restricted: IPv4 addresses of the internet-facing containers. A
	// "listed" platform bridge filters their frames (both directions; no
	// effect on "all" bridges), and their new connections to the node itself
	// are filtered from every interface (host access).
	Restricted []string `json:"restricted,omitempty"`
	// Host: node ports reachable from the platform bridges (nothing else).
	Host []SegmentHostAccess `json:"host,omitempty"`
}

// SegmentStatus is the body of GET /v1/segments (HostdSegmentStatus).
type SegmentStatus struct {
	Backend         string  `json:"backend"`
	Mode            string  `json:"mode"`
	Bridges         int     `json:"bridges"`
	Rules           int     `json:"rules"`
	Dropped         *int64  `json:"dropped"`
	PlatformBridges int     `json:"platformBridges"`
	HostDropped     *int64  `json:"hostDropped"`
	LastApplyAt     *string `json:"lastApplyAt"`
	LastApplyError  *string `json:"lastApplyError"`
}

// segFlow is a validated, normalized flow.
type segFlow struct {
	Bridge string
	Src    netip.Addr
	Dst    netip.Addr
	Proto  string
	Port   int
}

// segHost is a validated host access entry (Src invalid = the whole bridge).
type segHost struct {
	Bridge string
	Src    netip.Addr
	Proto  string
	Port   int
}

// segRules is the validated form of a SegmentState (sorted, deduplicated).
type segRules struct {
	Mode    string
	Bridges []string
	// Platform: the platform bridges (host access filtered); Listed: those
	// with isolation "listed". Both sorted, subsets of Bridges.
	Platform   []string
	Listed     []string
	Restricted []netip.Addr
	Host       []segHost
	Flows      []segFlow
}

// decodeSegmentState reads the body of PUT /v1/segments with its own limit
// (maxSegBodyBytes, see above) instead of decode()'s 1 MiB. A body past the
// limit is refused as a whole (never truncated into a partial policy).
func decodeSegmentState(w http.ResponseWriter, r *http.Request) (SegmentState, error) {
	var s SegmentState
	r.Body = http.MaxBytesReader(w, r.Body, maxSegBodyBytes)
	if err := json.NewDecoder(r.Body).Decode(&s); err != nil {
		return SegmentState{}, badRequest("invalid JSON body: %v", err)
	}
	return s, nil
}

func (s SegmentState) validate() (segRules, error) {
	r := segRules{Mode: s.Mode}
	switch s.Mode {
	case segModeEnforce, segModeMonitor, segModeOff:
	default:
		return r, badRequest("segments: invalid mode %q (enforce, monitor or off)", s.Mode)
	}
	if len(s.Bridges) > maxSegBridges {
		return r, badRequest("segments: too many bridges (%d > %d)", len(s.Bridges), maxSegBridges)
	}
	if len(s.Allow) > maxSegFlows {
		return r, badRequest("segments: too many flows (%d > %d)", len(s.Allow), maxSegFlows)
	}
	bridges := make(map[string]bool, len(s.Bridges))
	for _, b := range s.Bridges {
		if !segBridgeNameRe.MatchString(b.Name) {
			return r, badRequest("segments: invalid bridge name %q", b.Name)
		}
		switch b.Fabric {
		case segFabricFront, segFabricBack:
			if b.AccountID <= 0 {
				return r, badRequest("segments: bridge %s: invalid account id %d", b.Name, b.AccountID)
			}
			if b.Isolation != "" && b.Isolation != segIsolateAll {
				return r, badRequest("segments: bridge %s: an account fabric is always fully isolated (isolation %q)", b.Name, b.Isolation)
			}
		case segFabricPlat:
			if b.AccountID != 0 {
				return r, badRequest("segments: bridge %s: a platform bridge has account id 0 (got %d)", b.Name, b.AccountID)
			}
			if b.Isolation != "" && b.Isolation != segIsolateAll && b.Isolation != segIsolateList {
				return r, badRequest("segments: bridge %s: invalid isolation %q (all or listed)", b.Name, b.Isolation)
			}
		default:
			return r, badRequest("segments: bridge %s: invalid fabric %q", b.Name, b.Fabric)
		}
		if _, dup := bridges[b.Name]; dup {
			return r, badRequest("segments: bridge %s listed twice", b.Name)
		}
		bridges[b.Name] = b.Fabric == segFabricPlat
		r.Bridges = append(r.Bridges, b.Name)
		if b.Fabric == segFabricPlat {
			r.Platform = append(r.Platform, b.Name)
			if b.Isolation == segIsolateList {
				r.Listed = append(r.Listed, b.Name)
			}
		}
	}
	if len(s.Restricted) > maxSegRestrict {
		return r, badRequest("segments: too many restricted addresses (%d > %d)", len(s.Restricted), maxSegRestrict)
	}
	if len(s.Host) > maxSegHost {
		return r, badRequest("segments: too many host access entries (%d > %d)", len(s.Host), maxSegHost)
	}
	seenR := make(map[netip.Addr]bool, len(s.Restricted))
	for i, a := range s.Restricted {
		ip, err := parseSegAddr(a)
		if err != nil {
			return r, badRequest("segments: restricted %d: %v", i, err)
		}
		if !seenR[ip] {
			seenR[ip] = true
			r.Restricted = append(r.Restricted, ip)
		}
	}
	seenH := make(map[segHost]bool, len(s.Host))
	for i, h := range s.Host {
		platform, listed := bridges[h.Bridge]
		if !listed {
			return r, badRequest("segments: host %d: bridge %q is not listed", i, h.Bridge)
		}
		// A bridge-wide entry only on a platform bridge; a per-source entry
		// anywhere (a restricted container's addresses on account fabrics).
		if !platform && h.Src == "" {
			return r, badRequest("segments: host %d: bridge %q is not a platform bridge (a src is required)", i, h.Bridge)
		}
		v := segHost{Bridge: h.Bridge, Proto: h.Protocol, Port: h.Port}
		if h.Src != "" {
			src, err := parseSegAddr(h.Src)
			if err != nil {
				return r, badRequest("segments: host %d: src: %v", i, err)
			}
			v.Src = src
		}
		if h.Protocol != "tcp" && h.Protocol != "udp" {
			return r, badRequest("segments: host %d: invalid protocol %q (tcp or udp)", i, h.Protocol)
		}
		if h.Port < 1 || h.Port > 65535 {
			return r, badRequest("segments: host %d: invalid port %d", i, h.Port)
		}
		if !seenH[v] {
			seenH[v] = true
			r.Host = append(r.Host, v)
		}
	}
	seen := make(map[segFlow]bool, len(s.Allow))
	for i, f := range s.Allow {
		if _, ok := bridges[f.Bridge]; !ok {
			return r, badRequest("segments: flow %d: bridge %q is not listed", i, f.Bridge)
		}
		src, err := parseSegAddr(f.Src)
		if err != nil {
			return r, badRequest("segments: flow %d: src: %v", i, err)
		}
		dst, err := parseSegAddr(f.Dst)
		if err != nil {
			return r, badRequest("segments: flow %d: dst: %v", i, err)
		}
		if src == dst {
			return r, badRequest("segments: flow %d: src and dst are the same address", i)
		}
		if f.Protocol != "tcp" && f.Protocol != "udp" {
			return r, badRequest("segments: flow %d: invalid protocol %q (tcp or udp)", i, f.Protocol)
		}
		if f.Port < 1 || f.Port > 65535 {
			return r, badRequest("segments: flow %d: invalid port %d", i, f.Port)
		}
		v := segFlow{Bridge: f.Bridge, Src: src, Dst: dst, Proto: f.Protocol, Port: f.Port}
		if !seen[v] {
			seen[v] = true
			r.Flows = append(r.Flows, v)
		}
	}
	sort.Strings(r.Bridges)
	sort.Strings(r.Platform)
	sort.Strings(r.Listed)
	sort.Slice(r.Restricted, func(i, j int) bool { return r.Restricted[i].Less(r.Restricted[j]) })
	sort.Slice(r.Host, func(i, j int) bool {
		x, y := r.Host[i], r.Host[j]
		if x.Bridge != y.Bridge {
			return x.Bridge < y.Bridge
		}
		if c := x.Src.Compare(y.Src); c != 0 {
			return c < 0
		}
		if x.Proto != y.Proto {
			return x.Proto < y.Proto
		}
		return x.Port < y.Port
	})
	sort.Slice(r.Flows, func(i, j int) bool { return segFlowLess(r.Flows[i], r.Flows[j]) })
	return r, nil
}

// parseSegAddr accepts a plain IPv4 address only (no IPv6, no IPv4-mapped
// IPv6, no zone, no prefix).
func parseSegAddr(s string) (netip.Addr, error) {
	a, err := netip.ParseAddr(s)
	if err != nil {
		return netip.Addr{}, fmt.Errorf("invalid address %q", s)
	}
	if !a.Is4() {
		return netip.Addr{}, fmt.Errorf("%q is not an IPv4 address", s)
	}
	return a, nil
}

func segFlowLess(a, b segFlow) bool {
	if a.Bridge != b.Bridge {
		return a.Bridge < b.Bridge
	}
	if c := a.Src.Compare(b.Src); c != 0 {
		return c < 0
	}
	if c := a.Dst.Compare(b.Dst); c != 0 {
		return c < 0
	}
	if a.Proto != b.Proto {
		return a.Proto < b.Proto
	}
	return a.Port < b.Port
}

// renderSegments renders the `bridge oblimint_seg` table, preceded by the
// lines that make `nft -f` replace it atomically (mode off: delete only).
func renderSegments(r segRules) string {
	return renderSegmentsCarry(r, segCarry{})
}

// segCounterValue is the content of a named nft counter.
type segCounterValue struct {
	Packets, Bytes int64
}

// segCarry holds the drop counters read from the kernel just before a push.
// Every push (5-min periodic pass, Docker events, setting changes…) deletes
// and recreates both tables in one nft -f transaction, which would reset the
// counters: the new tables declare them with these values, so `dropped` /
// `host_dropped` stay cumulative for as long as the policy stays on (only
// the frames counted between the read and the commit, a few milliseconds,
// are lost; mode off deletes the tables and the counters with them). Zero
// values render the plain declaration (golden files unchanged).
type segCarry struct {
	Drop, Host segCounterValue
}

// writeSegCounter declares a named counter, with its carried value if any.
func writeSegCounter(w *nftWriter, name string, v segCounterValue) {
	w.line(1, "counter %s {", name)
	if v.Packets > 0 || v.Bytes > 0 {
		w.line(2, "packets %d bytes %d", v.Packets, v.Bytes)
	}
	w.line(1, "}")
}

// renderSegmentsCarry is renderSegments with the counters of the replaced
// tables carried over (segCarry).
func renderSegmentsCarry(r segRules, carry segCarry) string {
	var w nftWriter
	w.line(0, "# Generated by oblimint-hostd: do not edit (replaced on every apply).")
	w.line(0, "table bridge %s", segTable)
	w.line(0, "delete table bridge %s", segTable)
	w.line(0, "table inet %s", segHostTable)
	w.line(0, "delete table inet %s", segHostTable)
	if r.Mode == segModeOff {
		return w.b.String()
	}
	w.line(0, "table bridge %s {", segTable)
	writeSegCounter(&w, segCounter, carry.Drop)

	w.line(1, "set fabrics {")
	w.line(2, "type ifname")
	if len(r.Bridges) > 0 {
		quoted := make([]string, len(r.Bridges))
		for i, b := range r.Bridges {
			quoted[i] = strconv.Quote(b)
		}
		w.line(2, "elements = { %s }", strings.Join(quoted, ", "))
	}
	w.line(1, "}")
	if len(r.Listed) > 0 {
		w.line(1, "set listed {")
		w.line(2, "type ifname")
		w.line(2, "elements = { %s }", quoteAll(r.Listed))
		w.line(1, "}")
		w.line(1, "set restricted4 {")
		w.line(2, "type ipv4_addr")
		if len(r.Restricted) > 0 {
			w.line(2, "elements = { %s }", joinAddrs(r.Restricted))
		}
		w.line(1, "}")
	}

	// One tuple per (src, dst, proto, port): the bridge is implied by the
	// addresses (Docker never gives two networks of a host overlapping subnets).
	type tuple struct {
		a, b  netip.Addr
		proto string
		port  int
	}
	var allow, reply []tuple
	seenA, seenR := map[tuple]bool{}, map[tuple]bool{}
	for _, f := range r.Flows {
		if t := (tuple{f.Src, f.Dst, f.Proto, f.Port}); !seenA[t] {
			seenA[t] = true
			allow = append(allow, t)
		}
		if t := (tuple{f.Dst, f.Src, f.Proto, f.Port}); !seenR[t] {
			seenR[t] = true
			reply = append(reply, t)
		}
	}
	less := func(list []tuple) func(i, j int) bool {
		return func(i, j int) bool {
			x, y := list[i], list[j]
			if c := x.a.Compare(y.a); c != 0 {
				return c < 0
			}
			if c := x.b.Compare(y.b); c != 0 {
				return c < 0
			}
			if x.proto != y.proto {
				return x.proto < y.proto
			}
			return x.port < y.port
		}
	}
	sort.Slice(allow, less(allow))
	sort.Slice(reply, less(reply))
	for _, set := range []struct {
		name  string
		elems []tuple
	}{{"allow4", allow}, {"reply4", reply}} {
		w.line(1, "set %s {", set.name)
		w.line(2, "type ipv4_addr . ipv4_addr . inet_proto . inet_service")
		if len(set.elems) > 0 {
			w.line(2, "elements = {")
			for i, t := range set.elems {
				sep := ","
				if i == len(set.elems)-1 {
					sep = ""
				}
				w.line(3, "%s . %s . %s . %d%s", t.a, t.b, t.proto, t.port, sep)
			}
			w.line(2, "}")
		}
		w.line(1, "}")
	}

	w.line(1, "chain forward {")
	w.line(2, "type filter hook forward priority -200; policy accept;")
	w.line(2, "meta ibrname != @fabrics accept")
	w.line(2, "ether type arp accept")
	w.line(2, "ether type ip ip saddr . ip daddr . meta l4proto . th dport @allow4 accept")
	w.line(2, "ether type ip meta l4proto udp ip saddr . ip daddr . meta l4proto . th sport @reply4 accept")
	w.line(2, "ether type ip meta l4proto tcp tcp flags & (syn | ack) != syn ip saddr . ip daddr . meta l4proto . th sport @reply4 accept")
	w.line(2, "ether type ip icmp type { destination-unreachable, time-exceeded } accept")
	if len(r.Listed) > 0 {
		// "listed" platform bridges: trusted <-> trusted IPv4 passes.
		w.line(2, "meta ibrname @listed ether type ip ip saddr != @restricted4 ip daddr != @restricted4 accept")
	}
	if r.Mode == segModeMonitor {
		// Count everything, log at most 10 frames / s (a flood never fills the journal), let it through.
		w.line(2, "counter name %q limit rate 10/second burst 20 packets log prefix %q accept", segCounter, segLogPrefix)
	} else {
		w.line(2, "counter name %q drop", segCounter)
	}
	w.line(1, "}")
	w.line(0, "}")
	renderSegHost(&w, r, carry.Host)
	return w.b.String()
}

func joinAddrs(list []netip.Addr) string {
	addrs := make([]string, len(list))
	for i, a := range list {
		addrs[i] = a.String()
	}
	return strings.Join(addrs, ", ")
}

func quoteAll(list []string) string {
	quoted := make([]string, len(list))
	for i, b := range list {
		quoted[i] = strconv.Quote(b)
	}
	return strings.Join(quoted, ", ")
}

// renderSegHost renders table inet oblimint_seghost: new connections from a
// platform bridge to the node itself (nothing when no platform bridge).
func renderSegHost(w *nftWriter, r segRules, hostCarry segCounterValue) {
	if len(r.Platform) == 0 && len(r.Restricted) == 0 {
		return
	}
	var byBridge, bySrc []string
	for _, h := range r.Host {
		if h.Src.IsValid() {
			bySrc = append(bySrc, fmt.Sprintf("%s . %s . %d", h.Src, h.Proto, h.Port))
		} else {
			byBridge = append(byBridge, fmt.Sprintf("%s . %s . %d", strconv.Quote(h.Bridge), h.Proto, h.Port))
		}
	}
	w.line(0, "table inet %s {", segHostTable)
	writeSegCounter(w, segHostCounter, hostCarry)
	w.line(1, "set platform {")
	w.line(2, "type ifname")
	if len(r.Platform) > 0 {
		w.line(2, "elements = { %s }", quoteAll(r.Platform))
	}
	w.line(1, "}")
	w.line(1, "set restricted4 {")
	w.line(2, "type ipv4_addr")
	if len(r.Restricted) > 0 {
		w.line(2, "elements = { %s }", joinAddrs(r.Restricted))
	}
	w.line(1, "}")
	for _, set := range []struct {
		name, typ string
		elems     []string
	}{{"host_bridge", "ifname . inet_proto . inet_service", byBridge}, {"host_src", "ipv4_addr . inet_proto . inet_service", bySrc}} {
		w.line(1, "set %s {", set.name)
		w.line(2, "type %s", set.typ)
		if len(set.elems) > 0 {
			w.line(2, "elements = { %s }", strings.Join(set.elems, ", "))
		}
		w.line(1, "}")
	}
	verdict := fmt.Sprintf("counter name %q drop", segHostCounter)
	if r.Mode == segModeMonitor {
		verdict = fmt.Sprintf("counter name %q limit rate 10/second burst 20 packets log prefix %q accept", segHostCounter, segHostLog)
	}
	w.line(1, "chain host {")
	w.line(2, "ct state established,related accept")
	w.line(2, "meta l4proto { icmp, ipv6-icmp } accept")
	w.line(2, "meta l4proto { tcp, udp } iifname . meta l4proto . th dport @host_bridge accept")
	w.line(2, "meta l4proto { tcp, udp } ip saddr . meta l4proto . th dport @host_src accept")
	w.line(2, "%s", verdict)
	w.line(1, "}")
	// Every local address (gateway, LAN, public): Docker-published ports are
	// DNAT-ed to a container before INPUT, hence prerouting before DNAT.
	w.line(1, "chain prerouting {")
	w.line(2, "type filter hook prerouting priority %d; policy accept;", segHostPriority)
	w.line(2, "iifname @platform fib daddr type local jump host")
	w.line(2, "ip saddr @restricted4 fib daddr type local jump host")
	w.line(1, "}")
	// Defence in depth: flows DNAT-ed TO a host address.
	w.line(1, "chain input {")
	w.line(2, "type filter hook input priority %d; policy accept;", nftPriority)
	w.line(2, "iifname @platform jump host")
	w.line(2, "ip saddr @restricted4 jump host")
	w.line(1, "}")
	w.line(0, "}")
}

// segCounterReader returns `nft list counter …` output (nil: no counters).
type segCounterReader func(ctx context.Context) (string, error)

var segPacketsRe = regexp.MustCompile(`packets\s+(\d+)`)

// parseSegCounter extracts the packet count of `nft list counter` output.
func parseSegCounter(out string) (int64, bool) {
	m := segPacketsRe.FindStringSubmatch(out)
	if m == nil {
		return 0, false
	}
	n, err := strconv.ParseInt(m[1], 10, 64)
	return n, err == nil
}

var segBytesRe = regexp.MustCompile(`bytes\s+(\d+)`)

// parseSegCounterValue extracts packets and bytes of `nft list counter` output.
func parseSegCounterValue(out string) (segCounterValue, bool) {
	p, ok := parseSegCounter(out)
	if !ok {
		return segCounterValue{}, false
	}
	v := segCounterValue{Packets: p}
	if m := segBytesRe.FindStringSubmatch(out); m != nil {
		if b, err := strconv.ParseInt(m[1], 10, 64); err == nil {
			v.Bytes = b
		}
	}
	return v, true
}

// execSegCounter reads the drop counter with the nft binary (real runner only).
func execSegCounter(nftPath, family, table, counter string) segCounterReader {
	return func(ctx context.Context) (string, error) {
		ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		cmd := exec.CommandContext(ctx, nftPath, "list", "counter", family, table, counter)
		var out bytes.Buffer
		cmd.Stdout = &out
		cmd.Stderr = &out
		if err := cmd.Run(); err != nil {
			return "", fmt.Errorf("nft list counter: %v: %s", err, strings.TrimSpace(out.String()))
		}
		return out.String(), nil
	}
}

type segmentManager struct {
	mu        sync.Mutex
	nft       nftRunner
	statePath string
	now       func() time.Time
	counter   segCounterReader
	// hostCounter: the host-access drop counter (nil: none).
	hostCounter segCounterReader

	// applied: the last state the kernel took (nil = nothing applied yet).
	applied        *segRules
	raw            *SegmentState
	lastApplyAt    time.Time
	lastApplyError string
}

func newSegmentManager(nft nftRunner, statePath string) *segmentManager {
	m := &segmentManager{nft: nft, statePath: statePath, now: time.Now}
	if e, ok := nft.(*execNft); ok && e.path != "" {
		m.counter = execSegCounter(e.path, "bridge", segTable, segCounter)
		m.hostCounter = execSegCounter(e.path, "inet", segHostTable, segHostCounter)
	}
	return m
}

// Apply validates and applies the whole policy. A refused ruleset (502
// applyFailed) or a missing nft (501) keeps the previous policy applied and
// persisted; the error stays visible in Status.
func (m *segmentManager) Apply(ctx context.Context, s SegmentState) error {
	r, err := s.validate()
	if err != nil {
		return err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := m.applyLocked(ctx, r); err != nil {
		return err
	}
	raw := s
	m.raw = &raw
	m.persistLocked()
	return nil
}

func (m *segmentManager) applyLocked(ctx context.Context, r segRules) error {
	if m.nft == nil {
		m.lastApplyError = "nftables is not available"
		return fmt.Errorf("segments: %w (nftables is not available)", errUnsupported)
	}
	if err := m.nft.Apply(ctx, renderSegmentsCarry(r, m.readCarryLocked(ctx))); err != nil {
		m.lastApplyError = err.Error()
		slog.Error("segment policy apply failed (the previous policy stays in force)", "err", err)
		if errors.Is(err, errUnsupported) {
			return err
		}
		return &apiError{http.StatusBadGateway, codeApplyFailed, err.Error()}
	}
	applied := r
	m.applied = &applied
	m.lastApplyAt = m.now()
	m.lastApplyError = ""
	return nil
}

// readCarryLocked reads the drop counters of the tables about to be replaced
// (zero when unreadable: no table yet, previous mode off, fake runner).
func (m *segmentManager) readCarryLocked(ctx context.Context) segCarry {
	var c segCarry
	read := func(rd segCounterReader, dst *segCounterValue) {
		if rd == nil {
			return
		}
		cctx, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		out, err := rd(cctx)
		if err != nil {
			slog.Debug("segment counter not carried over", "err", err)
			return
		}
		if v, ok := parseSegCounterValue(out); ok {
			*dst = v
		}
	}
	read(m.counter, &c.Drop)
	read(m.hostCounter, &c.Host)
	return c
}

// Status reports the applied policy (and the drop counter when readable).
func (m *segmentManager) Status() SegmentStatus {
	m.mu.Lock()
	defer m.mu.Unlock()
	st := SegmentStatus{Backend: "none", Mode: segModeOff}
	if m.nft != nil && m.nft.Available() {
		st.Backend = "nftables"
	}
	if m.applied != nil {
		st.Mode = m.applied.Mode
		if m.applied.Mode != segModeOff {
			st.Bridges = len(m.applied.Bridges)
			st.Rules = len(m.applied.Flows)
			st.PlatformBridges = len(m.applied.Platform)
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
	if m.counter != nil && m.applied != nil && m.applied.Mode != segModeOff {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if out, err := m.counter(ctx); err == nil {
			if n, ok := parseSegCounter(out); ok {
				st.Dropped = &n
			}
		} else {
			slog.Debug("segment drop counter unreadable", "err", err)
		}
	}
	if m.hostCounter != nil && m.applied != nil && m.applied.Mode != segModeOff && len(m.applied.Platform) > 0 {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if out, err := m.hostCounter(ctx); err == nil {
			if n, ok := parseSegCounter(out); ok {
				st.HostDropped = &n
			}
		} else {
			slog.Debug("segment host drop counter unreadable", "err", err)
		}
	}
	return st
}

func (m *segmentManager) persistLocked() {
	if m.statePath == "" || m.raw == nil {
		return
	}
	if err := writeFileAtomic(m.statePath, m.raw); err != nil {
		slog.Warn("segment policy not persisted", "path", m.statePath, "err", err)
	}
}

// Restore re-applies the persisted policy at start (errors logged by the
// caller). A missing file is not an error (nothing pushed yet).
func (m *segmentManager) Restore(ctx context.Context) error {
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
	var s SegmentState
	if err := json.Unmarshal(b, &s); err != nil {
		return fmt.Errorf("%s: %w", m.statePath, err)
	}
	r, err := s.validate()
	if err != nil {
		return fmt.Errorf("%s: %w", m.statePath, err)
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := m.applyLocked(ctx, r); err != nil {
		return err
	}
	m.raw = &s
	return nil
}
