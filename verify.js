#!/usr/bin/env node

var SignedMessaging = require('./signedmsg.js').SignedMessaging;
var cfg = require('./config.js').config;

var smdb = new SignedMessaging();
smdb.useConfig(cfg);

if (process.argv.length < 2) {
	console.log('verifying requires a verifiable message as a parameter');
	process.exit(0);
}

smdb.verifySignedMessage(process.argv[2], null).then(function(msg) {
	console.log(JSON.stringify(msg));
}).done();
