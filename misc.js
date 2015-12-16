(function () { "use strict";

var _ = require('lodash');
var util = require('util');
var assert = require('assert');
var buscomponent = require('./stbuscomponent.js');
var qctx = require('./qctx.js');
var debug = require('debug')('sotrade:misc');

/**
 * Provides handlers for client requests not fitting into any of
 * the other modules.
 * 
 * @public
 * @module misc
 */
class Misc extends buscomponent.BusComponent {
  constructor() {
    super();
  }
}

/**
 * Return all information about the current user.
 * 
 * @return {object}  Returns with <code>get-own-options-success</code> and
 *                   sets <code>.result</code> to an {@link module:user~UserEntryBase}.
 * 
 * @function c2s~get-own-options
 */
Misc.prototype.getOwnOptions = buscomponent.provideQT('client-get-own-options', function(query, ctx) {
  assert.ok(ctx.user);
  
  var r = _.clone(ctx.user);
  assert.ok(!r.pwsalt);
  assert.ok(!r.pwhash);
  r.id = r.uid; // backwards compatibility
  return { code: 'get-own-options-success', 'result': r };
});

/**
 * Update the client storage for a certain user.
 * 
 * @return {object}  Returns with <code>set-clientstorage-success</code>.
 * 
 * @function c2s~set-clientstorage
 */
Misc.prototype.setClientStorage = buscomponent.provideQT('client-set-clientstorage', function(query, ctx) {
  try {
    var storage = new Buffer(query.storage);
  } catch (e) {
    throw new this.FormatError(e);
  }
  
  return ctx.query('UPDATE users_data SET clientstorage = ? WHERE uid = ?', [storage, ctx.user.uid]).then(function() {
    return { code: 'set-clientstorage-success' };
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
Misc.prototype.ping = buscomponent.provideQT('client-ping', function(query, ctx) {
  return { code: 'pong', uid: ctx.user ? ctx.user.uid : null };
});

/**
 * Throws an error (for testing error handling systems).
 * This requires appropiate privileges.
 * 
 * @return {object}  Returns with <code>artificial-error-success</code>.
 * 
 * @function c2s~artificial-error
 */
Misc.prototype.artificialError = buscomponent.provideQT('client-artificial-error', function(query, ctx) {
  if (!ctx.access.has('server'))
    throw new this.PermissionDenied();
  
  debug('Creating artificial error');
  ctx.emitError(new Error('Client-induced non-failure'));
  return { code: 'artificial-error-success' };
});

/**
 * Internally produces an database deadlock (for testing purposes).
 * This requires appropiate privileges.
 * 
 * @return {object}  Returns with <code>artificial-deadlock-success</code>.
 * 
 * @function c2s~artificial-deadlock
 */
Misc.prototype.artificialDeadlock = buscomponent.provideWQT('client-artificial-deadlock', function(query, ctx) {
  if (!ctx.access.has('server'))
    throw new this.PermissionDenied();
  
  debug('Creating artificial deadlock');
  var conn1, conn2, id;
  var deferred = Promise.defer();
  
  return ctx.query('CREATE TABLE IF NOT EXISTS deadlocktest (id INT AUTO_INCREMENT, value INT, PRIMARY KEY (id))').then(function() {
    return ctx.query('INSERT INTO deadlocktest (value) VALUES (0), (0)');
  }).then(function(r) {
    id = r.insertId;
    return ctx.startTransaction({}, {restart: function() {
      return ctx.query('DROP TABLE deadlocktest').then(function() {
        return deferred.resolve({ code: 'artificial-deadlock-success' });
      });
    }});
  }).then(function(conn1_) {
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
  }).then(function() {
    return deferred.promise;
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
Misc.prototype.artificialStalelock = buscomponent.provideWQT('client-artificial-stalelock', function(query, ctx) {
  if (!ctx.access.has('server'))
    throw new this.PermissionDenied();
  
  debug('Creating artificial stale lock');
  
  var conn;
  return ctx.startTransaction({httpresources: 'w'}).then(function(conn_) {
    conn = conn_;
    return Q.delay(5 * 60000);
  }).then(_.bind(conn.commit, conn));
});

/**
 * Sets the readonly mode of the network. Requires appropiate privileges.
 * Only try this at home.
 * 
 * @return {object}  Returns with <code>force-readonly-success</code>.
 * 
 * @function c2s~force-readonly
 */
Misc.prototype.forceReadonly = buscomponent.provideQT('client-force-readonly', function(query, ctx) {
  if (!ctx.access.has('server'))
    throw new this.PermissionDenied();
  
  debug('Force into readability mode', query.readonly);
  
  this.emitImmediate('change-readability-mode', { readonly: query.readonly ? true : false });
  
  return { code: 'force-readonly-success' };
});

/**
 * Internally produces a DB error.
 * 
 * @return {object}  Returns with <code>artificial-dberror-success</code>.
 * 
 * @function c2s~artificial-dberror
 */
Misc.prototype.artificialDBError = buscomponent.provideWQT('client-artificial-dberror', function(query, ctx) {
  if (!ctx.access.has('server'))
    throw new this.PermissionDenied();
  
  debug('Query with invalid SQL');
  
  return ctx.query('INVALID SQL').catch(function(err) {
    return { code: 'artificial-dberror-success', err: err };
  });
});

/**
 * Presents statistics that can safely be displayed to the general public.
 * 
 * @return {object}  Returns an associative array of variables
 *                   (currently <code>userCount, tradeCount, schoolCount</code>).
 * 
 * @function busreq~gatherPublicStatistics
 */
Misc.prototype.gatherPublicStatistics = buscomponent.provide('gatherPublicStatistics', [], function() {
  var ctx = new qctx.QContext({parentComponent: this});

  return Promise.all([
    ctx.query('SELECT COUNT(*) AS c FROM users WHERE deletiontime IS NULL'),
    ctx.query('SELECT COUNT(*) AS c FROM orderhistory'),
    ctx.query('SELECT COUNT(*) AS c FROM schools')
  ]).spread(function(ures, ores, sres) {
    return {
      userCount: ures[0].c,
      tradeCount: ores[0].c,
      schoolCount: sres[0].c
    };
  });
});

exports.Misc = Misc;

})();
