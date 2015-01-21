(function () { "use strict";

var _ = require('lodash');
var util = require('util');
var assert = require('assert');
var Q = require('q');
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
 * @return {object}  Returns with <code>get-own-options-success</code> and
 *                   sets <code>.result</code> to an {@link module:user~UserEntryBase}.
 * 
 * @function c2s~get-own-options
 */
Misc.prototype.getOwnOptions = buscomponent.provideQT('client-get-own-options', function(query, ctx, cb) {
	assert.ok(ctx.user);
	
	var r = _.clone(ctx.user);
	delete r.pwhash;
	delete r.pwsalt;
	return cb('get-own-options-success', {'result': r});
});

/**
 * Update the client storage for a certain user.
 * 
 * @return {object}  Returns with <code>set-clientstorage-success</code>.
 * 
 * @function c2s~set-clientstorage
 */
Misc.prototype.setClientStorage = buscomponent.provideQT('client-set-clientstorage', function(query, ctx, cb) {
	try {
		var storage = new Buffer(query.storage);
	} catch (e) {
		return cb('format-error');
	}
	
	return ctx.query('UPDATE users_data SET clientstorage = ? WHERE id = ?', [storage, ctx.user.id]).then(function() {
		return cb('set-clientstorage-success');
	});
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
	return cb('pong', {'uid': ctx.user ? ctx.user.uid : null});
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
	return cb('artificial-error-success');
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
	
	var conn1, conn2;
	return ctx.query('CREATE TABLE IF NOT EXISTS deadlocktest (id INT AUTO_INCREMENT, value INT, PRIMARY KEY (id))', []).then(function() {
		return ctx.query('INSERT INTO deadlocktest (value) VALUES (0), (0)', []);
	}).then(function(r) {
		var id = r.insertId;
		return ctx.startTransaction({}, {restart: function() {
		cb('artificial-deadlock-success');
	}}).then(function(conn1_) {
		conn1 = conn1_;
		return ctx.startTransaction();
	}).then(function(conn2_) {
		conn2 = conn2_;
		return conn1.query('UPDATE deadlocktest SET value = 1 WHERE id = ?', [id]);
	}).then(function() {
		return conn2.query('UPDATE deadlocktest SET value = 2 WHERE id = ?', [id+1]);
	}).then(function() {
		return conn1.query('UPDATE deadlocktest SET value = 3 WHERE id = ?', [id+1]);
	}).then(function() {
		return conn2.query('UPDATE deadlocktest SET value = 4 WHERE id = ?', [id]);
	});
});

/**
 * Internally produces a DB transaction which is released after 5 minutes.
 * This requires appropiate privileges. Go somewhere else if
 * you even consider trying this out in a production environment.
 * 
 * @return {object}  Returns with <code>artificial-stalelock-success</code>.
 * 
 * @function c2s~artificial-stalelock
 */
Misc.prototype.artificialError = buscomponent.provideWQT('client-artificial-stalelock', function(query, ctx, cb) {
	if (!ctx.access.has('server'))
		return cb('permission-denied');
	
	var conn;
	return ctx.startTransaction({httpresources: 'w'}).then(function(conn_) {
		conn = conn_;
		return Q.delay(5 * 60000);
	}).then(_.bind(conn.commit, conn));
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
	
	var ret = {};
	return ctx.query('SELECT COUNT(*) AS c FROM users WHERE deletiontime IS NULL', []).then(function(ures) {
		ret.userCount = ures[0].c;
		return ctx.query('SELECT COUNT(*) AS c FROM orderhistory', []);
	}).then(function(ores) {
		ret.tradeCount = ores[0].c;
		return ctx.query('SELECT COUNT(*) AS c FROM schools', []);
	}).then(function(sres) {
		ret.schoolCount = sres[0].c;
		
		return cb(ret);
	});
});

exports.Misc = Misc;

})();
