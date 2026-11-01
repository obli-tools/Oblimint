package main

import (
	"bufio"
	"context"
	"encoding/hex"
	"fmt"
	"net"
	"net/netip"
	"os"
	"sort"
	"strconv"
	"strings"
)

// ─────────────────────────────────────────────────────────────────────────────
// Host network facts for the publication of public ports (publish.go):
// interfaces and their addresses, the interface of the default route, the
// listening sockets of the node (/proc/net/{tcp,tcp6,udp,udp6}: hostd runs in
// the host network namespace), and the address operations on the managed
// dedicated IPs (`ip addr add|del`, gratuitous ARP). Everything goes through
// the netOps seam so the manager is tested without touching the kernel.
// ─────────────────────────────────────────────────────────────────────────────

// NetInterface is one entry of GET /v1/net/interfaces.
type NetInterface struct {
	Name         string   `json:"name"`
	Addresses    []string `json:"addresses"`
	Up           bool     `json:"up"`
	DefaultRoute bool     `json:"defaultRoute"`
}

// HostListener is one listening socket of the node (GET /v1/net/listeners).
type HostListener struct {
	Protocol string `json:"protocol"`
	Address  string `json:"address"`
	Port     int    `json:"port"`
}

// netOps: the kernel side of the publication (fake in the tests).
type netOps interface {
	Interfaces() ([]NetInterface, error)
	// AddrIface: the interface carrying addr ("" when none).
	AddrIface(addr netip.Addr) (string, error)
	AddAddr(ctx context.Context, iface string, addr netip.Addr, prefix int) error
	DelAddr(ctx context.Context, iface string, addr netip.Addr, prefix int) error
	// Announce sends a gratuitous ARP for addr on iface (best effort: neighbours drop a stale MAC).
	Announce(ctx context.Context, iface string, addr netip.Addr)
	DefaultRouteIface() (string, error)
	// BridgePrefixes: the IPv4 prefixes of a bridge interface (nil when it does not exist).
	BridgePrefixes(bridge string) ([]netip.Prefix, error)
	Listeners() ([]HostListener, error)
}

type realNetOps struct{ run runner }

func newRealNetOps() *realNetOps { return &realNetOps{run: execRunner} }

func (realNetOps) Interfaces() ([]NetInterface, error) {
	ifs, err := net.Interfaces()
	if err != nil {
		return nil, err
	}
	def, _ := realNetOps{}.DefaultRouteIface()
	out := make([]NetInterface, 0, len(ifs))
	for _, i := range ifs {
		e := NetInterface{Name: i.Name, Up: i.Flags&net.FlagUp != 0, DefaultRoute: i.Name == def, Addresses: []string{}}
		if addrs, err := i.Addrs(); err == nil {
			for _, a := range addrs {
				if p, err := netip.ParsePrefix(a.String()); err == nil && p.Addr().Is4() {
					e.Addresses = append(e.Addresses, p.String())
				}
			}
		}
		out = append(out, e)
	}
	sort.Slice(out, func(a, b int) bool { return out[a].Name < out[b].Name })
	return out, nil
}

func (realNetOps) AddrIface(addr netip.Addr) (string, error) {
	ifs, err := net.Interfaces()
	if err != nil {
		return "", err
	}
	for _, i := range ifs {
		addrs, err := i.Addrs()
		if err != nil {
			continue
		}
		for _, a := range addrs {
			if p, err := netip.ParsePrefix(a.String()); err == nil && p.Addr() == addr {
				return i.Name, nil
			}
		}
	}
	return "", nil
}

func (o *realNetOps) AddAddr(ctx context.Context, iface string, addr netip.Addr, prefix int) error {
	_, err := o.run(ctx, "ip", "-4", "addr", "add", fmt.Sprintf("%s/%d", addr, prefix), "dev", iface)
	return err
}

func (o *realNetOps) DelAddr(ctx context.Context, iface string, addr netip.Addr, prefix int) error {
	_, err := o.run(ctx, "ip", "-4", "addr", "del", fmt.Sprintf("%s/%d", addr, prefix), "dev", iface)
	return err
}

func (o *realNetOps) Announce(ctx context.Context, iface string, addr netip.Addr) {
	// iputils / busybox arping: -U unsolicited (gratuitous) ARP, one packet.
	_, _ = o.run(ctx, "arping", "-U", "-c", "1", "-I", iface, addr.String())
}

func (realNetOps) DefaultRouteIface() (string, error) {
	b, err := os.ReadFile("/proc/net/route")
	if err != nil {
		return "", err
	}
	return parseDefaultRoute(string(b)), nil
}

