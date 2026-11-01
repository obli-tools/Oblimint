package main

import (
	"context"
	"fmt"
	"regexp"
	"strings"
	"time"
)

// ─────────────────────────────────────────────────────────────────────────────
// Docker side of the publication (verified on Docker 24 / 29, iptables and
// nftables backends, docs: the dnatexp*.sh experiments of the 032 design).
// A connection DNAT-ed by table ip oblimint_pub towards a container of an
// account fabric is dropped by Docker's own forward rules (Docker 28+:
// "DOCKER ! -i <br> -o <br> DROP"; FORWARD policy DROP of a real host on 24):
//
//   iptables backend (iptables-nft, the default, or iptables-legacy): ONE
//     rule in DOCKER-USER, the chain Docker reserves for its users:
//       -m connmark --mark M/M -m comment --comment oblimint-publish -j ACCEPT
//     The ct mark M is set by our DNAT rules only (no tenant container holds
//     NET_ADMIN): the ACCEPT widens nothing else. Inserted idempotently (-C
//     then -I 1) at every apply and every 60 s (Docker recreates its chains
//     at restart), removed when nothing is published. Written through the
//     iptables binaries ONLY: writing Docker's iptables-nft tables with nft
//     would break Docker's own iptables calls.
//   nftables backend (Docker 29 --firewall-backend=nftables): no DOCKER-USER;
//     the daemon must run with "bridge-accept-fwmark": "M/M" (daemon.json)
//     and our markcopy chain copies the ct mark to the packet mark. hostd
//     never changes the daemon: it reports fwmarkMissing with the remedy.
//
// The drops of inet oblimint (bans, egress, priority -10) and inet
// oblimint_web stay first: a drop is final whatever DOCKER-USER says.
// ─────────────────────────────────────────────────────────────────────────────

const (
	publishComment = "oblimint-publish"
	// Backends reported by GET /v1/publish.
	backendIptablesNft    = "iptables-nft"
	backendIptablesLegacy = "iptables-legacy"
	backendDockerNft      = "docker-nftables"
	backendNone           = "none"
	acceptOK              = "ok"
	acceptMissing         = "missing"
	acceptFwmarkMissing   = "fwmarkMissing"
)

type dockerAccept struct {
	run      runner
	lookPath func(string) (string, error)
}

// acceptResult is the outcome of one ensure pass.
type acceptResult struct {
	Backend     string
	State       string
	Remediation string
	Err         error
}

func (d *dockerAccept) has(bin string) bool {
	if d.lookPath == nil {
		return false
	}
	_, err := d.lookPath(bin)
	return err == nil
}

func (d *dockerAccept) call(ctx context.Context, name string, args ...string) (string, error) {
	cctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	out, err := d.run(cctx, name, args...)
	return string(out), err
}

// iptablesBackends: the iptables binaries whose filter table has Docker's DOCKER-USER chain.
func (d *dockerAccept) iptablesBackends(ctx context.Context) []string {
	var out []string
	for _, bin := range []string{backendIptablesNft, backendIptablesLegacy} {
		if !d.has(bin) {
			continue
		}
		if _, err := d.call(ctx, bin, "-w", "5", "-t", "filter", "-S", "DOCKER-USER"); err == nil {
			out = append(out, bin)
		}
	}
	return out
}

func acceptRuleArgs(mark uint32) []string {
	m := fmt.Sprintf("0x%08x/0x%08x", mark, mark)
	return []string{"-m", "connmark", "--mark", m, "-m", "comment", "--comment", publishComment, "-j", "ACCEPT"}
}

var fwmarkRuleRe = regexp.MustCompile(`meta mark & (0x[0-9a-f]+) == (0x[0-9a-f]+)`)

// dockerNftAccepts: does Docker's nftables ruleset accept packets carrying the mark (bridge-accept-fwmark)?
func dockerNftAccepts(ruleset string, mark uint32) bool {
	for _, m := range fwmarkRuleRe.FindAllStringSubmatch(ruleset, -1) {
		var a, b uint64
		if _, err := fmt.Sscanf(m[1], "0x%x", &a); err != nil {
			continue
		}
		if _, err := fmt.Sscanf(m[2], "0x%x", &b); err != nil {
			continue
		}
		if uint32(a)&mark == mark && uint32(b)&mark == mark {
			return true
		}
	}
	return false
}

// Ensure makes Docker accept the marked connections (want) or removes our rule (!want).
func (d *dockerAccept) Ensure(ctx context.Context, mark uint32, want bool) acceptResult {
	if d.run == nil {
		return acceptResult{Backend: backendNone, State: acceptMissing}
	}
	bins := d.iptablesBackends(ctx)
	if len(bins) > 0 {
		res := acceptResult{Backend: bins[0], State: acceptOK}
		args := acceptRuleArgs(mark)
		for _, bin := range bins {
			_, checkErr := d.call(ctx, bin, append([]string{"-w", "5", "-C", "DOCKER-USER"}, args...)...)
			present := checkErr == nil
			switch {
			case want && !present:
				if _, err := d.call(ctx, bin, append([]string{"-w", "5", "-I", "DOCKER-USER", "1"}, args...)...); err != nil {
					res.State = acceptMissing
					res.Err = fmt.Errorf("%s: DOCKER-USER rule not inserted: %w", bin, err)
				}
			case !want && present:
				for i := 0; i < 8; i++ { // every copy (several hostd versions, manual inserts)
					if _, err := d.call(ctx, bin, append([]string{"-w", "5", "-D", "DOCKER-USER"}, args...)...); err != nil {
						break
					}
				}
			}
		}
		if !want {
			res.State = acceptMissing
		}
		return res
	}
	if d.has("nft") {
		if out, err := d.call(ctx, "nft", "list", "table", "ip", "docker-bridges"); err == nil {
			res := acceptResult{Backend: backendDockerNft, State: acceptOK}
			if !dockerNftAccepts(out, mark) {
				res.State = acceptFwmarkMissing
				res.Remediation = fmt.Sprintf(`Docker runs its nftables firewall backend: add "bridge-accept-fwmark": "0x%08x/0x%08x" to /etc/docker/daemon.json and restart Docker (owner's decision), or use the default iptables backend.`, mark, mark)
			}
			return res
		}
	}
	res := acceptResult{Backend: backendNone, State: acceptMissing}
	if want {
		res.Remediation = "No Docker firewall chain found (DOCKER-USER / table ip docker-bridges): is Docker running with its firewall enabled? The image needs iptables / iptables-legacy."
	}
	return res
}

// trimLines keeps a command output short for an error message.
func trimLines(s string, n int) string {
	lines := strings.Split(strings.TrimSpace(s), "\n")
	if len(lines) > n {
		lines = lines[:n]
	}
	return strings.Join(lines, " | ")
}
