(function () { "use strict";

var commonUtil = require('./common/util.js');
var _ = require('lodash');
var util = require('util');
var assert = require('assert');
var buscomponent = require('./stbuscomponent.js');

function Admin () {
	Admin.super_.apply(this, arguments);
}

util.inherits(Admin, buscomponent.BusComponent);

function _reqpriv_x (required, f) {
	var requiredPermission = required;
	
	return function(query, ctx, xdata, cb) {
		if (ctx.user === null || !ctx.access.has(requiredPermission))
			(cb ? cb : xdata)('permission-denied');
		else
			return _.bind(f, this)(query, ctx, xdata, cb);
	};
}

function _reqpriv (required, f) {
	return _reqpriv_x(required, function(query, ctx, xdata, cb) {
		return _.bind(f, this)(query, ctx, cb = xdata);
	});
}

Admin.prototype.listAllUsers = buscomponent.provideQT('client-list-all-users', _reqpriv('userdb', function(query, ctx, cb) {
	ctx.query('SELECT birthday, deletiontime, street, zipcode, town, `desc`, users.name, giv_name, fam_name, users.id AS uid, tradecount, ' +
		'email, email_verif AS emailverif, wprovision, lprovision, freemoney, totalvalue, wprov_sum, lprov_sum, ticks, registertime, ' +
		'schools.path AS schoolpath, schools.id AS schoolid, pending, jointime, ' +
		'(SELECT COUNT(*) FROM ecomments WHERE ecomments.commenter=users.id) AS commentcount, '+
		'(SELECT MAX(time) FROM ecomments WHERE ecomments.commenter=users.id) AS lastcommenttime FROM users ' +
		'JOIN users_data ON users.id = users_data.id ' +
		'JOIN users_finance ON users.id = users_finance.id ' +
		'LEFT JOIN schoolmembers AS sm ON sm.uid = users.id ' +
		'LEFT JOIN schools ON schools.id = sm.schoolid ',
		[], function(userlist) {
		cb('list-all-users-success', {results: userlist});
	});
}));

Admin.prototype.shutdown = buscomponent.provideQT('client-shutdown', _reqpriv('server', function(query, ctx, cb) {
	this.emit('globalShutdown');
	
	cb('shutdown-success');
}));

Admin.prototype.impersonateUser = buscomponent.provideWQT('client-impersonate-user', _reqpriv('server', function(query, ctx, cb) {
	if (parseInt(query.uid) != query.uid)
		return cb('permission-denied');
	
	ctx.query('SELECT COUNT(*) AS c FROM users WHERE id = ?', [parseInt(query.uid)], function(r) {
		assert.equal(r.length, 1);
		if (r[0].c == 0)
			return cb('impersonate-user-notfound', null, 'repush');
	
		ctx.query('UPDATE sessions SET uid = ? WHERE id = ?', [parseInt(query.uid), ctx.user.sid], function() {
			cb('impersonate-user-success', null, 'repush');
		});
	});
}));

Admin.prototype.deleteUser = buscomponent.provideWQT('client-delete-user', _reqpriv('userdb', function(query, ctx, cb) {
	if (ctx.user.id == query.uid)
		return cb('delete-user-self-notallowed');
	
	var uid = parseInt(query.uid);
	if (uid != uid) // NaN
		return cb('format-error');
	
	ctx.getConnection(function(conn, commit) {
		conn.query('START TRANSACTION', [], function() {
		conn.query('DELETE FROM sessions WHERE uid = ?', [uid], function() {
		conn.query('DELETE FROM schoolmembers WHERE uid = ?', [uid], function() {
		conn.query('UPDATE stocks SET name = CONCAT("leader:deleted", ?) WHERE leader = ?', [uid, uid], function() {
		conn.query('UPDATE users_data SET giv_name="__user_deleted__", fam_name="", birthday = NULL, ' +
			'street="", zipcode="", town="", traditye=0, `desc`="", realnamepublish = 0 WHERE id = ?', [uid], function() {
		conn.query('UPDATE users_finance SET wprovision=0, lprovision=0 WHERE id = ?', [uid], function() {
		conn.query('UPDATE users SET name = CONCAT("user_deleted", ?), email = CONCAT("deleted:", email), ' +
		'pwhash="xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", deletiontime = UNIX_TIMESTAMP() WHERE id = ?', [uid, uid], function() {
			commit(function() {
				cb('delete-user-success');
			});
		});
		});
		});
		});
		});
		});
		});
	});
}));

Admin.prototype.changeUserEMail = buscomponent.provideWQT('client-change-user', _reqpriv('userdb', function(query, ctx, cb) {
	ctx.query('UPDATE users SET email = ?, email_verif = ? WHERE id = ?',
		[String(query.email), query.emailverif ? 1 : 0, parseInt(query.uid)], function() {
		cb('change-user-email-success');
	});
}));

Admin.prototype.changeCommentText = buscomponent.provideWQT('client-change-comment-text', _reqpriv('moderate', function(query, ctx, cb) {
	ctx.query('UPDATE ecomments SET comment = ?, trustedhtml = ? WHERE commentid = ?',
		[String(query.comment), ctx.access.has('server') && query.trustedhtml ? 1:0, parseInt(query.commentid)], function() {
		cb('change-comment-text-success');
	});
}));

Admin.prototype.notifyUnstickAll = buscomponent.provideWQT('client-notify-unstick-all', _reqpriv('moderate', function(query, ctx, cb) {
	ctx.query('UPDATE mod_notif SET sticky = 0', [], function() {
		cb('notify-unstick-all-success');
	});
}));

Admin.prototype.notifyAll = buscomponent.provideWQT('client-notify-all', _reqpriv('moderate', function(query, ctx, cb) {
	ctx.query('INSERT INTO mod_notif (content, sticky) VALUES (?, ?)', [String(query.content), query.sticky ? 1 : 0], function(res) {
		ctx.feed({'type': 'mod-notification', 'targetid': res.insertId, 'srcuser': ctx.user.id, 'everyone': true});
		cb('notify-all-success');
	});
}));

Admin.prototype.renameSchool = buscomponent.provideWQT('client-rename-school', _reqpriv('schooldb', function(query, ctx, cb) {
	ctx.query('SELECT path FROM schools WHERE id = ?', [parseInt(query.schoolid)], function(r) {
		if (r.length == 0)
			return cb('rename-school-notfound');

		ctx.query('SELECT COUNT(*) AS c FROM schools WHERE path = ?', [commonUtil.parentPath(query.schoolpath || '/')], function(pr) {
			assert.equal(pr.length, 1);
			if (pr[0].c !== (commonUtil.parentPath(query.schoolpath || '/') != '/' ? 1 : 0))
				return cb('rename-school-notfound');
			
			ctx.query('SELECT COUNT(*) AS c FROM schools WHERE path = ?', [String(query.schoolpath || '/')], function(er) {
				assert.equal(er.length, 1);
				if (query.schoolpath && er[0].c == 1)
					return cb('rename-school-already-exists');
				
				ctx.query('UPDATE schools SET name = ? WHERE id = ?', [String(query.schoolname), parseInt(query.schoolid)], function() {
					if (query.schoolpath) {
						ctx.query('UPDATE schools SET path = REPLACE(path, ?, ?) WHERE path LIKE ? OR path = ?',
							[r[0].path, String(query.schoolpath), r[0].path + '/%', r[0].path], function() {
							cb('rename-school-success');
						});
					} else {
						cb('rename-school-success');
					}
				});
			});
		});
	});
}));

Admin.prototype.joinSchools = buscomponent.provideWQT('client-join-schools', _reqpriv('schooldb', function(query, ctx, cb) {
	ctx.query('SELECT path FROM schools WHERE id = ?', [parseInt(query.masterschool)], function(mr) {
	ctx.query('SELECT path FROM schools WHERE id = ?', [parseInt(query.subschool)], function(sr) {
		assert.ok(mr.length <= 1);
		assert.ok(sr.length <= 1);
		
		if (sr.length == 0 || ((mr.length == 0 || mr[0].path == sr[0].path) && query.masterschool != null))
			return cb('join-schools-notfound');
		if (mr.length > 0 && commonUtil.parentPath(mr[0].path) != commonUtil.parentPath(sr[0].path))
			return cb('join-schools-diff-parent');
		
		ctx.query('UPDATE schoolmembers SET schoolid = ? WHERE schoolid = ?', [parseInt(query.masterschool), parseInt(query.subschool)], function() {
		ctx.query('DELETE FROM schooladmins WHERE schoolid = ?', [parseInt(query.subschool)], function() {
			ctx.query('DELETE FROM schools WHERE id = ?', [parseInt(query.subschool)], function() {
				cb('join-schools-success');
			});
		});
		});
	});
	});
}));

Admin.prototype.getFollowers = buscomponent.provideQT('client-get-followers', _reqpriv('userdb', function(query, ctx, cb) {
	ctx.query('SELECT u.name, u.id, ds.* ' +
		'FROM stocks AS s ' +
		'JOIN depot_stocks AS ds ON ds.stockid = s.id ' +
		'JOIN users AS u ON ds.userid = u.id ' +
		'WHERE s.leader = ?', [parseInt(query.uid)], function(res) {
		
		cb('get-followers-success', {results: res});
	});
}));

Admin.prototype.getServerStatistics = buscomponent.provideQT('client-get-server-statistics', _reqpriv('userdb', function(query, ctx, cb) {
	this.requestGlobal({name: 'internal-get-server-statistics'}, function(replies) {
		cb('get-server-statistics-success', {servers: replies});
	});
}));

Admin.prototype.showPacketLog = buscomponent.provideQT('client-show-packet-log', _reqpriv('userdb', function(query, ctx, cb) {
	/* The package log is mostly informal and not expected to be used for anything but debugging.
	 * This means that circular structures in it may exist and JSON is simply not the way to go here. */ 
	cb('show-packet-log-success', {result: util.inspect(this.bus.packetLog, null)});
}));

Admin.prototype.getTicksStatistics = buscomponent.provideQT('client-get-ticks-statistics', _reqpriv('userdb', function(query, ctx, cb) {
	var now = Math.floor(Date.now() / 1000);
	var todayStart = now - now % 86400;
	var ndays = parseInt(query.ndays) || 365;
	var timespanStart = todayStart - ndays * 86400;
	var dt = 300;
	
	ctx.query('SELECT FLOOR(time/?)*? AS timeindex, SUM(ticks) AS ticksum, COUNT(ticks) AS tickcount ' +
		'FROM tickshistory ' +
		'GROUP BY timeindex',
		[dt, dt, dt, timespanStart, todayStart], function(res) {
		cb('get-ticks-statistics-success', {results: res});
	});
}));

exports.Admin = Admin;

})();
