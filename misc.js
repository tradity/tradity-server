(function () { "use strict";

var _ = require('lodash');
var util = require('util');
var assert = require('assert');
var buscomponent = require('./stbuscomponent.js');
var qctx = require('./qctx.js');

/**
 * Provides handlers for client requests not fitting into any of
 * the other modules.
 * 
 * @public
 * @module misc
 */

function Misc () {
	Misc.super_.apply(this, arguments);
};

util.inherits(Misc, buscomponent.BusComponent);

/**
 * Return all information about the current user.
 * 
 * @return {object}  Returns with <code>own-options-success</code> and
 *                   sets <code>.result</code> to an {@link module:user~UserEntryBase}.
 * 
 * @function c2s~get-own-options
 */
Misc.prototype.getOwnOptions = buscomponent.provideQT('client-get-own-options', function(query, ctx, cb) {
	assert.ok(ctx.user);
	
	var r = _.clone(ctx.user);
	delete r.pwhash;
	delete r.pwsalt;
	cb('own-options-success', {'result': r});
});

/**
 * Says hello.
 * 
 * @return {object}  Returns with <code>pong</code> and sets <code>.uid</code>
 *                   to the requesting user’s numerical id or <code>null</code>.
 * 
 * @loginignore
 * @function c2s~ping
 */
Misc.prototype.ping = buscomponent.provideQT('client-ping', function(query, ctx, cb) {
	cb('pong', {'uid': ctx.user ? ctx.user.uid : null});
});

/**
 * Throws an error (for testing error handling systems).
 * This requires appropiate privileges.
 * 
 * @return {object}  Returns with <code>artificial-error-success</code>.
 * 
 * @function c2s~artificial-error
 */
Misc.prototype.artificialError = buscomponent.provideQT('client-artificial-error', function(query, ctx, cb) {
	if (!ctx.access.has('server'))
		return cb('permission-denied');
	
	ctx.emitError(new Error('Client-induced non-failure'));
	cb('artificial-error-success');
});

/**
 * Internally produces an database deadlock (for testing purposes).
 * This requires appropiate privileges.
 * 
 * @return {object}  Returns with <code>artificial-deadlock-success</code>.
 * 
 * @function c2s~artificial-deadlock
 */
Misc.prototype.artificialError = buscomponent.provideWQT('client-artificial-deadlock', function(query, ctx, cb) {
	if (!ctx.access.has('server'))
		return cb('permission-denied');
	
	ctx.query('CREATE TABLE IF NOT EXISTS deadlocktest (id INT AUTO_INCREMENT, value INT, PRIMARY KEY (id))', [], function() {
	ctx.query('INSERT INTO deadlocktest (value) VALUES (0), (0)', [], function(r) {
	var id = r.insertId;
	
	ctx.startTransaction(function /* restart*/() {
		cb('artificial-deadlock-success');
	}, function(conn1, commit1, rollback1) {
		ctx.startTransaction(function(conn2, commit2, rollback2) {
			conn1.query('UPDATE deadlocktest SET value = 1 WHERE id = ?', [id], function() {
			conn2.query('UPDATE deadlocktest SET value = 2 WHERE id = ?', [id+1], function() {
			conn1.query('UPDATE deadlocktest SET value = 3 WHERE id = ?', [id+1], function() {
			conn2.query('UPDATE deadlocktest SET value = 4 WHERE id = ?', [id], function() {
			});
			});
			});
			});
		});
	});
	
	});
	});
});

/**
 * Presents statistics that can safely be displayed to the general public.
 * 
 * @return {object}  Calls the reply callback with an associative array of variables
 *                   (currently <code>userCount, tradeCount, schoolCount</code>).
 * 
 * @function busreq~gatherPublicStatistics
 */
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
