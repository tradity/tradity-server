(function () { "use strict";

var _ = require('underscore');
var util = require('util');
var assert = require('assert');
var buscomponent = require('./buscomponent.js');

function MiscDB () {
};

util.inherits(MiscDB, buscomponent.BusComponent);

MiscDB.prototype.getOwnOptions = buscomponent.provideQUA('client-get-own-options', function(query, user, access, cb) {
	var r = _.clone(user);
	delete r.pwhash;
	delete r.pwsalt;
	cb('own-options-success', {'result': r});
});

MiscDB.prototype.prod = buscomponent.provideQUA('client-prod', function(query, user, access, cb) {
	assert.ok(access);
	
	if (access.has('server') == -1)
		return cb('prod-not-allowed');
		
	var starttime = new Date().getTime();
	this.request({name: 'regularCallbackUser', query: query}, function() {
		var userdbtime = new Date().getTime();
		this.request({name: 'regularCallbackStocks', query: query}, function() {
			cb('prod-ready', {'utime': userdbtime - starttime, 'stime': new Date().getTime() - userdbtime});
		});
	});
});

MiscDB.prototype.logout = buscomponent.provideQUA('client-logout', function(query, user, access, cb) {
	this.request({name: 'logout', query: query, user: user, access: access}, function(code) {
		cb('logout-success', null, 'logout');
	});
});

MiscDB.prototype.ping = buscomponent.provideQUA('client-ping', function(query, user, access, cb) {
	cb('pong', {'uid': user ? user.uid : null});
});

MiscDB.prototype.clientGetConfig = buscomponent.provide('client-get-config', ['reply'], function(cb) {
	this.getServerConfig(function(cfg) {
		cb('get-config-success', {'config': _.pick(cfg, cfg.clientconfig)});
	});
});

MiscDB.prototype.fetchEvents = buscomponent.provideQUAX('client-fetch-events', function(query, user, access, xdata, cb) {
	cb('fetching-events');
	xdata.fetchEvents(query);
});

exports.MiscDB = MiscDB;

})();
