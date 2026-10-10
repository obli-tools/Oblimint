package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
)

// The P4b routes read their bodies with their own limits (decodeSegmentState,
// decodeWebFirewallState): a state larger than the generic 1 MiB body limit
// pushed through the real mux is applied, not refused as truncated JSON.
func TestP4bRoutesAcceptLargeStates(t *testing.T) {
	saved := p4bManagers
	t.Cleanup(func() { p4bManagers = saved })
	dir := t.TempDir()
	segNft := &fakeNft{available: true}
	webNft := &fakeNft{available: true}
	p4bManagers.segments = newSegmentManager(segNft, filepath.Join(dir, "run", "hostd-segments.json"))
	p4bManagers.webBans = newWebBanManager(webNft, filepath.Join(dir, "run", "hostd-webbans.json"))

	seg := SegmentState{Mode: segModeEnforce}
	for i := 0; i < 64; i++ {
		seg.Bridges = append(seg.Bridges, SegmentBridge{Name: fmt.Sprintf("omf%d", 1000+i), AccountID: int64(1000 + i), Fabric: "front"})
	}
	for i := 0; i < 16000; i++ {
		seg.Allow = append(seg.Allow, SegmentFlow{
			Bridge:   seg.Bridges[i%64].Name,
			Src:      fmt.Sprintf("100.%d.%d.%d", 100+i/65536, 100+(i/256)%100, 100+i%100),
			Dst:      fmt.Sprintf("200.%d.%d.%d", 100+i/65536, 100+(i/256)%100, 100+i%100),
			Protocol: "tcp", Port: 10000 + i%50000,
		})
	}
	web := WebFirewallState{Ports: []int{80, 443}}
	exp := "2026-10-10T12:34:56.789Z"
	for i := 0; i < 20000; i++ {
		web.Bans = append(web.Bans, WebBanEntry{CIDR: fmt.Sprintf("2a01:4f8:%x:%x::/64", 0x1000+i/0x1000, 0x1000+i%0x1000), ExpiresAt: &exp})
	}

	for _, tc := range []struct {
		target string
		state  any
		nft    *fakeNft
	}{
		{"/v1/segments", seg, segNft},
		{"/v1/firewall/web", web, webNft},
	} {
		body, err := json.Marshal(tc.state)
		if err != nil {
			t.Fatal(err)
		}
		if len(body) <= maxBodyBytes {
			t.Fatalf("%s: test state is only %d bytes, want > %d", tc.target, len(body), maxBodyBytes)
		}
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPut, tc.target, bytes.NewReader(body))
		newMux(&fakeOps{}, newLayout("/srv/oblimint"), nil, nil, nil).ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Errorf("PUT %s (%d bytes): status %d, body %s", tc.target, len(body), rec.Code, rec.Body.String())
		}
		if tc.nft.count() != 1 {
			t.Errorf("PUT %s: %d nft applies, want 1", tc.target, tc.nft.count())
		}
	}
}
