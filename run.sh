#!/bin/sh
export NODE_ENV=production
exec node main.js >>output.log 2>&1
