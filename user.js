(function () { "use strict";

var _ = require('underscore');
var util = require('util');
var hash = require('mhash').hash;
var crypto = require('crypto');
var assert = require('assert');
var buscomponent = require('./buscomponent.js');
var Access = require('./access.js').Access;
require('datejs');

function UserDB () {
}

util.inherits(UserDB, buscomponent.BusComponent);

UserDB.prototype.generatePWKey = function(pw, cb) {
	crypto.randomBytes(16, _.bind(function(ex, buf) {
		var pwsalt = buf.toString('hex');
		var pwhash = hash('sha256', pwsalt + pw);
		cb(pwsalt, pwhash);
	}, this));
}

UserDB.prototype.sendInviteEmail = function(data, cb) {
	this.request({name: 'readEMailTemplate', 
		template: 'invite-email.eml',
		variables: {'sendername': data.sender.name, 'sendermail': data.sender.email, 'email': data.email, 'url': data.url}
	}, function(opt) {
		this.request({name: 'sendMail', opt: opt}, function(error, resp) {
			if (error) {
				cb('create-invite-link-failed');
				this.emit('error', error);
			} else {
				cb('create-invite-link-success');
			}
		});
	});
};

UserDB.prototype.sendRegisterEmail = function(data, access, uid, xdata, cb) {
	access.drop('email_verif');
	
	this.login({
		name: data.email,
		stayloggedin: true,
		__ignore_password__: true
	}, null, access, xdata, _.bind(function(code, loginResp) {
		assert.equal(code, 'login-success');
		
		crypto.randomBytes(16, _.bind(function(ex, buf) {
			var key = buf.toString('hex');
			
			this.query('INSERT INTO email_verifcodes (`userid`, `time`, `key`) VALUES(?, UNIX_TIMESTAMP(), ?)', 
				[uid, key], function(res) {

				this.getServerConfig(function(cfg) {
					var url = cfg.regurl.replace(/\{\$key\}/g, key).replace(/\{\$uid\}/g, uid).replace(/\{\$hostname\}/g, cfg.hostname);
					
					this.request({name: 'readEMailTemplate', 
						template: 'register-email.eml',
						variables: {'url': url, 'username': data.name, 'email': data.email}
					}, function(opt) {
						this.request({name: 'sendMail', opt: opt}, function (error, resp) {
							if (error) {
								cb('reg-email-failed', loginResp, 'repush');
								this.emit('error', error);
							} else {
								cb('reg-success', loginResp, 'repush');
							}
						}, this);
					});
				});
			});
		}, this));
	}, this));
};

UserDB.prototype.listPopularStocks = buscomponent.provideQUA('client-list-popular-stocks', function(query, user, access, cb) {
	this.query('SELECT oh.stocktextid AS stockid, oh.stockname, ' +
		'SUM(ABS(money)) AS moneysum, ' +
		'SUM(ABS(money) / (UNIX_TIMESTAMP() - buytime + 300)) AS wsum ' +
		'FROM orderhistory AS oh ' +
		'GROUP BY stocktextid ORDER BY wsum DESC LIMIT 20', [], function(popular) {
		cb('list-popular-stocks-success', {'results': popular});
	});
});

UserDB.prototype.login = buscomponent.provideQUAX('client-login', function(query, user, access, xdata, cb) {
	var name = query.name;
	var pw = query.pw;
	var stayloggedin = query.stayloggedin;
	
	this.query('SELECT * FROM users WHERE (email = ? OR name = ?) AND deletiontime IS NULL ORDER BY id DESC', [name, name], function(res) {
		if (res.length == 0) {
			cb('login-badname');
			return;
		}
		
		var uid = res[0].id;
		var pwsalt = res[0].pwsalt;
		var pwhash = res[0].pwhash;
		if (pwhash != hash('sha256', pwsalt + pw) && !query.__ignore_password__) {
			cb('login-wrongpw');
			return;
		}
		
		crypto.randomBytes(16, _.bind(function(ex, buf) {
			this.getServerConfig(function(cfg) {
				var key = buf.toString('hex');
				
				this.regularCallback({});
				
				this.query('INSERT INTO logins(cdid, ip, logintime, uid, headers) VALUES(?, ?, UNIX_TIMESTAMP(), ?, ?)',
					[xdata.cdid, xdata.remoteip, uid, JSON.stringify(xdata.hsheaders)], function() {
				this.query('INSERT INTO sessions(uid, `key`, logintime, lastusetime, endtimeoffset)' +
					'VALUES(?, ?, UNIX_TIMESTAMP(), UNIX_TIMESTAMP(), ?)',
					[uid, key, stayloggedin ? cfg.stayloggedinTime : cfg.normalLoginTime], function(res) {
						cb('login-success', {key: key, uid: uid}, 'repush');
				});
				});
			});
		}, this));
	});
});

UserDB.prototype.logout = buscomponent.provideQUA('logout', function(query, user, access, cb) {
	this.query('DELETE FROM sessions WHERE `key` = ?', [query.key], function() {
		cb('logout-success');
	});
});

UserDB.prototype.getRanking = buscomponent.provideQUA('client-get-ranking', function(query, user, access, cb) {
	query.startindex = parseInt(query.startindex) || 0;
	query.endindex = parseInt(query.endindex) || (1 << 20);
	
	if (!query.since)
		query.since = 0;
	
	if (parseInt(query.since) != query.since)
		return cb('format-error');
	
	var likestringWhere = '';
	var likestringUnit = [];
	
	var join = 'FROM users AS u ' +
		'LEFT JOIN schoolmembers AS sm ON u.id = sm.uid ' +
		'LEFT JOIN schools AS c ON sm.schoolid = c.id ' +
		'JOIN valuehistory AS past_va ON past_va.userid = u.id ' +
		'JOIN (SELECT userid, MIN(time) AS t FROM valuehistory WHERE time > ? GROUP BY userid) AS past_locator_va ' +
			'ON past_va.userid = past_locator_va.userid AND past_va.time = past_locator_va.t ';
			
	if (!query.includeAll) 
		likestringWhere += ' AND email_verif != 0 ';

	if (query.search) {
		var likestring = '%' + (query.search.toString()).replace(/%/g, '\\%') + '%';
		likestringWhere += 'AND ((u.name LIKE ?) OR (realnamepublish != 0 AND (giv_name LIKE ? OR fam_name LIKE ?))) ';
		likestringUnit = likestringUnit.concat([likestring, likestring, likestring]);
	}
	
	_.bind(query.schoolid ? function(cont) {
		join += 'JOIN schools AS p ON c.path LIKE CONCAT(p.path, "/%") OR p.id = c.id ';
		likestringWhere += 'AND (p.id = ? OR p.path = ?) ';
		likestringUnit = likestringUnit.concat([query.schoolid, query.schoolid]);
		
		this.request({name: 'isSchoolAdmin', user: user, access: access, status: ['xadmin'], schoolid: query.schoolid}, function(ok) {
			cont(ok);
		});
	} : function(cont) { cont(access.has('userdb')); }, this)(_.bind(function(fulldata) {
		this.query('SELECT u.id AS uid, u.name AS name, c.path AS schoolpath, c.id AS school, c.name AS schoolname, jointime, pending, ' +
			'tradecount != 0 as hastraded, ' + 
			'u.totalvalue AS totalvalue, past_va.totalvalue AS past_totalvalue, ' +
			'u.wprov_sum + u.lprov_sum AS prov_sum, past_va.wprov_sum + past_va.lprov_sum AS past_prov_sum, ' +
			'((u.fperf_cur + u.fperf_sold - past_va.fperf_sold) / (u.fperf_bought - past_va.fperf_bought + past_va.fperf_cur)) AS fperf, ' +
			'((u.fperf_cur + u.fperf_sold - past_va.fperf_sold) - (u.fperf_bought - past_va.fperf_bought + past_va.fperf_cur))/GREATEST(700000000, past_va.totalvalue) AS fperfval, ' +
			(fulldata ? '' : 'IF(realnamepublish != 0,giv_name,NULL) AS ') + ' giv_name, ' +
			(fulldata ? '' : 'IF(realnamepublish != 0,fam_name,NULL) AS ') + ' fam_name, ' +
			'(SELECT SUM(xp) FROM achievements WHERE achievements.userid = u.id) AS xp ' +
			join + /* needs query.since parameter */
			'WHERE hiddenuser != 1 AND deletiontime IS NULL ' +
			likestringWhere +
			'LIMIT ?, ?', 
			[query.since].concat(likestringUnit).concat([query.startindex, query.endindex - query.startindex]), function(ranking) {
				cb('get-ranking-success', {'result': ranking});
			});
	}, this));
});

UserDB.prototype.getUserInfo = buscomponent.provideQUA('client-get-user-info', function(query, user, access, cb) {
	this.getServerConfig(function(cfg) {
	
	if (query.lookfor == '$self' && user)
		query.lookfor = user.id;
	
	var columns = (access.has('userdb') || query.lookfor == user.id ? [
		'u.*'
	] : [
		'IF(realnamepublish != 0,giv_name,NULL) AS giv_name',
		'IF(realnamepublish != 0,fam_name,NULL) AS fam_name'
	]).concat([
		'u.id AS uid', 'u.name AS name', 'birthday',
		'sm.pending AS schoolpending', 'sm.schoolid AS dschoolid', 'sm.jointime AS schooljointime',
		'`desc`', 'wprovision', 'lprovision', 'u.totalvalue', 'delayorderhist',
		'lastvalue', 'daystartvalue', 'weekstartvalue', 'stocks.id AS lstockid',
		'url AS profilepic', 'eventid AS registerevent', 'events.time AS registertime',
		'((u.fperf_cur + u.fperf_sold -  day_va.fperf_sold) / (u.fperf_bought -  day_va.fperf_bought +  day_va.fperf_cur)) AS  dayfperf',
		'((u.operf_cur + u.operf_sold -  day_va.operf_sold) / (u.operf_bought -  day_va.operf_bought +  day_va.operf_cur)) AS  dayoperf',
		'((u.fperf_cur + u.fperf_sold - week_va.fperf_sold) / (u.fperf_bought - week_va.fperf_bought + week_va.fperf_cur)) AS weekfperf',
		'((u.operf_cur + u.operf_sold - week_va.operf_sold) / (u.operf_bought - week_va.operf_bought + week_va.operf_cur)) AS weekoperf',
		'(u.fperf_cur + u.fperf_sold) / u.fperf_bought AS totalfperf',
		'(u.operf_cur + u.operf_sold) / u.operf_bought AS totaloperf',
		'freemoney', 'u.wprov_sum + u.lprov_sum AS prov_sum',
		'week_va.totalvalue AS weekstarttotalvalue',
		'day_va.totalvalue  AS daystarttotalvalue'
	]).join(', ');
		
	this.query('SELECT ' + columns + ' FROM users AS u '+
		'LEFT JOIN valuehistory AS week_va ON week_va.userid = u.id AND week_va.time = (SELECT MIN(time) FROM valuehistory WHERE userid = u.id AND time > ?) ' +
		'LEFT JOIN valuehistory AS day_va  ON day_va.userid  = u.id AND day_va.time  = (SELECT MIN(time) FROM valuehistory WHERE userid = u.id AND time > ?) ' +
		'LEFT JOIN schoolmembers AS sm ON u.id = sm.uid '+
		'LEFT JOIN stocks ON u.id = stocks.leader '+
		'LEFT JOIN httpresources ON httpresources.user = u.id AND httpresources.role = "profile.image" '+
		'LEFT JOIN events ON events.targetid = u.id AND events.type = "user-register" '+
		'WHERE u.id = ? OR u.name = ?', 
		[Date.parse('Sunday').getTime() / 1000, Date.parse('00:00').getTime() / 1000,
			parseInt(query.lookfor) == query.lookfor ? query.lookfor : -1, query.lookfor], function(users) {
		if (users.length == 0)
			return cb('get-user-info-notfound');
		var xuser = users[0];
		xuser.isSelf = (user && xuser.uid == user.uid);
		if (xuser.isSelf) 
			xuser.access = access.toArray();
		
		assert.ok(xuser.registerevent);
		
		delete xuser.pwhash;
		delete xuser.pwsalt;
		
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
					return cb('get-user-info-success', {result: xuser});
			
				this.query('SELECT oh.*,u.name AS leadername FROM orderhistory AS oh ' +
					'LEFT JOIN users AS u ON oh.leader = u.id ' + 
					'WHERE userid = ? AND buytime <= (UNIX_TIMESTAMP() - ?) ' + 
					'ORDER BY buytime DESC',
					[xuser.uid, (xuser.delayorderhist && xuser.uid != user.uid && !access.has('stocks')) ? cfg.delayOrderHistTime : 0], function(orders) {
					this.query('SELECT * FROM achievements ' +
						'LEFT JOIN events ON events.type="achievement" AND events.targetid = achid ' +
						'WHERE userid = ?', [xuser.uid], function(achievements) {
						this.query('SELECT time, totalvalue FROM valuehistory WHERE userid = ?', [xuser.uid], function(values) {
							this.query('SELECT c.*,u.name AS username,u.id AS uid, url AS profilepic, trustedhtml ' + 
								'FROM ecomments AS c ' + 
								'LEFT JOIN users AS u ON c.commenter = u.id ' + 
								'LEFT JOIN httpresources ON httpresources.user = c.commenter AND httpresources.role = "profile.image" ' + 
								'WHERE c.eventid = ?', [xuser.registerevent], function(comments) {
								return cb('get-user-info-success', {
									result: xuser,
									orders: orders,
									achievements: achievements,
									values: values,
									pinboard: comments});
							});
						});
					});
				});
			});
		});
	});
	});
});

