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
	socket.on('response', function (data) {
		console.log('incoming/response', data);
		process.exit(0);
	});
	
	emit('query', {
		type: 'stock-search',
		id: 'stock-search-query',
		name: process.argv[2],
		authorizationKey: authorizationKey
	});
});

})();
