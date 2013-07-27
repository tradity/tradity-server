(function () { "use strict";

var _ = require('underscore');
var util = require('util');
var hash = require('mhash').hash;
var crypto = require('crypto');
var assert = require('assert');

function UserDB (db, emailsender, config) {
	this.db = db;
	this.emailsender = emailsender;
	this.cfg = config;
}
util.inherits(UserDB, require('./objects.js').DBSubsystemBase);

UserDB.prototype.generatePWKey = function(pw, cb) {
	crypto.randomBytes(16, _.bind(function(ex, buf) {
		var pwsalt = buf.toString('hex');
		var pwhash = hash('sha256', pwsalt + pw);
		cb(pwsalt, pwhash);
	}, this));
}

UserDB.prototype.listStocks = function(user, cb) {
	this.query(
	'SELECT d.*, s.* FROM depot_stocks AS d WHERE userid = ? JOIN stocks AS s ON d.stockid = s.id', [user.id], function(res) {
		cb(_.map(res, function(row) { return new DepotStock(row); }));
	});
}

UserDB.prototype.insertPSEmail = function(query, user, access, cb) {
	this.query('SELECT COUNT(*) AS c FROM ps_emails WHERE email = ?', [query.email], function(res) {		
		assert.equal(res.length, 1);
			
		if (res[0].c != 0) {
			assert.equal(res[0].c, 1);
			cb('email-already-present');
			return;
		}
		
		this.query('INSERT INTO ps_emails (email, time, lang) VALUES(?, UNIX_TIMESTAMP(), ?)', [query.email, query.lang], function(res) {
			cb('email-enter-success');
		});
	});
}

UserDB.prototype.sendRegisterEmail = function(data, uid, cb) {
	crypto.randomBytes(16, _.bind(function(ex, buf) {
		var key = buf.toString('hex');
		
		this.query('INSERT INTO email_verifcodes (`userid`, `time`, `key`) VALUES(?, UNIX_TIMESTAMP(), ?)', 
			[uid, key], function(res) {
			
			var url = this.cfg.regurl.replace(/\{\$key\}/, key).replace(/\{\$uid\}/, uid);
			
			var opt = _.clone(this.cfg.mail['register-base']);
			opt.to = data.email;
			opt.subject += ' (' + data.name + ')';
			opt.generateTextFromHTML = true;
			opt.html = '<p>For completion of the registration, please click the following link:\n' + 
			'<a href="' + url + '">' + url + '</a></p>\n' + 
			'<p>If you received this email accidentally, you may simply ignore it.</p>';
			
			cb('reg-email-sending', uid);
			
			this.emailsender.sendMail(opt, _.bind(function (error, resp) {
				if (error) {
					cb('reg-email-failed', uid);
					this.emit('error', error);
				} else {
					cb('reg-success', uid);
				}
			}, this));
		});
	}, this));
}

UserDB.prototype.login = function(query, user, access, cb) {
	var name = query.name;
	var pw = query.pw;
	var stayloggedin = query.stayloggedin;
	
	this.query('SELECT * FROM users WHERE (email = ? OR name = ?) AND deletiontime IS NULL', [name, name], function(res) {
		if (res.length == 0) {
			cb('login-badname');
			return;
		}
		
		if (res.length > 1) {
			this.emit('error', new Error('more than one username returned when searching for: ' + name));
			cb('login-badname');
			return;
		}
		
		if (res[0].email_verif == 0) {
			cb('login-email-not-verified');
			return;
		}
		
		var uid = res[0].id;
		var pwsalt = res[0].pwsalt;
		var pwhash = res[0].pwhash;
		if (pwhash != hash('sha256', pwsalt + pw)) {
			cb('login-wrongpw');
			return;
		}
		
		crypto.randomBytes(16, _.bind(function(ex, buf) {
			var key = buf.toString('hex');
			
			this.regularCallback();
			
			this.query('INSERT INTO sessions(uid, `key`, logintime, lastusetime, endtimeoffset)' +
				'VALUES(?, ?, UNIX_TIMESTAMP(), UNIX_TIMESTAMP(), ?)',
				[uid, key, stayloggedin ? 3628800 : 1800], function(res) {
					cb('login-success', key);
				}
			);
		}, this));
	});
}

UserDB.prototype.logout = function(query, user, access, cb) {
	this.query('DELETE FROM sessions WHERE `key` = ?', [query.key]);
	cb('logout-success');
}

UserDB.prototype.listSchools = function(query, user, access, cb) {
	this.query('SELECT id, name FROM schools', [], cb);
}

UserDB.prototype.regularCallback = function() {
	this.query('DELETE FROM sessions WHERE lastusetime + endtimeoffset < UNIX_TIMESTAMP()');
}
					
UserDB.prototype.emailVerify = function(query, user, access, cb) {
	var uid = user.id;
	var key = query.key;
	
	this.query('SELECT email_verif AS v, 42 AS y, email FROM users WHERE id = ? ' +
	'UNION SELECT COUNT(*) AS v, 41 AS y, "Wulululu" AS email FROM email_verifcodes WHERE userid = ? AND `key` = ?', [uid, uid, key], function(res) {		
		if (access.indexOf('*') == -1) {
			if (res.length != 2) {
				console.log('strange email-verif stuff', res);
				cb('email-verify-failure');
				return;
			}
			
			var email = null;
			for (var i = 0; i < res.length; ++i) {
				if (res[i].y == 42 && res[i].v != 0) {
					cb('email-verify-already-verified');
					email = res[i].email;
					return;
				}
				
				if (res[i].y == 41 && res[i].v < 1) {
					cb('email-verify-failure');
					return;
				}
			}
		}
		
		this.query('SELECT COUNT(*) AS c FROM users WHERE email = ? AND email_verif = 1 AND id != ?', [email, uid], function(res) {
			if (res[0].c > 0) {
				cb('email-verify-other-already-verified');
				return;
			}
		
			this.query('DELETE FROM email_verifcodes WHERE userid = ?', [uid], function() {
			this.query('UPDATE users SET email_verif = 1 WHERE id = ?', [uid], function() {
				cb('email-verify-success');
			});
			});
		});
	});
}

UserDB.prototype.loadSessionUser = function(key, cb) {
	this.query('SELECT users.*, sessions.id AS sid, users.id AS uid, ranking.rank AS rank FROM sessions JOIN users ON sessions.uid = users.id LEFT JOIN ranking ON ranking.`type`="general" AND ranking.uid = users.id WHERE `key` = ? AND lastusetime + endtimeoffset > UNIX_TIMESTAMP()', [key], function(res) {
		if (res.length == 0) {
			cb(null);
		} else {
			assert.equal(res.length, 1);
			var user = res[0];
			user.id = user.uid;
			
			this.query('UPDATE sessions SET lastusetime = UNIX_TIMESTAMP() WHERE id = ?', [user.id]);
			cb(user);
		}
	});
}

UserDB.prototype.register = function(query, user, access, cb) {
	assert.strictEqual(user, null);
	this.updateUser(query, 'register', null, cb);
}

UserDB.prototype.changeOptions = function(query, user, access, cb) {
	this.updateUser(query, 'change', user, cb);
}

UserDB.prototype.deleteUser = function(query, user, access, cb) {
	this.query('DELETE FROM sessions WHERE uid = ?', [user.id], function() {
	this.query('UPDATE users SET name = CONCAT("user_deleted", ?), giv_name="__user_deleted__", fam_name="", pwhash="xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", gender="undisclosed", birthday=NULL, school=NULL, realnamepublish=0, `desc`="", provision=0, address=NULL, deletiontime = UNIX_TIMESTAMP()' +
	'WHERE id = ?', [user.id, user.id], function() {
		cb('delete-user-success');
	});
	});
}

UserDB.prototype.updateUser = function(data, type, user, cb) {
	var uid = user !== null ? user.id : null;
	if ((data.gender != 'male' && data.gender != 'female' && data.gender != 'undisclosed') || !data.name) {
		cb('format-error');
		return;
	}
	
	if (!data.password || data.password.length < 5) {
		cb('reg-too-short-pw');
		return;
	}
	
	if (!/^[^\.,@<>\x00-\x20\x7f!"'\/\\$#()^?&{}]+$/.test(data.name)) {
		cb('reg-name-invalid-char');
		return;
	}
	
	if (!data.provision) {
		data.provision = 15;
	}
	
	if (data.provision < 5 || data.provision > 30) {
		cb('format-error');
		return;
	}
	
	this.query('SELECT email,name,id FROM users WHERE (email = ? AND NOT email_verif) OR (name = ?) ORDER BY NOT(id != ?)',
		[data.email, data.name, uid], function(res) {
		if (res.length > 0 && res[0].id !== uid) {
			if (res[0].name == data.name)
				cb('reg-name-already-present');
			else if (res[0].email == data.email)
				cb('reg-email-already-present');
			else
				throw new Error('db returned bad email/name match: ' + [res[0], data]);
			return;
		}
		
		var schoolLookupCB = function(res) {
			var schoolAddedCB = function(res) {
				if (res && res.insertId)
					data.school = res.insertId;
				
				var updateCB = function(res) {
					if (uid === null)
						uid = res.insertId;
					
					this.sendRegisterEmail(data, uid, cb);
				};
				
				if (type == 'update') {
					this.generatePWKey(data.password, _.bind(function(pwsalt, pwhash) {
						this.query('UPDATE users SET name = ?, giv_name = ?, fam_name = ?, realnamepublish = ?, pwhash = ?, pwsalt = ?, gender = ?, school = ?, email = ?, email_verif = ?,' +
						'birthday = ?, desc = ?, provision = ?, address = ? WHERE id = ?',
						[data.name, data.giv_name, data.fam_name, data.realnamepublish, pwhash, pwsalt, data.gender, data.school, data.email, data.email == user.email,
						data.birthday, data.desc, data.provision, data.address, uid],
						updateCB);
					}, this));
				} else {
					this.generatePWKey(data.password, _.bind(function(pwsalt, pwhash) {
						this.query('INSERT INTO users (name, giv_name, fam_name, realnamepublish, pwhash, pwsalt, gender, school, email)' +
						'VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)',
						[data.name, data.giv_name, data.fam_name, data.realnamepublish, pwhash, pwsalt, data.gender, data.school, data.email],
						updateCB);
					}, this));
				}
			};
			
			assert.equal(res.length, 1);
			if (res[0].c == 0) {
				if (parseInt(data.school) == data.school) {
					cb('reg-unknown-school');
					return;
				} else {
					this.query('INSERT INTO schools (name) VALUES(?)', [data.school], schoolAddedCB);
				}
			} else {
				_.bind(schoolAddedCB,this)([]);
			}
		};
		
		if (data.school !== null) {
			this.query('SELECT COUNT(*) AS c FROM schools WHERE id = ?', [data.school], schoolLookupCB);
		} else {
			_.binid(schoolLookupCB,this)([{c:0}]);
		}
	});
}

exports.UserDB = UserDB;

})();