UserDB.prototype.regularCallback = buscomponent.provide('regularCallbackUser', ['query', 'reply'], function(query, cb) {
	cb = cb || function() {};
	
	this.query('DELETE FROM sessions WHERE lastusetime + endtimeoffset < UNIX_TIMESTAMP()', []);
	this.query('SELECT p.id, p.path, users.access FROM schools AS p ' +
		'JOIN events ON events.type="school-create" AND events.targetid = p.id ' +
		'JOIN users ON users.id = events.srcuser ' +
		'WHERE ' +
		'(SELECT COUNT(uid) FROM schoolmembers WHERE schoolmembers.schoolid = p.id) = 0 AND ' +
		'(SELECT COUNT(*) FROM schools AS c WHERE c.path LIKE CONCAT(p.path, "/%")) = 0', [], function(r) {
		for (var i = 0; i < r.length; ++i) {
			var access = Access.fromJSON(r[i].access);
			
			if (!access.has('schooldb') && (r[i].path.replace(/[^\/]/g, '').length == 1 || (query && query.weekly)))
				this.query('DELETE FROM schools WHERE id = ?', [r[i].id]);
		}
		
		cb();
	});
});

UserDB.prototype.emailVerify = buscomponent.provideQUAX('client-emailverif', function(query, user, access, xdata, cb) {
	var uid = parseInt(query.uid);
	var key = query.key;
	
	this.query('SELECT email_verif AS v, 42 AS y, email FROM users WHERE id = ? ' +
	'UNION SELECT COUNT(*) AS v, 41 AS y, "Wulululu" AS email FROM email_verifcodes WHERE userid = ? AND `key` = ?', [uid, uid, key], function(res) {
		if (res.length != 2) {
			console.warn('strange email-verif stuff', res);
			cb('email-verify-failure');
			return;
		}
			
		var email = null;
		for (var i = 0; i < res.length; ++i) {
			if (res[i].y == 42) {
				email = res[i].email;
					
				if (res[i].y == 42 && res[i].v != 0) 
					return cb('email-verify-already-verified');
			}
			
			if (res[i].y == 41 && res[i].v < 1 && !access.has('userdb')) {
				cb('email-verify-failure');
				return;
			}
		}
		
		this.query('SELECT COUNT(*) AS c FROM users WHERE email = ? AND email_verif = 1 AND id != ?', [email, uid], function(res) {
			if (res[0].c > 0) {
				cb('email-verify-other-already-verified');
				return;
			}
		
			this.query('DELETE FROM email_verifcodes WHERE userid = ?', [uid], function() {
			this.query('UPDATE users SET email_verif = 1 WHERE id = ?', [uid], function() {
				access.grant('email_verif');
				
				this.login({
					name: email,
					stayloggedin: true,
					__ignore_password__: true
				}, null, access, xdata, cb);
			});
			});
		});
	});
});

