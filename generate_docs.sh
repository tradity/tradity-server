#!/bin/bash

./node_modules/.bin/jsdoc *.js stockloaders/*.js lib/*.js \
  node_modules/tradity-connection/*.js \
  README.md --destination ./doc/ \
  || true
