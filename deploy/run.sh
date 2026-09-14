#!/bin/sh
# Runs one of the Amazon jobs with the environment loaded. Cron has almost no
# environment of its own, so it is loaded here rather than in the crontab line.
# Anything after the job name is passed through to the script (--dry-run, --only=…).
set -e
cd /opt/burrows-amazon
job="$1"
shift
set -a
. ./.env
set +a
exec /usr/bin/env node "scripts/$job.js" "$@"
