#!/bin/bash
set -e
set -v
[ -e server.js ]
npm install
npm update
