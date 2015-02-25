(function () { "use strict";

var commonUtil = require('tradity-connection');
var serverUtil = require('./server-util.js');
var _ = require('lodash');
var util = require('util');
var assert = require('assert');
var Q = require('q');
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
 *                       requests from users that do not have school admin capabilities.
 * 
 * @function module:schools~_reqschooladm
 */
function _reqschooladm (f, soft, scdb, status) {
	soft = soft || false;
	
	return function(query, ctx) {
		var self = this;
		
		var forward = function() { return f.call(self, query, ctx); };
		
		if (soft && !query.schoolid)
			return forward();
		
		var lsa = null;
		if (self && self.bus) lsa = self;
		if (scdb && scdb.bus) lsa = scdb;
		
		assert.ok(lsa);
		
		return lsa.request({name: 'isSchoolAdmin', ctx: ctx, status: status, schoolid: query.schoolid}).then(function(schoolAdminResult) {
			if (!schoolAdminResult.ok)
				throw new self.PermissionDenied();
			
			// in the case that schoolid was not numerical before
			query.schoolid = schoolAdminResult.schoolid;
			return forward();
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
 *
 * @return {object}  Returns a Q promise returning <code>{ ok: true, schoolid: … }</code> when successful,
 *                          otherwise with <code>{ ok: false, schoolid: null }</code>.
 * 
 * @function module:schools~Schools#isSchoolAdmin
 */
Schools.prototype.isSchoolAdmin = buscomponent.provide('isSchoolAdmin', ['ctx', 'status', 'schoolid'],
	function(ctx, status, schoolid)
{
	var self = this;
	
	return (parseInt(schoolid) == schoolid ? Q([{id: schoolid}]) :
		ctx.query('SELECT id FROM schools WHERE ? IN (id, name, path)', [schoolid]))
	.then(function(res) {
		if (res.length == 0)
			return {ok: false, schoolid: null};
		
		assert.equal(res.length, 1);
		
		schoolid = res[0].id;
		
		if (ctx.access.has('schooldb'))
			return {ok: true, schoolid: schoolid};
			
		status = status || ['admin', 'xadmin'];
		
		return self.loadSchoolAdmins(schoolid, ctx).then(function(admins) {
			var isAdmin = (admins.filter(function(a) {
				return status.indexOf(a.status) != -1 && a.adminid == ctx.user.id;
			}).length > 0);
			return {ok: isAdmin, schoolid: isAdmin ? schoolid : null};
		});
	});
});

/**
 * Load a list of admins for a given school/group.
 * 
 * @param {int} schoolid  The numerical id for the school.
 * @param {module:qctx~QContext} ctx  A QContext to provide database access
 * @return {object}  A Q promise for a complete list of school admins and associated metadata.
 * 
 * @function module:schools~Schools#loadSchoolAdmins
 */
Schools.prototype.loadSchoolAdmins = function(schoolid, ctx) {
	return ctx.query('SELECT sa.schoolid AS schoolid, sa.uid AS adminid, sa.status AS status, users.name AS adminname ' +
		'FROM schools AS c ' +
		'JOIN schools AS p ON c.path LIKE CONCAT(p.path, "%") OR p.id = c.id ' +
		'JOIN schooladmins AS sa ON sa.schoolid = p.id ' +
		'JOIN users ON users.id = sa.uid ' +
		'WHERE c.id = ?', [parseInt(schoolid)]);
};

/**
 * Load all relevant public info for a given school
 * 
 * @param {(int|string)} lookfor  A school id or path to use for searching the group.
 * @param {module:qctx~QContext} ctx  A context to provide database access.
 * @param {object} cfg  The server base config.
 * 
 * @return {object} A Q promise for a { code: …, schoolinfo: … / null } object
 * 
 * @function module:schools~Schools#loadSchoolInfo
 */
Schools.prototype.loadSchoolInfo = function(lookfor, ctx, cfg) {
	var self = this;
	
	var s;
	return ctx.query('SELECT schools.id, schools.name, schools.path, descpage, config, eventid, type, targetid, time, srcuser, url AS banner '+
		'FROM schools ' +
		'LEFT JOIN events ON events.targetid = schools.id AND events.type = "school-create" ' +
		'LEFT JOIN httpresources ON httpresources.groupassoc = schools.id AND httpresources.role = "schools.banner" ' +
		'WHERE ? IN (schools.id, schools.path, schools.name) ' + 
		'LIMIT 1', [String(lookfor)]).then(function(res) {
		if (res.length == 0)
			throw new this.SoTradeClientError('get-school-info-notfound');
		
		s = res[0];	
		s.parentPath = null;
		
		assert.ok(s.eventid);
		
		if (s.config == '')
			s.config = {};
		else
			s.config = JSON.parse(s.config);
			
		assert.ok(s.config);
		
		return Q.all([
			self.loadSchoolAdmins(s.id, ctx), // admins
			ctx.query('SELECT * FROM schools AS c WHERE c.path LIKE ?', [s.path + '/%']), // subschools
			ctx.query('SELECT COUNT(uid) AS usercount ' +
				'FROM schools AS p '+
				'LEFT JOIN schools AS c ON c.path LIKE CONCAT(p.path, "/%") OR p.id = c.id ' +
				'LEFT JOIN schoolmembers AS sm ON sm.schoolid = c.id AND NOT pending ' +
				'WHERE p.id = ?', [s.id]), // usercount[0].usercount
			ctx.query('SELECT c.*, u.name AS username, u.id AS uid, url AS profilepic, trustedhtml ' +
				'FROM ecomments AS c '+
				'LEFT JOIN users AS u ON c.commenter = u.id ' +
				'LEFT JOIN httpresources ON httpresources.user = c.commenter AND httpresources.role = "profile.image" '+
				'WHERE c.eventid = ?',
				[s.eventid]), // comments
			ctx.query('SELECT * FROM blogposts ' +
				'JOIN feedblogs ON feedblogs.blogid = blogposts.blogid ' +
				'JOIN events ON events.targetid = blogposts.postid AND events.type="blogpost" ' +
				'WHERE feedblogs.schoolid = ?',
				[s.id]).then(function(blogposts) {
					return blogposts.map(function(post) {
						var expost = _.extend(post, JSON.parse(post.postjson))
						delete expost.postjson;
						return expost;
					});
				}), // blogposts
			ctx.query('SELECT oh.stocktextid AS stockid, oh.stockname, ' +
				'SUM(ABS(money)) AS moneysum, ' +
				'SUM(ABS(money) / (UNIX_TIMESTAMP() - buytime + 300)) AS wsum ' +
				'FROM orderhistory AS oh ' +
				'JOIN schoolmembers AS sm ON sm.uid = oh.userid AND sm.jointime < oh.buytime AND sm.schoolid = ? ' +
				'GROUP BY stocktextid ORDER BY wsum DESC LIMIT 10', [s.id]), // popularStocks
			!ctx.access.has('wordpress') ? [] : 
				// compare wordpress-feed.js
				ctx.query('SELECT feedblogs.blogid, endpoint, category, schoolid, path AS schoolpath, ' +
					'bloguser, COUNT(*) AS postcount, users.name ' +
					'FROM feedblogs ' + 
					'LEFT JOIN blogposts ON feedblogs.blogid = blogposts.blogid ' +
					'LEFT JOIN users ON feedblogs.bloguser = users.id ' +
					'LEFT JOIN schools ON feedblogs.schoolid = schools.id ' +
					'WHERE schoolid = ? ' +
					'GROUP BY blogid', [s.id]), // feedblogs
			Q().then(function() {
				if (s.path.replace(/[^\/]/g, '').length != 1) // need higher-level 
					s.parentPath = commonUtil.parentPath(s.path);
				
				return s.parentPath ? self.loadSchoolInfo(s.parentPath, ctx, cfg) :
					Q({schoolinfo: null});
			}) // parentResult
		]);
	}).spread(function(admins, subschools, usercount, comments, blogposts, popularStocks, feedblogs, parentResult) {
		s.admins = admins;
		s.subschools = subschools;
		s.usercount = usercount[0].usercount;
		s.comments = comments;
		s.blogposts = blogposts;
		s.popularStocks = popularStocks;
		s.feedblogs = feedblogs;
		
		assert.ok(typeof parentResult.code == 'undefined' || parentResult.code == 'get-school-info-success');
		
		s.parentSchool = parentResult;
		s.config = serverUtil.deepupdate({}, cfg.schoolConfigDefaults,
			s.parentSchool ? s.parentSchool.config : {}, s.config);
		
		return { code: 'get-school-info-success', schoolinfo: s };
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
 * @property {Blogpost[]} blogposts  The school “blogposts” (Associated Wordpress blog posts).
 * @property {module:schools~schoolinfo[]} subschools  A list of subschools of this school
 *                                                     (in short notation, i.e. no event/comment information etc.).
 * @property {string} parentPath  The parent path of this school, or '/' if this school is top-level.
 * @property {object[]} popularStocks  See {@link c2s~list-popular-stocks}.
 * @property {object[]} feedblogs  See {@link c2s~list-wordpress-feeds}.
 */

/**
 * Load all relevant public info for a given school
 * 
 * @param {(int|string)} query.lookfor  A school id, path or name to look for.
 * 
 * @return {object} Returns with <code>get-school-info-success</code> and a detailed school info in <code>.result</code>
 *                  in case of success and <code>get-school-info-notfound</code> in case the school could not be found.
 *                  The precise format is described [here]{@link module:schools~schoolinfo}.
 * 
 * @function c2s~get-school-info
 */
Schools.prototype.getSchoolInfo = buscomponent.provideQT('client-get-school-info', function(query, ctx) {
	var self = this;
	
	return self.getServerConfig().then(function(cfg) {
		return self.loadSchoolInfo(query.lookfor, ctx, cfg);
	}).then(function(result) {
		return { code: result.code, 'result': result.schoolinfo };
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
Schools.prototype.schoolExists = buscomponent.provideQT('client-school-exists', function(query, ctx) {
	return ctx.query('SELECT path FROM schools WHERE ? IN (id, path, name) OR LOWER(?) IN (id, path, name)',
		[String(query.lookfor), String(query.lookfor)]).then(function(res) {
		return { code: 'school-exists-success', exists: res.length > 0, path: res.length > 0 ? res[0].path : null };
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
Schools.prototype.changeDescription = buscomponent.provideWQT('client-school-change-description', _reqschooladm(function(query, ctx) {
	return ctx.query('UPDATE schools SET descpage = ? WHERE id = ?',
		[String(query.descpage), parseInt(query.schoolid)]).then(function() {
		return { code: 'school-change-description-success' };
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
Schools.prototype.changeMemberStatus = buscomponent.provideWQT('client-school-change-member-status', _reqschooladm(function(query, ctx) {
	if (parseInt(query.uid) != query.uid)
		throw new this.FormatError();
	
	return ctx.query('UPDATE schoolmembers SET pending = 0 WHERE schoolid = ? AND uid = ?',
		[parseInt(query.uid), parseInt(query.schoolid)]).then(function() {
		if (query.status == 'member')
			return ctx.query('DELETE FROM schooladmins WHERE uid = ? AND schoolid = ?',
				[parseInt(query.uid), parseInt(query.schoolid)]);
		else
			return ctx.query('REPLACE INTO schooladmins (schoolid, uid, status) VALUES(?, ?, ?)',
				[parseInt(query.schoolid), parseInt(query.uid), String(query.status)]);
	}).then(function() {
		return { code: 'school-change-member-status-success' };
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
Schools.prototype.deleteComment = buscomponent.provideWQT('client-school-delete-comment', _reqschooladm(function(query, ctx) {
	var self = this;
	
	return ctx.query('SELECT c.commentid AS cid FROM ecomments AS c ' +
		'JOIN events AS e ON e.eventid = c.eventid ' +
		'WHERE c.commentid = ? AND e.targetid = ? AND e.type = "school-create"',
		[parseInt(query.commentid), parseInt(query.schoolid)]).then(function(res) {
		if (res.length == 0)
			throw new self.PermissionDenied();
		
		assert.ok(res.length == 1 && res[0].cid == query.commentid);
		
		return self.request({ name: 'readTemplate', template: 'comment-deleted-by-group-admin.html' });
	}).then(function(commentContent) {
		return ctx.query('UPDATE ecomments SET comment = ?, trustedhtml = 1 WHERE commentid = ?',
			[commentContent, parseInt(query.commentid)]);
	}).then(function() {
		return { code: 'school-delete-comment-success' };
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
Schools.prototype.kickUser = buscomponent.provideWQT('client-school-kick-user', _reqschooladm(function(query, ctx) {
	if (parseInt(query.uid) != query.uid || parseInt(query.schoolid) != query.schoolid)
		throw new this.FormatError();
	
	return ctx.query('DELETE FROM schoolmembers WHERE uid = ? AND schoolid = ?', 
		[parseInt(query.uid), parseInt(query.schoolid)]).then(function() {
		return ctx.query('DELETE FROM schooladmins WHERE uid = ? AND schoolid = ?', 
			[parseInt(query.uid), parseInt(query.schoolid)]);
	}).then(function() {
		return { code: 'school-kick-user-success' };
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
 *                                    Note that this indicates potential parent groups.
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
Schools.prototype.createSchool = buscomponent.provideWQT('client-create-school', function(query, ctx) {
	var self = this;
	
	if (!query.schoolname)
		throw new self.FormatError();
	
	query.schoolname = String(query.schoolname || '');
	
	if (!query.schoolpath)
		query.schoolpath = '/' + query.schoolname.toLowerCase().replace(/[^\w_-]/g, '');
	
	var conn;
	return ctx.startTransaction().then(function(conn_) {
		conn = conn_;
		
		return conn.query('SELECT COUNT(*) AS c FROM schools WHERE path = ?', [String(query.schoolpath)]);
	}).then(function(r) {
		assert.equal(r.length, 1);
		if (r[0].c == 1 || !query.schoolname.trim() || 
			!/^(\/[\w_-]+)+$/.test(query.schoolpath)) {
			return conn.rollback().then(function() {
				throw new self.SoTradeClientError('create-school-already-exists');
			});
		}
		
		if (String(query.schoolpath).replace(/[^\/]/g, '').length == 1)
			return [{c: 1}];
		else
			return conn.query('SELECT COUNT(*) AS c FROM schools WHERE path = ?',
			[commonUtil.parentPath(String(query.schoolpath))]);
	}).then(function(r) {
		assert.equal(r.length, 1);
		
		if (r[0].c != 1) {
			return conn.rollback().then(function() {
				throw new self.SoTradeClientError('create-school-missing-parent');
			});
		}
		
		return conn.query('INSERT INTO schools (name, path) VALUES(?, ?)',
			[String(query.schoolname), String(query.schoolpath)]);
	}).then(function(res) {
		return ctx.feed({
			'type': 'school-create',
			'targetid': res.insertId,
			'srcuser': ctx.user.id,
			'conn': conn
		});
	}).then(function() {
		return conn.commit();
	}).then(function() {
		return { code: 'create-school-success', path: String(query.schoolpath) };
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
Schools.prototype.listSchools = buscomponent.provideQT('client-list-schools', function(query, ctx) {
	query.parentPath = String(query.parentPath || '').toLowerCase();
	
	var where = 'WHERE 1 ';
	var params = [];
	if (query.parentPath) {
		where = 'AND p.path LIKE ? OR p.path = ? ';
		params.push(query.parentPath + '/%', query.parentPath);
	}
	
	if (query.search) {
		var likestring = '%' + (String(query.search)).replace(/%/g, '\\%') + '%';
		
		where += 'AND (p.name LIKE ? OR p.path LIKE ?) ';
		params.push(likestring, likestring);
	}
	
	return ctx.query('SELECT p.id, p.name, COUNT(sm.uid) AS usercount, p.path, url AS banner ' +
		'FROM schools AS p '+
		'LEFT JOIN schools AS c ON c.path LIKE CONCAT(p.path, "/%") OR p.id = c.id ' +
		'LEFT JOIN schoolmembers AS sm ON sm.schoolid = c.id AND NOT pending ' +
		'LEFT JOIN httpresources ON httpresources.groupassoc = p.id AND httpresources.role = "schools.banner" ' +
		where +
		'GROUP BY p.id', params).then(function(results) {
		return { code: 'list-schools-success', 'result': results };
	});
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
Schools.prototype.publishBanner = buscomponent.provideQT('client-school-publish-banner', function(query, ctx) {
	query.role = 'schools.banner';
	
	return _reqschooladm(_.bind(function(query, ctx) {
		return this.request({name: 'client-publish', query: query, ctx: ctx, groupassoc: query.schoolid});
	}, this), false, this)(query, ctx);
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
Schools.prototype.createInviteLink = buscomponent.provideQT('client-create-invite-link', function(query, ctx) {
	return _reqschooladm(_.bind(function(query, ctx) {
		return this.request({name: 'createInviteLink', query: query, ctx: ctx});
	}, this), true, this)(query, ctx);
});

exports.Schools = Schools;

})();
