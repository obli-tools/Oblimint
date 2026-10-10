package main

import (
	"net/http"
)

// ─────────────────────────────────────────────────────────────────────────────
// P4b routes (docs/P4b-PLAN.md §4.4, §9.4) — ARCHITECT FILE (frozen).
//
//   PUT /v1/segments       HostdSegmentState  → {ok}   segment policy of the account fabrics (segments.go,
//                                                       module segmentation): table bridge oblimint_seg
//   GET /v1/segments                          → SegmentStatus
//   PUT /v1/firewall/web   WebFirewallState   → {ok}   platform web bans on 80/443 (webbans.go, module
//                                                       honeypot-bans): table inet oblimint_web
//
// The managers are created by main() (newSegmentManager / newWebBanManager,
// both on the shared nftRunner, each with its own state file under <root>/run
// re-applied at start) and handed to newMux through p4bManagers. A nil manager
// answers 501 (tests of the older routes).
// ─────────────────────────────────────────────────────────────────────────────

// p4bManagers is set by main() before newMux (nil members = 501).
var p4bManagers struct {
	segments *segmentManager
	webBans  *webBanManager
}

func registerP4b(mux *http.ServeMux) {
	mux.HandleFunc("PUT /v1/segments", setSegments)
	mux.HandleFunc("GET /v1/segments", segmentsStatus)
	mux.HandleFunc("PUT /v1/firewall/web", setWebFirewall)
}

func p4bUnsupported(w http.ResponseWriter, what string) {
	writeError(w, &apiError{http.StatusNotImplemented, codeUnsupported, what + " not available"})
}

func setSegments(w http.ResponseWriter, r *http.Request) {
	m := p4bManagers.segments
	if m == nil {
		p4bUnsupported(w, "segments")
		return
	}
	body, err := decodeSegmentState(w, r)
	if err != nil {
		writeError(w, err)
		return
	}
	reply(w, r, okBody, m.Apply(r.Context(), body))
}

func segmentsStatus(w http.ResponseWriter, _ *http.Request) {
	m := p4bManagers.segments
	if m == nil {
		p4bUnsupported(w, "segments")
		return
	}
	writeJSON(w, http.StatusOK, m.Status())
}

func setWebFirewall(w http.ResponseWriter, r *http.Request) {
	m := p4bManagers.webBans
	if m == nil {
		p4bUnsupported(w, "web firewall")
		return
	}
	body, err := decodeWebFirewallState(w, r)
	if err != nil {
		writeError(w, err)
		return
	}
	reply(w, r, okBody, m.Apply(r.Context(), body))
}
