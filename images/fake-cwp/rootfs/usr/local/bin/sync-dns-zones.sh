#!/bin/sh
# CWP hourly zone sync (root crontab of the source). fake-cwp: cron is NOT running in the container,
# so the journal of the dynamic zone is never flushed into its .db file (CWP-MAP §9).
set -eu
/usr/sbin/rndc sync -clean
