#!/bin/bash

set -e

[ -e res/ ] && [ -e main.js ] && node -e ''

export SOTRADE_TEST=1 # indicates using config.test.js
export SOTRADE_ERROR_LOG_FILE=/tmp/errors-$(date +%s).log
export SOTRADE_DO_NOT_OUTPUT_ERRORS=1

echo "Setting up database..." >&2

unxz < res/testdb.sql.xz | mysql --defaults-file=<(cat <<MYSQL_CONFIG
[client]
socket=$(node config db cluster MASTER socketPath)
password=$(node config db password)
user=$(node config db user)
database=$(node config db database)
MYSQL_CONFIG
)

echo "Starting server (error output at $SOTRADE_ERROR_LOG_FILE)..." >&2

node main & SOTRADE_SERVER_PID=$!

function finish {
	echo "Stopping server..." >&2
	node server-q shutdown --q-quiet=yes --q-timeout=200
	echo "Waiting for server process to quit..." >&2
	wait $SOTRADE_SERVER_PID
	rm -f "$SOTRADE_ERROR_LOG_FILE"
	echo "Done." >&2
}

trap finish EXIT

echo "Testing connectivity..." >&2
node server-q ping --q-quiet=yes --q-timeout=200

echo "Running tests..." >&2

time (for file in test/*.js; do
	echo "Running $file..." >&2
	mocha -s 5000 -t 25000 $file
done)

echo "Thank you for watching, please subscribe to my channel to view other tests" >&2
