package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/netip"
	"strconv"
	"sync"
	"time"
)

// ─────────────────────────────────────────────────────────────────────────────
// Port gateway of the file servers (docs/P2-PLAN.md §9.4, ARCHITECTURE §3.3).
// With OBLIMINT_PORT_GATEWAY on, the SFTP container publishes no host port:
// hostd listens on the account's port (IPv4 and IPv6) and
//   - refuses at accept what the account state refuses (bans, allow-list —
//     defence in depth behind the nftables input chain), event 'refused';
//   - relays to the target (file server container IP on the account network
//     :2022), writing a PROXY protocol v2 header first;
//   - when the target is null (server stopped, on-demand mode) HOLDS the
//     connection up to activationWaitSec and emits ONE 'activate' event; the
//     panel starts the container and pushes the target, the held connections
//     are then relayed;
//   - emits 'idle' after idleTimeoutSec without any connection while a
//     target is set (the panel stops a gateway activation), then REPEATS it
//     every idleRepeatInterval while still idle (an event lost on the way —
//     long poll cut, queue overflow, panel error — must not keep an
//     on-demand server running forever);
//   - right after an activation the container is started but SFTPGo may not
//     listen yet (config rendering, host key generation): the dial to the
//     target is retried until the activation deadline instead of resetting
//     the client.
// Events are queued (bounded) and drained by the panel's long poll
// (GET /v1/gateway/events?wait=N).
// ─────────────────────────────────────────────────────────────────────────────

// GatewayTarget is the backend of an account (container IP : port).
type GatewayTarget struct {
	IP   string `json:"ip"`
	Port int    `json:"port"`
}

// GatewaySpec is the body of PUT /v1/gateway/accounts/{id}.
type GatewaySpec struct {
	AccountID         int64          `json:"accountId"`
	Port              int            `json:"port"`
	Target            *GatewayTarget `json:"target"`
	ProxyProtocol     bool           `json:"proxyProtocol"`
	IdleTimeoutSec    int            `json:"idleTimeoutSec"`
	ActivationWaitSec int            `json:"activationWaitSec"`
}

// GatewayEvent is one event of GET /v1/gateway/events.
type GatewayEvent struct {
	AccountID int64   `json:"accountId"`
	Kind      string  `json:"kind"`
	At        string  `json:"at"`
	RemoteIP  *string `json:"remoteIp"`
}

const (
	gwEventActivate = "activate"
	gwEventIdle     = "idle"
	gwEventRefused  = "refused"

	maxGatewayEvents      = 1000
	maxActivationWaitSec  = 120
	maxIdleTimeoutSec     = 7 * 24 * 3600
	gatewayDialTimeout    = 5 * time.Second
	refusedEventInterval  = time.Minute // at most one 'refused' event per (account, address) per minute
	maxGatewayConnections = 200         // per account
	// idleRepeatInterval: 'idle' is re-emitted this often while still idle.
	idleRepeatInterval = 5 * time.Minute
	// Dial retries of a freshly (re)started backend.
	gatewayRetryFirst = 250 * time.Millisecond
	gatewayRetryMax   = 2 * time.Second
)

// gatewayTargetAllowed is the R2 check of a pushed target (defence in depth:
// hostd runs as root in the host namespace and listens on public ports, a
// bad target would turn it into a public relay to host-local services). A
// target is a container address on an account network: private (RFC 1918,
// ULA) or shared (100.64.0.0/10), never loopback / link-local / one of the
// host's own addresses (the bridge gateways included). Tests replace it.
var gatewayTargetAllowed = defaultGatewayTargetAllowed

var sharedV4 = netip.MustParsePrefix("100.64.0.0/10")

func defaultGatewayTargetAllowed(a netip.Addr) bool {
	if a.IsLoopback() || a.IsLinkLocalUnicast() || a.IsUnspecified() || a.IsMulticast() {
		return false
	}
	if !a.IsPrivate() && !(a.Is4() && sharedV4.Contains(a)) {
		return false
	}
	return !isHostAddress(a)
}