func (realNetOps) BridgePrefixes(bridge string) ([]netip.Prefix, error) {
	i, err := net.InterfaceByName(bridge)
	if err != nil {
		return nil, nil // no such interface
	}
	addrs, err := i.Addrs()
	if err != nil {
		return nil, err
	}
	var out []netip.Prefix
	for _, a := range addrs {
		if p, err := netip.ParsePrefix(a.String()); err == nil && p.Addr().Is4() {
			out = append(out, p)
		}
	}
	return out, nil
}

func (realNetOps) Listeners() ([]HostListener, error) {
	var out []HostListener
	for _, f := range []struct {
		path  string
		proto string
	}{{"/proc/net/tcp", "tcp"}, {"/proc/net/tcp6", "tcp"}, {"/proc/net/udp", "udp"}, {"/proc/net/udp6", "udp"}} {
		b, err := os.ReadFile(f.path)
		if err != nil {
			continue // no IPv6, …
		}
		out = append(out, parseProcNet(string(b), f.proto)...)
	}
	return dedupListeners(out), nil
}

// parseDefaultRoute returns the interface of the first default route of /proc/net/route ("" when none).
func parseDefaultRoute(content string) string {
	sc := bufio.NewScanner(strings.NewReader(content))
	first := true
	for sc.Scan() {
		if first {
			first = false
			continue
		}
		f := strings.Fields(sc.Text())
		if len(f) >= 8 && f[1] == "00000000" && f[7] == "00000000" {
			return f[0]
		}
	}
	return ""
}

// parseProcNet extracts the listening sockets of /proc/net/{tcp,udp}[6]: TCP in state LISTEN (0A), UDP
// sockets bound and NOT connected (state 07 with a zero remote address: a server socket).
func parseProcNet(content, proto string) []HostListener {
	var out []HostListener
	sc := bufio.NewScanner(strings.NewReader(content))
	first := true
	for sc.Scan() {
		if first {
			first = false
			continue
		}
		f := strings.Fields(sc.Text())
		if len(f) < 4 {
			continue
		}
		local, remote, state := f[1], f[2], f[3]
		if proto == "tcp" && state != "0A" {
			continue
		}
		if proto == "udp" && (state != "07" || !zeroRemote(remote)) {
			continue
		}
		addr, port, ok := parseHexEndpoint(local)
		if !ok || port == 0 {
			continue
		}
		out = append(out, HostListener{Protocol: proto, Address: addr, Port: port})
	}
	return out
}

func zeroRemote(s string) bool {
	i := strings.LastIndexByte(s, ':')
	return i > 0 && strings.Trim(s[:i], "0") == "" && strings.Trim(s[i+1:], "0") == ""
}

// parseHexEndpoint decodes "0100007F:1F90" (little-endian 32-bit words) / the 128-bit IPv6 form.
func parseHexEndpoint(s string) (string, int, bool) {
	i := strings.LastIndexByte(s, ':')
	if i < 0 {
		return "", 0, false
	}
	p, err := strconv.ParseUint(s[i+1:], 16, 16)
	if err != nil {
		return "", 0, false
	}
	raw, err := hex.DecodeString(s[:i])
	if err != nil || (len(raw) != 4 && len(raw) != 16) {
		return "", 0, false
	}
	// Each 32-bit word is in host (little-endian) order.
	b := make([]byte, len(raw))
	for w := 0; w < len(raw); w += 4 {
		b[w], b[w+1], b[w+2], b[w+3] = raw[w+3], raw[w+2], raw[w+1], raw[w]
	}
	a, ok := netip.AddrFromSlice(b)
	if !ok {
		return "", 0, false
	}
	a = a.Unmap()
	return a.String(), int(p), true
}

func dedupListeners(in []HostListener) []HostListener {
	seen := map[HostListener]bool{}
	out := make([]HostListener, 0, len(in))
	for _, l := range in {
		if !seen[l] {
			seen[l] = true
			out = append(out, l)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Port != out[j].Port {
			return out[i].Port < out[j].Port
		}
		if out[i].Protocol != out[j].Protocol {
			return out[i].Protocol < out[j].Protocol
		}
		return out[i].Address < out[j].Address
	})
	return out
}

// listenerWildcard: a socket bound to every address (0.0.0.0 / ::).
func listenerWildcard(l HostListener) bool {
	return l.Address == "0.0.0.0" || l.Address == "::"
}
