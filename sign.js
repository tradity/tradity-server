var SignedMessaging = require('./signedmsg.js').SignedMessaging;
var cfg = require('./config.js').config;

var smdb = new SignedMessaging();
smdb.useConfig(cfg);

if (process.argv.length < 2) {
	console.log('signing requires a JSON-encoded object as a parameter');
	process.exit(0);
}

smdb.createSignedMessage(JSON.parse(process.argv[2])).then(function(msg) {
	console.log(msg);
}).done();