// isHostAddress reports whether a is assigned to an interface of the host.
func isHostAddress(a netip.Addr) bool {
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return false
	}
	for _, ia := range addrs {
		if n, ok := ia.(*net.IPNet); ok {
			if h, ok := netip.AddrFromSlice(n.IP); ok && h.Unmap() == a {
				return true
			}
		}
	}
	return false
}

func (s GatewaySpec) validate(accountID int64) (GatewaySpec, error) {
	if err := validateID("account id", accountID); err != nil {
		return s, err
	}
	if s.AccountID != 0 && s.AccountID != accountID {
		return s, badRequest("accountId %d does not match the path", s.AccountID)
	}
	s.AccountID = accountID
	if s.Port < 1 || s.Port > 65535 {
		return s, badRequest("invalid port %d", s.Port)
	}
	if s.IdleTimeoutSec < 0 || s.IdleTimeoutSec > maxIdleTimeoutSec {
		return s, badRequest("invalid idleTimeoutSec %d", s.IdleTimeoutSec)
	}
	if s.ActivationWaitSec < 0 || s.ActivationWaitSec > maxActivationWaitSec {
		return s, badRequest("invalid activationWaitSec %d", s.ActivationWaitSec)
	}
	if s.Target != nil {
		a, err := netip.ParseAddr(s.Target.IP)
		if err != nil || a.Zone() != "" || a.IsUnspecified() || a.IsMulticast() {
			return s, badRequest("invalid target ip %q", s.Target.IP)
		}
		if a = a.Unmap(); !gatewayTargetAllowed(a) {
			return s, badRequest("target ip %q is not a container address of an account network", s.Target.IP)
		}
		if s.Target.Port < 1 || s.Target.Port > 65535 {
			return s, badRequest("invalid target port %d", s.Target.Port)
		}
		s.Target = &GatewayTarget{IP: a.Unmap().String(), Port: s.Target.Port}
	}
	return s, nil
}

// gwAccount is the live state of one account's gateway.
type gwAccount struct {
	spec      GatewaySpec
	listeners []net.Listener
	conns     int
	// targetReady is closed (and replaced) whenever a target arrives: held
	// connections wait on it.
	targetReady chan struct{}
	// activating: an 'activate' was emitted and no target arrived yet.
	activating bool
	// targetSince: wall time the current target was pushed (dial retries of
	// a backend that is still starting).
	targetSince time.Time
	idleTimer   timer
	idleEmitted bool
	closed      bool
}

type gateway struct {
	mu       sync.Mutex
	clock    clock
	allows   func(accountID int64, ip netip.Addr) (bool, string)
	listen   func(network, addr string) (net.Listener, error)
	dial     func(ctx context.Context, network, addr string) (net.Conn, error)
	accounts map[int64]*gwAccount
	events   []GatewayEvent
	notify   chan struct{} // closed and replaced when an event is queued
	refused  map[string]time.Time
	// onChange is called (without the lock) after a spec change (persistence).
	onChange func()
}

func newGateway(c clock, allows func(int64, netip.Addr) (bool, string)) *gateway {
	d := &net.Dialer{Timeout: gatewayDialTimeout}
	return &gateway{
		clock:    c,
		allows:   allows,
		listen:   net.Listen,
		dial:     d.DialContext,
		accounts: map[int64]*gwAccount{},
		notify:   make(chan struct{}),
		refused:  map[string]time.Time{},
	}
}

// Specs returns the current specs (persistence).
func (g *gateway) Specs() map[int64]GatewaySpec {
	g.mu.Lock()
	defer g.mu.Unlock()
	out := make(map[int64]GatewaySpec, len(g.accounts))
	for id, a := range g.accounts {
		out[id] = a.spec
	}
	return out
}

// Listeners counts the open listening sockets.
func (g *gateway) Listeners() int {
	g.mu.Lock()
	defer g.mu.Unlock()
	n := 0
	for _, a := range g.accounts {
		n += len(a.listeners)
	}
	return n
}

