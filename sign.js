#!/usr/bin/env node
"use strict";

const SignedMessaging = require('./signedmsg.js').SignedMessaging;
const cfg = require('./config.js').config();

const smdb = new SignedMessaging();
smdb.useConfig(cfg);

if (process.argv.length < 2) {
  console.log('signing requires a JSON-encoded object as a parameter');
  process.exit(0);
}

smdb.createSignedMessage(JSON.parse(process.argv[2])).then(function(msg) {
  console.log(msg);
}).catch(e => console.trace(e));
