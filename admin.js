(function () { "use strict";

var commonUtil = require('./common/util.js');
var _ = require('lodash');
var util = require('util');
var assert = require('assert');
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
 * @function module:admin~_reqpriv_x
 */
function _reqpriv_x (required, f) {
	var requiredPermission = required;
	
	return function(query, ctx, xdata, cb) {
		if (ctx.user === null || !ctx.access.has(requiredPermission))
			(cb ? cb : xdata)('permission-denied');
		else
			return _.bind(f, this)(query, ctx, xdata, cb);
	};
}

/**
 * Helper function to indicate that a client request requires admin privileges.
 * 
 * @param {string} required  The required privilege level
 * @param {QTCallback} f  A standard QT client request handler
 * 
 * @function module:admin~_reqpriv
 */
function _reqpriv (required, f) {
	return _reqpriv_x(required, function(query, ctx, xdata, cb) {
		return _.bind(f, this)(query, ctx, cb = xdata);
	});
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
 *  schoolpath: '/KIT',
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

/**
 * Shuts down the server. Not really something for the typical user.
 * 
 * @return {object} Returns with <code>shutdown-success</code>.
 * 
 * @function c2s~shutdown
 */
Admin.prototype.shutdown = buscomponent.provideQT('client-shutdown', _reqpriv('server', function(query, ctx, cb) {
	this.emit('globalShutdown');
	
	cb('shutdown-success');
}));

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
Admin.prototype.deleteUser = buscomponent.provideWQT('client-delete-user', _reqpriv('userdb', function(query, ctx, cb) {
	var uid = parseInt(query.uid);
	if (uid != uid) // NaN
		return cb('format-error');
	
	if (ctx.user.id == uid)
		return cb('delete-user-self-notallowed');
	
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
 * @function c2s~change-user
 */
Admin.prototype.changeUserEMail = buscomponent.provideWQT('client-change-user-email', _reqpriv('userdb', function(query, ctx, cb) {
	ctx.query('UPDATE users SET email = ?, email_verif = ? WHERE id = ?',
		[String(query.email), query.emailverif ? 1 : 0, parseInt(query.uid)], function() {
		cb('change-user-email-success');
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
Admin.prototype.changeCommentText = buscomponent.provideWQT('client-change-comment-text', _reqpriv('moderate', function(query, ctx, cb) {
	ctx.query('UPDATE ecomments SET comment = ?, trustedhtml = ? WHERE commentid = ?',
		[String(query.comment), ctx.access.has('server') && query.trustedhtml ? 1:0, parseInt(query.commentid)], function() {
		cb('change-comment-text-success');
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
Admin.prototype.notifyUnstickAll = buscomponent.provideWQT('client-notify-unstick-all', _reqpriv('moderate', function(query, ctx, cb) {
	ctx.query('UPDATE mod_notif SET sticky = 0', [], function() {
		cb('notify-unstick-all-success');
	});
}));

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
Admin.prototype.notifyAll = buscomponent.provideWQT('client-notify-all', _reqpriv('moderate', function(query, ctx, cb) {
	ctx.query('INSERT INTO mod_notif (content, sticky) VALUES (?, ?)', [String(query.content), query.sticky ? 1 : 0], function(res) {
		ctx.feed({'type': 'mod-notification', 'targetid': res.insertId, 'srcuser': ctx.user.id, 'everyone': true});
		cb('notify-all-success');
	});
}));

/**
 * Changes a school’s name and/or path.
 * This is the proper way to change a group’s supergroup.
 * 
 * @param {int} query.schoolid  The numerical id of the target school.
 * @param {string} query.schoolpath  The school’s new path.
 * @param {string} query.schoolname  The school’s new human-readable name.
 * 
 * @return {object} Returns with <code>rename-school-notfound</code>,
 *                  <code>rename-school-success</code> or
 *                  a common error code.
 * 
 * @function c2s~rename-school
 */
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

/**
 * Merges two schools into a large school.
 * These schools need to have the same parent school.
 * 
 * @param {int} query.masterschool  The numerical id of the target school.
 * @param {int} query.subschool  The numerical id of the source school.
 * 
 * @return {object} Returns with <code>join-schools-notfound</code>,
 *                  <code>join-schools-success</code>,
 *                  <code>join-schools-diff-parent</code> or
 *                  a common error code.
 * 
 * @function c2s~join-schools
 */
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
Admin.prototype.getFollowers = buscomponent.provideQT('client-get-followers', _reqpriv('userdb', function(query, ctx, cb) {
	ctx.query('SELECT u.name, u.id, ds.* ' +
		'FROM stocks AS s ' +
		'JOIN depot_stocks AS ds ON ds.stockid = s.id ' +
		'JOIN users AS u ON ds.userid = u.id ' +
		'WHERE s.leader = ?', [parseInt(query.uid)], function(res) {
		
		cb('get-followers-success', {results: res});
	});
}));

/**
 * Return various server statistics information.
 * 
 * @return {object} Returns with <code>get-server-statistics-success</code> or
 *                  a common error code and, in case of success, sets
 *                  <code>.servers</code> to an array of results of
 *                  calls to {@link busreq~internal-get-server-statistics}.
 * 
 * @function c2s~get-server-statistics
 */
Admin.prototype.getServerStatistics = buscomponent.provideQT('client-get-server-statistics', _reqpriv('userdb', function(query, ctx, cb) {
	this.requestGlobal({name: 'internal-get-server-statistics'}, function(replies) {
		cb('get-server-statistics-success', {servers: replies});
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
Admin.prototype.showPacketLog = buscomponent.provideQT('client-show-packet-log', _reqpriv('userdb', function(query, ctx, cb) {
	/* The package log is mostly informal and not expected to be used for anything but debugging.
	 * This means that circular structures in it may exist and JSON is simply not the way to go here. */ 
	cb('show-packet-log-success', {result: util.inspect(this.bus.packetLog, null)});
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
