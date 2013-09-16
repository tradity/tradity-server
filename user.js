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
			
			var url = this.cfg.regurl.replace(/\{\$key\}/, key).replace(/\{\$uid\}/, uid).replace(/\{\$hostname\}/, this.cfg.hostname);
			
			var opt = _.clone(this.cfg.mail['register-base']);
			opt.to = data.email;
			opt.subject += ' (' + data.name + ')';
			opt.generateTextFromHTML = true;
			opt.html = '<p>Um deine Registrierung zu vollenden, klicke bitte auf diesen Link:\n' + 
			'<a href="' + url + '">' + url + '</a></p>\n' + 
			'<p>Falls du diese E-Mail zufällig erhalten hast, darfst du sie einfach ignorieren.</p>';
			
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
				[uid, key, stayloggedin ? this.cfg.stayloggedinTime : this.cfg.normalLoginTime], function(res) {
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

UserDB.prototype.getRanking = function(query, user, access, cb) {
	var si = query.startindex, ei = query.endindex;
	if (parseInt(si) != si || parseInt(ei) != ei)
		cb('format-error');
	var schools_join = '';
	if (query.fromschool != null) {
		schools_join = 'AND users.school = "' + parseInt(query.fromschool) + '"';
		query.studentonly = true;
	}
	
	this.query('SELECT rank, uid, name, totalvalue, (dayfperfcur+totalfperfsold) / totalfperfbase AS totalfperf FROM ranking ' +
		'JOIN users ON ranking.uid = users.id ' +
		schools_join + ' WHERE `type` = ? AND `group` = ? AND rank >= ? AND rank < ?', 
		[query.rtype, query.studentonly ? 'students' : 'all', si, ei], cb);
}

UserDB.prototype.getUserInfo = function(query, user, access, cb) {
	if (query.lookfor == '$self')
		query.lookfor = user.id;
	
	var columns = [
		'users.id AS uid', 'users.name AS name',
		'IF(realnamepublish != 0,giv_name,NULL) AS giv_name',
		'IF(realnamepublish != 0,fam_name,NULL) AS fam_name',
		'birthday', 'schools.id AS schoolid', 'schools.name AS schoolname',
		'`desc`', 'provision', 'totalvalue', 'rank', 'delayorderhist',
		'lastvalue', 'daystartvalue', 'weekstartvalue',
		'url AS profilepic', 
		'(dayfperfcur+dayfperfsold) / dayfperfbase AS dayfperf', '(dayoperfcur+dayoperfsold) / dayoperfbase AS dayoperf',
		'(dayfperfcur+weekfperfsold) / weekfperfbase AS weekfperf', '(dayoperfcur+weekoperfsold) / weekoperfbase AS weekoperf',
		'(dayfperfcur+totalfperfsold) / totalfperfbase AS totalfperf', '(dayoperfcur+totaloperfsold) / totaloperfbase AS totaloperf'
	].join(', ')
	this.query('SELECT ' + columns + ' FROM users LEFT JOIN schools ON users.school = schools.id LEFT JOIN ranking ON users.id = ranking.uid LEFT JOIN stocks ON users.id = stocks.leader LEFT JOIN httpresources ON httpresources.user = users.id AND httpresources.role = "profile.image" WHERE users.id = ? OR users.name = ?', [query.lookfor, query.lookfor], function(users) {
		if (users.length == 0)
			return cb(null, null, null);
		var xuser = users[0];
		xuser.isSelf = (xuser.uid == user.uid);
		if (query.nohistory)
			return cb(xuser, null, null);
		this.query('SELECT oh.*,u.name AS leadername FROM orderhistory AS oh LEFT JOIN users AS u ON oh.leader = u.id  WHERE userid = ? AND buytime <= (UNIX_TIMESTAMP() - ?) ORDER BY buytime DESC', [xuser.uid, !!xuser.delayorderhist ? 2 * 86400 : 0], function(orders) {
			this.query('SELECT * FROM valuehistory WHERE userid = ?', [user.uid], function(values) {
				cb(xuser, orders, values);
			});
		});
	});
}

UserDB.prototype.listSchools = function(query, user, access, cb) {
	this.query('SELECT schools.id, schools.name, COUNT(users.id) AS usercount FROM schools LEFT JOIN users ON users.school=schools.id GROUP BY schools.id', [], cb);
}

UserDB.prototype.regularCallback = function(cb) {
	cb = cb || function() {};
	
	this.query('DELETE FROM sessions WHERE lastusetime + endtimeoffset < UNIX_TIMESTAMP()', [], cb);
	this.query('DELETE FROM schools WHERE (SELECT COUNT(id) FROM users WHERE users.school = schools.id) = 0', [], cb);
}
					
UserDB.prototype.emailVerify = function(query, user, access, cb) {
	var uid = parseInt(query.uid);
	var key = query.key;
	
	this.query('SELECT email_verif AS v, 42 AS y, email FROM users WHERE id = ? ' +
	'UNION SELECT COUNT(*) AS v, 41 AS y, "Wulululu" AS email FROM email_verifcodes WHERE userid = ? AND `key` = ?', [uid, uid, key], function(res) {		
		if (access.indexOf('*') == -1) {
			if (res.length != 2) {
				console.warn('strange email-verif stuff', res);
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
	this.query('SELECT users.*, sessions.id AS sid, users.id AS uid, ranking.rank AS rank, schools.name AS schoolname FROM sessions JOIN users ON sessions.uid = users.id LEFT JOIN ranking ON ranking.`type`="general" AND ranking.`group`="all" AND ranking.uid = users.id LEFT JOIN schools ON schools.id=users.school WHERE `key` = ? AND lastusetime + endtimeoffset > UNIX_TIMESTAMP()', [key], function(res) {
		if (res.length == 0) {
			cb(null);
		} else {
			assert.equal(res.length, 1);
			var user = res[0];
			user.id = user.uid;
			user.realnamepublish = !!user.realnamepublish;
			user.delayorderhist = !!user.delayorderhist;
			
			this.query('UPDATE sessions SET lastusetime = UNIX_TIMESTAMP() WHERE id = ?', [user.sid]);
			cb(user);
		}
	});
}

UserDB.prototype.register = function(query, user, access, cb) {
	assert.strictEqual(user, null);
	this.updateUser(query, 'register', null, access, cb);
}

UserDB.prototype.changeOptions = function(query, user, access, cb) {
	this.updateUser(query, 'change', user, access, cb);
}

UserDB.prototype.deleteUser = function(query, user, access, cb) {
	this.query('DELETE FROM sessions WHERE uid = ?', [user.id], function() {
	this.query('UPDATE users SET name = CONCAT("user_deleted", ?), giv_name="__user_deleted__", fam_name="", pwhash="xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", birthday=NULL, school=NULL, realnamepublish=0, `desc`="", provision=0, address=NULL, deletiontime = UNIX_TIMESTAMP()' +
	'WHERE id = ?', [user.id, user.id], function() {
		cb('delete-user-success');
	});
	});
}

UserDB.prototype.passwordReset = function(data, user, access, cb) {
	this.query('SELECT * FROM users WHERE name = ?', [data.name], function(res) {
		if (res.length == 0)
			cb('password-reset-notfound');
		
		var u = res[0];
		
		crypto.randomBytes(6, _.bind(function(ex, buf) {
			var pw = buf.toString('hex');
			this.generatePWKey(pw, _.bind(function(salt, hash) {
				this.query('UPDATE users SET pwsalt = ?, pwhash = ? WHERE id = ?', [salt, hash, u.id], function() {
					var opt = _.clone(this.cfg.mail['pwreset-base']);
					opt.to = u.email;
					opt.subject += ' (' + data.name + ')';
					opt.generateTextFromHTML = true;
					opt.html = '<p>Dein Passwort bei Tradity wurde zurückgesetzt. Du kannst dich jetzt mit „' + pw + '“ anmelden.</p>';
					
					cb('password-reset-sending', u.id);
					
					this.emailsender.sendMail(opt, _.bind(function (error, resp) {
						if (error) {
							cb('password-reset-failed', u.id);
							this.emit('error', error);
						} else {
							cb('password-reset-success', u.id);
						}
					}, this));
				});
			}, this));
		}, this));
	});
}

UserDB.prototype.updateUser = function(data, type, user, access, cb) {
	var uid = user !== null ? user.id : null;
	if (!data.name || !data.email || !data.giv_name || !data.fam_name) {
		cb('format-error');
		return;
	}
	
	if ((data.password || type != 'change') && (!data.password || data.password.length < 5)) {
		cb('reg-too-short-pw');
		return;
	}
	
	if (!/^[^\.,@<>\x00-\x20\x7f!"'\/\\$#()^?&{}]+$/.test(data.name) || parseInt(data.name) == data.name) {
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
	
	if (!data.school) // e. g., empty string
		data.school = null;
	
	var betakey = data.betakey ? data.betakey.toString().split('-') : [0,0];
	
	this.query('SELECT email,name,id FROM users WHERE (email = ? AND NOT email_verif) OR (name = ?) ORDER BY NOT(id != ?)',
		[data.email, data.name, uid], function(res) {
	this.query('SELECT `key` FROM betakeys WHERE `id`=?',
		[betakey[0]], function(βkey) {
		if (this.cfg['betakey-required'] && (βkey.length == 0 || βkey[0].key != betakey[1]) && type=='register' && access.indexOf('*') == -1) {
			cb('reg-beta-necessary');
			return;
		}
		
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

					if ((user && data.email == user.email) || (access.indexOf('*') != -1 && data.nomail))
						cb('reg-success', uid);
					else
						this.sendRegisterEmail(data, uid, cb);
				};
				
				var onPWGenerated = _.bind(function(pwsalt, pwhash) {
					if (type == 'change') {
						this.query('UPDATE users SET name = ?, giv_name = ?, fam_name = ?, realnamepublish = ?, delayorderhist = ?, pwhash = ?, pwsalt = ?, school = ?, email = ?, email_verif = ?,' +
						'birthday = ?, `desc` = ?, provision = ?, address = ? WHERE id = ?',
						[data.name, data.giv_name, data.fam_name, data.realnamepublish?1:0, data.delayorderhist?1:0, pwhash, pwsalt, data.school, data.email, data.email == user.email,
						data.birthday, data.desc, data.provision, data.address, uid],
						updateCB);
						this.query('UPDATE stocks SET name = ? WHERE leader = ?', ['leader:\'' + data.name + '\'', uid]);
					} else {
						if (data.betakey)
							this.query('DELETE FROM betakeys WHERE id=?', [betakey[0]]);
						this.query('INSERT INTO users (name, giv_name, fam_name, realnamepublish, delayorderhist, pwhash, pwsalt, school, email)' +
						'VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)',
						[data.name, data.giv_name, data.fam_name, data.realnamepublish?1:0, data.delayorderhist?1:0, pwhash, pwsalt, data.school, data.email],
						updateCB);
					}
				}, this);
				
				if (data.password)
					this.generatePWKey(data.password, onPWGenerated);
				else
					onPWGenerated(user.pwsalt, user.pwhash);				
			};
			
			if (res.length == 0 && data.school !== null) {
				if (parseInt(data.school) == data.school || !data.school) {
					cb('reg-unknown-school');
					return;
				} else {
					this.query('INSERT INTO schools (name) VALUES(?)', [data.school], schoolAddedCB);
				}
			} else {
				if (data.school !== null) {
					assert.ok(parseInt(data.school) != data.school || data.school == res[0].id);
					data.school = res[0].id;
				}
				
				_.bind(schoolAddedCB,this)([]);
			}
		};
		
		if (data.school !== null) {
			this.query('SELECT id FROM schools WHERE id = ? OR name = ?', [data.school, data.school], schoolLookupCB);
		} else {
			_.bind(schoolLookupCB,this)([]);
		}
	});
	});
}

UserDB.prototype.watchlistAdd = function(query, user, access, cb) {
	if (query.userid == user.id)
		return cb('watchlist-add-self');
		
	this.query('SELECT id,name FROM users WHERE id = ?', [query.userid], function(res) {
		if (res.length == 0)
			return cb('watchlist-add-notfound');
		this.query('REPLACE INTO watchlists (watcher, watched) VALUES(?,?)', [user.id, query.userid], function(r) {
			this.feed({'type': 'watch-add','targetid':r.insertId,'srcuser':user.id,'json':{'watched':query.userid,'watchedname':res[0].name},'feedusers':[query.userid]});
			cb('watchlist-add-success');
		}); 
	});
}

UserDB.prototype.watchlistRemove = function(query, user, access, cb) {
	this.query('DELETE FROM watchlists WHERE watcher=? AND watched=?', [user.id, query.userid], function() {
		this.feed({'type': 'watch-remove','targetid':null,'srcuser':user.id,'json':{'watched':query.userid,'watchedname':res[0].name}});
		cb('watchlist-remove-success');
	}); 
}

UserDB.prototype.watchlistShow = function(query, user, access, cb) {
	this.query('SELECT users.name, users.id AS uid FROM watchlists AS w JOIN users ON users.id=w.watched WHERE w.watcher = ?', [user.id], function(res) {
		cb(res);
	});
}

exports.UserDB = UserDB;

})();
