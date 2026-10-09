package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/hex"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestProxyV2Header(t *testing.T) {
	h, err := encodeProxyV2(netip.MustParseAddrPort("203.0.113.7:51234"), netip.MustParseAddrPort("192.0.2.10:30003"))
	if err != nil {
		t.Fatal(err)
	}
	want := "0d0a0d0a000d0a515549540a" + // signature
		"21" + "11" + "000c" + // v2 PROXY, TCP over IPv4, 12 bytes
		"cb007107" + "c000020a" + // 203.0.113.7, 192.0.2.10
		"c822" + "7533" // 51234, 30003
	if got := hex.EncodeToString(h); got != want {
		t.Errorf("v4 header\n got %s\nwant %s", got, want)
	}

	h, _ = encodeProxyV2(netip.MustParseAddrPort("[2001:db8::7]:443"), netip.MustParseAddrPort("[2001:db8::1]:30003"))
	want6 := "0d0a0d0a000d0a515549540a" + "21" + "21" + "0024" +
		"20010db8000000000000000000000007" + "20010db8000000000000000000000001" + "01bb" + "7533"
	if got := hex.EncodeToString(h); got != want6 {
		t.Errorf("v6 header\n got %s\nwant %s", got, want6)
	}

	// Mixed families: IPv4-mapped IPv6.
	h, _ = encodeProxyV2(netip.MustParseAddrPort("203.0.113.7:1"), netip.MustParseAddrPort("[2001:db8::1]:2"))
	if h[13] != proxyV2TCP6 || !bytes.Equal(h[16:32], netip.MustParseAddr("::ffff:203.0.113.7").AsSlice()) {
		t.Errorf("mixed header %x", h)
	}
	if _, err := encodeProxyV2(netip.AddrPort{}, netip.MustParseAddrPort("192.0.2.1:1")); err == nil {
		t.Error("invalid address accepted")
	}
}

// ── Gateway with loopback listeners ─────────────────────────────────────────

// backend is a loopback TCP server that records the PROXY header (if any)
// and echoes the rest with a prefix.
type backend struct {
	ln      net.Listener
	mu      sync.Mutex
	headers [][]byte
}

func newBackend(t *testing.T, proxy bool) *backend {
	t.Helper()
	ln, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	b := &backend{ln: ln}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				defer c.Close()
				r := bufio.NewReader(c)
				if proxy {
					hdr := make([]byte, 16)
					if _, err := io.ReadFull(r, hdr); err != nil {
						return
					}
					rest := make([]byte, int(hdr[14])<<8|int(hdr[15]))
					if _, err := io.ReadFull(r, rest); err != nil {
						return
					}
					b.mu.Lock()
					b.headers = append(b.headers, append(hdr, rest...))
					b.mu.Unlock()
				}
				line, err := r.ReadString('\n')
				if err != nil {
					return
				}
				_, _ = c.Write([]byte("echo:" + line))
			}()
		}
	}()
	return b
}

func (b *backend) target() *GatewayTarget {
	ap := b.ln.Addr().(*net.TCPAddr).AddrPort()
	return &GatewayTarget{IP: ap.Addr().String(), Port: int(ap.Port())}
}

// testGateway listens on loopback only (any free port), with a fake clock.
func testGateway(t *testing.T, allows func(int64, netip.Addr) (bool, string)) (*gateway, *fakeClock) {
	t.Helper()
	clk := newFakeClock(fwNow)
	if allows == nil {
		allows = func(int64, netip.Addr) (bool, string) { return true, "" }
	}
	g := newGateway(clk, allows)
	// The backends of these tests are loopback servers: allow loopback
	// targets (the production check refuses them, TestGatewayTargetCheck).
	prev := gatewayTargetAllowed
	gatewayTargetAllowed = func(a netip.Addr) bool { return a.IsLoopback() || defaultGatewayTargetAllowed(a) }
	t.Cleanup(func() { gatewayTargetAllowed = prev })
	g.listen = func(network, addr string) (net.Listener, error) {
		_, port, _ := net.SplitHostPort(addr)
		if network == "tcp6" {
			return net.Listen("tcp6", "[::1]:"+port)
		}
		return net.Listen("tcp4", "127.0.0.1:"+port)
	}
	t.Cleanup(g.Close)
	return g, clk
}

