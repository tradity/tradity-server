(function () { "use strict";

var sio = require('socket.io-client');
var fs = require('fs');
var assert = require('assert');
var _ = require('underscore');

var cfg = require('./config.js').config;

var socket = sio.connect('http://localhost:' + cfg.wsport);
var authorizationKey = fs.readFileSync(cfg['auth-key-file']).toString();
var key = '';

socket.on('connect', function() {	
	var emit = function (e, d) { console.log('outgoing', e, d); socket.emit(e, d); }
	socket.on('push', function (data) {
		console.log('incoming/push', data);
	});
	socket.on('response', function (data) {
		console.log('incoming/response', data);
	});
	
	emit('query', {
		type: 'prod',
		id: 'prod-query',
		authorizationKey: authorizationKey
	});
	setTimeout(function() {
		process.exit(0);
	}, 10000);
});

})();
