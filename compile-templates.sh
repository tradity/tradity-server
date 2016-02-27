#!/bin/bash

# XXX throw this file out in favour of dynamic loading

TARGET="templates-compiled.js"

(
for file in templates/*/*; do
	filename=$(basename "$file")
	lang=$(basename $(dirname "$file"))
	echo -n "exports['$lang'] = exports['$lang'] || {};"
	echo -n "exports['$lang']['$filename'] = "
	sed -e "s/\\\\/\\\\\\\\/g" -e "s/\x27/\\\\\x27/g" -e "s/^/'/g" -e "s/$/\\\\n' + /g" < "$file"
	echo "'';"
done
) > "$TARGET"
