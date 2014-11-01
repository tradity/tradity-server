(function () { "use strict";

var sio = require('socket.io-client');
var fs = require('fs');
var https = require('https');
var assert = require('assert');
var util = require('util');
var _ = require('lodash');

var cfg = require('./config.js').config;
var SignedMessagingDB = require('./signedmsg.js').SignedMessagingDB;

var smdb = new SignedMessagingDB();
smdb.useConfig(cfg);
var options = process.argv.splice(2);

assert.ok(options.length > 0);

var query = {
	type: options[0],
	id: 'server-q-query'
};

for (var i = 1; i < options.length; ++i) {
	var p = options[i].match(/-{0,2}(\w+)=(.+)/);
	
	var value = p[2];
	if (value == 'false') value = false;
	if (value == 'true')  value = true;
	if (value == 'null')  value = null;
	
	if (value[0] == '$')  value = eval(value.substr(1));
	
	query[p[1]] = value;
}

var protocol = cfg.http.secure ? 'https' : 'http';
var socket = sio.connect(query.wsurl || (protocol + '://' +
	(query.wshost || cfg.wshoste || cfg.wshost) + ':' +
	(query.wsport || cfg.wsporte || cfg.wsports[0])), query.ssldefault ? { 
		agent: new https.Agent(cfg.ssl)
		}: null);
var key = '';

if (query.timeout) {
	setTimeout(function() {
		console.log('timeout exceeded');
		process.exit(1);
	}, query.timeout * 1000);
}

socket.on('connect', function() {
	var emit = function (e, d, sign) {
		d.quiet || console.log('outgoing', e, JSON.stringify(d, null, 2));
		
		if (sign) {
			smdb.createSignedMessage(d, function(signedD) {
				socket.emit(e, { signedContent: signedD }); 
			});
		} else {
			socket.emit(e, d);
		}
	};
	
	socket.on('push', function (data) {
		query.quiet || console.log('incoming/push', JSON.stringify(data, null, 2));
	});
	
	socket.on('response', function (data) {
		assert.equal(data.e, 'raw');
		
		query.quiet || console.log('incoming/response', util.inspect(JSON.parse(data.s)));
		
		if (!query.lurk)
			process.exit(0);
	});
	
	emit('query', query, true);
});

})();
