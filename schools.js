(function () { "use strict";
	
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
			
			this.query('SELECT c.*,u.name AS username,u.id AS uid, trustedhtml FROM ecomments AS c LEFT JOIN users AS u ON c.commenter = u.id WHERE c.eventid = ?',
				[s.eventid],
				function(comments) {
				s.comments = comments;
			
				this.query('SELECT oh.stocktextid AS stockid, oh.stockname, ' +
					'SUM(ABS(money)) AS moneysum, ' +
					'SUM(ABS(money) / (UNIX_TIMESTAMP() - buytime)) AS wsum '+
					'FROM orderhistory AS oh ' +
					'JOIN schoolmembers AS sm ON sm.uid = oh.userid AND sm.jointime < oh.buytime AND sm.schoolid = ? ' +
					'GROUP BY stocktextid ORDER BY wsum DESC', [s.id], function(popular) {
					s.popularStocks = popular.splice(0, 10);
					
					if (s.path.replace(/[^\/]/g, '').length != 1) { // need higher-level 
						s.parentPath = s.path.match(/(\/\w+)+\/\w+$/)[1];
						this.loadSchoolInfo(s.parentPath, user, access, function(code, result) {
							assert.equal(code, 'get-schools-info-success');
							
							s.parentSchool = result;
							
							cb('get-schools-info-success', s);
						});
					} else {
						cb('get-schools-info-success', s);
					}
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
		this.query('REPLACE INTO schooladmins (schoolid, uid, status) VALUES(?, ?, ?)', query.uid, query.schoolid, query.status, function() {
			cb('school-change-member-status-success');
		});
	}
});

exports.SchoolsDB = SchoolsDB;

})();
