#!/bin/bash

set -e

[ -e res/ ] && [ -e main.js ] && node -e ''

export DEBUG=''
export SOTRADE_CONFIG=test # indicates using config.test.js
export SOTRADE_ERROR_LOG_FILE=/tmp/errors-$(date +%s).log
export SOTRADE_DO_NOT_OUTPUT_ERRORS=1
export SOTRADE_NO_CLUSTER=1

if [ x"$SOTRADE_TEST_SKIP_DB_SETUP" = x"" ]; then
echo "Setting up database..." >&2

(cat res/testdb-preamendments.sql && \
 unxz < res/testdb.sql.xz && \
 cat res/testdb-postamendments.sql) | mysql --defaults-file=<(cat <<MYSQL_CONFIG
[client]
socket=$(node config db cluster MASTER socketPath)
password=$(node config db password)
user=$(node config db user)
database=$(node config db database)
MYSQL_CONFIG
)
else
echo "Skipping database setup..." >&2
fi

echo "Generating keys..." >&2
openssl genrsa 2048 > res/test-id_rsa
openssl rsa -in res/test-id_rsa -pubout > res/test-id_rsa.pub

echo "Starting server (error output at $SOTRADE_ERROR_LOG_FILE)..." >&2
touch "$SOTRADE_ERROR_LOG_FILE"

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
	mocha -s 15000 -t 80000 "$@" $file
done)

echo "Thank you for watching, please subscribe to my channel to view other tests" >&2
