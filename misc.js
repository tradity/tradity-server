(function () { "use strict";

var _ = require('underscore');
var util = require('util');
var assert = require('assert');
var buscomponent = require('./buscomponent.js');

function MiscDB () {
};

util.inherits(MiscDB, buscomponent.BusComponent);

MiscDB.prototype.getOwnOptions = buscomponent.provideQUA('client-get-own-options', function(query, user, access, cb) {
	assert.ok(user);
	
	var r = _.clone(user);
	delete r.pwhash;
	delete r.pwsalt;
	cb('own-options-success', {'result': r});
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

exports.MiscDB = MiscDB;

})();
