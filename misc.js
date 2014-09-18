(function () { "use strict";

var _ = require('underscore');
var util = require('util');
var assert = require('assert');
var buscomponent = require('./buscomponent.js');

function MiscDB () {
};

util.inherits(MiscDB, buscomponent.BusComponent);

MiscDB.prototype.getOwnOptions = buscomponent.provideQT('client-get-own-options', function(query, ctx, cb) {
	assert.ok(ctx.user);
	
	var r = _.clone(ctx.user);
	delete r.pwhash;
	delete r.pwsalt;
	cb('own-options-success', {'result': r});
});

MiscDB.prototype.logout = buscomponent.provideQT('client-logout', function(query, ctx, cb) {
	this.request({name: 'logout', query: query, ctx: ctx}, function(code) {
		cb('logout-success', null, 'logout');
	});
});

MiscDB.prototype.ping = buscomponent.provideQT('client-ping', function(query, ctx, cb) {
	cb('pong', {'uid': ctx.user ? ctx.user.uid : null});
});

MiscDB.prototype.clientGetConfig = buscomponent.provide('client-server-config', ['reply'], function(cb) {
	this.getServerConfig(function(cfg) {
		cb('server-config-success', {'config': _.pick(cfg, cfg.clientconfig)});
	});
});

exports.MiscDB = MiscDB;

})();
