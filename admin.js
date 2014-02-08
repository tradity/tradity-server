(function () { "use strict";

var _ = require('underscore');
var util = require('util');
var assert = require('assert');

function AdminDB (db, config) {
	this.db = db;
	this.cfg = config;
}
util.inherits(AdminDB, require('./objects.js').DBSubsystemBase);

function _reqpriv (required, f) {
	var requiredPermission = required;
	return function(query, user, access, cb) {
		if (user === null || !access.has(requiredPermission))
			cb('not-logged-in')
		else
			return _.bind(f,this)(query, user, access, cb);
	};
}

AdminDB.prototype.listAllUsers = _reqpriv('userdb', function(query, user, access, cb) {
	this.query('SELECT birthday, deletiontime, street, zipcode, town, `desc`, giv_name, fam_name, users.id AS uid, tradecount, ' +
		'email, email_verif AS emailverif, wprovision, lprovision, freemoney, totalvalue, wprov_sum, lprov_sum, ticks, ' +
		'logins.logintime AS lastlogintime, schools.name AS schoolname, schools.id AS schoolid, ' +
		'(SELECT COUNT(*) FROM ecomments WHERE ecomments.commenter=uid) AS commentcount, '+
		'(SELECT MAX(time) FROM ecomments WHERE ecomments.commenter=uid) AS lastcommenttime FROM users ' +
		'LEFT JOIN schools ON schools.id = users.school ' +
		'LEFT JOIN logins ON logins.id = (SELECT id FROM logins AS l WHERE l.uid = users.id ORDER BY logintime DESC LIMIT 1)', [], function(userlist)
	{
		cb('list-all-users-success', userlist);
	});
});

AdminDB.prototype.impersonateUser = _reqpriv('server', function(query, user, access, cb) {
	this.query('SELECT COUNT(*) AS c FROM users WHERE id=?', [query.userid], function(r) {
		assert.equal(r.length, 1);
		if (r[0].c == 0)
			return cb('impersonate-user-notfound');
	
		this.query('UPDATE sessions SET uid = ? WHERE id = ?', [query.userid, user.sid], function() {
			cb('impersonate-user-success');
		});
	});
});

AdminDB.prototype.deleteUser = _reqpriv('userdb', function(query, user, access, cb_) {
	if (user.id == query.uid)
		return cb_('delete-user-self-notallowed');
	
	this.locked(['userdb'], cb_, function(cb) {
		this.query('DELETE FROM sessions WHERE uid = ?', [query.uid], function() {
		this.query('UPDATE stocks SET name = CONCAT("leader:deleted", ?) WHERE leader = ?', [query.uid, query.uid], function() {
		this.query('UPDATE users SET name = CONCAT("user_deleted", ?), giv_name="__user_deleted__", email = CONCAT("deleted:", email), ' +
		'fam_name="", pwhash="xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", birthday=NULL, school=NULL, realnamepublish=0, `desc`="", wprovision=0, lprovision=0, ' + 
		'street="", zipcode="", town="", traderse=0, tradersp=0, traditye=0, wot=0, deletiontime = UNIX_TIMESTAMP() WHERE id = ?', [query.uid, query.uid], function() {
			cb('delete-user-success');
		});
		});
		});
	});
});

AdminDB.prototype.changeUserEMail = _reqpriv('userdb', function(query, user, access, cb) {
	this.query('UPDATE users SET email = ?, email_verif = ? WHERE id = ?', [query.email, query.emailverif ? 1 : 0, query.uid], function() {
		cb('change-user-email-success');
	});
});

AdminDB.prototype.changeCommentText = _reqpriv('moderate', function(query, user, access, cb) {
	this.query('UPDATE ecomments SET comment = ?, trustedhtml = ? WHERE commentid = ?', [query.comment, access.has('server') && query.trustedhtml ? 1:0, query.commentid], function() {
		cb('change-comment-text-success');
	});
});

AdminDB.prototype.notifyAll = _reqpriv('moderate', function(query, user, access, cb) {
	this.query('INSERT INTO mod_notif (content, sticky) VALUES (?, ?)', [query.content, query.sticky], function(res) {
		this.feed({'type': 'mod-notification', 'targetid': res.insertId, 'srcuser': user.id, 'everyone': true});
		cb('notify-all-success');
	});
});

AdminDB.prototype.createSchool = _reqpriv('schooldb', function(query, user, access, cb_) {
	this.locked(['userdb'], cb_, function(cb) {
		this.query('SELECT COUNT(*) AS c FROM schools WHERE name = ?', [query.schoolname], function(r) {
			assert.equal(r.length, 1);
			if (r[0].c == 1 || !query.schoolname.trim())
				return cb('create-school-already-exists');
			
			this.query('INSERT INTO schools (name) VALUES(?)', [query.schoolname], function() {
				cb('create-school-success');
			});
		});
	});
});

AdminDB.prototype.renameSchool = _reqpriv('schooldb', function(query, user, access, cb) {
	this.query('UPDATE schools SET name = ? WHERE id = ?', [query.schoolname, query.schoolid], function() {
		cb('rename-school-success');
	});
});

AdminDB.prototype.joinSchools = _reqpriv('schooldb', function(query, user, access, cb_) {
	this.locked(['userdb'], cb_, function(cb) {
		this.query('SELECT COUNT(*) AS c FROM schools WHERE id = ?', [query.masterschool], function(r) {
			assert.equal(r.length, 1);
			if (r[0].c == 0 || query.masterschool == query.subschool)
				return cb('join-schools-notfound');
			
			this.query('UPDATE users SET school = ? WHERE school = ?', [query.masterschool, query.subschool], function() {
				this.query('DELETE FROM schools WHERE id = ?', [query.subschool], function() {
					cb('join-schools-success');
				});
			});
		});
	});
});

exports.AdminDB = AdminDB;

})();
