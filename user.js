(function () { "use strict";

var _ = require('underscore');
var util = require('util');
var hash = require('mhash').hash;
var crypto = require('crypto');
var assert = require('assert');

function UserDB (db) {
	this.db = db;
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
	this.db.query(
	'SELECT d.*, s.* FROM depot_stocks AS d WHERE userid = ? JOIN stocks AS s ON d.stockid = s.id', [user.id], this.qcb(function(res) {
		cb(_.map(res, function(row) { return new DepotStock(row); }));
	}));
}

UserDB.prototype.insertPSEmail = function(email, cb) {
	this.db.query('SELECT COUNT(*) AS c FROM ps_emails WHERE email = ?', [email], this.qcb(function(res) {		
		assert.equal(res.length, 1);
			
		if (res[0].c != 0) {
			assert.equal(res[0].c, 1);
			cb('email-already-present');
			return;
		}
		
		this.db.query('INSERT INTO ps_emails (email, time) VALUES(?, UNIX_TIMESTAMP())', [email], this.qcb(function(res) {
			cb('email-enter-success');
		}));
	}));
}

UserDB.prototype.sendRegisterEmail = function(data, uid, emailsender, cfg, cb) {
	crypto.randomBytes(16, _.bind(function(ex, buf) {
		var key = buf.toString('hex');
		
		this.db.query('INSERT INTO email_verifcodes (`userid`, `time`, `key`) VALUES(?, UNIX_TIMESTAMP(), ?)', 
			[uid, key], this.qcb(function(res) {
			
			var url = cfg.regurl.replace(/\{\$key\}/, key).replace(/\{\$uid\}/, uid);
			
			var opt = _.clone(cfg.mail['register-base']);
			opt.to = data.email;
			opt.subject += ' (' + data.name + ')';
			opt.generateTextFromHTML = true;
			opt.html = '<p>For completion of the registration, please click the following link:\n' + 
			'<a href="' + url + '">' + url + '</a></p>\n' + 
			'<p>If you received this email accidentally, you may simply ignore it.</p>';
			
			cb('reg-email-sending');
			
			emailsender.sendMail(opt, _.bind(function (error, resp) {
				if (error) {
					cb('reg-email-failed');
					this.emit('error', error);
				} else {
					cb('reg-success');
				}
			}, this));
		}));
	}, this));
}

UserDB.prototype.login = function(name, pw, stayloggedin, cb) {
	this.db.query('SELECT * FROM users WHERE email = ? OR name = ?', [name, name], this.qcb(function(res) {
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
			
			this.db.query('INSERT INTO sessions(uid, `key`, logintime, lastusetime, endtimeoffset)' +
				'VALUES(?, ?, UNIX_TIMESTAMP(), UNIX_TIMESTAMP(), ?)',
				[id, key, stayloggedin ? 3628800 : 1800], this.db.qcb(function(res) {
					cb('login-success', key);
				})
			);
		}, this));
	}, this));
}

UserDB.prototype.logout = function(key) {
	this.db.query('DELETE FROM sessions WHERE key = ?', [key], this.qcb(function() {}));
}

UserDB.prototype.regularCallback = function() {
	this.db.query('DELETE FROM sessions WHERE lastusetime + endtimeoffset < UNIX_TIMESTAMP()', [], this.qcb(function() {}));
}
					
UserDB.prototype.emailVerify = function(uid, key, cb) {
	this.db.query('SELECT email_verif AS v, 42 AS y, email FROM users WHERE id = ? ' +
	'UNION SELECT COUNT(*) AS v, 41 AS y FROM email_verifcodes WHERE userid = ? AND `key` = ?', [uid, uid, key], this.qcb(function(res) {		
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
		
		this.db.query('SELECT COUNT(*) AS c FROM users WHERE email = ? AND email_verif = 1 AND id != ?', [email, uid], this.qcb(function(res) {
			if (res[0].c > 0) {
				cb('email-verify-other-already-verified');
				return;
			}
		
			this.db.query('DELETE FROM email_verifcodes WHERE userid = ?', [uid], this.qcb(function() {
			this.db.query('UPDATE users SET email_verif = 1 WHERE id = ?', [uid], this.qcb(function() {
				cb('email-verify-success');
			}));
			}));
		}));
	}));
}

