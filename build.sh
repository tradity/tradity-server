#!/bin/bash
set -e
set -v
npm install
npm update
./compile-templates.sh
./generate_docs.sh