// Set creates or updates the gateway of an account. A port change reopens
// the listeners; a target change wakes the held connections and re-arms the
// idle timer.
func (g *gateway) Set(spec GatewaySpec) error {
	spec, err := spec.validate(spec.AccountID)
	if err != nil {
		return err
	}
	g.mu.Lock()
	a := g.accounts[spec.AccountID]
	if a != nil && a.spec.Port != spec.Port {
		g.closeLocked(a)
		delete(g.accounts, spec.AccountID)
		a = nil
	}
	if a == nil {
		lns, err := g.openListeners(spec.Port)
		if err != nil {
			g.mu.Unlock()
			return err
		}
		a = &gwAccount{spec: spec, listeners: lns, targetReady: make(chan struct{})}
		if spec.Target != nil {
			a.targetSince = time.Now()
		}
		g.accounts[spec.AccountID] = a
		for _, ln := range lns {
			go g.serve(a, spec.AccountID, ln)
		}
		g.armIdleLocked(a)
		g.mu.Unlock()
		g.changed()
		return nil
	}
	old := a.spec
	a.spec = spec
	targetChanged := !sameTarget(old.Target, spec.Target)
	if spec.Target != nil && targetChanged {
		a.targetSince = time.Now()
		a.activating = false
		close(a.targetReady)
		a.targetReady = make(chan struct{})
	}
	if targetChanged || old.IdleTimeoutSec != spec.IdleTimeoutSec {
		a.idleEmitted = false
		g.armIdleLocked(a)
	}
	g.mu.Unlock()
	if old != spec || targetChanged {
		g.changed()
	}
	return nil
}

func sameTarget(a, b *GatewayTarget) bool {
	if a == nil || b == nil {
		return a == b
	}
	return *a == *b
}

// Remove closes the listeners of an account (open connections are kept).
func (g *gateway) Remove(accountID int64) error {
	if err := validateID("account id", accountID); err != nil {
		return err
	}
	g.mu.Lock()
	a := g.accounts[accountID]
	if a != nil {
		g.closeLocked(a)
		delete(g.accounts, accountID)
	}
	g.mu.Unlock()
	if a != nil {
		g.changed()
	}
	return nil
}

// Close stops every listener (shutdown).
func (g *gateway) Close() {
	g.mu.Lock()
	defer g.mu.Unlock()
	for id, a := range g.accounts {
		g.closeLocked(a)
		delete(g.accounts, id)
	}
}

func (g *gateway) changed() {
	if g.onChange != nil {
		g.onChange()
	}
}

func (g *gateway) closeLocked(a *gwAccount) {
	a.closed = true
	for _, ln := range a.listeners {
		_ = ln.Close()
	}
	a.listeners = nil
	if a.idleTimer != nil {
		a.idleTimer.Stop()
		a.idleTimer = nil
	}
	close(a.targetReady) // held connections give up (closed = true)
	a.targetReady = make(chan struct{})
}

// openListeners listens on the port for IPv4 and IPv6. IPv4 is required;
// IPv6 is best effort (a host without IPv6 keeps the IPv4 listener).
func (g *gateway) openListeners(port int) ([]net.Listener, error) {
	p := strconv.Itoa(port)
	ln4, err := g.listen("tcp4", "0.0.0.0:"+p)
	if err != nil {
		return nil, &apiError{409, "portInUse", fmt.Sprintf("gateway: cannot listen on port %d: %v", port, err)}
	}
	lns := []net.Listener{ln4}
	if ln6, err := g.listen("tcp6", "[::]:"+p); err == nil {
		lns = append(lns, ln6)
	} else {
		slog.Warn("gateway: no IPv6 listener", "port", port, "err", err)
	}
	return lns, nil
}

// armIdleLocked (re)starts the idle timer when a target is set, no
// connection is open and the timeout is on: the first 'idle' after the idle
// timeout, then a repeat every idleRepeatInterval while still idle.
func (g *gateway) armIdleLocked(a *gwAccount) {
	if a.idleTimer != nil {
		a.idleTimer.Stop()
		a.idleTimer = nil
	}
	if a.closed || a.spec.Target == nil || a.conns > 0 || a.spec.IdleTimeoutSec == 0 {
		return
	}
	d := time.Duration(a.spec.IdleTimeoutSec) * time.Second
	if a.idleEmitted {
		d = min(d, idleRepeatInterval)
	}
	var t timer
	t = g.clock.AfterFunc(d, func() {
		g.mu.Lock()
		defer g.mu.Unlock()
		if a.idleTimer != t || a.closed || a.conns > 0 || a.spec.Target == nil {
			return // superseded (activity, new spec) or no longer idle
		}
		a.idleEmitted = true
		g.pushLocked(GatewayEvent{AccountID: a.spec.AccountID, Kind: gwEventIdle})
		g.armIdleLocked(a)
	})
	a.idleTimer = t
}

