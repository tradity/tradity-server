(function () { "use strict";

function parentPath(x) {
	var match = x.match(/((\/[\w_-]+)+)\/[\w_-]+$/);
	return match ? match[1] : '/';
}

var _ = require('underscore');
var util = require('util');
var assert = require('assert');
var buscomponent = require('./bus/buscomponent.js');

function SchoolsDB () {
}

util.inherits(SchoolsDB, buscomponent.BusComponent);

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
			
			query.schoolid = schoolid;
			forward();
		});
	};
}

SchoolsDB.prototype.isSchoolAdmin = buscomponent.provide('isSchoolAdmin', ['ctx', 'status', 'schoolid', 'reply'],
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

SchoolsDB.prototype.loadSchoolAdmins = function(schoolid, ctx, cb) {
	ctx.query('SELECT sa.schoolid AS schoolid, sa.uid AS adminid, sa.status AS status, users.name AS adminname ' +
		'FROM schools AS c ' +
		'JOIN schools AS p ON c.path LIKE CONCAT(p.path, "%") OR p.id = c.id ' +
		'JOIN schooladmins AS sa ON sa.schoolid = p.id ' +
		'JOIN users ON users.id = sa.uid ' +
		'WHERE c.id = ?', [schoolid], cb);
};

SchoolsDB.prototype.loadSchoolInfo = function(lookfor, ctx, cfg, cb) {
	var self = this;
	
	ctx.query('SELECT schools.id, schools.name, schools.path, descpage, config, eventid, type, targetid, time, srcuser, url AS banner '+
		'FROM schools ' +
		'LEFT JOIN events ON events.targetid = schools.id AND events.type = "school-create" ' +
		'LEFT JOIN httpresources ON httpresources.groupassoc = schools.id AND httpresources.role = "schools.banner" ' +
		'WHERE ? IN (schools.id, schools.path, schools.name) ' + 
		'LIMIT 1', [lookfor], function(res) {
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
			ctx.query('SELECT c.*,u.name AS username,u.id AS uid, url AS profilepic, trustedhtml ' +
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
						s.parentPath = parentPath(s.path);
						self.loadSchoolInfo(s.parentPath, ctx.user, ctx.access, cfg, function(code, result) {
							assert.equal(code, 'get-school-info-success');
							
							s.parentSchool = result;
							
							s.config = _.defaults(s.config, s.parentSchool.config, cfg.schoolConfigDefaults);
							
							cb('get-school-info-success', s);
						});
					} else {
						s.config = _.defaults(s.config, cfg.schoolConfigDefaults);
						
						cb('get-school-info-success', s);
					}
				});
			});
			});
			});
		});
	});
};

SchoolsDB.prototype.getSchoolInfo = buscomponent.provideQT('client-get-school-info', function(query, ctx, cb) {
	var self = this;
	
	self.getServerConfig(function(cfg) {
		self.loadSchoolInfo(query.lookfor, ctx, cfg, function(code, result) {
			cb(code, {'result': result});
		});
	});
});

SchoolsDB.prototype.schoolExists = buscomponent.provideQT('client-school-exists', function(query, ctx, cb) {
	ctx.query('SELECT path FROM schools WHERE ? IN (id, path, name)', [query.lookfor], function(res) {
		cb('school-exists-success', {exists: res.length > 0, path: res.length > 0 ? res[0].path : null});
	});
});

SchoolsDB.prototype.changeDescription = buscomponent.provideQT('client-school-change-description', _reqschooladm(function(query, ctx, cb) {
	ctx.query('UPDATE schools SET descpage = ? WHERE id = ?', [query.descpage, query.schoolid], function() {
		cb('school-change-description-success');
	});
}));

SchoolsDB.prototype.changeMemberStatus = buscomponent.provideQT('client-school-change-member-status', _reqschooladm(function(query, ctx, cb) {
	ctx.query('UPDATE schoolmembers SET pending = 0 WHERE schoolid = ? AND uid = ?', [query.schoolid, query.uid], function() {
		if (query.status == 'member') {
			ctx.query('DELETE FROM schooladmins WHERE uid = ? AND schoolid = ?', [query.uid, query.schoolid], function() {
				cb('school-change-member-status-success');
			});
		} else {
			ctx.query('REPLACE INTO schooladmins (schoolid, uid, status) VALUES(?, ?, ?)', [query.schoolid, query.uid, query.status], function() {
				cb('school-change-member-status-success');
			});
		}
	});
}));

