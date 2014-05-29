(function () { "use strict";
	
function parentPath(x) {
	var match = x.match(/(\/[\w_-]+)+\/[\w_-]+$/);
	return match ? match[1] : '/';
}

var _ = require('underscore');
var util = require('util');
var assert = require('assert');
var buscomponent = require('./buscomponent.js');

function AdminDB () {
}
util.inherits(AdminDB, buscomponent.BusComponent);

function _reqpriv (required, f) {
	var requiredPermission = required;
	return function(query, user, access, cb) {
		if (user === null || !access.has(requiredPermission))
			cb('permission-denied');
		else
			return _.bind(f,this)(query, user, access, cb);
	};
}

AdminDB.prototype.listAllUsers = buscomponent.provideQUA('client-list-all-users', _reqpriv('userdb', function(query, user, access, cb) {
	this.query('SELECT birthday, deletiontime, street, zipcode, town, `desc`, users.name, giv_name, fam_name, users.id AS uid, tradecount, ' +
		'email, email_verif AS emailverif, wprovision, lprovision, freemoney, totalvalue, wprov_sum, lprov_sum, ticks, ' +
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

AdminDB.prototype.evalCode = buscomponent.provideQUA('client-eval-code', _reqpriv('*', function(query, user, access, cb) {
	if (!query.authorizationKey)
		cb('permission-denied');
	else
		cb('eval-code-success', {result: eval(query.code)});
}));

AdminDB.prototype.shutdown = buscomponent.provideQUA('client-shutdown', _reqpriv('server', function(query, user, access, cb) {
	this.emit('shutdown');
	
	cb('shutdown-success');
}));

AdminDB.prototype.impersonateUser = buscomponent.provideQUA('client-impersonate-user', _reqpriv('server', function(query, user, access, cb) {
	this.query('SELECT COUNT(*) AS c FROM users WHERE id=?', [query.uid], function(r) {
		assert.equal(r.length, 1);
		if (r[0].c == 0)
			return cb('impersonate-user-notfound', null, 'repush');
	
		this.query('UPDATE sessions SET uid = ? WHERE id = ?', [query.uid, user.sid], function() {
			cb('impersonate-user-success', null, 'repush');
		});
	});
}));

AdminDB.prototype.deleteUser = buscomponent.provideQUA('client-delete-user', _reqpriv('userdb', function(query, user, access, cb) {
	if (user.id == query.uid)
		return cb('delete-user-self-notallowed');
	
	this.getConnection(function(conn) {
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

AdminDB.prototype.changeUserEMail = buscomponent.provideQUA('client-change-user', _reqpriv('userdb', function(query, user, access, cb) {
	this.query('UPDATE users SET email = ?, email_verif = ? WHERE id = ?', [query.email, query.emailverif ? 1 : 0, query.uid], function() {
		cb('change-user-email-success');
	});
}));

AdminDB.prototype.changeCommentText = buscomponent.provideQUA('client-change-comment-text', _reqpriv('moderate', function(query, user, access, cb) {
	this.query('UPDATE ecomments SET comment = ?, trustedhtml = ? WHERE commentid = ?', [query.comment, access.has('server') && query.trustedhtml ? 1:0, query.commentid], function() {
		cb('change-comment-text-success');
	});
}));

AdminDB.prototype.notifyUnstickAll = buscomponent.provideQUA('client-notify-unstick-all', _reqpriv('moderate', function(query, user, access, cb) {
	this.query('UPDATE mod_notif SET sticky = 0', [], function() {
		cb('notify-unstick-all-success');
	});
}));

AdminDB.prototype.notifyAll = buscomponent.provideQUA('client-notify-all', _reqpriv('moderate', function(query, user, access, cb) {
	this.query('INSERT INTO mod_notif (content, sticky) VALUES (?, ?)', [query.content, query.sticky ? 1 : 0], function(res) {
		this.feed({'type': 'mod-notification', 'targetid': res.insertId, 'srcuser': user.id, 'everyone': true});
		cb('notify-all-success');
	});
}));

AdminDB.prototype.renameSchool = buscomponent.provideQUA('client-rename-school', _reqpriv('schooldb', function(query, user, access, cb) {
	this.query('SELECT path FROM schools WHERE id = ?', [query.schoolid], function(r) {
		if (r.length == 0 || (query.schoolpath && parentPath(r[0].path) != parentPath(query.schoolpath)))
			return cb('rename-school-notfound');
		
		this.query('UPDATE schools SET name = ? WHERE id = ?', [query.schoolname, query.schoolid], function() {
			if (query.schoolpath) {
				this.query('UPDATE schools SET path = REPLACE(path, ?, ?) WHERE path LIKE ? OR path = ?', [r[0].path, query.schoolpath, r[0].path + '/%', r[0].path], function() {
					cb('rename-school-success');
				});
			} else {
				cb('rename-school-success');
			}
		});
	});
}));

AdminDB.prototype.joinSchools = buscomponent.provideQUA('client-join-schools', _reqpriv('schooldb', function(query, user, access, cb) {
	this.query('SELECT COUNT(*) AS c FROM schools WHERE id = ?', [query.masterschool], function(r) {
		assert.equal(r.length, 1);
		if ((r[0].c == 0 && query.masterschool != null) || query.masterschool == query.subschool)
			return cb('join-schools-notfound');
		
		this.query('UPDATE schoolmembers SET schoolid = ? WHERE schoolid = ?', [query.masterschool, query.subschool], function() {
			this.query('DELETE FROM schools WHERE id = ?', [query.subschool], function() {
				cb('join-schools-success');
			});
		});
	});
}));

AdminDB.prototype.getUserLogins = buscomponent.provideQUA('client-get-user-logins', _reqpriv('userdb', function(query, user, access, cb) {
	this.query('SELECT * FROM logins WHERE uid = ?', [query.uid], function(res) {
		_.each(res, function(e) {
			e.headers = JSON.parse(e.headers);
		});
		
		cb('get-user-logins-success', {results: res});
	});
}));

AdminDB.prototype.getTicksStatistics = buscomponent.provideQUA('client-get-ticks-statistics', _reqpriv('userdb', function(query, user, access, cb) {
	var now = Math.floor(new Date().getTime() / 1000);
	var todayStart = now - now % 86400;
	var ndays = parseInt(query.ndays) || 365;
	var timespanStart = todayStart - ndays * 86400;
	var dt = 300;
	
	this.query('SELECT FLOOR(time/?)*? AS timeindex, SUM(ticks) AS ticksum, COUNT(ticks) AS tickcount ' +
		'FROM valuehistory ' +
		'GROUP BY timeindex',
		[dt, dt, dt, timespanStart, todayStart], function(res) {
		cb('get-ticks-statistics-success', {results: res});
	});
}));

exports.AdminDB = AdminDB;

})();
