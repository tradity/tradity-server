(function () { "use strict";

var commonAPI = require('./common/sotrade-api.js');
var sio = require('socket.io-client');
var _ = require('lodash');

function NodeSoTradeConnection (opt) {
	var cfg = require('./config.js').config;
	
	try {
		if (!opt.messageSigner) {
			var SignedMessaging = require('./signedmsg.js').SignedMessaging;
			var smdb = new SignedMessaging();
			smdb.useConfig(cfg);
			opt.messageSigner = smdb;
		}
	} catch (e) {
		console.error(e);
	}

	try {
		opt.lzma = opt.lzma || new require('lzma-native').LZMA();
	} catch (e) {
		console.error(e);
	}
	
	try {
		opt.q = require('q');
		opt.q.longStackSupport = true;
	} catch (e) {
		console.error(e);
	}
	
	var url = opt.url;
	if (url && !opt.connect)
		opt.connect = function() { return sio.connect(url, opt.socketopts); };
	
	if (typeof opt.logDevCheck == 'undefined')
		opt.logDevCheck = true;
	
	return new commonAPI.SoTradeConnection(opt);
};

exports.SoTradeConnection = NodeSoTradeConnection;

})();