func freePort(t *testing.T) int {
	t.Helper()
	ln, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	return ln.Addr().(*net.TCPAddr).Port
}

func roundTrip(t *testing.T, port int, msg string) (string, error) {
	t.Helper()
	c, err := net.DialTimeout("tcp4", "127.0.0.1:"+strconv.Itoa(port), 2*time.Second)
	if err != nil {
		return "", err
	}
	defer c.Close()
	_ = c.SetDeadline(time.Now().Add(5 * time.Second))
	if _, err := c.Write([]byte(msg + "\n")); err != nil {
		return "", err
	}
	line, err := bufio.NewReader(c).ReadString('\n')
	return strings.TrimSpace(line), err
}

func waitEvents(t *testing.T, g *gateway, n int) []GatewayEvent {
	t.Helper()
	var got []GatewayEvent
	deadline := time.Now().Add(3 * time.Second)
	for len(got) < n && time.Now().Before(deadline) {
		got = append(got, g.Events(context.Background(), 200*time.Millisecond)...)
	}
	return got
}

func TestGatewayRelaysWithProxyHeader(t *testing.T) {
	be := newBackend(t, true)
	g, _ := testGateway(t, nil)
	port := freePort(t)
	if err := g.Set(GatewaySpec{AccountID: 3, Port: port, Target: be.target(), ProxyProtocol: true, IdleTimeoutSec: 900, ActivationWaitSec: 30}); err != nil {
		t.Fatal(err)
	}
	if n := g.Listeners(); n < 1 {
		t.Fatalf("listeners = %d", n)
	}
	got, err := roundTrip(t, port, "hello")
	if err != nil || got != "echo:hello" {
		t.Fatalf("relay = %q %v", got, err)
	}
	be.mu.Lock()
	defer be.mu.Unlock()
	if len(be.headers) != 1 {
		t.Fatalf("headers = %d", len(be.headers))
	}
	h := be.headers[0]
	if !bytes.Equal(h[:12], proxyV2Signature) || h[13] != proxyV2TCP4 {
		t.Errorf("header %x", h)
	}
	src := netip.AddrFrom4([4]byte(h[16:20]))
	dstPort := int(h[26])<<8 | int(h[27])
	if src.String() != "127.0.0.1" || dstPort != port {
		t.Errorf("header src %s dst port %d", src, dstPort)
	}
}

func TestGatewayRefusesAtAccept(t *testing.T) {
	be := newBackend(t, false)
	g, _ := testGateway(t, func(id int64, ip netip.Addr) (bool, string) { return false, "notAllowed" })
	port := freePort(t)
	if err := g.Set(GatewaySpec{AccountID: 4, Port: port, Target: be.target()}); err != nil {
		t.Fatal(err)
	}
	if got, err := roundTrip(t, port, "x"); err == nil {
		t.Fatalf("refused connection was relayed: %q", got)
	}
	_, _ = roundTrip(t, port, "again") // rate-limited: one event per address per minute
	evs := waitEvents(t, g, 1)
	time.Sleep(100 * time.Millisecond)
	evs = append(evs, g.Events(context.Background(), 0)...)
	if len(evs) != 1 || evs[0].Kind != gwEventRefused || evs[0].AccountID != 4 || evs[0].RemoteIP == nil || *evs[0].RemoteIP != "127.0.0.1" {
		t.Errorf("events = %+v", evs)
	}
}

