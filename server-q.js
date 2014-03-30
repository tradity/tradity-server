(function () { "use strict";

var sio = require('socket.io-client');
var fs = require('fs');
var assert = require('assert');
var _ = require('underscore');

var cfg = require('./config.js').config;

var socket = sio.connect('http://' + cfg.wshost + ':' + cfg.wsport);
var authorizationKey = fs.readFileSync(cfg['auth-key-file']).toString();
var key = '';

var options = process.argv.splice(2);

assert.ok(options.length > 0);

var query = {
	type: options[0],
	id: 'server-q-query',
	authorizationKey: authorizationKey
};

for (var i = 1; i < options.length; ++i) {
	var p = options[i].match(/-{0,2}(\w+)=(\S*)/);
	query[p[1]] = p[2];
}

socket.on('connect', function() {	
	var emit = function (e, d) { query.quiet || console.log('outgoing', e, d); socket.emit(e, d); }
	socket.on('response', function (data) {
		query.quiet || console.log('incoming/response', JSON.stringify(data, null, 2));
		process.exit(0);
	});
	
	emit('query', query);
});

})();