func (g *gateway) pushLocked(e GatewayEvent) {
	e.At = g.clock.Now().UTC().Format(time.RFC3339Nano)
	if len(g.events) >= maxGatewayEvents {
		g.events = g.events[1:]
	}
	g.events = append(g.events, e)
	close(g.notify)
	g.notify = make(chan struct{})
}

// Events drains the queue, waiting up to wait for the first event.
func (g *gateway) Events(ctx context.Context, wait time.Duration) []GatewayEvent {
	g.mu.Lock()
	if len(g.events) == 0 && wait > 0 {
		ch := g.notify
		g.mu.Unlock()
		t := time.NewTimer(wait)
		select {
		case <-ch:
		case <-t.C:
		case <-ctx.Done():
		}
		t.Stop()
		g.mu.Lock()
	}
	out := g.events
	g.events = nil
	g.mu.Unlock()
	if out == nil {
		out = []GatewayEvent{}
	}
	return out
}

func (g *gateway) serve(a *gwAccount, accountID int64, ln net.Listener) {
	for {
		c, err := ln.Accept()
		if err != nil {
			if errors.Is(err, net.ErrClosed) {
				return
			}
			slog.Warn("gateway accept failed", "accountId", accountID, "err", err)
			time.Sleep(100 * time.Millisecond)
			continue
		}
		go g.handle(a, accountID, c)
	}
}

func remoteAddr(c net.Conn) netip.AddrPort {
	if ta, ok := c.RemoteAddr().(*net.TCPAddr); ok {
		return ta.AddrPort()
	}
	ap, _ := netip.ParseAddrPort(c.RemoteAddr().String())
	return ap
}

func localAddr(c net.Conn) netip.AddrPort {
	if ta, ok := c.LocalAddr().(*net.TCPAddr); ok {
		return ta.AddrPort()
	}
	ap, _ := netip.ParseAddrPort(c.LocalAddr().String())
	return ap
}

// handle runs one client connection: accept check, hold / activate, relay.
func (g *gateway) handle(a *gwAccount, accountID int64, c net.Conn) {
	defer c.Close()
	src := remoteAddr(c)
	ip := src.Addr().Unmap()

	if ok, _ := g.allows(accountID, ip); !ok {
		g.refuse(accountID, ip)
		return
	}

	g.mu.Lock()
	if a.closed || a.conns >= maxGatewayConnections {
		g.mu.Unlock()
		return
	}
	a.conns++
	if a.idleTimer != nil {
		a.idleTimer.Stop()
		a.idleTimer = nil
	}
	a.idleEmitted = false
	g.mu.Unlock()
	defer func() {
		g.mu.Lock()
		a.conns--
		g.armIdleLocked(a)
		g.mu.Unlock()
	}()

	spec, deadline, ok := g.waitTarget(a, ip)
	if !ok {
		return
	}
	g.relay(a, c, src, localAddr(c), spec, deadline)
}

// refuse emits a rate-limited 'refused' event.
func (g *gateway) refuse(accountID int64, ip netip.Addr) {
	g.mu.Lock()
	defer g.mu.Unlock()
	key := fmt.Sprintf("%d|%s", accountID, ip)
	now := g.clock.Now()
	if last, ok := g.refused[key]; ok && now.Sub(last) < refusedEventInterval {
		return
	}
	if len(g.refused) > 10000 {
		for k, t := range g.refused {
			if now.Sub(t) >= refusedEventInterval {
				delete(g.refused, k)
			}
		}
	}
	g.refused[key] = now
	s := ip.String()
	g.pushLocked(GatewayEvent{AccountID: accountID, Kind: gwEventRefused, RemoteIP: &s})
}

