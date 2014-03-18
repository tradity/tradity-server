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

UserDB.prototype.sendInviteEmail = function(data, cb) {	
	var opt = _.clone(this.cfg.mail['invite-base']);
	opt.to = data.email;
	opt.subject += ' (' + data.sender.name + ')';
	opt.headers = {
		'Sender': data.sender.email
	};
	opt.generateTextFromHTML = true;
	
	opt.html = '<p>Der Benutzer „' + data.sender.name + '“ hat dich zum Börsenspiel Tradity eingeladen.\n' +
		'<a href="' + data.url + '">Klicke hier, um mitzuspielen.</a></p>';
	
	this.emailsender.sendMail(opt, _.bind(function(error, resp) {
		if (error) {
			cb('create-invite-link-failed');
			this.emit('error', error);
		} else {
			cb('create-invite-link-success');
		}
	}, this));
};

UserDB.prototype.sendRegisterEmail = function(data, uid, cb) {
	crypto.randomBytes(16, _.bind(function(ex, buf) {
		var key = buf.toString('hex');
		
		this.query('INSERT INTO email_verifcodes (`userid`, `time`, `key`) VALUES(?, UNIX_TIMESTAMP(), ?)', 
			[uid, key], function(res) {
			
			var url = this.cfg.regurl.replace(/\{\$key\}/g, key).replace(/\{\$uid\}/g, uid).replace(/\{\$hostname\}/g, this.cfg.hostname);
			
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

UserDB.prototype.login = function(query, user, access, xdata, cb) {
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
		
		var uid = res[0].id;
		var pwsalt = res[0].pwsalt;
		var pwhash = res[0].pwhash;
		if (pwhash != hash('sha256', pwsalt + pw)) {
			cb('login-wrongpw');
			return;
		}
		
		crypto.randomBytes(16, _.bind(function(ex, buf) {
			var key = buf.toString('hex');
			
			this.regularCallback({});
			
			this.query('INSERT INTO logins(cdid, ip, logintime, uid, headers) VALUES(?, ?, UNIX_TIMESTAMP(), ?, ?)',
				[xdata.cdid, xdata.remoteip, uid, JSON.stringify(xdata.hsheaders)], function() {
			this.query('INSERT INTO sessions(uid, `key`, logintime, lastusetime, endtimeoffset)' +
				'VALUES(?, ?, UNIX_TIMESTAMP(), UNIX_TIMESTAMP(), ?)',
				[uid, key, stayloggedin ? this.cfg.stayloggedinTime : this.cfg.normalLoginTime], function(res) {
					cb('login-success', key);
			});
			});
		}, this));
	});
}

UserDB.prototype.logout = function(query, user, access, cb) {
	this.query('DELETE FROM sessions WHERE `key` = ?', [query.key]);
	cb('logout-success');
}

UserDB.prototype.getRanking = function(query, user, access, cb_) {
	query.startindex = parseInt(query.startindex) || 0;
	query.endindex = parseInt(query.endindex) || (1 << 20);
	
	var likestringWhere = '';
	var likestringUnit = [];
	if (query.search) {
		var likestring = '%' + (query.search.toString()).replace(/%/g, '\\%') + '%';
		likestringWhere += 'AND (users.name LIKE ?) ';
		likestringUnit = likestringUnit.concat([likestring]);
	}
	
	if (query.schoolid) {
		likestringWhere += 'AND (schools.id = ? OR schools.path = ?) ';
		likestringUnit = likestringUnit.concat([query.schoolid, query.schoolid]);
	}
	
	this.locked(['ranking'], cb_, function(cb) {
		var join = 'FROM ranking ' +
			'JOIN users ON ranking.uid = users.id ' +
			'LEFT JOIN schoolmembers AS sm ON users.id = sm.uid ' +
			'LEFT JOIN schools ON sm.schoolid = schools.id ';
		
		this.query('SELECT rank, users.id AS uid, users.name AS name, schools.path AS schoolpath, schools.id AS school, schools.name AS schoolname, jointime, pending, ' +
			'totalvalue, weekstarttotalvalue, weekstartprov_sum, wprov_sum + lprov_sum AS prov_sum, tradecount != 0 as hastraded, ' +
			'(dayfperfcur+weekfperfsold) / weekfperfbase AS weekfperf, (dayfperfcur+totalfperfsold) / totalfperfbase AS totalfperf, ' +
			'(dayfperfcur+totalfperfsold-totalfperfbase)/GREATEST(700000000, totalvalue) AS totalfperfval, (dayfperfcur+weekfperfsold-weekfperfbase)/GREATEST(700000000, weekstarttotalvalue) AS weekfperfval, ' +
			'IF(realnamepublish != 0,giv_name,NULL) AS giv_name, ' +
			'IF(realnamepublish != 0,fam_name,NULL) AS fam_name ' +
			join +
			'WHERE `type` = ? ' +
			likestringWhere +
			'ORDER BY rank ASC LIMIT ?, ?', 
			[query.rtype].concat(likestringUnit).concat([query.startindex, query.endindex - query.startindex]), function(res) {
			this.query('SELECT COUNT(*) AS c ' +
				join +
				'WHERE `type` = ? ' + likestringWhere, [query.rtype].concat(likestringUnit), function(cr) {
				assert.equal(cr.length, 1);
				cb(res, cr[0].c);
			});
		});
	});
}

UserDB.prototype.getUserInfo = function(query, user, access, cb) {
	if (query.lookfor == '$self')
		query.lookfor = user.id;
	
	var columns = (access.has('userdb') ? [
		'users.*'
	] : [
		'IF(realnamepublish != 0,giv_name,NULL) AS giv_name',
		'IF(realnamepublish != 0,fam_name,NULL) AS fam_name'
	]).concat([
		'users.id AS uid', 'users.name AS name', 'birthday',
		'sm.pending AS schoolpending', 'sm.schoolid AS dschoolid', 'sm.jointime AS schooljointime',
		'`desc`', 'wprovision', 'lprovision', 'totalvalue', 'rank', 'delayorderhist',
		'lastvalue', 'daystartvalue', 'weekstartvalue', 'stocks.id AS lstockid',
		'url AS profilepic', 'eventid AS registerevent', 'events.time AS registertime',
		'(dayfperfcur+dayfperfsold) / dayfperfbase AS dayfperf', '(dayoperfcur+dayoperfsold) / dayoperfbase AS dayoperf',
		'(dayfperfcur+weekfperfsold) / weekfperfbase AS weekfperf', '(dayoperfcur+weekoperfsold) / weekoperfbase AS weekoperf',
		'(dayfperfcur+totalfperfsold) / totalfperfbase AS totalfperf', '(dayoperfcur+totaloperfsold) / totaloperfbase AS totaloperf',
		'freemoney', 'wprov_sum + lprov_sum AS prov_sum', 'weekstarttotalvalue', 'daystarttotalvalue'
	]).join(', ');
	
	this.query('SELECT ' + columns + ' FROM users '+
		'LEFT JOIN ranking ON users.id = ranking.uid '+ // note: this ignores the ranking lock!
		'LEFT JOIN schoolmembers AS sm ON users.id = sm.uid '+
		'LEFT JOIN stocks ON users.id = stocks.leader '+
		'LEFT JOIN httpresources ON httpresources.user = users.id AND httpresources.role = "profile.image" '+
		'LEFT JOIN events ON events.targetid = users.id AND events.type = "user-register" '+
		'WHERE users.id = ? OR users.name = ?', 
		[parseInt(query.lookfor) == query.lookfor ? query.lookfor : -1, query.lookfor], function(users) {
		if (users.length == 0)
			return cb(null, null, null);
		var xuser = users[0];
		xuser.isSelf = (user && xuser.uid == user.uid);
		if (xuser.isSelf) 
			xuser.access = access.toArray();
		
		this.query('SELECT SUM(amount) AS samount, SUM(1) AS sone FROM depot_stocks AS ds WHERE ds.stockid=?', [xuser.lstockid], function(followers) {
			xuser.f_amount = followers[0].samount || 0;
			xuser.f_count = followers[0].sone || 0;
				
			this.query('SELECT p.name, p.path, p.id FROM schools AS c ' +
				'JOIN schools AS p ON c.path LIKE CONCAT(p.path, "/%") OR p.id = c.id ' + 
				'WHERE c.id = ? ORDER BY LENGTH(p.path) ASC', [xuser.dschoolid], function(schools) {
				
				/* do some validation on the schools array.
				 * this is not necessary; however, it may help catch bugs long 
				 * before they actually do a lot of harm.
				 */
				var levelArray = _.map(schools, function(s) { return s.path.replace(/[^\/]/g, '').length; });
				if (_.intersection(levelArray, _.range(1, levelArray.length+1)).length != levelArray.length)
					return this.emit('error', new Error('Invalid school chain for user: ' + JSON.stringify(schools)));
				
				xuser.schools = schools;
				if (query.nohistory)
					return cb(xuser, null, null, null);
				
				this.query('SELECT oh.*,u.name AS leadername FROM orderhistory AS oh LEFT JOIN users AS u ON oh.leader = u.id  WHERE userid = ? AND buytime <= (UNIX_TIMESTAMP() - ?) ORDER BY buytime DESC', [xuser.uid, (xuser.delayorderhist && xuser.uid != user.uid) ? this.cfg.delayOrderHistTime : 0], function(orders) {
					this.query('SELECT * FROM valuehistory WHERE userid = ?', [xuser.uid], function(values) {
						this.query('SELECT c.*,u.name AS username,u.id AS uid, url AS profilepic, trustedhtml FROM ecomments AS c LEFT JOIN users AS u ON c.commenter = u.id LEFT JOIN httpresources ON httpresources.user = c.commenter AND httpresources.role = "profile.image"  WHERE c.eventid = ?', [xuser.registerevent], function(comments) {
							cb(xuser, orders, values, comments);
						});
					});
				});
			});
		});
	});
}

UserDB.prototype.listSchools = function(query, user, access, cb) {
	this.query('SELECT schools.id, schools.name, COUNT(sm.uid) AS usercount, schools.path FROM schools '+
		'LEFT JOIN schoolmembers AS sm ON sm.schoolid=schools.id AND NOT pending '+
		'GROUP BY schools.id', [], cb);
}

UserDB.prototype.regularCallback = function(query, cb) {
	cb = cb || function() {};
	
	this.query('DELETE FROM sessions WHERE lastusetime + endtimeoffset < UNIX_TIMESTAMP()', []);
	this.query('SELECT id, path FROM schools AS p WHERE ' +
		'(SELECT COUNT(uid) FROM schoolmembers WHERE schoolmembers.schoolid = p.id) = 0 AND ' +
		'(SELECT COUNT(*) FROM schools AS c WHERE c.path LIKE CONCAT(p.path, "/%")) = 0', [], function(r) {
		for (var i = 0; i < r.length; ++i) {
			if (r[i].path.replace(/[^\/]/g, '').length == 1 || (query && query.weekly))
				this.query('DELETE FROM schools WHERE id = ?', [r[i].id]);
		}
		
		cb();
	});
}
					
UserDB.prototype.emailVerify = function(query, user, access, cb) {
	var uid = parseInt(query.uid);
	var key = query.key;
	
	this.query('SELECT email_verif AS v, 42 AS y, email FROM users WHERE id = ? ' +
	'UNION SELECT COUNT(*) AS v, 41 AS y, "Wulululu" AS email FROM email_verifcodes WHERE userid = ? AND `key` = ?', [uid, uid, key], function(res) {		
		if (!access.has('userdb')) {
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
	// ignores ranking lock
	this.query('SELECT users.*, sessions.id AS sid, users.id AS uid, ranking.rank AS rank, ' +
		'schools.path AS schoolpath, schools.id AS school, schools.name AS schoolname, jointime, sm.pending AS schoolpending ' +
		'FROM sessions ' +
		'JOIN users ON sessions.uid = users.id ' +
		'LEFT JOIN ranking ON ranking.`type`="general" AND ranking.uid = users.id ' +
		'LEFT JOIN schoolmembers AS sm ON sm.uid=users.id ' +
		'LEFT JOIN schools ON schools.id=sm.schoolid ' +
		'WHERE `key` = ? AND lastusetime + endtimeoffset > UNIX_TIMESTAMP() LIMIT 1', [key], function(res) {
		if (res.length == 0) {
			cb(null);
		} else {
			assert.equal(res.length, 1);
			var user = res[0];
			user.id = user.uid;
			user.realnamepublish = !!user.realnamepublish;
			user.delayorderhist = !!user.delayorderhist;
			
			this.query('UPDATE sessions SET lastusetime = UNIX_TIMESTAMP() WHERE id = ?', [user.sid]);
			this.query('UPDATE users SET ticks = ticks + 1 WHERE id = ?', [user.id]);
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

UserDB.prototype.resetUser = function(query, user, access, sdb, cb_) {
	assert.ok(user);
	assert.ok(access);
	
	this.locked(['userdb', 'depotstocks'], cb_, function(cb) {
	this.query('DELETE FROM ranking WHERE uid = ?', [user.uid], function() { // ignores ranking lock – won’t be too bad
	this.query('DELETE FROM depot_stocks WHERE userid = ?', [user.uid], function() {
	this.query('UPDATE users SET freemoney = 1000000000, totalvalue = 1000000000, ' +
		'dayfperfbase = 0, dayfperfcur = 0, dayfperfsold = 0, ' + 
		'weekfperfbase = 0, weekfperfsold = 0, ' + 
		'totalfperfbase = 0, totalfperfsold = 0, ' + 
		'dayoperfbase = 0, dayoperfcur = 0, dayoperfsold = 0, ' + 
		'weekoperfbase = 0, weekoperfsold = 0, ' + 
		'totaloperfbase = 0, totaloperfsold = 0, ' + 
		'daystarttotalvalue = 1000000000, weekstarttotalvalue = 1000000000, '+
		'weekstartprov_sum = 0, wprov_sum = 0, lprov_sum = 0 ' + 
		'WHERE id = ?', [user.uid], function() {
		sdb.sellAll(query, user, access, _.bind(function() {
			this.query('UPDATE stocks SET lastvalue = 10000000, ask = 10000000, bid = 10000000, ' +
				'daystartvalue = 10000000, weekstartvalue = 10000000, lastchecktime = UNIX_TIMESTAMP() WHERE leader = ?', [user.uid], function() {
				this.feed({'type': 'user-reset', 'targetid': user.uid, 'srcuser': user.uid});
				cb('reset-user-success');
			});
		}, this));
	});
	});
	});
	});
}

UserDB.prototype.passwordReset = function(data, user, access, cb) {
	this.query('SELECT * FROM users WHERE name = ? AND deletiontime IS NULL', [data.name], function(res) {
		if (res.length == 0)
			return cb('password-reset-notfound');
		
		var u = res[0];
		assert.ok(u);
		
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
};

UserDB.prototype.createInviteLink = function(query, user, access, cb) {
	query.email = query.email || null;
	
	if (!access.has('userdb')) {
		if (query.email && !/([\w_+.-]+)@([\w.-]+)$/.test(query.email))
			return cb('create-invite-link-invalid-email');
			
		if (user.email_verif == 0)
			return cb('create-invite-link-not-verif');
	}
	
	crypto.randomBytes(16, _.bind(function(ex, buf) {
		var key = buf.toString('hex');
		var sendKeyToCaller = access.has('userdb');
		this.query('INSERT INTO invitelink ' +
			'(uid, `key`, email, ctime, schoolid) VALUES ' +
			'(?, ?, ?, UNIX_TIMESTAMP(), ?)', 
			[user.id, key, query.email, query.schoolid ? parseInt(query.schoolid) : null], function() {
			var url = this.cfg.inviteurl.replace(/\{\$key\}/g, key).replace(/\{\$hostname\}/g, this.cfg.hostname);
	
			_.bind(query.email ? function(cont) {
				this.sendInviteEmail({
					sender: user,
					email: query.email,
					url: url
				}, _.bind(function(status) {
					cont(status);
				}, this));
			} : function(cont) {
				sendKeyToCaller = true;
				cont('create-invite-link-success');
			}, this)(_.bind(function(status) {
				cb(status, sendKeyToCaller ? url : null);
			}, this));
		});
	}, this));
};

UserDB.prototype.updateUser = function(data, type, user, access, cb_) {
	this.locked(['userdb'], cb_, function(cb) {
		
	var uid = user !== null ? user.id : null;
	if (!data.name || !data.email) {
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
	
	data.giv_name = data.giv_name || '';
	data.fam_name = data.fam_name || '';
	data.wprovision = data.wprovision || 15;
	data.lprovision = data.lprovision || 0;
	
	if (data.wprovision < 5 || data.wprovision > 30 || data.lprovision < 0 || data.lprovision > 100) 
		return cb('invalid-provision');
	
	if (!data.school) // e. g., empty string
		data.school = null;
	
	var betakey = data.betakey ? data.betakey.toString().split('-') : [0,0];
	
	this.query('SELECT email,name,id FROM users WHERE email = ? OR (name = ?) ORDER BY NOT(id != ?)',
		[data.email, data.name, uid], function(res) {
	this.query('SELECT `key` FROM betakeys WHERE `id`=?',
		[betakey[0]], function(βkey) {
		if (this.cfg['betakey-required'] && (βkey.length == 0 || βkey[0].key != betakey[1]) && type=='register' && !access.has('userdb')) {
			cb('reg-beta-necessary');
			return;
		}
		
		if (res.length > 0 && res[0].id !== uid) {
			if (res[0].name == data.name)
				cb('reg-name-already-present');
			else if (res[0].email == data.email)
				cb('reg-email-already-present');
			else
				throw new Error('db returned bad email/name match: ' + [res[0].name, res[0].email, data[0].name, data[0].email, type]);
			return;
		}
		
		var schoolLookupCB = function(res) {
			var schoolAddedCB = function(res) {
				var gainUIDCB = function() {};
				
				if (res && res.insertId) {
					// in case school was created
					
					data.school = res.insertId;
					
					gainUIDCB = _.bind(function() {
						assert.ok(uid != null);
						
						this.feed({'type': 'school-create', 'targetid': res.insertId, 'srcuser': uid});
					}, this);
				}
				
				var updateCB = _.bind(function(res) {
					if (uid === null)
						uid = res.insertId;
					
					assert.ok(uid != null);
					
					gainUIDCB();

					if ((user && data.email == user.email) || (access.has('userdb') && data.nomail))
						cb('reg-success', uid);
					else
						this.sendRegisterEmail(data, uid, cb);
				}, this);
				
				var onPWGenerated = _.bind(function(pwsalt, pwhash) {
					if (type == 'change') {
						this.query('UPDATE users SET name = ?, giv_name = ?, fam_name = ?, realnamepublish = ?, delayorderhist = ?, pwhash = ?, pwsalt = ?, email = ?, email_verif = ?,' +
						'birthday = ?, `desc` = ?, wprovision = ?, lprovision = ?, street = ?, zipcode = ?, town = ?, traderse = ?, tradersp = ?, traditye = ?, wot = ? '+
						'WHERE id = ?',
						[data.name, data.giv_name, data.fam_name, data.realnamepublish?1:0, data.delayorderhist?1:0, pwhash, pwsalt, data.email, data.email == user.email,
						data.birthday, data.desc, data.wprovision, data.lprovision, data.street, data.zipcode, data.town, data.traderse?1:0, data.tradersp?1:0, data.traditye?1:0, data.wot?1:0, uid],
						updateCB);
						
						if (data.name != user.name) {
							this.feed({'type': 'user-namechange', 'targetid': uid, 'srcuser': uid, json: {'oldname': user.name, 'newname': data.name}});
							this.query('UPDATE stocks SET name = ? WHERE leader = ?', ['Leader: ' + data.name, uid]);
						}
						
						if (data.school != user.school) {
							if (data.school == null)
								this.query('DELETE FROM schoolmembers WHERE uid = ?', [uid]);
							else
								this.query('REPLACE INTO schoolmembers (uid, schoolid, pending, jointime) '+
									'VALUES(?, ?, ' + (access.has('schooldb') ? '0' : '((SELECT COUNT(*) FROM schooladmins WHERE schoolid = ? AND status="admin") > 0)') + ', UNIX_TIMESTAMP())',
									[uid, data.school, data.school]);
							
							if (user.school != null) 
								this.query('DELETE FROM schooladmins WHERE uid = ? AND schoolid = ?', [uid, user.school]);
						}

						if (data.wprovision != user.wprovision || data.lprovision != user.lprovision)
							this.feed({'type': 'user-provchange', 'targetid': uid, 'srcuser': uid, json:
								{'oldwprov': user.wprovision, 'newwprov': data.wprovision,
								 'oldlprov': user.lprovision, 'newlprov': data.lprovision}});
					} else {
						this.locked(['depotstocks'], updateCB, function(cb) {
							if (data.betakey)
								this.query('DELETE FROM betakeys WHERE id=?', [betakey[0]]);
							
							var inv = {};
							_.bind(data.invitekey ? function(cont) {
								this.query('SELECT * FROM invitelink WHERE `key` = ?', [data.invitekey], function(invres) {
									if (invres.length == 0)
										cont();
									
									assert.equal(invres.length, 1);
									
									var inv = invres[0];
									if (inv.schoolid && !data.school || parseInt(data.school) == parseInt(inv.schoolid)) {
										data.school = inv.schoolid;
										inv.__schoolverif__ = 1;
									}
									
									this.query('INSERT INTO inviteaccept (iid, uid, accepttime) (?, ?, UNIX_TIMESTAMP())', [inv.id, uid]);
									
									cont();
								});
							} : function(cont) {
								cont();
							}, this)(_.bind(function() {
								this.query('INSERT INTO users ' +
									'(name, giv_name, fam_name, realnamepublish, delayorderhist, pwhash, pwsalt, email, email_verif, ' +
									'traderse, tradersp, traditye, wot, street, zipcode, town)' +
									'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
									[data.name, data.giv_name, data.fam_name, data.realnamepublish?1:0, data.delayorderhist?1:0, pwhash, pwsalt,
									data.email, (inv.email && inv.email == data.email) ? 1 : 0,
									data.traderse?1:0, data.tradersp?1:0, data.traditye?1:0, data.wot?1:0, data.street, data.zipcode, data.town],
								function(res) {
									uid = res.insertId;
									this.feed({'type': 'user-register', 'targetid': uid, 'srcuser': uid});
									this.query('INSERT INTO stocks (stockid, leader, name, exchange, pieces) VALUES(?, ?, ?, ?, 100000000)',
										['__LEADER_' + uid + '__', uid, 'Leader: ' + data.name, 'tradity'], _.bind(cb, this, res));
									
									if (data.school) {
										this.query('INSERT INTO schoolmembers (uid, schoolid, pending, jointime) ' +
											'VALUES(?, ?, ' + 
											(inv.__schoolverif__ ? '1' : '((SELECT COUNT(*) FROM schooladmins WHERE schoolid = ? AND status="admin") > 0) ') +
											', UNIX_TIMESTAMP())',
											[uid, data.school, data.school]);
									}
								});
							}, this));
						});
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
					this.query('INSERT INTO schools (name,path) VALUES(?,CONCAT("/",MD5(?)))', [data.school, data.school], schoolAddedCB);
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
			this.query('SELECT id FROM schools WHERE ? IN (id, name, path)', [data.school], schoolLookupCB);
		} else {
			_.bind(schoolLookupCB,this)([]);
		}
	
	});
	});
	});
}

UserDB.prototype.watchlistAdd = function(query, user, access, cb) {
	this.query('SELECT stockid,users.id AS uid,users.name, bid FROM stocks LEFT JOIN users ON users.id = stocks.leader WHERE stocks.id = ?', [query.stockid], function(res) {
		if (res.length == 0)
			return cb('watchlist-add-notfound');
		var uid = res[0].uid;
		if (uid == user.id)
			return cb('watchlist-add-self');
		
		this.query('REPLACE INTO watchlists (watcher, watchstarttime, watchstartvalue, watched) VALUES(?, UNIX_TIMESTAMP(), ?, ?)', [user.id, res[0].bid, query.stockid], function(r) {
			this.feed({'type': 'watch-add','targetid':r.insertId,'srcuser':user.id,'json':{'watched': query.stockid, 'watcheduser':uid,'watchedname':res[0].name},'feedusers':uid ? [uid] : []});
			cb('watchlist-add-success');
		}); 
	});
}

UserDB.prototype.watchlistRemove = function(query, user, access, cb) {
	this.query('DELETE FROM watchlists WHERE watcher=? AND watched=?', [user.id, query.stockid], function() {
		this.feed({'type': 'watch-remove','targetid':null,'srcuser':user.id,'json':{'watched':query.stockid}});
		cb('watchlist-remove-success');
	}); 
}

UserDB.prototype.watchlistShow = function(query, user, access, cb) {
	this.query('SELECT stocks.*, stocks.name AS stockname, users.name AS username, users.id AS uid, watchstartvalue, watchstarttime FROM watchlists AS w '+
		'JOIN stocks ON w.watched=stocks.id LEFT JOIN users ON users.id=stocks.leader WHERE w.watcher = ?', [user.id], function(res) {
		cb(res);
	});
}

exports.UserDB = UserDB;

})();
