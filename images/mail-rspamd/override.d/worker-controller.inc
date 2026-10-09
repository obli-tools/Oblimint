# images/mail-rspamd — controller on the loopback ONLY (healthcheck, reload
# checks); never reachable from the mail network, never published (MA7).
bind_socket = "127.0.0.1:11334";