SchoolsDB.prototype.deleteComment = buscomponent.provideQT('client-school-delete-comment', _reqschooladm(function(query, ctx, cb) {
	var self = this;
	
	ctx.query('SELECT c.commentid AS cid FROM ecomments AS c ' +
		'JOIN events AS e ON e.eventid = c.eventid ' +
		'WHERE c.commentid = ? AND e.targetid = ? AND e.type = "school-create"',
		[query.commentid, query.schoolid], function(res) {
		if (res.length == 0)
			return cb('permission-denied');
		
		assert.ok(res.length == 1 && res[0].cid == query.commentid);
		
		ctx.query('UPDATE ecomments SET comment = ?, trustedhtml = 1 WHERE commentid = ?',
			[self.readTemplate('comment-deleted-by-group-admin.html'), query.commentid], function() {
			cb('school-delete-comment-success');
		});
	});
}));

SchoolsDB.prototype.kickUser = buscomponent.provideQT('client-school-kick-user', _reqschooladm(function(query, ctx, cb) {
	ctx.query('DELETE FROM schoolmembers WHERE uid = ? AND schoolid = ?', 
		[query.uid, query.schoolid], function() {
		ctx.query('DELETE FROM schooladmins WHERE uid = ? AND schoolid = ?', 
			[query.uid, query.schoolid], function() {
			cb('school-kick-user-success');
		});
	});
}));

SchoolsDB.prototype.createSchool = buscomponent.provideQT('client-create-school', function(query, ctx, cb) {
	if (!query.schoolpath)
		query.schoolpath = '/' + query.schoolname.replace(/[^\w_-]/g, '');
	
	ctx.getConnection(function(conn) {
		conn.query('START TRANSACTION', [], function() {
		conn.query('SELECT COUNT(*) AS c FROM schools WHERE path = ?', [query.schoolpath], function(r) {
			assert.equal(r.length, 1);
			if (r[0].c == 1 || !query.schoolname.trim() || 
				!/^(\/[\w_-]+)+$/.test(query.schoolpath)) {
				conn.query('ROLLBACK', function() {
					conn.release();
				});
				
				return cb('create-school-already-exists');
			}
			
			var createCB = function() {
				conn.query('INSERT INTO schools (name,path) VALUES(?,?)', [query.schoolname,query.schoolpath], function(res) {
					ctx.feed({'type': 'school-create', 'targetid': res.insertId, 'srcuser': ctx.user.id});
					
					conn.query('COMMIT', function() {
						conn.release();
					});
					
					cb('create-school-success');
				});
			};
			
			if (query.schoolpath.replace(/[^\/]/g, '').length == 1)
				createCB();
			else conn.query('SELECT COUNT(*) AS c FROM schools WHERE path = ?', [parentPath(query.schoolpath)], function(r) {
				assert.equal(r.length, 1);
				if (r[0].c != 1) {
					conn.query('ROLLBACK', function() {
						conn.release();
					});
					
					return cb('create-school-missing-parent');
				}
				
				createCB();
			});
		});
		});
	});
});

SchoolsDB.prototype.listSchools = buscomponent.provideQT('client-list-schools', function(query, ctx, cb) {
	var where = 'WHERE 1 ';
	var params = [];
	if (query.parentPath) {
		where = 'AND path LIKE ? OR path = ? ';
		params = params.concat([query.parentPath + '/%', query.parentPath]);
	}
	
	if (query.search) {
		var likestring = '%' + (query.search.toString()).replace(/%/g, '\\%') + '%';
		
		where += 'AND (name LIKE ? OR path LIKE ?) ';
		params = params.concat([likestring, likestring]);
	}
	
	ctx.query('SELECT schools.id, schools.name, COUNT(sm.uid) AS usercount, schools.path FROM schools ' +
		'LEFT JOIN schoolmembers AS sm ON sm.schoolid=schools.id AND NOT pending ' +
		where +
		'GROUP BY schools.id', params, function(results) {
			cb('list-schools-success', {'result': results});
		}
	);
});

SchoolsDB.prototype.publishBanner = buscomponent.provideQT('client-school-publish-banner', function(query, ctx, cb) {
	query.__groupassoc__ = query.schoolid;
	query.role = 'schools.banner';
	
	_reqschooladm(_.bind(function(query, ctx, cb) {
		this.request({name: 'client-publish', query: query, user: user, access: access}, cb);
	}, this), false, this)(query, ctx, cb);
});

SchoolsDB.prototype.createInviteLink = buscomponent.provideQT('client-create-invite-link', function(query, ctx, cb) {
	_reqschooladm(_.bind(function(query, ctx, cb) {
		this.request({name: 'createInviteLink', query: query, user: user, access: access}, cb);
	}, this), true, this)(query, ctx, cb);
});

exports.SchoolsDB = SchoolsDB;

})();
