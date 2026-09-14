#!/bin/sh
# Runs one of the Amazon jobs with the environment loaded. Cron has almost no
# environment of its own, so it is loaded here rather than in the crontab line.
set -e
cd /opt/burrows-amazon
set -a
. ./.env
set +a
exec /usr/bin/env node "scripts/$1.js"