UserDB.prototype.loadSessionUser = function(key, cb) {
	this.db.query('SELECT *, sessions.id AS sid, users.id AS uid FROM sessions JOIN users ON sessions.uid = users.id WHERE `key` = ? AND lastusetime + endtimeoffset < UNIX_TIMESTAMP()', [key], this.qcb(function(res) {
		if (res.length == 0) {
			cb(null);
		} else {
			assert.equal(res.length, 1);
			
			this.db.query('UPDATE sessions SET lastusetime = UNIX_TIMESTAMP() WHERE id = ?', [res], this.qcb());
			cb(res);
		}
	}));
}

UserDB.prototype.changeOptions = function(data, emailsender, cfg, cb) {
	this.loadSessionUser(data.key, _.bind(function(user) {
		if (user === null) {
			cb('not-logged-in');
			return;
		}
		
		this.updateUser(data, 'change', user, emailsender, cfg, cb);
	}, this));
}

UserDB.prototype.deleteUser = function(data, cb) {
	this.loadSessionUser(data.key, _.bind(function(user) {
		if (user === null) {
			cb('not-logged-in');
			return;
		}
		
		this.db.query('DELETE FROM sessions WHERE uid = ?', [user.uid], this.qcb(function() {
		this.db.query('UPDATE users SET name = CONCAT("user_deleted", ?), giv_name="__user_deleted__", fam_name="", pwhash="xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", gender="undisclosed", birthday=NULL, school=NULL, realnamepublish=0, desc="", provision=0, address=NULL, deletiontime=UNIX_TIMESTAMP()' +
		'WHERE id = ?', [user.uid, user.uid], this.qcb(function() {
			cb('delete-user-success');
		}));
		}));
	}, this));
}

UserDB.prototype.register = function(data, emailsender, cfg, cb) {
	this.updateUser(data, 'register', null, emailsender, cfg, cb);
}

UserDB.prototype.updateUser = function(data, type, user, emailsender, cfg, cb) {
	var uid = user !== null ? user.id : null;
	if ((data.gender != 'male' && data.gender != 'female' && data.gender != 'undisclosed') || !data.name) {
		cb('format-error');
		return;
	}
	
	if (!data.password || data.password.length < 5) {
		cb('reg-too-short-pw');
		return;
	}
	
	if (!/^[^\.,@<>\x00-\x20\0x7f!"'\/\\$#()^?&{}]+$/.test(data.name)) {
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
	
	this.db.query('SELECT email,name,id FROM users WHERE (email = ? AND NOT email_verif) OR (name = ?) ORDER BY NOT(id != ?)',
		[data.email, data.name, uid], this.qcb(function(res) {
		if (res.length > 0 && res[0].id !== uid) {
			if (res[0].name == data.name)
				cb('reg-name-already-present');
			else if (res[0].email == data.email)
				cb('reg-email-already-present');
			else
				throw new Error('db returned bad email/name match: ' + [res[0], data]);
			return;
		}
		
		var schoolLookupCB = this.qcb(function(res) {
			if (res.length == 0) {
				cb('reg-unknown-school');
				return;
			}
			
			var updateCB = this.qcb(function(res) {
				if (uid === null)
					uid = res.insertId;
				
				this.sendRegisterEmail(data, uid, emailsender, cfg, cb);
			});
			
			if (type == 'update') {
				this.generatePWKey(data.password, _.bind(function(pwsalt, pwhash) {
					this.db.query('UPDATE users SET name = ?, giv_name = ?, fam_name = ?, realnamepublish = ?, pwhash = ?, pwsalt = ?, gender = ?, school = ?, email = ?, email_verif = ?,' +
					'birthday = ?, desc = ?, provision = ?, address = ? WHERE id = ?',
					[data.name, data.giv_name, data.fam_name, data.realnamepublish, pwhash, pwsalt, data.gender, data.school, data.email, data.email == user.email,
					data.birthday, data.desc, data.provision, data.address, uid],
					updateCB);
				}, this));
			} else {
				this.generatePWKey(data.password, _.bind(function(pwsalt, pwhash) {
					this.db.query('INSERT INTO users (name, giv_name, fam_name, realnamepublish, pwhash, pwsalt, gender, school, email)' +
					'VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)',
					[data.name, data.giv_name, data.fam_name, data.realnamepublish, pwhash, pwsalt, data.gender, data.school, data.email],
					updateCB);
				}, this));
			}
		}, this);
		
		if (data.school !== null) {
			this.db.query('SELECT COUNT(*) FROM schools WHERE id = ?', [data.school], schoolLookupCB);
		} else {
			schoolLookupCB(null, [0]);
		}
	}));
}

exports.UserDB = UserDB;

})();
