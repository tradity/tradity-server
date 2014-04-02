#!/bin/bash

TARGET="templates-compiled.js"

(
for file in templates/*; do 
	echo -n 'exports["'`basename "$file"`'"] = ' 
	sed -e "s/\\\\/\\\\\\\\/g" -e "s/\x27/\\\\\x27/g" -e "s/^/'/g" -e "s/$/\\\\n' + /g" < "$file"
	echo "'';"
done
) > "$TARGET"
