(function () { "use strict";

var util = require('util');
var events = require('events');
var _ = require('underscore');

function DBSubsystemBase () {
	this.db = null;
}
util.inherits(DBSubsystemBase, events.EventEmitter);

DBSubsystemBase.prototype.dbevent = function(name, data, access) {
	this.emit('dbevent', {name:name, data:data, access:access});
}

DBSubsystemBase.prototype.query = function(query, data, cb) {
	data = data || [];
	
	this.db.query(query, data, this.queryCallback(cb, query));
}

DBSubsystemBase.prototype.queryCallback = function(cb, query) {
	if (!cb)
		return (function() {});
	
	return _.bind(function(err, res) {
		if (err) 
			this.emit('error', query ? new Error(err + '\nCaused by <<' + query + '>>') : err);
		else
			_.bind(cb, this)(res);
	}, this);
}

DBSubsystemBase.prototype.feed = function(data) {
	var src = data.srcuser;
	this.query('INSERT INTO events (`type`,targetid,time,user,srcuser,seen) '+
		'SELECT ?,?,UNIX_TIMESTAMP(),userid,?,0 FROM depot_stocks AS ds JOIN stocks AS s ON ds.stockid = s.id AND s.leader = ?', [], function() {
		this.emit('push-events');
	});
}

DBSubsystemBase.prototype.fetchEvents = function(query, user, access, cb) {
	this.query('SELECT * FROM events '+
		'LEFT JOIN tcomments AS c ON c.commentid = events.targetid AND events.type="comment" '+
		'JOIN orderhistory AS oh ON c.tradeid = oh.orderid OR (oh.orderid = events.targetid AND events.type="trade") '+
		'WHERE user = ? AND time > ? AND NOT (seen*?)', [user.uid, query ? query.since : 0, query && query.all ? 0:1], cb);
}

DBSubsystemBase.prototype.markEventSeen = function(query, user, access, cb) {
	this.query('UPDATE events SET seen = 1 WHERE user = ? AND eventid = ?', [user.id, query.eventid], function() {
		cb('mark-event-seen-success');
	});
}

exports.DBSubsystemBase = DBSubsystemBase;

})();
