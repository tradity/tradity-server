(function () { "use strict";

var commonUtil = require('./common/util.js');
var serverUtil = require('./server-util.js');
var _ = require('lodash');
var util = require('util');
var assert = require('assert');
var buscomponent = require('./stbuscomponent.js');

/**
 * Provides requests regarding the group structure to the client
 * @public
 * @module schools
 */

/**
 * Main object of the {@link module:schools} module
 * @public
 * @constructor module:schools~Schools
 * @augments module:stbuscomponent~STBusComponent
 */
function Schools () {
	Schools.super_.apply(this, arguments);
}

util.inherits(Schools, buscomponent.BusComponent);

/**
 * Helper function to indicate that a client request requires school admin privileges
 * 
 * @param {QTCallback} f    A standard QT client request handler
 * @param {boolean} [soft=false]   If this is set to true, the request does not fail with a
 *                                 <code>permission-denied</code> error if the <code>schoolid</code> property
 *                                 is not set.
 *                                 This is useful when a request does not always require privileges
 *                                 but rather only when it is applied to a school.
 * @param {module:schools~Schools} [scdb] A provider of the {@link busreq~isSchoolAdmin} bus request for checking privileges.
 * @param {Array} [status] Passed to {@link busreq~isSchoolAdmin}
 * 
 * @return {QTCallback}  A modified callback that fails with <code>permission-denied</code> when encountering
 *                       requests from users that do not have schools admin capabilities.
 * 
 * @function module:schools~_reqschooladm
 */
function _reqschooladm (f, soft, scdb, status) {
	soft = soft || false;
	
	return function(query, ctx, cb) {
		var forward = _.bind(function() { return _.bind(f, this)(query, ctx, cb); }, this);
		
		if (soft && !query.schoolid)
			return forward();
		
		var lsa = null;
		if (this && this.bus) lsa = this;
		if (scdb && scdb.bus) lsa = scdb;
		
		assert.ok(lsa);
		
		lsa.request({name: 'isSchoolAdmin', ctx: ctx, status: status, schoolid: query.schoolid}, function(ok, schoolid) {
			if (!ok)
				return cb('permission-denied');
			
			// in case tha schoolid was not numerical before
			query.schoolid = schoolid;
			forward();
		});
	};
}

/**
 * See {@link module:schools~Schools.isSchoolAdmin}
 * 
 * @function busreq~isSchoolAdmin
 */
/**
 * Tests a user (precisely, a {@link module:qctx~QContext}) for school/group admin privileges.
 * 
 * @param {module:qctx~QContext} ctx  The query context whose user and access patterns are to be checked.
 * @param {?Array} status   A list of acceptable user status to be considered “admin”-Like.
 * @param {int} schoolid    The id of the schools whose admin tables are to be checked.
 * @param {function} reply  Will be called with <code>reply(true, schoolid)</code> when successful,
 *                          otherwise with <code>reply(false, null)</code>.
 * 
 * @function module:schools~Schools#isSchoolAdmin
 */
Schools.prototype.isSchoolAdmin = buscomponent.provide('isSchoolAdmin', ['ctx', 'status', 'schoolid', 'reply'],
	function(ctx, status, schoolid, cb)
{
	var self = this;
	
	(parseInt(schoolid) == schoolid ? function(cont) { cont(); } : function(cont) {
		ctx.query('SELECT id FROM schools WHERE ? IN (id, name, path)', [schoolid], function(res) {
			if (res.length == 0)
				return cb(false, null);
			
			assert.equal(res.length, 1);
			
			schoolid = res[0].id;
			cont();
		});
	})(function() {
		if (ctx.access.has('schooldb'))
			return cb(true, schoolid);
			
		status = status || ['admin', 'xadmin'];
		
		self.loadSchoolAdmins(schoolid, ctx, function(admins) {
			cb(_.chain(admins).filter(function(a) { return status.indexOf(a.status) != -1 && a.adminid == ctx.user.id; }).value().length != 0, schoolid);
		});
	});
});

/**
 * Load a list of admins for a given school/group.
 * 
 * @param {int} schoolid  The numerical id for the school.
 * @param {module:qctx~QContext} ctx  A QContext to provide database access
 * @param {function} cb  A function to be called with a complete list of school admins
 *                       and associated metadata.
 * 
 * @function module:schools~Schools#loadSchoolAdmins
 */
Schools.prototype.loadSchoolAdmins = function(schoolid, ctx, cb) {
	ctx.query('SELECT sa.schoolid AS schoolid, sa.uid AS adminid, sa.status AS status, users.name AS adminname ' +
		'FROM schools AS c ' +
		'JOIN schools AS p ON c.path LIKE CONCAT(p.path, "%") OR p.id = c.id ' +
		'JOIN schooladmins AS sa ON sa.schoolid = p.id ' +
		'JOIN users ON users.id = sa.uid ' +
		'WHERE c.id = ?', [parseInt(schoolid)], cb);
};

/**
 * Load all relevant public info for a given school
 * 
 * @param {(int|string)} lookfor  A school id or path to use for searching the group.
 * @param {module:qctx~QContext} ctx  A context to provide database access.
 * @param {object} cfg  The server base config.
 * @param {function} cb  When ready, will be called with a success or failure parameter
 *                       (see {@link c2s~get-school-info}) as the first parameter and,
 *                       in case of success, a group info as the second parameter.
 * 
 * @function module:schools~Schools#loadSchoolInfo
 */
Schools.prototype.loadSchoolInfo = function(lookfor, ctx, cfg, cb) {
	var self = this;
	
	ctx.query('SELECT schools.id, schools.name, schools.path, descpage, config, eventid, type, targetid, time, srcuser, url AS banner '+
		'FROM schools ' +
		'LEFT JOIN events ON events.targetid = schools.id AND events.type = "school-create" ' +
		'LEFT JOIN httpresources ON httpresources.groupassoc = schools.id AND httpresources.role = "schools.banner" ' +
		'WHERE ? IN (schools.id, schools.path, schools.name) ' + 
		'LIMIT 1', [String(lookfor)], function(res) {
		if (res.length == 0)
			return cb('get-school-info-notfound');
		
		var s = res[0];	
		s.parentPath = null;
		
		assert.ok(s.eventid);
		
		if (s.config == '')
			s.config = {};
		else
			s.config = JSON.parse(s.config);
			
		assert.ok(s.config);
		
		self.loadSchoolAdmins(s.id, ctx, function(admins) {
			s.admins = admins;
			
			ctx.query('SELECT * FROM schools AS c WHERE c.path LIKE ?', [s.path + '/%'], function(subschools) {
			ctx.query('SELECT COUNT(uid) AS usercount ' +
				'FROM schoolmembers AS sm '+
				'LEFT JOIN schools AS c ON sm.schoolid = c.id ' +
				'LEFT JOIN schools AS p ON c.path LIKE CONCAT(p.path, "/%") OR p.id = c.id ' +
				'WHERE p.id = ?', [s.id], function(usercount) {
			ctx.query('SELECT c.*, u.name AS username, u.id AS uid, url AS profilepic, trustedhtml ' +
				'FROM ecomments AS c '+
				'LEFT JOIN users AS u ON c.commenter = u.id ' +
				'LEFT JOIN httpresources ON httpresources.user = c.commenter AND httpresources.role = "profile.image" '+
				'WHERE c.eventid = ?',
				[s.eventid],
				function(comments) {
				s.comments = comments;
				s.subschools = subschools;
				s.usercount = usercount[0].usercount;
				
				ctx.query('SELECT oh.stocktextid AS stockid, oh.stockname, ' +
					'SUM(ABS(money)) AS moneysum, ' +
					'SUM(ABS(money) / (UNIX_TIMESTAMP() - buytime + 300)) AS wsum ' +
					'FROM orderhistory AS oh ' +
					'JOIN schoolmembers AS sm ON sm.uid = oh.userid AND sm.jointime < oh.buytime AND sm.schoolid = ? ' +
					'GROUP BY stocktextid ORDER BY wsum DESC LIMIT 10', [s.id], function(popular) {
					if (s.path.replace(/[^\/]/g, '').length != 1) { // need higher-level 
						s.parentPath = commonUtil.parentPath(s.path);
						self.loadSchoolInfo(s.parentPath, ctx, cfg, function(code, result) {
							assert.equal(code, 'get-school-info-success');
							
							s.parentSchool = result;
							
							s.config = serverUtil.deepupdate({}, cfg.schoolConfigDefaults, s.parentSchool.config, s.config);
							
							cb('get-school-info-success', s);
						});
					} else {
						s.config = serverUtil.deepupdate({}, cfg.schoolConfigDefaults, s.config);
						
						cb('get-school-info-success', s);
					}
				});
			});
			});
			});
		});
	});
};

/**
 * A school info object (specializes {@link Event}), as returned by {@link c2s~get-school-info}
 * 
 * @typedef module:schools~schoolinfo
 * @type {object}
 * 
 * @property {int} id  A numerical school id.
 * @property {string} name  A human-readable name for the school/group.
 * @property {string} path  A machine-readable path for the school/group, indicating its supergroups’ paths.
 * @property {string} descpage  A human-readable description of the school/group, usually written by its administrators.
 * @property {object} config  A config for the school containing various parameters, e.g. ranking information.
 * @property {int} eventid  The event for the school creation. Useful for writing comments on the pinboard.
 * @property {string} type  The event type for the school creation (<code>school-create</code>).
 * @property {int} targetid  The school id.
 * @property {int} time  The school creation time.
 * @property {string} banner  The public school banner.
 * @property {int} usercount  The number of school members.
 * @property {Comment[]} comments  The school “pinboard” (i.e. comments on the school creation event).
 * @property {module:schools~schoolinfo[]} subschools  A list of subschools of this school
 *                                                     (in short notation, i.e. no event/comment information etc.).
 * @property {string} parentPath  The parent path of this school, or '/' if this school is top-level.
 */

/**
 * Load all relevant public info for a given school
 * 
 * @param {(int|string)} query.lookfor A school id, path or name to look for.
 * 
 * @return {object} Returns with <code>get-school-info-success</code> and a detailed school info in <code>.result</code>
 *                  in case of success and <code>get-school-info-notfound</code> in case the school could not be found.
 *                  The precise format is described [here]{@link module:schools~schoolinfo}.
 * 
 * @function c2s~get-school-info
 */
Schools.prototype.getSchoolInfo = buscomponent.provideQT('client-get-school-info', function(query, ctx, cb) {
	var self = this;
	
	self.getServerConfig(function(cfg) {
		self.loadSchoolInfo(query.lookfor, ctx, cfg, function(code, result) {
			cb(code, {'result': result});
		});
	});
});

/**
 * Check for the existence of a given school path/id/name.
 * This is not a redundancy to {@link c2s~get-school-info}, since the latter
 * requires the querying user to be logged in.
 * 
 * @param {(int|string)} query.lookfor A school id, path or name to look for.
 * 
 * @return {object} Returns with <code>school-exists-success</code>.
 *                  The <code>.exists</code> attribute will be a boolean indicating
 *                  the existence of the given group, and in case it exists, <code>.path</code>
 *                  will contain its path identifier.
 * 
 * @loginignore
 * @function c2s~school-exists
 */
Schools.prototype.schoolExists = buscomponent.provideQT('client-school-exists', function(query, ctx, cb) {
	ctx.query('SELECT path FROM schools WHERE ? IN (id, path, name)', [String(query.lookfor)], function(res) {
		cb('school-exists-success', {exists: res.length > 0, path: res.length > 0 ? res[0].path : null});
	});
});

/**
 * Changes a school description text.
 * 
 * @param {int} query.schoolid  A school id to operate on.
 * @param {(string)} query.descpage  A human-readable description of the school/group for later display.
 * 
 * @return {object} Returns with <code>school-exists-success</code> or a common error code.
 * 
 * @noreadonly
 * @function c2s~school-change-description
 */
Schools.prototype.changeDescription = buscomponent.provideWQT('client-school-change-description', _reqschooladm(function(query, ctx, cb) {
	ctx.query('UPDATE schools SET descpage = ? WHERE id = ?', [String(query.descpage), parseInt(query.schoolid)], function() {
		cb('school-change-description-success');
	});
}));

/**
 * Makes a school member non-pending and, optionally, awards or removes admin status.
 * 
 * @param {int} query.schoolid  A school id to operate on.
 * @param {string} query.status  If 'member', removes all admin status. Otherwise
 *                         (and especially for 'admin'), marks the given user as a
 *                         school/group admin.
 * 
 * @return {object} Returns with <code>school-change-member-status</code> or a common error code.
 * 
 * @noreadonly
 * @function c2s~school-change-member-status
 */
Schools.prototype.changeMemberStatus = buscomponent.provideWQT('client-school-change-member-status', _reqschooladm(function(query, ctx, cb) {
	ctx.query('UPDATE schoolmembers SET pending = 0 WHERE schoolid = ? AND uid = ?',
		[parseInt(query.schoolid), parseInt(query.uid)], function() {
		if (query.status == 'member') {
			ctx.query('DELETE FROM schooladmins WHERE uid = ? AND schoolid = ?',
				[parseInt(query.uid), parseInt(query.schoolid)], function() {
				cb('school-change-member-status-success');
			});
		} else {
			ctx.query('REPLACE INTO schooladmins (schoolid, uid, status) VALUES(?, ?, ?)',
				[parseInt(query.schoolid), parseInt(query.uid), String(query.status)], function() {
				cb('school-change-member-status-success');
			});
		}
	});
}));

/**
 * Deletes a comment (replaces the text with a notice).
 * 
 * The server template for the notice is stored in
 * <code>comment-deleted-by-group-admin.html</code>.
 * 
 * @param {int} query.schoolid  A school id to operate on.
 * @param {int} query.commentid  The numeric id of the comment to delete.
 * 
 * @return {object} Returns with <code>school-delete-comment-success</code> or a common error code.
 * 
 * @noreadonly
 * @function c2s~school-delete-comment
 */
Schools.prototype.deleteComment = buscomponent.provideWQT('client-school-delete-comment', _reqschooladm(function(query, ctx, cb) {
	var self = this;
	
	ctx.query('SELECT c.commentid AS cid FROM ecomments AS c ' +
		'JOIN events AS e ON e.eventid = c.eventid ' +
		'WHERE c.commentid = ? AND e.targetid = ? AND e.type = "school-create"',
		[parseInt(query.commentid), parseInt(query.schoolid)], function(res) {
		if (res.length == 0)
			return cb('permission-denied');
		
		assert.ok(res.length == 1 && res[0].cid == query.commentid);
		
		ctx.query('UPDATE ecomments SET comment = ?, trustedhtml = 1 WHERE commentid = ?',
			[self.readTemplate('comment-deleted-by-group-admin.html'), parseInt(query.commentid)], function() {
			cb('school-delete-comment-success');
		});
	});
}));

/**
 * Removes a user from the school member list.
 * 
 * @param {int} query.schoolid  A school id to operate on.
 * @param {int} query.uid  The numeric id of the user to remove.
 * 
 * @return {object} Returns with <code>school-kick-user-success</code> or a common error code.
 * 
 * @noreadonly
 * @function c2s~school-kick-user
 */
Schools.prototype.kickUser = buscomponent.provideWQT('client-school-kick-user', _reqschooladm(function(query, ctx, cb) {
	ctx.query('DELETE FROM schoolmembers WHERE uid = ? AND schoolid = ?', 
		[parseInt(query.uid), parseInt(query.schoolid)], function() {
		ctx.query('DELETE FROM schooladmins WHERE uid = ? AND schoolid = ?', 
			[parseInt(query.uid), parseInt(query.schoolid)], function() {
			cb('school-kick-user-success');
		});
	});
}));

/**
 * Informs users that a new group/school has been created.
 * 
 * @typedef s2c~school-create
 * @type {Event}
 * 
 * @property {int} schoolid  The numerical ID of the new school
 * @property {string} schoolname  The human-readable name of the new school
 * @property {string} schoolpath  The new school’s path indicating its place in the
 *                                school tree
 */

/**
 * Creates a new school.
 * 
 * @param {?string} query.schoolpath  The path for the new school. If not given,
 *                                    a path will be generated from the school’s name.
 *                                    Note that this indicated potential parent groups.
 * @param {string} query.schoolname   A human-readable identifier of the school.
 *                                    It is recommended but not enforced that this is unrelated
 *                                    to any parent group’s names, therefore not introducing
 *                                    redundancy.
 * 
 * @return {object} Returns with <code>create-school-success</code>,
 *                  <code>create-school-already-exists</code> if the path is already taken,
 *                  <code>create-school-missing-parent</code> if the path is invalid,
 *                  or a common error code.
 * 
 * @noreadonly
 * @function c2s~create-school
 */
Schools.prototype.createSchool = buscomponent.provideWQT('client-create-school', function(query, ctx, cb) {
	if (!query.schoolname)
		return cb('format-error');
	
	query.schoolname = String(query.schoolname);
	
	if (!query.schoolpath)
		query.schoolpath = '/' + query.schoolname.replace(/[^\w_-]/g, '');
	
	ctx.getConnection(function(conn, commit, rollback) {
		conn.query('START TRANSACTION', [], function() {
		conn.query('SELECT COUNT(*) AS c FROM schools WHERE path = ?', [String(query.schoolpath)], function(r) {
			assert.equal(r.length, 1);
			if (r[0].c == 1 || !query.schoolname.trim() || 
				!/^(\/[\w_-]+)+$/.test(query.schoolpath)) {
				rollback();
				
				return cb('create-school-already-exists');
			}
			
			var createCB = function() {
				conn.query('INSERT INTO schools (name,path) VALUES(?,?)',
					[String(query.schoolname), String(query.schoolpath)], function(res) {
					ctx.feed({'type': 'school-create', 'targetid': res.insertId, 'srcuser': ctx.user.id});
					
					commit();
					
					cb('create-school-success');
				});
			};
			
			if (query.schoolpath.replace(/[^\/]/g, '').length == 1)
				createCB();
			else conn.query('SELECT COUNT(*) AS c FROM schools WHERE path = ?',
				[commonUtil.parentPath(String(query.schoolpath))],
				function(r) {
				assert.equal(r.length, 1);
				if (r[0].c != 1) {
					rollback();
					
					return cb('create-school-missing-parent');
				}
				
				createCB();
			});
		});
		});
	});
});

/**
 * Enumerate all currently present groups, optionally filtered by further specifiers.
 * 
 * @param {?string} query.parentPath  Enumerate only subgroups of the one specified via this path.
 * @param {?string} query.search      Search group paths and names for this string
 *                                    (i.e. return only matches).
 * 
 * @return {object} Returns with <code>list-schools-success</code> or a common error code.
 * 
 * @noreadonly
 * @loginignore
 * @function c2s~list-schools
 */
Schools.prototype.listSchools = buscomponent.provideQT('client-list-schools', function(query, ctx, cb) {
	var where = 'WHERE 1 ';
	var params = [];
	if (query.parentPath) {
		where = 'AND path LIKE ? OR path = ? ';
		params.push(String(query.parentPath) + '/%', String(query.parentPath));
	}
	
	if (query.search) {
		var likestring = '%' + (String(query.search)).replace(/%/g, '\\%') + '%';
		
		where += 'AND (name LIKE ? OR path LIKE ?) ';
		params.push(likestring, likestring);
	}
	
	ctx.query('SELECT schools.id, schools.name, COUNT(sm.uid) AS usercount, schools.path FROM schools ' +
		'LEFT JOIN schoolmembers AS sm ON sm.schoolid=schools.id AND NOT pending ' +
		where +
		'GROUP BY schools.id', params, function(results) {
			cb('list-schools-success', {'result': results});
		}
	);
});

/**
 * Publish the school banner for a given group.
 * 
 * This inherits all parameters and return codes from {@link c2s~publish}.
 * 
 * @param {int} query.schoolid  The numerical id of the school to publish the banner for.
 * 
 * @return {object} See {@link c2s~publish}.
 * 
 * @noreadonly
 * @function c2s~school-publish-banner
 */
Schools.prototype.publishBanner = buscomponent.provideQT('client-school-publish-banner', function(query, ctx, cb) {
	query.role = 'schools.banner';
	
	_reqschooladm(_.bind(function(query, ctx, cb) {
		this.request({name: 'client-publish', query: query, ctx: ctx, groupassoc: query.schoolid}, cb);
	}, this), false, this)(query, ctx, cb);
});

/**
 * Create an invite link, optionally for a given school/group and/or send it to an email adress.
 * 
 * See also {@link busreq~createInviteLink}.
 * 
 * @param {?int} query.schoolid  The numerical id of the school to create an invite link for.
 *                               Use of the invite link will lead to automatically joining the group.
 * @param {?string} query.email  The email to send the invite link to.
 * 
 * @return {object} Returns with <code>create-invite-link-success</code>,
 *                  <code>create-invite-link-not-verif</code> if the own e-mail address has not been verified,
 *                  <code>create-invite-link-invalid-email</code> if <code>query.email</code> is not valid,
 *                  or a common error code.
 * 
 * @noreadonly
 * @function c2s~create-invite-link
 */
Schools.prototype.createInviteLink = buscomponent.provideQT('client-create-invite-link', function(query, ctx, cb) {
	_reqschooladm(_.bind(function(query, ctx, cb) {
		this.request({name: 'createInviteLink', query: query, ctx: ctx}, cb);
	}, this), true, this)(query, ctx, cb);
});

exports.Schools = Schools;

})();
