# images/mail-rspamd — milter for Postfix (oblimint-mail). No authentication
# (a milter client may claim any SASL user and get a DKIM signature): the
# container is on the engine back-end network oblimint-mail-core ONLY (engine,
# Redis, scanner) — never on oblimint-mail (webmail, edge, panel, site relay)
# — and publishes no port. self_scan = the proxy scans by itself (no separate
# normal worker).
bind_socket = "*:11332";
milter = yes;
timeout = 120s;
count = 2;
discard_on_reject = false;
quarantine_on_reject = false;
reject_message = "Spam message rejected";
upstream "local" {
  default = yes;
  self_scan = yes;
}
