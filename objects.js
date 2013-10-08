(function () { "use strict";

var util = require('util');
var events = require('events');
var locking = require('./locking.js');
var assert = require('assert');
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
			this.emit('error', query ? new Error(err + '\nCaused by <<' + query + '>> with arguments [' + new Buffer(JSON.stringify(data)).toString('base64') + ']') : err);
		else
			_.bind(cb, this)(res);
	}, this);
}

DBSubsystemBase.prototype.feed = function(data) {
	var src = data.srcuser;
	var json = JSON.stringify(data.json ? data.json : {});
	
	this.query('INSERT INTO events(`type`,targetid,time,srcuser,json) VALUES (?,?,UNIX_TIMESTAMP(),?,?)',
		[data.type, data.targetid, data.srcuser, json], function(r) {
		var eventid = r.insertId;
		
		var query, params;
		
		if (!data.private) {
			var additional = data.feedusers && data.feedusers.slice(0) || [];
			if (additional.indexOf(data.srcuser) == -1)
				additional.push(data.srcuser);
			
			query = 'INSERT INTO events_users (eventid,userid) '+
				'SELECT ?,userid FROM depot_stocks AS ds JOIN stocks AS s ON ds.stockid = s.id AND s.leader = ? ' + // all followers
				'UNION ' +
				'SELECT ?,w.watcher FROM stocks AS s JOIN watchlists AS w ON s.id = w.watched WHERE s.leader = ? '; // all users in watchlist
			params = [eventid, data.srcuser, eventid, data.srcuser];
				 
			for (var i = 0; i < additional.length; ++i) {
				if (parseInt(additional[i]) != additional[i])
					return this.emit('error', new Error('Bad additional user for feed event: ' + additional[i]));
				
				query += 'UNION SELECT ?,? ';
				params = params.concat([eventid, additional[i]]);
			}
		} else {
			query = 'INSERT INTO events (eventid, userid) VALUES (?,?)';
			params = [eventid, data.srcuser];
		}
		
		this.query(query, params, function() {
			this.emit('push-events');
		});
	});
}

DBSubsystemBase.prototype.fetchEvents = function(query, user, access, cb) {
	this.query('SELECT events.*, events_users.*, c.*, oh.*, events.time AS eventtime, events.eventid AS eventid, e2.type AS baseeventtype, trader.id AS traderid, trader.name AS tradername, su.name AS srcusername FROM events_users '+
		'JOIN events ON events_users.eventid = events.eventid '+
		'LEFT JOIN ecomments AS c ON c.commentid = events.targetid AND events.type="comment" '+
		'LEFT JOIN events AS e2 ON c.eventid=e2.eventid '+
		'LEFT JOIN orderhistory AS oh ON (e2.targetid = oh.orderid AND e2.type="trade") OR (oh.orderid = events.targetid AND events.type="trade") '+
		'LEFT JOIN users AS su ON su.id = events.srcuser '+
		'LEFT JOIN users AS trader ON (trader.id = oh.userid AND e2.type="trade") OR (trader.id = e2.targetid AND e2.type="user-register") '+
		'WHERE events_users.userid = ? AND events.time > ? ORDER BY events.time DESC LIMIT ?',
		[user.uid, query ? query.since : 0, query && query.count !== null ? query.count : 100000], function(r) {
		cb(_.chain(r).map(function(ev) {
			if (ev.json) {
				var json = JSON.parse(ev.json);
				if (json.__delay__ && (new Date().getTime()/1000 - ev.eventtime < json.__delay__))
					return null;
				_.chain(json).keys().each(function(k) { ev[k] = json[k]; });
			}
			delete ev.json;
			return ev;
		}).reject(function(ev) { return !ev; }).value());
	});
}

DBSubsystemBase.prototype.commentEvent = function(query, user, access, cb) {
	this.query('SELECT COUNT(*) AS c FROM events WHERE eventid=?', [query.eventid], function(res) {
		assert.equal(res.length, 1);
		if (res[0].c == 0)
			cb('comment-notfound');
		else this.query('INSERT INTO ecomments (eventid, commenter, comment, time) VALUES(?, ?, ?, UNIX_TIMESTAMP())', 
			[query.eventid, user.id, query.comment], function(res) {
			this.feed({'type': 'comment','targetid':res.insertId,'srcuser':user.id});
			cb('comment-success');
		});
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
