(function () { "use strict";

var util = require('util');
var events = require('events');
var locking = require('./locking.js');
var _ = require('underscore');

function DBSubsystemBase () {
	this.db = null;
	this.lockAuthority = null;
}
util.inherits(DBSubsystemBase, events.EventEmitter);

DBSubsystemBase.prototype.dbevent = function(name, data, access) {
	this.emit('dbevent', {name:name, data:data, access:access});
}

DBSubsystemBase.prototype.query = function(query, data, cb) {
	data = data || [];
	
	this.db.query(query, data, this.queryCallback(cb, query, data));
}

DBSubsystemBase.prototype.queryCallback = function(cb, query, data) {
	if (!cb)
		return (function() {});
	
	return _.bind(function(err, res) {
		if (err) 
			this.emit('error', query ? new Error(err + '\nCaused by <<' + query + '>> with arguments [' + new Buffer(data.toString()).toString('base64') + ']') : err);
		else
			_.bind(cb, this)(res);
	}, this);
}

DBSubsystemBase.prototype.feed = function(data) {
	var src = data.srcuser;
	var json = JSON.stringify(data.json ? data.json : {});
	
	var additional = data.feedusers && data.feedusers.slice(0) || [];
	if (additional.indexOf(data.srcuser) == -1)
		additional.push(data.srcuser);
	
	var query = 'INSERT INTO events (`type`,targetid,time,user,srcuser,seen,json) '+
		'SELECT ?,?,UNIX_TIMESTAMP(),userid,?,0,? FROM depot_stocks AS ds JOIN stocks AS s ON ds.stockid = s.id AND s.leader = ? ' + // all followers
		'UNION ' +
		'SELECT ?,?,UNIX_TIMESTAMP(),w.watcher,?,0,? FROM watchlists AS w WHERE w.watched = ? '; // all users in watchlist
	var params = [data.type, data.targetid, data.srcuser, json, data.srcuser,
		 data.type, data.targetid, data.srcuser, json, data.srcuser];
		 
	for (var i = 0; i < additional.length; ++i) {
		if (parseInt(additional[i]) != additional[i])
			return this.emit('error', new Error('Bad additional user for feed event: ' + additional[i]));
		
		query += 'UNION SELECT ?,?,UNIX_TIMESTAMP(),?,?,0,? ';
		params = params.concat([data.type, data.targetid, additional[i], data.srcuser, json]);
	}
	
	this.query(query, params, function() {
		this.emit('push-events');
	});
}

DBSubsystemBase.prototype.fetchEvents = function(query, user, access, cb) {
	this.query('SELECT events.*, c.*, oh.*, events.time AS eventtime, su.name AS srcusername FROM events '+
		'LEFT JOIN tcomments AS c ON c.commentid = events.targetid AND events.type="comment" '+
		'LEFT JOIN orderhistory AS oh ON c.tradeid = oh.orderid OR (oh.orderid = events.targetid AND events.type="trade") '+
		'LEFT JOIN users AS su ON su.id = events.srcuser '+
		'WHERE user = ? AND events.time > ? AND NOT (seen*?) ORDER BY events.time DESC LIMIT ?',
		[user.uid, query ? query.since : 0, query && query.all ? 0:1, query && query.count !== null ? query.count : 100000], function(r) {
		cb(_.map(r, function(ev) {
			if (ev.json) {
				var json = JSON.parse(ev.json);
				_.chain(json).keys().each(function(k) { ev[k] = json[k]; });
			}
			delete ev.json;
			return ev;
		}));
	});
}

DBSubsystemBase.prototype.markEventSeen = function(query, user, access, cb) {
	this.query('UPDATE events SET seen = 1 WHERE user = ? AND eventid = ?', [user.id, query.eventid], function() {
		cb('mark-event-seen-success');
	});
}

DBSubsystemBase.prototype.getNeededStocks = function() {
	return [];
}

DBSubsystemBase.prototype.locked = function(locks, origCB, fn) {
	if (!this.lockAuthority)
		this.lockAuthority = locking.Lock.globalLockAuthority;
	
	this.lockAuthority.locked(locks, origCB, _.bind(fn, this));
}

exports.DBSubsystemBase = DBSubsystemBase;

})();
