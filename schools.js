(function () { "use strict";
	
function parentPath(x) { return x.match(/(\/[\w_-]+)+\/[\w_-]+$/)[1]; }

var _ = require('underscore');
var util = require('util');
var assert = require('assert');

function SchoolsDB (db, config) {
	this.db = db;
	this.cfg = config;
}
util.inherits(SchoolsDB, require('./objects.js').DBSubsystemBase);

function _reqschooladm (f) {
	return function(query, user, access, cb) {
		var forward = _.bind(function() { return _.bind(f, this)(query, user, access, cb); }, this);
		if (access.has('schooldb'))
			return forward();
		
		assert.ok(this.loadSchoolAdmins);
		
		this.loadSchoolAdmins(query.schoolid, function(adminlist) {
			if (_.chain(adminlist).filter(function(a) { return a.status == 'admin' && a.adminid == user.id; }).value().length == 0)
				cb('permission-denied');
			else
				forward();
		});
	};
}

// only internal
SchoolsDB.prototype.loadSchoolAdmins = function(schoolid, cb) {
	this.query('SELECT sa.schoolid AS schoolid, sa.uid AS adminid, sa.status AS status, users.name AS adminname ' +
		'FROM schools AS c ' +
		'JOIN schools AS p ON c.path LIKE CONCAT(p.path, "%") OR p.id = c.id ' +
		'JOIN schooladmins AS sa ON sa.schoolid = p.id ' +
		'JOIN users ON users.id = sa.uid ' +
		'WHERE c.id = ?', [schoolid], cb);
};

SchoolsDB.prototype.loadSchoolInfo = function(lookfor, user, access, cb) {
	this.query('SELECT * FROM schools ' +
		'LEFT JOIN events ON events.targetid = schools.id AND events.type = "school-create" ' +
		'WHERE ? IN (id, path, name) ' + 
		'LIMIT 1', [lookfor], function(res) {
		if (res.length == 0)
			return cb('get-school-info-notfound');
		
		var s = res[0];	
		s.parentPath = null;
		
		assert.ok(s.eventid);
		
		this.loadSchoolAdmins(s.id, function(admins) {
			s.admins = admins;
			
			this.query('SELECT * FROM schools AS c WHERE c.path LIKE ?', [s.path + '/%'], function(subschools) {
			this.query('SELECT c.*,u.name AS username,u.id AS uid, trustedhtml ' +
				'FROM ecomments AS c '+
				'LEFT JOIN users AS u ON c.commenter = u.id '+
				'WHERE c.eventid = ?',
				[s.eventid],
				function(comments) {
				s.comments = comments;
				s.subschools = subschools;
			
				this.query('SELECT oh.stocktextid AS stockid, oh.stockname, ' +
					'SUM(ABS(money)) AS moneysum, ' +
					'SUM(ABS(money) / (UNIX_TIMESTAMP() - buytime)) AS wsum '+
					'FROM orderhistory AS oh ' +
					'JOIN schoolmembers AS sm ON sm.uid = oh.userid AND sm.jointime < oh.buytime AND sm.schoolid = ? ' +
					'GROUP BY stocktextid ORDER BY wsum DESC', [s.id], function(popular) {
					s.popularStocks = popular.splice(0, 10);
					
					if (s.path.replace(/[^\/]/g, '').length != 1) { // need higher-level 
						s.parentPath = parentPath(s.path);
						this.loadSchoolInfo(s.parentPath, user, access, function(code, result) {
							assert.equal(code, 'get-schools-inf-success');
							
							s.parentSchool = result;
							
							cb('get-school-info-success', s);
						});
					} else {
						cb('get-school-info-success', s);
					}
				});
			});
			});
		});
	});
};

SchoolsDB.prototype.getSchoolInfo = function(query, user, access, cb) {
	this.loadSchoolInfo(query.lookfor, user, access, cb);
};

SchoolsDB.prototype.changeDescription = _reqschooladm(function(query, user, access, cb) {
	this.query('UPDATE schools SET descpage = ? WHERE id = ?', [query.descpage, query.schoolid], function() {
		cb('school-change-description-success');
	});
});

SchoolsDB.prototype.changeMemberStatus = _reqschooladm(function(query, user, access, cb) {
	if (query.newstatus == 'member') {
		this.query('DELETE FROM schooladmins WHERE uid = ? AND schoolid = ?', [query.uid, query.schoolid], function() {
			cb('school-change-member-status-success');
		});
	} else {
		this.query('REPLACE INTO schooladmins (schoolid, uid, status) VALUES(?, ?, ?)', [query.schoolid, query.uid, query.status], function() {
			cb('school-change-member-status-success');
		});
	}
});

SchoolsDB.prototype.deleteComment = _reqschooladm(function(query, user, access, cb) {
	this.query('SELECT c.commentid AS cid FROM ecomments AS c ' +
		'JOIN events AS e ON e.eventid = c.eventid ' +
		'WHERE c.commentid = ? AND e.targetid = ? AND e.type = "school-create"',
		[query.commentid, query.schoolid], function(res) {
		if (res.length == 0)
			return cb('permission-denied');
		
		assert.ok(res.length == 1 && res[0].cid == query.commentid);
		
		this.query('UPDATE ecomments SET comment = ?, trustedhtml = 1 WHERE commentid = ?',
			['<em>Dieser Kommentar wurde durch die Gruppenadministratoren gelöscht.</em>', query.commentid], function() {
			cb('school-delete-comment-success');
		});
	});
});

SchoolsDB.prototype.kickUser = _reqschooladm(function(query, user, access, cb) {
	this.query('DELETE FROM schoolmembers WHERE uid = ? AND schoolid = ?', 
		[query.uid, query.schoolid], function() {
		this.query('DELETE FROM schooladmins WHERE uid = ? AND schoolid = ?', 
			[query.uid, query.schoolid], function() {
			cb('school-kick-user-success');
		});
	});
});

SchoolsDB.prototype.createSchool = function(query, user, access, cb_) {
	if (!query.schoolpath)
		query.schoolpath = '/' + query.schoolname.replace(/[^\w_-]/g, '');
	
	this.locked(['userdb'], cb_, function(cb) {
		this.query('SELECT COUNT(*) AS c FROM schools WHERE path = ?', [query.schoolpath], function(r) {
			assert.equal(r.length, 1);
			if (r[0].c == 1 || !query.schoolname.trim() || 
				!/^(\/[\w_-]+)+$/.test(query.schoolpath)) {
				return cb('create-school-already-exists');
			}
			
			var createCB = _.bind(function() {
				this.query('INSERT INTO schools (name,path) VALUES(?,?)', [query.schoolname,query.schoolpath], function(res) {
					this.feed({'type': 'school-create', 'targetid': res.insertId, 'srcuser': user.id});
					
					cb('create-school-success');
				});
			}, this);
			
			if (query.schoolpath.replace(/[^\/]/g, '').length == 1)
				createCB();
			else this.query('SELECT COUNT(*) AS c FROM schools WHERE path = ?', [parentPath(query.schoolpath)], function(r) {
				assert.equal(r.length, 1);
				if (r[0].c != 1)
					return cb('create-school-missing-parent');
				
				createCB();
			});
		});
	});
};

exports.SchoolsDB = SchoolsDB;

})();
