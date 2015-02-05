(function () { "use strict";

var commonUtil = require('tradity-connection');
var _ = require('lodash');
var util = require('util');
var assert = require('assert');
var Q = require('q');
var buscomponent = require('./stbuscomponent.js');

/**
 * Provides client requests for administrative tasks and information gathering.
 * 
 * @public
 * @module admin
 */

/**
 * Main object of the {@link module:admin} module
 * @public
 * @constructor module:admin~Admin
 * @augments module:stbuscomponent~STBusComponent
 */
function Admin () {
	Admin.super_.apply(this, arguments);
}

util.inherits(Admin, buscomponent.BusComponent);

/**
 * Helper function to indicate that a client request requires admin privileges.
 * 
 * @param {string} required  The required privilege level
 * @param {QTXCallback} f  A standard QTX client request handler
 * 
 * @function module:admin~_reqpriv
 */
function _reqpriv (required, f) {
	var requiredPermission = required;
	
	return function(query, ctx, xdata) {
		if (ctx.user === null || !ctx.access.has(requiredPermission))
			return { code: 'permission-denied' };
		else
			return _.bind(f, this)(query, ctx, xdata);
	};
}

/**
 * Returns all users and tons of information on them.
 * 
 * @example
 * Example ouput:
 * [ …, {
 *  birthday: 713923200000,
 *  deletiontime: null,
 *  street: 'null',
 *  zipcode: 'null',
 *  town: 'null',
 *  lang: …,
 *  desc: …,
 *  name: …,
 *  giv_name: …,
 *  fam_name: …,
 *  uid: 14,
 *  tradecount: 41,
 *  email: …,
 *  emailverif: 1,
 *  wprovision: 5,
 *  lprovision: 5,
 *  freemoney: 787240079,
 *  totalvalue: 787240064,
 *  wprov_sum: 0,
 *  lprov_sum: 0,
 *  registertime: 0,
 *  schoolpath: '/kit',
 *  schoolid: 27,
 *  pending: 0,
 *  jointime: 0,
 *  commentcount: 7,
 *  lastcommenttime: 1403753220 }, … ]
 * 
 * @return {object} Returns with <code>list-all-users-success</code> or a common error code
 *                  and populates <code>.results</code> with a
 *                  {@link module:user~UserEntryBase[]}, augmented by various data only
 *                  available to administrative users.
 * 
 * @function c2s~list-all-users
 */
Admin.prototype.listAllUsers = buscomponent.provideQT('client-list-all-users', _reqpriv('userdb', function(query, ctx) {
	return ctx.query('SELECT birthday, deletiontime, street, zipcode, town, `desc`, users.name, giv_name, fam_name, ' + 
		'users.id AS uid, tradecount, email, email_verif AS emailverif, ' +
		'wprovision, lprovision, freemoney, totalvalue, wprov_sum, lprov_sum, registertime, lang, ' +
		'schools.path AS schoolpath, schools.id AS schoolid, pending, jointime, ' +
		'(SELECT COUNT(*) FROM ecomments WHERE ecomments.commenter=users.id) AS commentcount, '+
		'(SELECT MAX(time) FROM ecomments WHERE ecomments.commenter=users.id) AS lastcommenttime FROM users ' +
		'JOIN users_data ON users.id = users_data.id ' +
		'JOIN users_finance ON users.id = users_finance.id ' +
		'LEFT JOIN schoolmembers AS sm ON sm.uid = users.id ' +
		'LEFT JOIN schools ON schools.id = sm.schoolid ',
		[]).then(function(userlist) {
		return { code: 'list-all-users-success', results: userlist };
	});
}));

/**
 * Shuts down the server. Not really something for the typical user.
 * 
 * @return {object} Returns with <code>shutdown-success</code>.
 * 
 * @function c2s~shutdown
 */
Admin.prototype.shutdown = buscomponent.provideQT('client-shutdown', function(query, ctx) {
	if (!ctx.access.has('server'))
		return { code: 'permission-denied' };
	
	var self = this;
	Q.delay(2000).then(function() {
		self.emit('globalShutdown');
	}).done();
	
	return { code: 'shutdown-success' };
});

/**
 * Change the session user id.
 * 
 * @param {int} query.uid  The user id to assign to the current session.
 * 
 * @return {object} Returns with <code>impersonate-user-success</code> or
 *                  <code>impersonate-user-notfound</code> or a common error code.
 * 
 * @function c2s~impersonate-user
 */
Admin.prototype.impersonateUser = buscomponent.provideWQT('client-impersonate-user', _reqpriv('server', function(query, ctx) {
	if (parseInt(query.uid) != query.uid)
		return { code: 'permission-denied' };
	
	return ctx.query('SELECT COUNT(*) AS c FROM users WHERE id = ?', [parseInt(query.uid)]).then(function(r) {
		assert.equal(r.length, 1);
		if (r[0].c == 0)
			return { code: 'impersonate-user-notfound' };
	
		return ctx.query('UPDATE sessions SET uid = ? WHERE id = ?', [parseInt(query.uid), ctx.user.sid]).then(function() {
			return { code: 'impersonate-user-success', extra: 'repush' };
		});
	});
}));

/**
 * Removes data for a given user from the database.
 * 
 * @param {int} query.uid  The numerical id of the user to be removed.
 * 
 * @return {object} Returns with <code>delete-user-self-notallowed</code> or
 *                  <code>delete-user-success</code> or a common error code.
 * 
 * @function c2s~delete-user
 */
Admin.prototype.deleteUser = buscomponent.provideWQT('client-delete-user', _reqpriv('userdb', function(query, ctx) {
	var uid = parseInt(query.uid);
	if (uid != uid) // NaN
		return { code: 'format-error' };
	
	if (ctx.user.id == uid)
		return { code: 'delete-user-self-notallowed' };
	
	var conn;
	return ctx.startTransaction().then(function(conn_) {
		conn = conn_;
		return conn.query('DELETE FROM sessions WHERE uid = ?', [uid]);
	}).then(function() {
		return conn.query('DELETE FROM schoolmembers WHERE uid = ?', [uid]);
	}).then(function() {
		return conn.query('UPDATE stocks SET name = CONCAT("leader:deleted", ?) WHERE leader = ?', [uid, uid]);
	}).then(function() {
		return conn.query('UPDATE users_data SET giv_name="__user_deleted__", fam_name="", birthday = NULL, ' +
			'street="", zipcode="", town="", traditye=0, `desc`="", realnamepublish = 0 WHERE id = ?', [uid]);
	}).then(function() {
		return conn.query('UPDATE users_finance SET wprovision=0, lprovision=0 WHERE id = ?', [uid]);
	}).then(function() {
		return conn.query('UPDATE users SET name = CONCAT("user_deleted", ?), email = CONCAT("deleted:", email), ' +
		'pwhash="xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", deletiontime = UNIX_TIMESTAMP() WHERE id = ?', [uid, uid]);
	}).then(function() {
		return conn.commit();
	}).then(function() {
		return { code: 'delete-user-success' };
	});
}));

/**
 * Change a user’s e-mail address administratively.
 * 
 * @param {int} query.uid  The numerical id of the target user.
 * @param {string} query.email  The new e-mail address.
 * @param {boolean} query.emailverif  If truthy, automatically set the e-mail
 *                                    address to being verified.
 * 
 * @return {object} Returns with <code>change-user-email-success</code> or
 *                  a common error code.
 * 
 * @function c2s~change-user-email
 */
Admin.prototype.changeUserEMail = buscomponent.provideWQT('client-change-user-email', _reqpriv('userdb', function(query, ctx) {
	if (parseInt(query.uid) != query.uid)
		return { code: 'format-error' };
	
	return ctx.query('UPDATE users SET email = ?, email_verif = ? WHERE id = ?',
		[String(query.email), query.emailverif ? 1 : 0, parseInt(query.uid)]).then(function() {
		return { code: 'change-user-email-success' };
	});
}));

/**
 * Change a comment’s text.
 * 
 * @param {int} query.commentid  The numerical id of the target comment.
 * @param {string} query.comment The new comment text.
 * @param {boolean} query.trustedhtml  If truthy, the new text is HTML-formatted.
 * 
 * @return {object} Returns with <code>change-comment-text-success</code> or
 *                  a common error code.
 * 
 * @function c2s~change-comment-text
 */
Admin.prototype.changeCommentText = buscomponent.provideWQT('client-change-comment-text', _reqpriv('moderate', function(query, ctx) {
	return ctx.query('UPDATE ecomments SET comment = ?, trustedhtml = ? WHERE commentid = ?',
		[String(query.comment), ctx.access.has('server') && query.trustedhtml ? 1:0, parseInt(query.commentid)]).then(function() {
		return { code: 'change-comment-text-success' };
	});
}));

/**
 * Remove the <code>sticky</code> flag from all notifications.
 * 
 * @return {object} Returns with <code>notify-unstick-all-success</code> or
 *                  a common error code.
 * 
 * @function c2s~notify-unstick-all
 */
Admin.prototype.notifyUnstickAll = buscomponent.provideWQT('client-notify-unstick-all', _reqpriv('moderate', function(query, ctx) {
	return ctx.query('UPDATE mod_notif SET sticky = 0').then(function() {
		return { code: 'notify-unstick-all-success' };
	});
}));

/**
 * A notice from the admins to the general community.
 * 
 * @typedef s2c~mod-notification
 * @type {Event}
 * 
 * @property {string} notifcontent  The HTML string to display to the readers
 * @property {boolean} sticky  Whether to move the notification to the to of
 *                             the feed when displaying
 */

/**
 * Inserts a message into all user feeds.
 * 
 * @param {string} query.content  The message to be displayed.
 * @param {boolean} query.sticky  If truthy, display the message on top of each feed.
 * 
 * @return {object} Returns with <code>notify-all-success</code> or
 *                  a common error code.
 * 
 * @function c2s~notify-all
 */
Admin.prototype.notifyAll = buscomponent.provideWQT('client-notify-all', _reqpriv('moderate', function(query, ctx) {
	return ctx.query('INSERT INTO mod_notif (content, sticky) VALUES (?, ?)',
		[String(query.content), query.sticky ? 1 : 0]).then(function(res) {
		return ctx.feed({
			'type': 'mod-notification',
			'targetid': res.insertId,
			'srcuser': ctx.user.id,
			'everyone': true
		});
	}).then(function() {
		return { code: 'notify-all-success' };
	});
}));

/**
 * Changes a school’s name and/or path.
 * This is the proper way to change a group’s supergroup.
 * 
 * @param {int} query.schoolid  The numerical id of the target school.
 * @param {string} query.schoolpath  The school’s new path. (Will be converted to lower case)
 * @param {string} query.schoolname  The school’s new human-readable name.
 * 
 * @return {object} Returns with <code>rename-school-notfound</code>,
 *                  <code>rename-school-success</code> or
 *                  a common error code.
 * 
 * @function c2s~rename-school
 */
Admin.prototype.renameSchool = buscomponent.provideWQT('client-rename-school', _reqpriv('schooldb', function(query, ctx) {
	query.schoolpath = String(query.schoolpath || '/').toLowerCase();
	
	var oldpath;
	return ctx.query('SELECT path FROM schools WHERE id = ?', [parseInt(query.schoolid)]).then(function(r) {
		if (r.length == 0)
			return { code: 'rename-school-notfound' };
		
		oldpath = r.path;

		return ctx.query('SELECT COUNT(*) AS c FROM schools WHERE path = ?',
			[commonUtil.parentPath(query.schoolpath)]).then(function(pr) {
			
			assert.equal(pr.length, 1);
			if (pr[0].c !== (commonUtil.parentPath(query.schoolpath) != '/' ? 1 : 0))
				return { code: 'rename-school-notfound' };
			
			return ctx.query('SELECT COUNT(*) AS c FROM schools WHERE path = ?', [query.schoolpath]).then(function(er) {
				assert.equal(er.length, 1);
				if (query.schoolpath && er[0].c == 1)
					return { code: 'rename-school-already-exists' };
				
				return ctx.query('UPDATE schools SET name = ? WHERE id = ?',
					[String(query.schoolname), parseInt(query.schoolid)]).then(function() {
					if (query.schoolpath) {
						return ctx.query('UPDATE schools SET path = REPLACE(path, ?, ?) WHERE path LIKE ? OR path = ?',
							[oldpath, query.schoolpath, oldpath + '/%', oldpath]);
					}
				}).then(function() {
					return { code: 'rename-school-success' };
				});
			});
		});
	});
}));

/**
 * Merges two schools into a large school.
 * These schools need to have the same parent school.
 * 
 * @param {int} query.masterschool  The numerical id of the target school.
 * @param {int} query.subschool     The numerical id of the source school.
 * 
 * @return {object} Returns with <code>join-schools-notfound</code>,
 *                  <code>join-schools-success</code>,
 *                  <code>join-schools-diff-parent</code> or
 *                  a common error code.
 * 
 * @function c2s~join-schools
 */
Admin.prototype.joinSchools = buscomponent.provideWQT('client-join-schools', _reqpriv('schooldb', function(query, ctx) {
	var mr;
	return ctx.query('SELECT path FROM schools WHERE id = ?', [parseInt(query.masterschool)]).then(function(mr_) {
		mr = mr_;
		return ctx.query('SELECT path FROM schools WHERE id = ?', [parseInt(query.subschool)]);
	}).then(function(sr) {
		assert.ok(mr.length <= 1);
		assert.ok(sr.length <= 1);
		
		if (sr.length == 0 || ((mr.length == 0 || mr[0].path == sr[0].path) && query.masterschool != null))
			return { code: 'join-schools-notfound' };
		if (mr.length > 0 && commonUtil.parentPath(mr[0].path) != commonUtil.parentPath(sr[0].path))
			return { code: 'join-schools-diff-parent' };
		
		return ctx.query('UPDATE schoolmembers SET schoolid = ? WHERE schoolid = ?',
			[parseInt(query.masterschool), parseInt(query.subschool)]).then(function() {
			return ctx.query('UPDATE feedblogs SET schoolid = ? WHERE schoolid = ?',
				[parseInt(query.masterschool), parseInt(query.subschool)]);
		}).then(function() {
			return ctx.query('DELETE FROM schooladmins WHERE schoolid = ?', [parseInt(query.subschool)]);
		}).then(function() {
			return ctx.query('DELETE FROM schools WHERE id = ?', [parseInt(query.subschool)]);
		}).then(function() {
			return { code: 'join-schools-success' };
		});
	});
}));

/**
 * Return all current followers of a given leader account.
 * 
 * @param {int} query.uid  The numerical user id of the leader.
 * 
 * @return {object} Returns with <code>get-followers-success</code>
 *                  a common error code and, in case of success, sets
 *                  <code>.results</code> accordingly.
 * 
 * @function c2s~get-followers
 */
Admin.prototype.getFollowers = buscomponent.provideQT('client-get-followers', _reqpriv('userdb', function(query, ctx) {
	if (parseInt(query.uid) != query.uid)
		return { code: 'format-error' };
	
	return ctx.query('SELECT u.name, u.id, ds.* ' +
		'FROM stocks AS s ' +
		'JOIN depot_stocks AS ds ON ds.stockid = s.id ' +
		'JOIN users AS u ON ds.userid = u.id ' +
		'WHERE s.leader = ?', [parseInt(query.uid)]).then(function(res) {
		
		return { code: 'get-followers-success', results: res };
	});
}));

/**
 * Return various server statistics information.
 * 
 * @param {boolean} qctxDebug  Whether to include debugging information on the local QContexts
 * 
 * @return {object} Returns with <code>get-server-statistics-success</code> or
 *                  a common error code and, in case of success, sets
 *                  <code>.servers</code> to an array of results of
 *                  calls to {@link busreq~internalServerStatistics}.
 * 
 * @function c2s~get-server-statistics
 */
Admin.prototype.getServerStatistics = buscomponent.provideQT('client-get-server-statistics', _reqpriv('userdb', function(query, ctx) {
	return this.requestGlobal({name: 'internalServerStatistics', qctxDebug: query.qctxDebug ? 1 : 0}).then(function(replies) {
		return { code: 'get-server-statistics-success', servers: replies };
	});
}));

/**
 * Returns the local bus’ packet log.
 * 
 * @return {object} Returns with <code>show-packet-log-success</code> or
 *                  a common error code and, in case of success, sets
 *                  <code>.result</code> to a <code>util.inspect</code>
 *                  version of the bus’ packet log.
 * 
 * @function c2s~show-packet-log
 */
Admin.prototype.showPacketLog = buscomponent.provideQT('client-show-packet-log', _reqpriv('userdb', function(query, ctx) {
	/* The package log is mostly informal and not expected to be used for anything but debugging.
	 * This means that circular structures in it may exist and JSON is simply not the way to go here. */ 
	return { code: 'show-packet-log-success', result: util.inspect(this.bus.packetLog, null) };
}));

/**
 * Returns game usage statistics.
 * 
 * This is likely to be subjected to larger modifications due to #270.
 * 
 * @return {object} Returns with <code>get-ticks-statistics</code> or
 *                  a common error code and, in case of success, sets
 *                  <code>.results</code> appropiately.
 * 
 * @function c2s~get-ticks-statistics
 */
Admin.prototype.getTicksStatistics = buscomponent.provideQT('client-get-ticks-statistics', _reqpriv('userdb', function(query, ctx) {
	var now = Math.floor(Date.now() / 1000);
	var todayStart = now - now % 86400;
	var ndays = parseInt(query.ndays) || 365;
	var timespanStart = todayStart - ndays * 86400;
	var dt = 300;
	
	return ctx.query('SELECT FLOOR(time/?)*? AS timeindex, SUM(ticks) AS ticksum, COUNT(ticks) AS tickcount ' +
		'FROM tickshistory ' +
		'GROUP BY timeindex',
		[dt, dt, dt, timespanStart, todayStart]).then(function(res) {
		return { code: 'get-ticks-statistics-success', results: res };
	});
}));

exports.Admin = Admin;

})();
