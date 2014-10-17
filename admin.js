(function () { "use strict";

function parentPath(x) {
	var match = x.match(/((\/[\w_-]+)+)\/[\w_-]+$/);
	return match ? match[1] : '/';
}

var _ = require('underscore');
var util = require('util');
var assert = require('assert');
var buscomponent = require('./bus/buscomponent.js');

function AdminDB () {
}
util.inherits(AdminDB, buscomponent.BusComponent);

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

AdminDB.prototype.listAllUsers = buscomponent.provideQT('client-list-all-users', _reqpriv('userdb', function(query, ctx, cb) {
	ctx.query('SELECT birthday, deletiontime, street, zipcode, town, `desc`, users.name, giv_name, fam_name, users.id AS uid, tradecount, ' +
		'email, email_verif AS emailverif, wprovision, lprovision, freemoney, totalvalue, wprov_sum, lprov_sum, ticks, registertime, ' +
		'logins.logintime AS lastlogintime, schools.path AS schoolpath, schools.id AS schoolid, pending, jointime, ' +
		'(SELECT COUNT(*) FROM ecomments WHERE ecomments.commenter=users.id) AS commentcount, '+
		'(SELECT MAX(time) FROM ecomments WHERE ecomments.commenter=users.id) AS lastcommenttime FROM users ' +
		'LEFT JOIN schoolmembers AS sm ON sm.uid = users.id ' +
		'LEFT JOIN schools ON schools.id = sm.schoolid ' +
		'LEFT JOIN logins ON logins.id = (SELECT id FROM logins AS l WHERE l.uid = users.id ORDER BY logintime DESC LIMIT 1)',
		[], function(userlist) {
		cb('list-all-users-success', {results: userlist});
	});
}));

AdminDB.prototype.evalCode = buscomponent.provideQT('client-eval-code', _reqpriv('*', function(query, ctx, xdata, cb) {
	if (!query.authorizationKey)
		cb('permission-denied');
	else
		cb('eval-code-success', {result: eval(query.code)});
}));

AdminDB.prototype.shutdown = buscomponent.provideQT('client-shutdown', _reqpriv('server', function(query, ctx, cb) {
	this.emit('globalShutdown');
	
	cb('shutdown-success');
}));

AdminDB.prototype.impersonateUser = buscomponent.provideQT('client-impersonate-user', _reqpriv('server', function(query, ctx, cb) {
	ctx.query('SELECT COUNT(*) AS c FROM users WHERE id=?', [query.uid], function(r) {
		assert.equal(r.length, 1);
		if (r[0].c == 0)
			return cb('impersonate-user-notfound', null, 'repush');
	
		ctx.query('UPDATE sessions SET uid = ? WHERE id = ?', [query.uid, ctx.user.sid], function() {
			cb('impersonate-user-success', null, 'repush');
		});
	});
}));

AdminDB.prototype.deleteUser = buscomponent.provideQT('client-delete-user', _reqpriv('userdb', function(query, ctx, cb) {
	if (ctx.user.id == query.uid)
		return cb('delete-user-self-notallowed');
	
	ctx.getConnection(function(conn) {
		conn.query('START TRANSACTION', [], function() {
		conn.query('DELETE FROM sessions WHERE uid = ?', [query.uid], function() {
		conn.query('DELETE FROM schoolmembers WHERE uid = ?', [query.uid], function() {
		conn.query('UPDATE stocks SET name = CONCAT("leader:deleted", ?) WHERE leader = ?', [query.uid, query.uid], function() {
		conn.query('UPDATE users SET name = CONCAT("user_deleted", ?), giv_name="__user_deleted__", email = CONCAT("deleted:", email), ' +
		'fam_name="", pwhash="xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", birthday=NULL, realnamepublish=0, `desc`="", wprovision=0, lprovision=0, ' + 
		'street="", zipcode="", town="", traditye=0, deletiontime = UNIX_TIMESTAMP() WHERE id = ?', [query.uid, query.uid], function() {
			conn.query('COMMIT', [], function() {
				conn.release();
				cb('delete-user-success');
			});
		});
		});
		});
		});
		});
	});
}));

AdminDB.prototype.changeUserEMail = buscomponent.provideQT('client-change-user', _reqpriv('userdb', function(query, ctx, cb) {
	ctx.query('UPDATE users SET email = ?, email_verif = ? WHERE id = ?', [query.email, query.emailverif ? 1 : 0, query.uid], function() {
		cb('change-user-email-success');
	});
}));

AdminDB.prototype.changeCommentText = buscomponent.provideQT('client-change-comment-text', _reqpriv('moderate', function(query, ctx, cb) {
	ctx.query('UPDATE ecomments SET comment = ?, trustedhtml = ? WHERE commentid = ?', [query.comment, ctx.access.has('server') && query.trustedhtml ? 1:0, query.commentid], function() {
		cb('change-comment-text-success');
	});
}));

AdminDB.prototype.notifyUnstickAll = buscomponent.provideQT('client-notify-unstick-all', _reqpriv('moderate', function(query, ctx, cb) {
	ctx.query('UPDATE mod_notif SET sticky = 0', [], function() {
		cb('notify-unstick-all-success');
	});
}));

AdminDB.prototype.notifyAll = buscomponent.provideQT('client-notify-all', _reqpriv('moderate', function(query, ctx, cb) {
	ctx.query('INSERT INTO mod_notif (content, sticky) VALUES (?, ?)', [query.content, query.sticky ? 1 : 0], function(res) {
		ctx.feed({'type': 'mod-notification', 'targetid': res.insertId, 'srcuser': ctx.user.id, 'everyone': true});
		cb('notify-all-success');
	});
}));

AdminDB.prototype.renameSchool = buscomponent.provideQT('client-rename-school', _reqpriv('schooldb', function(query, ctx, cb) {
	ctx.query('SELECT path FROM schools WHERE id = ?', [query.schoolid], function(r) {
		if (r.length == 0)
			return cb('rename-school-notfound');

		ctx.query('SELECT COUNT(*) AS c FROM schools WHERE path = ?', [parentPath(query.schoolpath || '/')], function(pr) {
			assert.equal(pr.length, 1);
			if (pr[0].c !== (parentPath(query.schoolpath || '/') != '/' ? 1 : 0))
				return cb('rename-school-notfound');
			
			ctx.query('SELECT COUNT(*) AS c FROM schools WHERE path = ?', [query.schoolpath ? query.schoolpath : '/'], function(er) {
				assert.equal(er.length, 1);
				if (query.schoolpath && er[0].c == 1)
					return cb('rename-school-already-exists');
				
				ctx.query('UPDATE schools SET name = ? WHERE id = ?', [query.schoolname, query.schoolid], function() {
					if (query.schoolpath) {
						ctx.query('UPDATE schools SET path = REPLACE(path, ?, ?) WHERE path LIKE ? OR path = ?', [r[0].path, query.schoolpath, r[0].path + '/%', r[0].path], function() {
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

AdminDB.prototype.joinSchools = buscomponent.provideQT('client-join-schools', _reqpriv('schooldb', function(query, ctx, cb) {
	ctx.query('SELECT path FROM schools WHERE id = ?', [query.masterschool], function(mr) {
	ctx.query('SELECT path FROM schools WHERE id = ?', [query.subschool], function(sr) {
		assert.ok(mr.length <= 1);
		assert.ok(sr.length <= 1);
		
		if (sr.length == 0 || ((mr.length == 0 || mr[0].path == sr[0].path) && query.masterschool != null))
			return cb('join-schools-notfound');
		if (mr.length > 0 && parentPath(mr[0].path) != parentPath(sr[0].path))
			return cb('join-schools-diff-parent');
		
		ctx.query('UPDATE schoolmembers SET schoolid = ? WHERE schoolid = ?', [query.masterschool, query.subschool], function() {
		ctx.query('DELETE FROM schooladmins WHERE schoolid = ?', [query.subschool], function() {
			ctx.query('DELETE FROM schools WHERE id = ?', [query.subschool], function() {
				cb('join-schools-success');
			});
		});
		});
	});
	});
}));

AdminDB.prototype.getFollowers = buscomponent.provideQT('client-get-followers', _reqpriv('userdb', function(query, ctx, cb) {
	ctx.query('SELECT u.name, u.id, ds.* ' +
		'FROM stocks AS s ' +
		'JOIN depot_stocks AS ds ON ds.stockid = s.id ' +
		'JOIN users AS u ON ds.userid = u.id ' +
		'WHERE s.leader = ?', [query.uid], function(res) {
		
		cb('get-followers-success', {results: res});
	});
}));

AdminDB.prototype.getUserLogins = buscomponent.provideQT('client-get-user-logins', _reqpriv('userdb', function(query, ctx, cb) {
	ctx.query('SELECT * FROM logins WHERE uid = ?', [query.uid], function(res) {
		_.each(res, function(e) {
			e.headers = JSON.parse(e.headers);
		});
		
		cb('get-user-logins-success', {results: res});
	});
}));

AdminDB.prototype.getServerStatistics = buscomponent.provideQT('client-get-server-statistics', _reqpriv('userdb', function(query, ctx, cb) {
	this.requestGlobal({name: 'internal-get-server-statistics'}, function(replies) {
		cb('get-server-statistics-success', {servers: replies});
	});
}));

AdminDB.prototype.getTicksStatistics = buscomponent.provideQT('client-get-ticks-statistics', _reqpriv('userdb', function(query, ctx, cb) {
	var now = Math.floor(new Date().getTime() / 1000);
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

exports.AdminDB = AdminDB;

})();
