#!/bin/bash
set -e
set -v
[ -e server.js ]
echo "module.exports = 'SOTS$(date +%s)-$(git rev-parse HEAD)';" > buildstamp.js
npm install
npm update
./compile-templates.sh
./generate_docs.sh
