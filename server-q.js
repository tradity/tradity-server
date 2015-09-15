#!/usr/bin/env node
(function () { "use strict";

Error.stackTraceLimit = Infinity;

var fs = require('fs');
var https = require('https');
var assert = require('assert');
var util = require('util');
var _ = require('lodash');

var cfg = require('./config.js').config();
var sotradeClient = require('./sotrade-client.js');

var options = process.argv.splice(2);

assert.ok(options.length > 0);

var query = {
	type: options[0],
	id: 'server-q-query'
};

for (var i = 1; i < options.length; ++i) {
	var p = options[i].match(/^-{0,2}([\w_-]+)=(.*)$/);
	
	var value = p[2];
	if (value == 'false') value = false;
	if (value == 'true')  value = true;
	if (value == 'null')  value = null;
	
	if (value && value.length > 0 && value[0] == '$')  value = eval(value.substr(1));
	
	query[p[1]] = value;
}

var protocol = cfg.protocol;
var socket = new sotradeClient.SoTradeConnection({
	url: query.wsurl || (protocol + '://' +
		(query.wshost || cfg.wshoste || cfg.wshost) + ':' +
		(query.wsport || cfg.wsporte || cfg.wsports[0])),
	socketopts: query.ssldefault ? { 
		agent: new https.Agent(cfg.ssl)
	} : null,
	logDevCheck: !query['q-quiet']
});

if (query['q-timeout']) {
	setTimeout(function() {
		console.log('timeout exceeded');
		process.exit(1);
	}, query['q-timeout'] * 1000);
}

socket.once('server-config').then(function() {
	return socket.emit(query.type, query);
}).then(function(data) {
	if (query.resultPath) {
		var path = String(query.resultPath).split('.');
		
		console.log(_.reduce(path, _.result, data));
	}
	
	if (!query.lurk)
		process.exit(0);
}).done();

})();
