package main

import (
	"net/http"
	"slices"
	"strconv"
	"time"
)

// P2 handlers: database instance dirs, firewall state, port gateway
// (contract: server/src/services/hostd/client.ts).

func (a *api) ensureDbInstance(w http.ResponseWriter, r *http.Request) {
	var body ownerBody
	accountID, err := pathID(r, "id")
	var instanceID int64
	if err == nil {
		instanceID, err = pathID(r, "iid")
	}
	if err == nil {
		err = decode(r, &body)
	}
	spec := DbInstanceSpec{AccountID: accountID, InstanceID: instanceID}
	if err == nil {
		spec.Owner, err = body.owner()
	}
	if err != nil {
		writeError(w, err)
		return
	}
	reply(w, r, okBody, a.ops.EnsureDbInstance(r.Context(), spec))
}

func (a *api) removeDbInstance(w http.ResponseWriter, r *http.Request) {
	accountID, err := pathID(r, "id")
	var instanceID int64
	if err == nil {
		instanceID, err = pathID(r, "iid")
	}
	var purge bool
	if err == nil {
		purge, err = queryBool(r, "purge")
	}
	if err != nil {
		writeError(w, err)
		return
	}
	reply(w, r, okBody, a.ops.RemoveDbInstance(r.Context(), accountID, instanceID, purge))
}

func (a *api) setDefaultDbSocket(w http.ResponseWriter, r *http.Request) {
	// {"instanceId": <id> | null}: null removes the link; the key is required.
	var instanceID *int64
	accountID, err := pathID(r, "id")
	var fam DbFamily
	if err == nil {
		fam, err = parseDbFamily(r.PathValue("family"))
	}
	var raw map[string]*int64
	if err == nil {
		err = decode(r, &raw)
	}
	if err == nil {
		v, ok := raw["instanceId"]
		if !ok {
			err = badRequest("instanceId is required (null removes the link)")
		}
		instanceID = v
	}
	if err != nil {
		writeError(w, err)
		return
	}
	reply(w, r, okBody, a.ops.SetDefaultDbSocket(r.Context(), accountID, fam, instanceID))
}

// ── Firewall ─────────────────────────────────────────────────────────────────

func (a *api) unsupported(w http.ResponseWriter) bool {
	if a.fw == nil || a.gw == nil {
		writeError(w, &apiError{http.StatusNotImplemented, codeUnsupported, "firewall / gateway not available"})
		return true
	}
	return false
}

func (a *api) firewallStatus(w http.ResponseWriter, r *http.Request) {
	if a.unsupported(w) {
		return
	}
	st := a.fw.Status(a.gw.Listeners())
	for id := range a.gw.Specs() {
		st.GatewayAccountIDs = append(st.GatewayAccountIDs, id)
	}
	slices.Sort(st.GatewayAccountIDs)
	writeJSON(w, http.StatusOK, st)
}

func (a *api) setFirewallGlobal(w http.ResponseWriter, r *http.Request) {
	if a.unsupported(w) {
		return
	}
	var body FirewallGlobal
	if err := decode(r, &body); err != nil {
		writeError(w, err)
		return
	}
	reply(w, r, okBody, a.fw.SetGlobal(r.Context(), body))
}

func (a *api) applyFirewall(w http.ResponseWriter, r *http.Request) {
	if a.unsupported(w) {
		return
	}
	var body FirewallAccountState
	accountID, err := pathID(r, "id")
	if err == nil {
		err = decode(r, &body)
	}
	if err != nil {
		writeError(w, err)
		return
	}
	reply(w, r, okBody, a.fw.SetAccount(r.Context(), accountID, body))
}

func (a *api) removeFirewall(w http.ResponseWriter, r *http.Request) {
	if a.unsupported(w) {
		return
	}
	accountID, err := pathID(r, "id")
	if err != nil {
		writeError(w, err)
		return
	}
	reply(w, r, okBody, a.fw.RemoveAccount(r.Context(), accountID))
}

// ── Gateway ──────────────────────────────────────────────────────────────────

func (a *api) setGateway(w http.ResponseWriter, r *http.Request) {
	if a.unsupported(w) {
		return
	}
	var body GatewaySpec
	accountID, err := pathID(r, "id")
	if err == nil {
		err = decode(r, &body)
	}
	if err == nil {
		body, err = body.validate(accountID)
	}
	if err != nil {
		writeError(w, err)
		return
	}
	reply(w, r, okBody, a.gw.Set(body))
}

func (a *api) removeGateway(w http.ResponseWriter, r *http.Request) {
	if a.unsupported(w) {
		return
	}
	accountID, err := pathID(r, "id")
	if err != nil {
		writeError(w, err)
		return
	}
	reply(w, r, okBody, a.gw.Remove(accountID))
}

// maxEventsWait bounds the long poll (the panel's timeout is 70 s).
const maxEventsWait = 55

func (a *api) gatewayEvents(w http.ResponseWriter, r *http.Request) {
	if a.unsupported(w) {
		return
	}
	wait := 0
	if s := r.URL.Query().Get("wait"); s != "" {
		n, err := strconv.Atoi(s)
		if err != nil || n < 0 {
			writeError(w, badRequest("wait must be a number of seconds"))
			return
		}
		wait = min(n, maxEventsWait)
	}
	events := a.gw.Events(r.Context(), time.Duration(wait)*time.Second)
	writeJSON(w, http.StatusOK, map[string]any{"events": events})
}