UserDB.prototype.loadSessionUser = buscomponent.provide('loadSessionUser', ['key', 'reply'], function(key, cb) {
	this.query('SELECT users.*, sessions.id AS sid, users.id AS uid, ' +
		'schools.path AS schoolpath, schools.id AS school, schools.name AS schoolname, jointime, sm.pending AS schoolpending ' +
		'FROM sessions ' +
		'JOIN users ON sessions.uid = users.id ' +
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
});

UserDB.prototype.register = buscomponent.provideQUAX('client-register', function(query, user, access, xdata, cb) {
	if (user !== null)
		return cb('already-logged-in');
	this.updateUser(query, 'register', null, access, xdata, cb);
});

UserDB.prototype.changeOptions = buscomponent.provideQUAX('client-change-options', function(query, user, access, xdata, cb) {
	this.updateUser(query, 'change', user, access, xdata, cb);
});

UserDB.prototype.resetUser = buscomponent.provideQUA('client-reset-user', function(query, user, access, cb) {
	this.getServerConfig(function(cfg) {
		if (!cfg.resetAllowed && !access.has('userdb'))
			return cb('permission-denied');
		
		assert.ok(user);
		assert.ok(access);
		
		this.query('DELETE FROM depot_stocks WHERE userid = ?', [user.uid], function() {
		this.query('UPDATE users SET freemoney = 1000000000, totalvalue = 1000000000, ' +
			'fperf_bought = 0, fperf_cur = 0, fperf_sold = 0, ' + 
			'operf_bought = 0, operf_cur = 0, operf_sold = 0, ' + 
			'wprov_sum = 0, lprov_sum = 0 ' + 
			'WHERE id = ?', [user.uid], function() {
			this.request({name: 'sellAll', query: query, user: user, access: access}, function() {
				this.query('UPDATE stocks SET lastvalue = 10000000, ask = 10000000, bid = 10000000, ' +
					'daystartvalue = 10000000, weekstartvalue = 10000000, lastchecktime = UNIX_TIMESTAMP() WHERE leader = ?', [user.uid], function() {
					this.query('DELETE FROM valuehistory WHERE userid = ?', [user.uid], function() {
						this.feed({'type': 'user-reset', 'targetid': user.uid, 'srcuser': user.uid});
						this.request({name: 'dqueriesResetUser', user: user}, function() {
							cb('reset-user-success');
						});
					});
				});
			});
		});
		});
	});
});

UserDB.prototype.passwordReset = buscomponent.provideQUA('client-password-reset', function(data, user, access, cb) {
	if (user)
		return cb('already-logged-in');
	
	this.query('SELECT * FROM users WHERE name = ? AND deletiontime IS NULL', [data.name], function(res) {
		if (res.length == 0)
			return cb('password-reset-notfound');
		
		var u = res[0];
		assert.ok(u);
		
		crypto.randomBytes(6, _.bind(function(ex, buf) {
			var pw = buf.toString('hex');
			this.generatePWKey(pw, _.bind(function(salt, hash) {
				this.query('UPDATE users SET pwsalt = ?, pwhash = ? WHERE id = ?', [salt, hash, u.id], function() {
					var opt = this.request({name: 'readEMailTemplate', 
						template: 'password-reset-email.eml',
						variables: {'password': pw, 'username': data.name, 'email': u.email},
					}, function(opt) {
						this.request({name: 'sendMail', opt: opt}, function (error, resp) {
							if (error) {
								cb('password-reset-failed');
								this.emit('error', error);
							} else {
								cb('password-reset-success');
							}
						});
					});
				});
			}, this));
		}, this));
	});
});

UserDB.prototype.getInviteKeyInfo = buscomponent.provideQUA('client-get-invite-key-info', function(query, user, access, cb) {
	this.query('SELECT email, schoolid FROM invitelink WHERE `key` = ?', [query.invitekey], function(res) {
		if (res.length == 0) {
			cb('get-invitekey-info-notfound');
		} else {
			this.getServerConfig(function(cfg) {
				assert.equal(res.length, 1);
				
				res[0].url = cfg.inviteurl.replace(/\{\$key\}/g, query.invitekey).replace(/\{\$hostname\}/g, cfg.hostname);
				
				cb('get-invitekey-info-success', {result: res[0]});
			});
		}
	});
});

UserDB.prototype.createInviteLink = buscomponent.provideQUA('createInviteLink', function(query, user, access, cb) {
	this.getServerConfig(function(cfg) {
		query.email = query.email || null;
		
		if (!access.has('userdb')) {
			if (query.email && !/([\w_+.-]+)@([\w.-]+)$/.test(query.email))
				return cb('create-invite-link-invalid-email');
			
			if (!access.has('email_verif'))
				return cb('create-invite-link-not-verif');
		}
		
		crypto.randomBytes(16, _.bind(function(ex, buf) {
			var key = buf.toString('hex');
			var sendKeyToCaller = access.has('userdb');
			this.query('INSERT INTO invitelink ' +
				'(uid, `key`, email, ctime, schoolid) VALUES ' +
				'(?, ?, ?, UNIX_TIMESTAMP(), ?)', 
				[user.id, key, query.email, query.schoolid ? parseInt(query.schoolid) : null], function() {
				var url = cfg.inviteurl.replace(/\{\$key\}/g, key).replace(/\{\$hostname\}/g, cfg.hostname);
		
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
					cb(status, sendKeyToCaller ? {'url': url, 'key': key} : null);
				}, this));
			});
		}, this));
	});
});

