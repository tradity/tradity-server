(function () { "use strict";

var _ = require('lodash');
var util = require('util');
var assert = require('assert');
var buscomponent = require('./stbuscomponent.js');
var qctx = require('./qctx.js');

function Misc () {
	Misc.super_.apply(this, arguments);
};

util.inherits(Misc, buscomponent.BusComponent);

Misc.prototype.getOwnOptions = buscomponent.provideQT('client-get-own-options', function(query, ctx, cb) {
	assert.ok(ctx.user);
	
	var r = _.clone(ctx.user);
	delete r.pwhash;
	delete r.pwsalt;
	cb('own-options-success', {'result': r});
});

Misc.prototype.ping = buscomponent.provideQT('client-ping', function(query, ctx, cb) {
	cb('pong', {'uid': ctx.user ? ctx.user.uid : null});
});

Misc.prototype.artificialError = buscomponent.provideQT('client-artificial-error', function(query, ctx, cb) {
	if (!ctx.access.has('server'))
		return cb('permission-denied');
	
	ctx.emitError(new Error('Client-induced non-failure'));
});

Misc.prototype.gatherPublicStatistics = buscomponent.provide('gatherPublicStatistics', ['reply'], function(cb) {
	var ctx = new qctx.QContext({parentComponent: this});
	
	ctx.query('SELECT COUNT(*) AS c FROM users WHERE deletiontime IS NULL', [], function(ures) {
		ctx.query('SELECT COUNT(*) AS c FROM orderhistory', [], function(ores) {
			ctx.query('SELECT COUNT(*) AS c FROM schools', [], function(sres) {
				cb({
					userCount: ures[0].c,
					tradeCount: ores[0].c,
					schoolCount: sres[0].c
				});
			});
		});
	});
});

exports.Misc = Misc;

})();
