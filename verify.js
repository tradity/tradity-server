#!/usr/bin/env node

"use strict";
const SignedMessaging = require('./signedmsg.js').SignedMessaging;
const cfg = require('./config.js').config();

const smdb = new SignedMessaging();
smdb.useConfig(cfg);

if (process.argv.length < 2) {
  console.log('verifying requires a verifiable message as a parameter');
  process.exit(0);
}

smdb.verifySignedMessage(process.argv[2], null).then(msg => {
  console.log(JSON.stringify(msg));
}).catch(e => console.trace(e));
