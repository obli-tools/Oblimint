package main

import (
	"net/http"
)

// ─────────────────────────────────────────────────────────────────────────────
// Public ports + dedicated IPs (publish.go, netaddr.go, dockeraccept.go):
//
//   PUT /v1/publish        PublishState → PublishReply   replaces the whole publication state
//   GET /v1/publish                     → PublishStatus  backend, Docker rule, addresses, counter
//   GET /v1/net/interfaces              → {interfaces: NetInterface[]}
//   GET /v1/net/listeners               → {listeners: HostListener[]}
//
// The manager is created by main() (after the segment manager: R2 reads the
// applied front bridges) and handed through pubManagers (nil = 501).
// ─────────────────────────────────────────────────────────────────────────────

var pubManagers struct {
	publish *publishManager
	net     netOps
}

func registerPub(mux *http.ServeMux) {
	mux.HandleFunc("PUT /v1/publish", setPublish)
	mux.HandleFunc("GET /v1/publish", publishStatus)
	mux.HandleFunc("GET /v1/net/interfaces", netInterfaces)
	mux.HandleFunc("GET /v1/net/listeners", netListeners)
}

func setPublish(w http.ResponseWriter, r *http.Request) {
	m := pubManagers.publish
	if m == nil {
		p4bUnsupported(w, "publish")
		return
	}
	body, err := decodePublishState(w, r)
	if err != nil {
		writeError(w, err)
		return
	}
	res, err := m.Apply(r.Context(), body)
	if err != nil {
		reply(w, r, nil, err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

func publishStatus(w http.ResponseWriter, _ *http.Request) {
	m := pubManagers.publish
	if m == nil {
		p4bUnsupported(w, "publish")
		return
	}
	writeJSON(w, http.StatusOK, m.Status())
}

func netInterfaces(w http.ResponseWriter, r *http.Request) {
	n := pubManagers.net
	if n == nil {
		p4bUnsupported(w, "network interfaces")
		return
	}
	list, err := n.Interfaces()
	if err != nil {
		reply(w, r, nil, err)
		return
	}
	if list == nil {
		list = []NetInterface{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"interfaces": list})
}

func netListeners(w http.ResponseWriter, r *http.Request) {
	n := pubManagers.net
	if n == nil {
		p4bUnsupported(w, "listeners")
		return
	}
	list, err := n.Listeners()
	if err != nil {
		reply(w, r, nil, err)
		return
	}
	if list == nil {
		list = []HostListener{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"listeners": list})
}