// Target null: the connection is held, ONE 'activate' is emitted, and the
// connection is relayed as soon as the target is pushed.
func TestGatewayHoldActivateThenRelay(t *testing.T) {
	be := newBackend(t, false)
	g, _ := testGateway(t, nil)
	port := freePort(t)
	spec := GatewaySpec{AccountID: 5, Port: port, IdleTimeoutSec: 60, ActivationWaitSec: 30}
	if err := g.Set(spec); err != nil {
		t.Fatal(err)
	}
	type res struct {
		s   string
		err error
	}
	results := make(chan res, 2)
	for i := 0; i < 2; i++ {
		go func(i int) {
			s, err := roundTrip(t, port, "c"+strconv.Itoa(i))
			results <- res{s, err}
		}(i)
	}
	evs := waitEvents(t, g, 1)
	time.Sleep(150 * time.Millisecond) // the second connection is held too
	evs = append(evs, g.Events(context.Background(), 0)...)
	if len(evs) != 1 || evs[0].Kind != gwEventActivate || evs[0].AccountID != 5 {
		t.Fatalf("events = %+v", evs)
	}
	spec.Target = be.target()
	if err := g.Set(spec); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		r := <-results
		if r.err != nil || !strings.HasPrefix(r.s, "echo:c") {
			t.Errorf("held connection: %q %v", r.s, r.err)
		}
	}
}

