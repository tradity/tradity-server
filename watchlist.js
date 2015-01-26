(function () { "use strict";

var _ = require('lodash');
var util = require('util');
var assert = require('assert');
var buscomponent = require('./stbuscomponent.js');

/**
 * Provides methods for loading and changing user watchlists.
 * 
 * @public
 * @module watchlist
 */

/**
 * Main object of the {@link module:watchlist} module
 * @public
 * @constructor module:watchlist~Watchlist
 * @augments module:stbuscomponent~STBusComponent
 */
function Watchlist () {
	Watchlist.super_.apply(this, arguments);
};

util.inherits(Watchlist, buscomponent.BusComponent);

/**
 * Indicates that one user added a stock or another user to their watchlist.
 * 
 * @typedef s2c~watch-add
 * @type {Event}
 * 
 * @property {int} watched  The numerical ID of the watched stock
 * @property {?int} watcheduser  The numerical ID of the watched leader
 * @property {?string} watchedname  The name chosen by the watched leader
 */

/**
 * Adds a stock to the current user’s watchlist.
 * 
 * @param {string} query.stockid  The numerical stock id of the stock to be added.
 * 
 * @return {object} Returns with <code>watchlist-add-notfound</code>,
 *                  <code>watchlist-add-self</code> or <code>watchlist-add-success</code>.
 * 
 * @noreadonly
 * @function c2s~watchlist-add
 */
Watchlist.prototype.watchlistAdd = buscomponent.provideWQT('client-watchlist-add', function(query, ctx) {
	return ctx.query('SELECT stockid, users.id AS uid, users.name, bid FROM stocks ' +
		'LEFT JOIN users ON users.id = stocks.leader WHERE stocks.id = ?',
		[String(query.stockid)]).then(function(res) {
		if (res.length == 0)
			return { code: 'watchlist-add-notfound' };
		var uid = res[0].uid;
		if (uid == ctx.user.id)
			return { code: 'watchlist-add-self' };
		
		return ctx.query('REPLACE INTO watchlists ' +
			'(watcher, watchstarttime, watchstartvalue, watched) '+
			'VALUES(?, UNIX_TIMESTAMP(), ?, ?)',
			[ctx.user.id, res[0].bid, String(query.stockid)]).then(function(r) {
			return ctx.feed({
				type: 'watch-add',
				targetid: r.insertId,
				srcuser: ctx.user.id,
				json: {
					watched: query.stockid, 
					watcheduser: uid,
					watchedname: res[0].name
				},
				feedusers: uid ? [uid] : []
			});
		}).then(function() {
			return { code: 'watchlist-add-success' };
		}); 
	});
});

/**
 * Indicates that one user removed a stock or another user from their watchlist.
 * 
 * @typedef s2c~watch-add
 * @type {Event}
 * 
 * @property {int} watched  The numerical ID of the watched stock
 */

/**
 * Removes an entry to the current user’s watchlist.
 * 
 * @param {string} query.stockid  The numerical stock id of the stock to be added.
 * 
 * @return {object} Returns with <code>watchlist-remove-success</code>.
 * 
 * @noreadonly
 * @function c2s~watchlist-remove
 */
Watchlist.prototype.watchlistRemove = buscomponent.provideWQT('client-watchlist-remove', function(query, ctx) {
	return ctx.query('DELETE FROM watchlists WHERE watcher = ? AND watched = ?', [ctx.user.id, String(query.stockid)]).then(function() {
		return ctx.feed({
			type: 'watch-remove',
			targetid: null,
			srcuser: ctx.user.id,
			json: { watched: String(query.stockid) }
		});
	}).then(function() {
		return { code: 'watchlist-remove-success' };
	});
});


/**
 * Represents a single watchlist entry.
 * @typedef module:watchlist~StockRecord
 * @type object
 * 
 * @property {?string} username  The name of the leader if this refers to a leader stock.
 * @property {?int} uid  The numerical id of the leader if this refers to a leader stock.
 * @property {number} watchstartvalue  The stock (bid) value when this
 *                                     entry was added to the watchlist.
 * @property {int} watchstarttime  Unix timestamp of the addition of this
 *                                 entry to the watchlist.
 * @property {boolean} friends  Indicates whether the leader and the user watch each other.
 * @property {int} lastactive  If <code>friends</code> is true and the watched user
 *                             has an active session, this is that sessions last activity
 *                             timestamp.
 */

/**
 * Returns all entries of the current user’s watchlist.
 * 
 * @return {object} Returns with <code>watchlist-show-success</code>
 *                  and populates <code>.results</code> with a
 *                  {@link module:watchlist~WatchlistEntry[]}
 * 
 * @function c2s~watchlist-show
 */
Watchlist.prototype.watchlistShow = buscomponent.provideQT('client-watchlist-show', function(query, ctx) {
	return ctx.query('SELECT s.*, s.name AS stockname, users.name AS username, users.id AS uid, w.watchstartvalue, w.watchstarttime, ' +
		'lastusetime AS lastactive, IF(rw.watched IS NULL, 0, 1) AS friends ' +
		'FROM watchlists AS w ' +
		'JOIN stocks AS s ON w.watched = s.id ' +
		'JOIN stocks AS rs ON rs.leader = w.watcher ' +
		'LEFT JOIN users ON users.id = s.leader ' +
		'LEFT JOIN watchlists AS rw ON rw.watched = rs.id AND rw.watcher = s.leader ' +
		'LEFT JOIN sessions ON sessions.lastusetime = (SELECT MAX(lastusetime) FROM sessions WHERE uid = rw.watched) AND sessions.uid = rw.watched ' +
		'WHERE w.watcher = ?', [ctx.user.id]).then(function(res) {
		return { code: 'watchlist-show-success', 'results': res };
	});
});

exports.Watchlist = Watchlist;

})();
