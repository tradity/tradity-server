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
};

DBSubsystemBase.prototype.timeQueryWrap = function(fn, connid) {
	if (this.cfg && this.cfg.timeQueries) {
		return _.bind(function(query, data, cb) {
			var tStart = new Date().getTime();
			
			fn(query, data, _.bind(function() {
				var tEnd = new Date().getTime();
				console.log('Query ', connid, query.substr(0, 60), ' took ', tEnd - tStart, 'ms');
				
				cb.apply(this, arguments);
			}, this));
		}, this);
	} else {
		return fn;
	}
};

DBSubsystemBase.prototype.query = function(query, data, cb) {
	data = data || [];
	
	this.timeQueryWrap(_.bind(this.db.query, this.db), '*')(query, data, this.queryCallback(cb, query, data));
};

DBSubsystemBase.prototype.getConnection = function(conncb) {
	this.db.getConnection(_.bind(function(err, cn) {
		if (err)
			this.emit('error', err);
			
		if (!this.dbconnid)
			this.dbconnid = 0;
		var connid = ++this.dbconnid;
		
		conncb({
			query: _.bind(function(q, data, cb) {
				data = data || [];
				this.timeQueryWrap(_.bind(cn.query, cn), connid)(q, data, this.queryCallback(cb, q, data));
			}, this),
			release: _.bind(function() {
				cn.release();
			}, this)
		});
	}, this));
};

DBSubsystemBase.prototype.queryCallback = function(cb, query, data) {	
	return _.bind(function(err, res) {
		if (err) 
			this.emit('error', query ? new Error(err + '\nCaused by <<' + query + '>> with arguments [' + new Buffer(JSON.stringify(data)).toString('base64') + ']') : err);
		else if (cb)
			_.bind(cb, this)(res);
	}, this);
};

DBSubsystemBase.prototype.feed = function(data) {
	var src = data.srcuser;
	var json = JSON.stringify(data.json ? data.json : {});
	
	this.query('INSERT INTO events(`type`,targetid,time,srcuser,json) VALUES (?,?,UNIX_TIMESTAMP(),?,?)',
		[data.type, data.targetid, data.srcuser, json], function(r) {
		var eventid = r.insertId;
		
		var query, params;
		
		if (!data.private && !data.everyone) {
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
		} else if (data.everyone) {
			query = 'INSERT INTO events_users (eventid, userid) SELECT ?, id FROM users';
			params = [eventid];
		} else {
			query = 'INSERT INTO events_users (eventid, userid) VALUES (?,?)';
			params = [eventid, data.srcuser];
		}
		
		this.query(query, params, function() {
			this.emit('push-events');
		});
	});
};

DBSubsystemBase.prototype.fetchEvents = function(query, user, access, cb) {
	this.query('SELECT events.*, events_users.*, c.*, oh.*, events.time AS eventtime, events.eventid AS eventid, '+
		'e2.eventid AS baseeventid, e2.type AS baseeventtype, trader.id AS traderid, trader.name AS tradername, ' +
		'schools.id AS schoolid, schools.name AS schoolname, '+
		'su.name AS srcusername, notif.content AS notifcontent, notif.sticky AS notifsticky FROM events_users '+
		'JOIN events ON events_users.eventid = events.eventid '+
		'LEFT JOIN ecomments AS c ON c.commentid = events.targetid AND events.type="comment" '+
		'LEFT JOIN events AS e2 ON c.eventid=e2.eventid '+
		'LEFT JOIN orderhistory AS oh ON (e2.targetid = oh.orderid AND e2.type="trade") OR (oh.orderid = events.targetid AND events.type="trade") '+
		'LEFT JOIN users AS su ON su.id = events.srcuser '+
		'LEFT JOIN users AS trader ON (trader.id = oh.userid AND e2.type="trade") OR (trader.id = e2.targetid AND e2.type="user-register") '+
		'LEFT JOIN schools ON (schools.id = e2.targetid AND e2.type="school-create") '+
		'LEFT JOIN mod_notif AS notif ON notif.notifid = events.targetid AND events.type="mod-notification"'+
		'WHERE events_users.userid = ? AND events.time > ? ORDER BY events.time DESC LIMIT ?',
		[user.uid, query ? query.since : 0, query && query.count !== null ? query.count : 100000], function(r) {
		cb(_.chain(r).map(function(ev) {
			if (ev.json) {
				var json = JSON.parse(ev.json);
				if (json.__delay__ && (new Date().getTime()/1000 - ev.eventtime < json.__delay__) && user.uid != ev.srcuser)
					return null;
				_.chain(json).keys().each(function(k) { ev[k] = json[k]; });
			}
			delete ev.json;
			return ev;
		}).reject(function(ev) { return !ev; }).value());
	});
};

DBSubsystemBase.prototype.commentEvent = function(query, user, access, cb) {
	this.query('SELECT events.type,events.targetid,oh.userid AS trader FROM events '+
	'LEFT JOIN orderhistory AS oh ON oh.orderid = events.targetid WHERE eventid=?', [query.eventid], function(res) {
		if (res.length == 0)
			return cb('comment-notfound');
			
		var feedusers = [];
		var r = res[0];
		if (r.type == 'user-register') {
			assert.ok(r.targetid !== null);
			feedusers.push(r.targetid);
		}
		if (r.type == 'trade') {
			assert.ok(r.trader !== null);
			feedusers.push(r.trader);
		}
		
		this.query('INSERT INTO ecomments (eventid, commenter, comment, trustedhtml, time) VALUES(?, ?, ?, 0, UNIX_TIMESTAMP())', 
			[query.eventid, user.id, query.comment], function(res) {
			this.feed({'type': 'comment','targetid':res.insertId,'srcuser':user.id,'feedusers':feedusers});
			cb('comment-success');
		});
	});
};

DBSubsystemBase.prototype.getNeededStocks = function() {
	return [];
};

DBSubsystemBase.prototype.locked = function(locks, origCB, fn) {
	if (!this.lockAuthority)
		this.lockAuthority = locking.Lock.globalLockAuthority;
	
	this.lockAuthority.locked(locks, origCB, _.bind(fn, this));
};

exports.DBSubsystemBase = DBSubsystemBase;

})();