// Nobody activates in time: the held connection is closed and the next one
// asks again.
func TestGatewayActivationTimeout(t *testing.T) {
	g, clk := testGateway(t, nil)
	port := freePort(t)
	if err := g.Set(GatewaySpec{AccountID: 6, Port: port, ActivationWaitSec: 30}); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { _, err := roundTrip(t, port, "x"); done <- err }()
	if evs := waitEvents(t, g, 1); len(evs) != 1 || evs[0].Kind != gwEventActivate {
		t.Fatalf("events = %+v", evs)
	}
	time.Sleep(50 * time.Millisecond) // the held connection arms its deadline right after the event
	clk.Advance(31 * time.Second)
	select {
	case err := <-done:
		if err == nil {
			t.Error("timed-out connection got an answer")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("held connection not released at the deadline")
	}
	go func() { _, _ = roundTrip(t, port, "y") }()
	if evs := waitEvents(t, g, 1); len(evs) != 1 || evs[0].Kind != gwEventActivate {
		t.Errorf("second activation = %+v", evs)
	}
	time.Sleep(50 * time.Millisecond) // the held connection arms its deadline right after the event
	clk.Advance(31 * time.Second)
}

func TestGatewayIdle(t *testing.T) {
	be := newBackend(t, false)
	g, clk := testGateway(t, nil)
	port := freePort(t)
	spec := GatewaySpec{AccountID: 7, Port: port, Target: be.target(), IdleTimeoutSec: 900, ActivationWaitSec: 30}
	if err := g.Set(spec); err != nil {
		t.Fatal(err)
	}
	clk.Advance(10 * time.Minute)
	if _, err := roundTrip(t, port, "x"); err != nil { // activity: the idle timer restarts after it
		t.Fatal(err)
	}
	time.Sleep(100 * time.Millisecond) // the relay goroutine closes and re-arms
	clk.Advance(10 * time.Minute)
	if evs := g.Events(context.Background(), 0); len(evs) != 0 {
		t.Fatalf("idle too early: %+v", evs)
	}
	clk.Advance(6 * time.Minute)
	evs := g.Events(context.Background(), 0)
	if len(evs) != 1 || evs[0].Kind != gwEventIdle || evs[0].AccountID != 7 || evs[0].RemoteIP != nil {
		t.Fatalf("events = %+v", evs)
	}
	// The same target pushed again (periodic resync) does not re-arm the
	// timeout; while still idle, 'idle' is repeated every idleRepeatInterval
	// (a lost event must not keep the server running forever).
	if err := g.Set(spec); err != nil {
		t.Fatal(err)
	}
	// The first 'idle' fired at 25 min (now: 26 min): the repeat is due at 30.
	clk.Advance(idleRepeatInterval - 2*time.Minute)
	if evs := g.Events(context.Background(), 0); len(evs) != 0 {
		t.Errorf("idle repeated too early: %+v", evs)
	}
	clk.Advance(2 * time.Minute)
	if evs := g.Events(context.Background(), 0); len(evs) != 1 || evs[0].Kind != gwEventIdle {
		t.Errorf("idle not repeated: %+v", evs)
	}
	clk.Advance(2 * idleRepeatInterval)
	if evs := g.Events(context.Background(), 0); len(evs) != 2 {
		t.Errorf("repeats = %+v", evs)
	}
	// Activity stops the repeats (the full timeout applies again).
	if _, err := roundTrip(t, port, "y"); err != nil {
		t.Fatal(err)
	}
	time.Sleep(100 * time.Millisecond)
	clk.Advance(idleRepeatInterval + time.Second)
	if evs := g.Events(context.Background(), 0); len(evs) != 0 {
		t.Errorf("idle right after activity: %+v", evs)
	}
	// Target null (server stopped): no idle.
	spec.Target = nil
	_ = g.Set(spec)
	clk.Advance(time.Hour)
	if evs := g.Events(context.Background(), 0); len(evs) != 0 {
		t.Errorf("idle without target: %+v", evs)
	}
}

func TestGatewayPortChangeAndRemove(t *testing.T) {
	g, _ := testGateway(t, nil)
	p1, p2 := freePort(t), freePort(t)
	if err := g.Set(GatewaySpec{AccountID: 8, Port: p1}); err != nil {
		t.Fatal(err)
	}
	if err := g.Set(GatewaySpec{AccountID: 8, Port: p2}); err != nil {
		t.Fatal(err)
	}
	if c, err := net.DialTimeout("tcp4", "127.0.0.1:"+strconv.Itoa(p1), time.Second); err == nil {
		c.Close()
		t.Error("old port still listening")
	}
	if specs := g.Specs(); specs[8].Port != p2 {
		t.Errorf("specs = %+v", specs)
	}
	// Another account cannot take the same port.
	if err := g.Set(GatewaySpec{AccountID: 9, Port: p2}); err == nil {
		t.Error("port shared by two accounts")
	}
	if err := g.Remove(8); err != nil {
		t.Fatal(err)
	}
	if g.Listeners() != 0 {
		t.Errorf("listeners after remove = %d", g.Listeners())
	}
	for _, bad := range []GatewaySpec{
		{AccountID: 8, Port: 0}, {AccountID: 8, Port: 70000}, {AccountID: 8, Port: 1, ActivationWaitSec: 999},
		{AccountID: 8, Port: 1, IdleTimeoutSec: -1}, {AccountID: 8, Port: 1, Target: &GatewayTarget{IP: "oblimint-files-8", Port: 2022}},
		{AccountID: 8, Port: 1, Target: &GatewayTarget{IP: "0.0.0.0", Port: 2022}}, {AccountID: 8, Port: 1, Target: &GatewayTarget{IP: "172.20.0.5", Port: 0}},
	} {
		if err := g.Set(bad); !isBadRequest(err) {
			t.Errorf("%+v accepted: %v", bad, err)
		}
	}
}

func TestEventsLongPoll(t *testing.T) {
	g, _ := testGateway(t, nil)
	start := time.Now()
	if evs := g.Events(context.Background(), 150*time.Millisecond); len(evs) != 0 || time.Since(start) < 140*time.Millisecond {
		t.Errorf("empty poll = %+v after %v", evs, time.Since(start))
	}
	go func() {
		time.Sleep(50 * time.Millisecond)
		g.mu.Lock()
		g.pushLocked(GatewayEvent{AccountID: 1, Kind: gwEventIdle})
		g.mu.Unlock()
	}()
	start = time.Now()
	if evs := g.Events(context.Background(), 5*time.Second); len(evs) != 1 || time.Since(start) > 2*time.Second {
		t.Errorf("poll = %+v after %v", evs, time.Since(start))
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if evs := g.Events(ctx, 5*time.Second); len(evs) != 0 {
		t.Errorf("cancelled poll = %+v", evs)
	}
}

// The HTTP routes of the firewall and the gateway, end to end on real
// managers (fake nft).
func TestFirewallAndGatewayRoutes(t *testing.T) {
	clk := newFakeClock(fwNow)
	nft := &fakeNft{available: true}
	fw := newFirewallManager(nft, clk, "")
	fw.resolvers = nil
	g, _ := testGateway(t, fw.Allows)
	mux := newMux(&fakeOps{}, newLayout("/srv/oblimint"), fw, g)
	call := func(method, target, body string) (int, string) {
		rec := httptest.NewRecorder()
		req, _ := http.NewRequest(method, target, strings.NewReader(body))
		mux.ServeHTTP(rec, req)
		return rec.Code, rec.Body.String()
	}
	port := freePort(t)
	steps := []struct {
		method, target, body string
		status               int
		contains             string
	}{
		{"PUT", "/v1/firewall/accounts/3", `{"accountId":3,"mode":"allowlist","gatewayPorts":[30003],"publishedPorts":[],"allow":[{"cidr":"198.51.100.0/24","expiresAt":null}],"bans":[]}`, 200, `"ok":true`},
		{"PUT", "/v1/firewall/accounts/3", `{"accountId":4,"mode":"open"}`, 400, `"code":"invalid"`},
		{"PUT", "/v1/firewall/accounts/3", `{"mode":"open","allow":[{"cidr":"1.2.3.4; flush ruleset"}]}`, 400, `"code":"invalid"`},
		{"PUT", "/v1/firewall/global", `{"egress":"metadata","accountSubnets":["172.20.0.0/16"],"egressAllow":[]}`, 200, `"ok":true`},
		{"PUT", "/v1/firewall/global", `{"egress":"everything"}`, 400, `"code":"invalid"`},
		{"GET", "/v1/firewall", "", 200, `"backend":"nftables","accounts":1`},
		{"PUT", "/v1/gateway/accounts/3", `{"accountId":3,"port":` + strconv.Itoa(port) + `,"target":null,"proxyProtocol":true,"idleTimeoutSec":900,"activationWaitSec":30}`, 200, `"ok":true`},
		{"GET", "/v1/firewall", "", 200, `"accountIds":[3],"gatewayAccountIds":[3]`},
		{"PUT", "/v1/gateway/accounts/3", `{"port":"x"}`, 400, `"code":"invalid"`},
		{"GET", "/v1/gateway/events?wait=0", "", 200, `{"events":[]}`},
		{"GET", "/v1/gateway/events?wait=-1", "", 400, `"code":"invalid"`},
		{"DELETE", "/v1/gateway/accounts/3", "", 200, `"ok":true`},
		{"DELETE", "/v1/firewall/accounts/3", "", 200, `"ok":true`},
		{"GET", "/v1/firewall", "", 200, `"accounts":0`},
	}
	for _, s := range steps {
		code, body := call(s.method, s.target, s.body)
		if code != s.status || !strings.Contains(body, s.contains) {
			t.Errorf("%s %s %s: %d %s", s.method, s.target, s.body, code, body)
		}
	}
	if !strings.Contains(nft.applied[0], "allow4_3") {
		t.Errorf("first apply:\n%s", nft.applied[0])
	}
	// Without managers (P1 wiring): 501.
	rec := httptest.NewRecorder()
	req, _ := http.NewRequest("GET", "/v1/firewall", nil)
	newMux(&fakeOps{}, newLayout("/srv/oblimint"), nil, nil).ServeHTTP(rec, req)
	if rec.Code != http.StatusNotImplemented {
		t.Errorf("no managers: %d", rec.Code)
	}
}

// The first connection after an activation: the target is pushed as soon as
// the container started, but SFTPGo listens a moment later. The relay
// retries the dial until the activation deadline instead of resetting the
// client.
func TestGatewayRetriesBackendThatListensLate(t *testing.T) {
	g, _ := testGateway(t, nil)
	port := freePort(t)
	bePort := freePort(t)
	spec := GatewaySpec{AccountID: 11, Port: port, IdleTimeoutSec: 60, ActivationWaitSec: 30}
	if err := g.Set(spec); err != nil {
		t.Fatal(err)
	}
	type res struct {
		s   string
		err error
	}
	done := make(chan res, 1)
	go func() {
		s, err := roundTrip(t, port, "late")
		done <- res{s, err}
	}()
	if evs := waitEvents(t, g, 1); len(evs) != 1 || evs[0].Kind != gwEventActivate {
		t.Fatalf("events = %+v", evs)
	}
	spec.Target = &GatewayTarget{IP: "127.0.0.1", Port: bePort}
	if err := g.Set(spec); err != nil {
		t.Fatal(err)
	}
	time.Sleep(700 * time.Millisecond) // a few refused dials
	ln, err := net.Listen("tcp4", "127.0.0.1:"+strconv.Itoa(bePort))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		defer c.Close()
		line, _ := bufio.NewReader(c).ReadString('\n')
		_, _ = c.Write([]byte("echo:" + line))
	}()
	select {
	case r := <-done:
		if r.err != nil || r.s != "echo:late" {
			t.Errorf("held connection: %q %v", r.s, r.err)
		}
	case <-time.After(8 * time.Second):
		t.Fatal("held connection not relayed")
	}

	// Long after the push, a dead backend is not retried: immediate close.
	g.mu.Lock()
	g.accounts[11].targetSince = time.Now().Add(-time.Hour)
	g.mu.Unlock()
	ln.Close()
	start := time.Now()
	if _, err := roundTrip(t, port, "x"); err == nil {
		t.Error("dead backend answered")
	}
	if time.Since(start) > 2*time.Second {
		t.Errorf("dead backend retried for %v", time.Since(start))
	}
}

// R2: a target must be a container address (private / shared), never
// loopback, link-local, public or one of the host's own addresses.
func TestGatewayTargetCheck(t *testing.T) {
	for _, ip := range []string{"127.0.0.1", "::1", "169.254.169.254", "fe80::1", "8.8.8.8", "2001:db8::1", "::ffff:127.0.0.1"} {
		s := GatewaySpec{AccountID: 1, Port: 30001, Target: &GatewayTarget{IP: ip, Port: 2022}}
		if _, err := s.validate(1); !isBadRequest(err) {
			t.Errorf("target %s accepted: %v", ip, err)
		}
	}
	for _, ip := range []string{"172.20.0.5", "10.1.2.3", "192.168.50.2", "100.64.3.4", "fd00:20::5"} {
		a := netip.MustParseAddr(ip)
		if isHostAddress(a) {
			continue // this machine owns it
		}
		s := GatewaySpec{AccountID: 1, Port: 30001, Target: &GatewayTarget{IP: ip, Port: 2022}}
		if _, err := s.validate(1); err != nil {
			t.Errorf("target %s refused: %v", ip, err)
		}
	}
	// The host's own addresses are refused (first private one found, if any).
	addrs, _ := net.InterfaceAddrs()
	for _, ia := range addrs {
		if n, ok := ia.(*net.IPNet); ok {
			if h, ok := netip.AddrFromSlice(n.IP); ok && h.Unmap().IsPrivate() {
				if defaultGatewayTargetAllowed(h.Unmap()) {
					t.Errorf("host address %s allowed as a target", h)
				}
				break
			}
		}
	}
}