UserDB.prototype.updateUser = function(data, type, user, access, xdata, cb) {
	this.getServerConfig(function(cfg) {
		
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
	data.wprovision = data.wprovision || cfg.defaultWProvision;
	data.lprovision = data.lprovision || cfg.defaultLProvision;
	
	if (data.wprovision < cfg.minWProvision || data.wprovision > cfg.maxWProvision ||
	    data.lprovision < cfg.minLProvision || data.lprovision > cfg.maxLProvision) 
		return cb('invalid-provision');
	
	if (!data.school) // e. g., empty string
		data.school = null;
	
	var betakey = data.betakey ? data.betakey.toString().split('-') : [0,0];
	
	this.getConnection(function(conn) {
	conn.query('SET autocommit = 0; ' +
		'LOCK TABLES users WRITE, stocks WRITE, betakeys WRITE, inviteaccept WRITE, invitelink READ' +
		(data.school ? ', schoolmembers WRITE, schools WRITE, schooladmins WRITE' : '') + ';', [], function() {
	
	var commit = _.bind(function(cb) {
		cb = _.bind(cb, this) || function() {};
		conn.query('COMMIT; UNLOCK TABLES; SET autocommit = 1;', [], function() { conn.release(); cb(); });
	}, this);
	
	var rollback = function() {
		conn.query('ROLLBACK; UNLOCK TABLES; SET autocommit = 1;', [], function() { conn.release(); });
	};
	
	conn.query('SELECT email,name,id FROM users WHERE (email = ? AND email_verif) OR (name = ?) ORDER BY NOT(id != ?)',
		[data.email, data.name, uid], function(res) {
	conn.query('SELECT `key` FROM betakeys WHERE `id` = ?',
		[betakey[0]], function(βkey) {
		if (cfg.betakeyRequired && (βkey.length == 0 || βkey[0].key != betakey[1]) && type == 'register' && !access.has('userdb')) {
			rollback();
			cb('reg-beta-necessary');
			
			return;
		}
		
		if (res.length > 0 && res[0].id !== uid) {
			rollback();
			
			if (res[0].email.toLowerCase() == data.email.toLowerCase())
				cb('reg-email-already-present');
			else
				cb('reg-name-already-present');
			return;
		}
		
		var schoolLookupCB = function(res) {
			var schoolAddedCB = function(res) {
				var gainUIDCBs = [];
				
				if (res && res.insertId) {
					// in case school was created
					
					data.school = res.insertId;
					
					gainUIDCBs.push(_.bind(function() {
						assert.ok(uid != null);
						
						this.feed({'type': 'school-create', 'targetid': res.insertId, 'srcuser': uid});
					}, this));
				}
				
				var updateCB = _.bind(function(res) {
					commit(function() {
						conn.release();
					
						if (uid === null)
							uid = res.insertId;
						
						assert.ok(uid != null);
						
						for (var i = 0; i < gainUIDCBs.length; ++i)
							gainUIDCBs[i]();

						if ((user && data.email == user.email) || (access.has('userdb') && data.nomail))
							cb('reg-success', {uid: uid}, 'repush');
						else 
							this.sendRegisterEmail(data, access, uid, xdata, cb);
					});
				}, this);
				
				var onPWGenerated = _.bind(function(pwsalt, pwhash) {
					if (type == 'change') {
						conn.query('UPDATE users SET name = ?, giv_name = ?, fam_name = ?, realnamepublish = ?, delayorderhist = ?, pwhash = ?, pwsalt = ?, email = ?, email_verif = ?,' +
						'birthday = ?, `desc` = ?, wprovision = ?, lprovision = ?, street = ?, zipcode = ?, town = ?, traditye = ?, skipwalkthrough = ? '+
						'WHERE id = ?',
						[data.name, data.giv_name, data.fam_name, data.realnamepublish?1:0, data.delayorderhist?1:0, pwhash, pwsalt, data.email, data.email == user.email,
						data.birthday, data.desc, data.wprovision, data.lprovision, data.street, data.zipcode, data.town, data.traditye?1:0, data.skipwalkthrough?1:0, uid],
						updateCB);
						
						if (data.name != user.name) {
							this.feed({'type': 'user-namechange', 'targetid': uid, 'srcuser': uid, json: {'oldname': user.name, 'newname': data.name}});
							conn.query('UPDATE stocks SET name = ? WHERE leader = ?', ['Leader: ' + data.name, uid]);
						}
						
						if (data.school != user.school) {
							if (data.school == null)
								conn.query('DELETE FROM schoolmembers WHERE uid = ?', [uid]);
							else
								conn.query('REPLACE INTO schoolmembers (uid, schoolid, pending, jointime) '+
									'VALUES(?, ?, ' + (access.has('schooldb') ? '0' : '((SELECT COUNT(*) FROM schooladmins WHERE schoolid = ? AND status="admin") > 0)') + ', UNIX_TIMESTAMP())',
									[uid, data.school, data.school]);
							
							if (user.school != null) 
								conn.query('DELETE FROM schooladmins WHERE uid = ? AND schoolid = ?', [uid, user.school]);
						}

						if (data.wprovision != user.wprovision || data.lprovision != user.lprovision)
							this.feed({'type': 'user-provchange', 'targetid': uid, 'srcuser': uid, json:
								{'oldwprov': user.wprovision, 'newwprov': data.wprovision,
								 'oldlprov': user.lprovision, 'newlprov': data.lprovision}});
						
						if (data.desc != user.desc)
							this.feed({'type': 'user-descchange', 'targetid': uid, 'srcuser': uid});
					} else {
						if (data.betakey)
							conn.query('DELETE FROM betakeys WHERE id=?', [betakey[0]]);
						
						var inv = {};
						_.bind(data.invitekey ? function(cont) {
							conn.query('SELECT * FROM invitelink WHERE `key` = ?', [data.invitekey], function(invres) {
								if (invres.length == 0)
									cont();
								
								assert.equal(invres.length, 1);
								
								inv = invres[0];
								if (inv.schoolid && !data.school || parseInt(data.school) == parseInt(inv.schoolid)) {
									data.school = inv.schoolid;
									inv.__schoolverif__ = 1;
								}
								
								gainUIDCBs.push(_.bind(function() {
									conn.query('INSERT INTO inviteaccept (iid, uid, accepttime) VALUES(?, ?, UNIX_TIMESTAMP())', [inv.id, uid]);
								}, this));
								
								cont();
							});
						} : function(cont) {
							cont();
						}, this)(_.bind(function() {
							conn.query('INSERT INTO users ' +
								'(name, giv_name, fam_name, realnamepublish, delayorderhist, pwhash, pwsalt, email, email_verif, ' +
								'traditye, street, zipcode, town, registertime, wprovision, lprovision)' +
								'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, UNIX_TIMESTAMP(), ?, ?)',
								[data.name, data.giv_name, data.fam_name, data.realnamepublish?1:0, data.delayorderhist?1:0, pwhash, pwsalt,
								data.email, (inv.email && inv.email == data.email) ? 1 : 0,
								data.traditye?1:0, data.street, data.zipcode, data.town,
								cfg.defaultWProvision, cfg.defaultLProvision],
							function(res) {
								uid = res.insertId;
								this.feed({'type': 'user-register', 'targetid': uid, 'srcuser': uid});
								conn.query('INSERT INTO stocks (stockid, leader, name, exchange, pieces) VALUES(?, ?, ?, ?, 100000000)',
									['__LEADER_' + uid + '__', uid, 'Leader: ' + data.name, 'tradity'], _.bind(updateCB, this, res));
									
								if (data.school) {
									conn.query('INSERT INTO schoolmembers (uid, schoolid, pending, jointime) ' +
										'VALUES(?, ?, ' + 
										(inv.__schoolverif__ ? '1' : '((SELECT COUNT(*) FROM schooladmins WHERE schoolid = ? AND status="admin") > 0) ') +
										', UNIX_TIMESTAMP())',
										[uid, data.school, data.school]);
								}
							});
						}, this));
					}
				}, this);
				
				if (data.password)
					this.generatePWKey(data.password, onPWGenerated);
				else
					onPWGenerated(user.pwsalt, user.pwhash);
			};
			
			if (res.length == 0 && data.school !== null) {
				if (parseInt(data.school) == data.school || !data.school) {
					rollback();
					
					cb('reg-unknown-school');
					return;
				} else {
					conn.query('INSERT INTO schools (name, path) VALUES(?, CONCAT("/",MD5(?)))', [data.school, data.school], schoolAddedCB);
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
			conn.query('SELECT id FROM schools WHERE ? IN (id, name, path)', [data.school], schoolLookupCB);
		} else {
			_.bind(schoolLookupCB,this)([]);
		}
	
	});
	});
	});
	});
	
	});
};

UserDB.prototype.watchlistAdd = buscomponent.provideQUA('client-watchlist-add', function(query, user, access, cb) {
	this.query('SELECT stockid,users.id AS uid,users.name, bid FROM stocks LEFT JOIN users ON users.id = stocks.leader WHERE stocks.id = ?', [query.stockid], function(res) {
		if (res.length == 0)
			return cb('watchlist-add-notfound');
		var uid = res[0].uid;
		if (uid == user.id)
			return cb('watchlist-add-self');
		
		this.query('REPLACE INTO watchlists (watcher, watchstarttime, watchstartvalue, watched) VALUES(?, UNIX_TIMESTAMP(), ?, ?)', [user.id, res[0].bid, query.stockid], function(r) {
			this.feed({
				type: 'watch-add',
				targetid: r.insertId,
				srcuser: 
				user.id,
				json: {
					watched: query.stockid, 
					watcheduser: uid,
					watchedname: 
					res[0].name
				},
				feedusers: uid ? [uid] : []
			});
			
			cb('watchlist-add-success');
		}); 
	});
});

UserDB.prototype.watchlistRemove = buscomponent.provideQUA('client-watchlist-remove', function(query, user, access, cb) {
	this.query('DELETE FROM watchlists WHERE watcher = ? AND watched = ?', [user.id, query.stockid], function() {
		this.feed({
			type: 'watch-remove',
			targetid: null,
			srcuser: user.id,
			json: { watched: query.stockid }
		});
		
		cb('watchlist-remove-success');
	}); 
});

UserDB.prototype.watchlistShow = buscomponent.provideQUA('client-watchlist-show', function(query, user, access, cb) {
	this.query('SELECT s.*, s.name AS stockname, users.name AS username, users.id AS uid, w.watchstartvalue, w.watchstarttime, ' +
		'lastusetime AS lastactive, IF(rw.watched IS NULL, 0, 1) AS friends ' +
		'FROM watchlists AS w ' +
		'JOIN stocks AS s ON w.watched = s.id ' +
		'JOIN stocks AS rs ON rs.leader = w.watcher ' +
		'LEFT JOIN users ON users.id = s.leader ' +
		'LEFT JOIN watchlists AS rw ON rw.watched = rs.id AND rw.watcher = s.leader ' +
		'LEFT JOIN sessions ON sessions.lastusetime = (SELECT MAX(lastusetime) FROM sessions WHERE uid = rw.watched) AND sessions.uid = rw.watched ' +
		'WHERE w.watcher = ?', [user.id], function(res) {
		cb('watchlist-show-success', {'results': res});
	});
});

UserDB.prototype.getChat = buscomponent.provideQUA('client-chat-get', function(query, user, access, cb) {
	var whereString = '';
	var params = [];
	
	if (!query.endpoints || !query.endpoints.length) {
		if (!query.chatid || parseInt(query.chatid) != query.chatid)
			return cb('format-error');
		
		whereString += ' chatid = ?';
		params.push(query.chatid);
	} else {
		if (query.chatid)
			return cb('format-error');
		
		var containsOwnUser = false;
		for (var i = 0; i < query.endpoints.length; ++i) {
			var uid = query.endpoints[i];
			containsOwnUser = containsOwnUser || (uid == user.id);
			if (parseInt(uid) != uid)
				return cb('format-error');
		}
		
		if (!containsOwnUser && user)
			query.endpoints.push(user.id);
		
		var endpointsList = query.endpoints.join(',');
		var numEndpoints = query.endpoints.length;
		
		whereString += 
			' (SELECT COUNT(*) FROM chatmembers AS cm JOIN users ON users.id = cm.userid WHERE cm.chatid = c.chatid ' +
			'AND cm.userid IN (' +  endpointsList + ')) = ? ';
		
		params.push(numEndpoints);
	}
	
	this.query('SELECT chatid, eventid AS chatstartevent FROM chats AS c ' +
		'LEFT JOIN events ON events.targetid = c.chatid AND events.type = "chat-start" '+
		'WHERE ' + whereString + ' ' +
		'ORDER BY (SELECT MAX(time) FROM events AS msgs WHERE msgs.type="comment" AND msgs.targetid = chatstartevent) DESC LIMIT 1', params, function(chatlist) {
		_.bind((chatlist.length == 0) ? function(cont) {
			if (query.failOnMissing)
				cont(null);
			
			this.query('INSERT INTO chats(creator) VALUE(?)', [user.id], function(res) {
				var members = [];
				var memberValues = [];
				for (var i = 0; i < query.endpoints.length; ++i) {
					members.push('(?, ?, UNIX_TIMESTAMP())');
					memberValues.push(res.insertId);
					memberValues.push(query.endpoints[i]);
				}
				
				this.query('INSERT INTO chatmembers(chatid, userid, jointime) VALUES ' + members.join(','), memberValues, function() {
					this.feed({
						type: 'chat-start',
						targetid: res.insertId, 
						srcuser: user.id,
						noFollowers: true,
						feedusers: query.endpoints,
						json: {endpoints: query.endpoints}
					}, function(eventid) {
						cont({chatid: res.insertId, eventid: eventid});
					});
				});
			});
		} : function(cont) {
			cont(chatlist[0]);
		}, this)(_.bind(function(chat) {
			if (chat === null)
				return cb('chat-get-notfound');
			
			assert.notStrictEqual(chat.chatid, null);
			assert.notStrictEqual(chat.eventid, null);
			
			chat.endpoints = query.endpoints;
			
			if (query.noMessages)
				return cb('chat-get-success', chat);
			
			this.query('SELECT u.name AS username, u.id AS uid, url AS profilepic ' +
				'FROM chatmembers AS cm ' +
				'JOIN users AS u ON u.id = cm.userid ' +
				'LEFT JOIN httpresources ON httpresources.user = cm.userid AND httpresources.role = "profile.image" ' + 
				'WHERE cm.chatid = ?', [chat.chatid], function(endpoints) {
				assert.ok(endpoints.length > 0);
				chat.endpoints = endpoints;
				
				var ownUserIsEndpoint = false;
				for (var i = 0; i < chat.endpoints.length; ++i) {
					if (chat.endpoints[i].uid == user.id) {
						ownUserIsEndpoint = true;
						break;
					}
				}
				
				if (!ownUserIsEndpoint)
					return cb('chat-get-notfound');
				
				this.query('SELECT c.*,u.name AS username,u.id AS uid, url AS profilepic, trustedhtml ' + 
					'FROM ecomments AS c ' + 
					'LEFT JOIN users AS u ON c.commenter = u.id ' + 
					'LEFT JOIN httpresources ON httpresources.user = c.commenter AND httpresources.role = "profile.image" ' + 
					'WHERE c.eventid = ?', [chat.chatstartevent], function(comments) {
					chat.messages = comments;
					cb('chat-get-success', {chat: chat});
				});	
			});
		}, this));
	});
});

UserDB.prototype.addUserToChat = buscomponent.provideQUA('client-chat-adduser', function(query, user, access, cb) {
	if (parseInt(query.userid) != query.userid || parseInt(query.chatid) != query.chatid)
		return cb('format-error');
	
	this.query('SELECT name FROM users WHERE id = ?', [query.userid], function(res) {
		if (res.length == 0)
			return cb('chat-adduser-user-notfound');
		
		assert.equal(res.length, 1);
		var username = res[0].name;
		
		this.getChat({
			chatid: query.chatid,
			failOnMissing: true
		}, user, access, function(status, chat) {
			switch (status) {
				case 'chat-get-notfound':
					return cb('chat-adduser-chat-notfound');
				case 'chat-get-success':
					break;
				default:
					return cb(status); // assume other error
			}
			
			this.query('INSERT INTO chatmembers (chatid, userid) VALUES (?, ?)', [query.chatid, query.userid], function(r) {
				var feedusers = _.pluck(chat.endpoints, 'uid');
				feedusers.push(query.userid);
				
				this.feed({
					type: 'chat-user-added',
					targetid: query.chatid, 
					srcuser: user.id,
					noFollowers: true,
					feedusers: chat.endpoints,
					json: {addedUser: query.userid, addedUserName: username, endpoints: chat.endpoints}
				});
				
				cb('chat-adduser-success');
			});
		});
	});
});

UserDB.prototype.listAllChats = buscomponent.provideQUA('client-list-all-chats', function(query, user, access, cb) {
	this.query('SELECT c.chatid, c.creator, creator_u.name AS creatorname, u.id AS member, u.name AS membername, url AS profilepic, ' +
		'eventid AS chatstartevent ' +
		'FROM chatmembers AS cmi ' +
		'JOIN chats AS c ON c.chatid = cmi.chatid ' +
		'JOIN chatmembers AS cm ON cm.chatid = c.chatid ' +
		'JOIN users AS u ON cm.userid = u.id ' +
		'LEFT JOIN httpresources ON httpresources.user = u.id AND httpresources.role = "profile.image" ' +
		'JOIN users AS creator_u ON c.creator = creator_u.id ' +
		'JOIN events ON events.targetid = c.chatid AND events.type = "chat-start" ' +
		'WHERE cmi.userid = ?', [user.id], function(res) {
		var ret = {};
		
		for (var i = 0; i < res.length; ++i) {
			if (!ret[res[i].chatid]) {
				ret[res[i].chatid] = _.pick(res[i], 'chatid', 'creator', 'creatorname', 'chatstartevent');
				ret[res[i].chatid].members = [];
			}
			
			ret[res[i].chatid].members.push({id: res[i].member, name: res[i].membername, profilepic: res[i].profilepic});
		}
		
		cb('list-all-chats-success', {chats: ret});
	});
});

exports.UserDB = UserDB;

})();
