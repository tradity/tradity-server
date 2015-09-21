#!/bin/sh
export NODE_ENV=production
export DEBUG='sotrade:error'
exec node main.js >>output.$$.log 2>&1