// waitTarget returns the spec with a target, holding the connection (and
// emitting one 'activate' per activation) while there is none. The returned
// deadline (wall clock) bounds the dial retries: the end of the hold, or
// activationWaitSec after the target was pushed (a backend that is still
// starting); zero = a single dial.
func (g *gateway) waitTarget(a *gwAccount, ip netip.Addr) (GatewaySpec, time.Time, bool) {
	g.mu.Lock()
	wait := time.Duration(a.spec.ActivationWaitSec) * time.Second
	if a.spec.Target != nil {
		spec := a.spec
		var deadline time.Time
		if d := a.targetSince.Add(wait); wait > 0 && !a.targetSince.IsZero() && d.After(time.Now()) {
			deadline = d
		}
		g.mu.Unlock()
		return spec, deadline, true
	}
	if wait == 0 {
		g.mu.Unlock()
		return GatewaySpec{}, time.Time{}, false
	}
	holdDeadline := time.Now().Add(wait)
	if !a.activating {
		a.activating = true
		s := ip.String()
		g.pushLocked(GatewayEvent{AccountID: a.spec.AccountID, Kind: gwEventActivate, RemoteIP: &s})
	}
	ready := a.targetReady
	g.mu.Unlock()

	timeout := make(chan struct{})
	t := g.clock.AfterFunc(wait, func() { close(timeout) })
	defer t.Stop()
	select {
	case <-ready:
	case <-timeout:
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	if a.closed || a.spec.Target == nil {
		// Nobody answered in time: the next connection asks again.
		if !a.closed && a.spec.Target == nil {
			a.activating = false
		}
		return GatewaySpec{}, time.Time{}, false
	}
	return a.spec, holdDeadline, true
}

// dialBackend dials the target; until deadline (when set) it retries with a
// backoff — following target changes — while the account is open and has a
// target. The first connection after an activation thus waits for SFTPGo to
// listen instead of being reset.
func (g *gateway) dialBackend(a *gwAccount, spec GatewaySpec, deadline time.Time) (net.Conn, string, error) {
	backoff := gatewayRetryFirst
	for {
		addr := net.JoinHostPort(spec.Target.IP, strconv.Itoa(spec.Target.Port))
		ctx, cancel := context.WithTimeout(context.Background(), gatewayDialTimeout)
		backend, err := g.dial(ctx, "tcp", addr)
		cancel()
		if err == nil {
			return backend, addr, nil
		}
		if deadline.IsZero() || time.Until(deadline) < backoff {
			return nil, addr, err
		}
		time.Sleep(backoff)
		backoff = min(backoff*2, gatewayRetryMax)
		g.mu.Lock()
		closed, cur := a.closed, a.spec
		g.mu.Unlock()
		if closed || cur.Target == nil {
			return nil, addr, err
		}
		spec.Target = cur.Target
	}
}

// relay dials the target (retrying until deadline), writes the PROXY v2
// header and copies both ways.
func (g *gateway) relay(a *gwAccount, client net.Conn, src, dst netip.AddrPort, spec GatewaySpec, deadline time.Time) {
	backend, addr, err := g.dialBackend(a, spec, deadline)
	if err != nil {
		slog.Warn("gateway: backend unreachable", "accountId", spec.AccountID, "target", addr, "err", err)
		return
	}
	defer backend.Close()
	if spec.ProxyProtocol {
		hdr, err := encodeProxyV2(src, dst)
		if err == nil {
			_, err = backend.Write(hdr)
		}
		if err != nil {
			slog.Warn("gateway: PROXY header not sent", "accountId", spec.AccountID, "err", err)
			return
		}
	}
	done := make(chan struct{}, 2)
	pipe := func(dst, src net.Conn) {
		_, _ = io.Copy(dst, src)
		if cw, ok := dst.(interface{ CloseWrite() error }); ok {
			_ = cw.CloseWrite()
		} else {
			_ = dst.Close()
		}
		done <- struct{}{}
	}
	go pipe(backend, client)
	go pipe(client, backend)
	<-done
	<-done
}
