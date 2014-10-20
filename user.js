(function () { "use strict";

var _ = require('underscore');
var util = require('util');
var hash = require('mhash').hash;
var crypto = require('crypto');
var assert = require('assert');
var buscomponent = require('./bus/buscomponent.js');
var Access = require('./access.js').Access;
var qctx = require('./qctx.js');
require('datejs');

function UserDB () {
}

util.inherits(UserDB, buscomponent.BusComponent);

UserDB.prototype.generatePWKey = function(pw, cb) {
	crypto.randomBytes(16, function(ex, buf) {
		var pwsalt = buf.toString('hex');
		var pwhash = hash('sha256', pwsalt + pw);
		cb(pwsalt, pwhash);
	});
};

UserDB.prototype.sendInviteEmail = function(data, cb) {
	var self = this;
	
	self.request({name: 'readEMailTemplate', 
		template: 'invite-email.eml',
		variables: {'sendername': data.sender.name, 'sendermail': data.sender.email, 'email': data.email, 'url': data.url}
	}, function(opt) {
		self.request({name: 'sendMail', opt: opt}, function(error, resp) {
			if (error) {
				cb('create-invite-link-failed');
				self.emitError(error);
			} else {
				cb('create-invite-link-success');
			}
		});
	});
};

UserDB.prototype.sendRegisterEmail = function(data, ctx, xdata, cb) {
	var self = this;
	
	ctx.access.drop('email_verif');
	
	self.login({
		name: data.email,
		stayloggedin: true,
		__ignore_password__: true
	}, ctx, xdata, function(code, loginResp) {
		assert.equal(code, 'login-success');
		
		crypto.randomBytes(16, function(ex, buf) {
			var key = buf.toString('hex');
			
			ctx.query('INSERT INTO email_verifcodes (`userid`, `time`, `key`) VALUES(?, UNIX_TIMESTAMP(), ?)', 
				[ctx.user.id, key], function(res) {

				self.getServerConfig(function(cfg) {
					var url = cfg.regurl.replace(/\{\$key\}/g, key).replace(/\{\$uid\}/g, ctx.user.id).replace(/\{\$hostname\}/g, cfg.hostname);
					
					self.request({name: 'readEMailTemplate', 
						template: 'register-email.eml',
						variables: {'url': url, 'username': data.name, 'email': data.email}
					}, function(opt) {
						self.request({name: 'sendMail', opt: opt}, function (error, resp) {
							if (error) {
								cb('reg-email-failed', loginResp, 'repush');
								self.emitError(error);
							} else {
								cb('reg-success', loginResp, 'repush');
							}
						});
					});
				});
			});
		});
	});
};

UserDB.prototype.listPopularStocks = buscomponent.provideQT('client-list-popular-stocks', function(query, ctx, cb) {
	ctx.query('SELECT oh.stocktextid AS stockid, oh.stockname, ' +
		'SUM(ABS(money)) AS moneysum, ' +
		'SUM(ABS(money) / (UNIX_TIMESTAMP() - buytime + 300)) AS wsum ' +
		'FROM orderhistory AS oh ' +
		'GROUP BY stocktextid ORDER BY wsum DESC LIMIT 20', [], function(popular) {
		cb('list-popular-stocks-success', {'results': popular});
	});
});

UserDB.prototype.login = buscomponent.provideQTX('client-login', function(query, ctx, xdata, cb) {
	var self = this;
	
	var name = String(query.name);
	var pw = String(query.pw);
	
	ctx.query('SELECT * FROM users WHERE (email = ? OR name = ?) AND deletiontime IS NULL ORDER BY id DESC', [name, name], function(res) {
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
		
		crypto.randomBytes(16, function(ex, buf) {
			self.getServerConfig(function(cfg) {
				var key = buf.toString('hex');
				
				self.regularCallback({}, ctx);
				
				ctx.query('INSERT INTO logins(cdid, ip, logintime, uid, headers) VALUES(?, ?, UNIX_TIMESTAMP(), ?, ?)',
					[xdata.cdid, xdata.remoteip, uid, JSON.stringify(xdata.hsheaders)], function() {
				ctx.query('INSERT INTO sessions(uid, `key`, logintime, lastusetime, endtimeoffset)' +
					'VALUES(?, ?, UNIX_TIMESTAMP(), UNIX_TIMESTAMP(), ?)',
					[uid, key, query.stayloggedin ? cfg.stayloggedinTime : cfg.normalLoginTime], function(res) {
						cb('login-success', {key: key, uid: uid}, 'repush');
				});
				});
			});
		});
	});
});

UserDB.prototype.logout = buscomponent.provideQT('logout', function(query, ctx, cb) {
	ctx.query('DELETE FROM sessions WHERE `key` = ?', [String(query.key)], function() {
		cb('logout-success');
	});
});

UserDB.prototype.getRanking = buscomponent.provideQT('client-get-ranking', function(query, ctx, cb) {
	var self = this;
	
	query.startindex = parseInt(query.startindex) || 0;
	query.endindex = parseInt(query.endindex) || (1 << 20);
	
	query.since = parseInt(query.since) || 0;
	query.upto = parseInt(query.upto) || (Date.now() / 1000);
	
	if (parseInt(query.since) != query.since)
		return cb('format-error');
	
	var likestringWhere = '';
	var likestringUnit = [];
	
	var join = 'FROM users AS u ' +
		'LEFT JOIN schoolmembers AS sm ON u.id = sm.uid ' +
		'LEFT JOIN schools AS c ON sm.schoolid = c.id ' +
		'JOIN valuehistory AS past_va ON past_va.userid = u.id ' +
		'JOIN (SELECT userid, MIN(time) AS t FROM valuehistory WHERE time > ? GROUP BY userid) AS past_locator_va ' +
			'ON past_va.userid = past_locator_va.userid AND past_va.time = past_locator_va.t ' +
		'JOIN valuehistory AS now_va ON now_va.userid = u.id ' +
		'JOIN (SELECT userid, MAX(time) AS t FROM valuehistory WHERE time < ? GROUP BY userid) AS now_locator_va ' +
			'ON now_va.userid = now_locator_va.userid AND now_va.time = now_locator_va.t ';
			
	if (!query.includeAll) 
		likestringWhere += ' AND email_verif != 0 ';

	if (query.search) {
		var likestring = '%' + (String(query.search)).replace(/%/g, '\\%') + '%';
		likestringWhere += 'AND ((u.name LIKE ?) OR (realnamepublish != 0 AND (giv_name LIKE ? OR fam_name LIKE ?))) ';
		likestringUnit.push(likestring, likestring, likestring);
	}
	
	(query.schoolid ? function(cont) {
		join += 'JOIN schools AS p ON c.path LIKE CONCAT(p.path, "/%") OR p.id = c.id ';
		likestringWhere += 'AND (p.id = ? OR p.path = ?) ';
		likestringUnit.push(String(query.schoolid), String(query.schoolid));
		
		self.request({name: 'isSchoolAdmin', ctx: ctx, status: ['xadmin'], schoolid: query.schoolid}, function(ok) {
			cont(ok);
		});
	} : function(cont) { cont(ctx.access.has('userdb')); })(function(fulldata) {
		ctx.query('SELECT u.id AS uid, u.name AS name, c.path AS schoolpath, c.id AS school, c.name AS schoolname, jointime, pending, ' +
			'tradecount != 0 as hastraded, ' + 
			'now_va.totalvalue AS totalvalue, past_va.totalvalue AS past_totalvalue, ' +
			'now_va.wprov_sum + now_va.lprov_sum AS prov_sum, past_va.wprov_sum + past_va.lprov_sum AS past_prov_sum, ' +
			'((now_va.fperf_cur + now_va.fperf_sold - past_va.fperf_sold) / (now_va.fperf_bought - past_va.fperf_bought + past_va.fperf_cur)) AS fperf, ' +
			'((now_va.fperf_cur + now_va.fperf_sold - past_va.fperf_sold) - (now_va.fperf_bought - past_va.fperf_bought + past_va.fperf_cur))/GREATEST(700000000, past_va.totalvalue) AS fperfval, ' +
			(fulldata ? '' : 'IF(realnamepublish != 0,giv_name,NULL) AS ') + ' giv_name, ' +
			(fulldata ? '' : 'IF(realnamepublish != 0,fam_name,NULL) AS ') + ' fam_name, ' +
			'(SELECT SUM(xp) FROM achievements WHERE achievements.userid = u.id) AS xp ' +
			join + /* needs query.since parameter */
			'WHERE hiddenuser != 1 AND deletiontime IS NULL ' +
			likestringWhere +
			'LIMIT ?, ?', 
			[query.since, query.upto].concat(likestringUnit).concat([query.startindex, query.endindex - query.startindex]),
		function(ranking) {
			cb('get-ranking-success', {'result': ranking});
		});
	});
});

UserDB.prototype.getUserInfo = buscomponent.provideQT('client-get-user-info', function(query, ctx, cb) {
	var self = this;
	
	self.getServerConfig(function(cfg) {
	
	if (query.lookfor == '$self' && ctx.user)
		query.lookfor = ctx.user.id;
	
	var columns = (ctx.access.has('userdb') || query.lookfor == ctx.user.id ? [
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
		
	ctx.query('SELECT ' + columns + ' FROM users AS u '+
		'LEFT JOIN valuehistory AS week_va ON week_va.userid = u.id AND week_va.time = (SELECT MIN(time) FROM valuehistory WHERE userid = u.id AND time > ?) ' +
		'LEFT JOIN valuehistory AS day_va  ON day_va.userid  = u.id AND day_va.time  = (SELECT MIN(time) FROM valuehistory WHERE userid = u.id AND time > ?) ' +
		'LEFT JOIN schoolmembers AS sm ON u.id = sm.uid '+
		'LEFT JOIN stocks ON u.id = stocks.leader '+
		'LEFT JOIN httpresources ON httpresources.user = u.id AND httpresources.role = "profile.image" '+
		'LEFT JOIN events ON events.targetid = u.id AND events.type = "user-register" '+
		'WHERE u.id = ? OR u.name = ?', 
		[Date.parse('Sunday').getTime() / 1000, Date.parse('00:00').getTime() / 1000,
			parseInt(query.lookfor) == query.lookfor ? query.lookfor : -1, String(query.lookfor)], function(users) {
		if (users.length == 0)
			return cb('get-user-info-notfound');
		
		var xuser = users[0];
		xuser.isSelf = (ctx.user && xuser.uid == ctx.user.uid);
		if (xuser.isSelf) 
			xuser.access = ctx.access.toArray();
		
		assert.ok(xuser.registerevent);
		
		delete xuser.pwhash;
		delete xuser.pwsalt;
		
		ctx.query('SELECT SUM(amount) AS samount, SUM(1) AS sone FROM depot_stocks AS ds WHERE ds.stockid=?', [xuser.lstockid], function(followers) {
			xuser.f_amount = followers[0].samount || 0;
			xuser.f_count = followers[0].sone || 0;
				
			ctx.query('SELECT p.name, p.path, p.id FROM schools AS c ' +
				'JOIN schools AS p ON c.path LIKE CONCAT(p.path, "/%") OR p.id = c.id ' + 
				'WHERE c.id = ? ORDER BY LENGTH(p.path) ASC', [xuser.dschoolid], function(schools) {
				
				/* do some validation on the schools array.
				 * this is not necessary; however, it may help catch bugs long 
				 * before they actually do a lot of harm.
				 */
				var levelArray = _.map(schools, function(s) { return s.path.replace(/[^\/]/g, '').length; });
				if (_.intersection(levelArray, _.range(1, levelArray.length+1)).length != levelArray.length)
					return self.emitError(new Error('Invalid school chain for user: ' + JSON.stringify(schools)));
				
				xuser.schools = schools;
				if (query.nohistory) 
					return cb('get-user-info-success', {result: xuser});
			
				ctx.query('SELECT oh.*,u.name AS leadername FROM orderhistory AS oh ' +
					'LEFT JOIN users AS u ON oh.leader = u.id ' + 
					'WHERE userid = ? AND buytime <= (UNIX_TIMESTAMP() - ?) ' + 
					'ORDER BY buytime DESC',
					[xuser.uid, (xuser.delayorderhist && xuser.uid != ctx.user.uid && !ctx.access.has('stocks')) ? cfg.delayOrderHistTime : 0], function(orders) {
					ctx.query('SELECT * FROM achievements ' +
						'LEFT JOIN events ON events.type="achievement" AND events.targetid = achid ' +
						'WHERE userid = ?', [xuser.uid], function(achievements) {
						ctx.query('SELECT time, totalvalue FROM valuehistory WHERE userid = ?', [xuser.uid], function(values) {
							ctx.query('SELECT c.*,u.name AS username,u.id AS uid, url AS profilepic, trustedhtml ' + 
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

UserDB.prototype.regularCallback = buscomponent.provide('regularCallbackUser', ['query', 'ctx', 'reply'], function(query, ctx, cb) {
	cb = cb || function() {};
	
	ctx.query('DELETE FROM sessions WHERE lastusetime + endtimeoffset < UNIX_TIMESTAMP()', []);
	ctx.query('SELECT p.id, p.path, users.access FROM schools AS p ' +
		'JOIN events ON events.type="school-create" AND events.targetid = p.id ' +
		'JOIN users ON users.id = events.srcuser ' +
		'WHERE ' +
		'(SELECT COUNT(uid) FROM schoolmembers WHERE schoolmembers.schoolid = p.id) = 0 AND ' +
		'(SELECT COUNT(*) FROM schools AS c WHERE c.path LIKE CONCAT(p.path, "/%")) = 0', [], function(r) {
		for (var i = 0; i < r.length; ++i) {
			var access = Access.fromJSON(r[i].access);
			
			if (!access.has('schooldb') && (r[i].path.replace(/[^\/]/g, '').length == 1 || (query && query.weekly)))
				ctx.query('DELETE FROM schools WHERE id = ?', [r[i].id]);
		}
		
		cb();
	});
});

UserDB.prototype.emailVerify = buscomponent.provideQTX('client-emailverif', function(query, ctx, xdata, cb) {
	var self = this;
	
	var uid = parseInt(query.uid);
	var key = String(query.key);
	
	ctx.query('SELECT email_verif AS v, 42 AS y, email FROM users WHERE id = ? ' +
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
			
			if (res[i].y == 41 && res[i].v < 1 && !ctx.access.has('userdb')) {
				cb('email-verify-failure');
				return;
			}
		}
		
		ctx.query('SELECT COUNT(*) AS c FROM users WHERE email = ? AND email_verif = 1 AND id != ?', [email, uid], function(res) {
			if (res[0].c > 0) {
				cb('email-verify-other-already-verified');
				return;
			}
		
			ctx.query('DELETE FROM email_verifcodes WHERE userid = ?', [uid], function() {
			ctx.query('UPDATE users SET email_verif = 1 WHERE id = ?', [uid], function() {
				ctx.access.grant('email_verif');
				
				self.login({
					name: email,
					stayloggedin: true,
					__ignore_password__: true
				}, new qctx.QContext({access: ctx.access, parentComponent: self}), xdata, cb);
			});
			});
		});
	});
});

UserDB.prototype.updateUserStatistics = buscomponent.provide('updateUserStatistics',
	['user', 'ctx', 'force', 'reply'], function(user, ctx, force, reply)
{
	var now = Date.now();
	var lastSessionUpdate = ctx.getProperty('lastSessionUpdate');
	if (((!lastSessionUpdate || (now - lastSessionUpdate) < 60000) && !force) || ctx.getProperty('readonly')) {
		// don't update things yet
		ctx.setProperty('pendingTicks', ctx.getProperty('pendingTicks') + 1);
	} else {
		ctx.query('UPDATE sessions SET lastusetime = UNIX_TIMESTAMP() WHERE id = ?', [user.sid]);
		ctx.query('UPDATE users SET ticks = ? + 1 WHERE id = ?', [ctx.getProperty('pendingTicks'), user.id]);
		ctx.setProperty('pendingTicks', 0);
		ctx.setProperty('lastSessionUpdate', now);
	}
	
	reply();
});

UserDB.prototype.loadSessionUser = buscomponent.provide('loadSessionUser', ['key', 'ctx', 'reply'], function(key, ctx, cb) {
	var self = this;
	
	ctx.query('SELECT users.*, sessions.id AS sid, users.id AS uid, ' +
		'schools.path AS schoolpath, schools.id AS school, schools.name AS schoolname, jointime, sm.pending AS schoolpending ' +
		'FROM sessions ' +
		'JOIN users ON sessions.uid = users.id ' +
		'LEFT JOIN schoolmembers AS sm ON sm.uid = users.id ' +
		'LEFT JOIN schools ON schools.id = sm.schoolid ' +
		'WHERE `key` = ? AND lastusetime + endtimeoffset > UNIX_TIMESTAMP() LIMIT 1', [key], function(res) {
		if (res.length == 0) {
			cb(null);
		} else {
			assert.equal(res.length, 1);
			var user = res[0];
			user.id = user.uid;
			user.realnamepublish = !!user.realnamepublish;
			user.delayorderhist = !!user.delayorderhist;
			
			self.updateUserStatistics(user, ctx);
			
			cb(user);
		}
	});
});

UserDB.prototype.register = buscomponent.provideQTX('client-register', function(query, ctx, xdata, cb) {
	if (ctx.user !== null)
		return cb('already-logged-in');
	this.updateUser(query, 'register', ctx, xdata, cb);
});

UserDB.prototype.changeOptions = buscomponent.provideQTX('client-change-options', function(query, ctx, xdata, cb) {
	this.updateUser(query, 'change', ctx, xdata, cb);
});

UserDB.prototype.resetUser = buscomponent.provideQT('client-reset-user', function(query, ctx, cb) {
	var self = this;
	
	self.getServerConfig(function(cfg) {
		if (!cfg.resetAllowed && !ctx.access.has('userdb'))
			return cb('permission-denied');
		
		assert.ok(ctx.user);
		assert.ok(ctx.access);
		
		ctx.query('DELETE FROM depot_stocks WHERE userid = ?', [ctx.user.uid], function() {
		ctx.query('UPDATE users SET freemoney = 1000000000, totalvalue = 1000000000, ' +
			'fperf_bought = 0, fperf_cur = 0, fperf_sold = 0, ' + 
			'operf_bought = 0, operf_cur = 0, operf_sold = 0, ' + 
			'wprov_sum = 0, lprov_sum = 0 ' + 
			'WHERE id = ?', [ctx.user.uid], function() {
			self.request({name: 'sellAll', query: query, ctx: ctx}, function() {
				ctx.query('UPDATE stocks SET lastvalue = 10000000, ask = 10000000, bid = 10000000, ' +
					'daystartvalue = 10000000, weekstartvalue = 10000000, lastchecktime = UNIX_TIMESTAMP() WHERE leader = ?', [ctx.user.uid], function() {
					ctx.query('DELETE FROM valuehistory WHERE userid = ?', [ctx.user.uid], function() {
						ctx.feed({'type': 'user-reset', 'targetid': ctx.user.uid, 'srcuser': ctx.user.uid});
						self.request({name: 'dqueriesResetUser', ctx: ctx}, function() {
							cb('reset-user-success');
						});
					});
				});
			});
		});
		});
	});
});

UserDB.prototype.passwordReset = buscomponent.provideQT('client-password-reset', function(query, ctx, cb) {
	var self = this;
	
	if (ctx.user)
		return cb('already-logged-in');
	
	ctx.query('SELECT * FROM users WHERE name = ? AND deletiontime IS NULL', [String(query.name)], function(res) {
		if (res.length == 0)
			return cb('password-reset-notfound');
		
		var u = res[0];
		assert.ok(u);
		
		crypto.randomBytes(6, function(ex, buf) {
			var pw = buf.toString('hex');
			self.generatePWKey(pw, function(salt, hash) {
				ctx.query('UPDATE users SET pwsalt = ?, pwhash = ? WHERE id = ?', [salt, hash, u.id], function() {
					var opt = self.request({name: 'readEMailTemplate', 
						template: 'password-reset-email.eml',
						variables: {'password': pw, 'username': query.name, 'email': u.email},
					}, function(opt) {
						self.request({name: 'sendMail', opt: opt}, function (error, resp) {
							if (error) {
								cb('password-reset-failed');
								self.emitError(error);
							} else {
								cb('password-reset-success');
							}
						});
					});
				});
			});
		});
	});
});

UserDB.prototype.getInviteKeyInfo = buscomponent.provideQT('client-get-invite-key-info', function(query, ctx, cb) {
	var self = this;
	
	ctx.query('SELECT email, schoolid FROM invitelink WHERE `key` = ?', [String(query.invitekey)], function(res) {
		if (res.length == 0) {
			cb('get-invitekey-info-notfound');
		} else {
			self.getServerConfig(function(cfg) {
				assert.equal(res.length, 1);
				
				res[0].url = cfg.inviteurl.replace(/\{\$key\}/g, query.invitekey).replace(/\{\$hostname\}/g, cfg.hostname);
				
				cb('get-invitekey-info-success', {result: res[0]});
			});
		}
	});
});

UserDB.prototype.createInviteLink = buscomponent.provideQT('createInviteLink', function(query, ctx, cb) {
	var self = this;
	
	self.getServerConfig(function(cfg) {
		query.email = query.email ? String(query.email) : null;
		
		if (!ctx.access.has('userdb')) {
			if (query.email && !/([\w_+.-]+)@([\w.-]+)$/.test(query.email))
				return cb('create-invite-link-invalid-email');
			
			if (!ctx.access.has('email_verif'))
				return cb('create-invite-link-not-verif');
		}
		
		crypto.randomBytes(16, function(ex, buf) {
			var key = buf.toString('hex');
			var sendKeyToCaller = ctx.access.has('userdb');
			ctx.query('INSERT INTO invitelink ' +
				'(uid, `key`, email, ctime, schoolid) VALUES ' +
				'(?, ?, ?, UNIX_TIMESTAMP(), ?)', 
				[ctx.user.id, key, query.email, query.schoolid ? parseInt(query.schoolid) : null], function() {
				var url = cfg.inviteurl.replace(/\{\$key\}/g, key).replace(/\{\$hostname\}/g, cfg.hostname);
		
				(query.email ? function(cont) {
					self.sendInviteEmail({
						sender: ctx.user,
						email: query.email,
						url: url
					}, function(status) {
						cont(status);
					});
				} : function(cont) {
					sendKeyToCaller = true;
					cont('create-invite-link-success');
				})(function(status) {
					cb(status, sendKeyToCaller ? {'url': url, 'key': key} : null);
				});
			});
		});
	});
});

UserDB.prototype.updateUser = function(query, type, ctx, xdata, cb) {
	var self = this;
	
	self.getServerConfig(function(cfg) {
		
	var uid = ctx.user !== null ? ctx.user.id : null;
	if (!query.name || !query.email) {
		cb('format-error');
		return;
	}
	
	if ((query.password || type != 'change') && (!query.password || query.password.length < 5)) {
		cb('reg-too-short-pw');
		return;
	}
	
	query.email = String(query.email);
	query.name = String(query.name);
	if (!/^[^\.,@<>\x00-\x20\x7f!"'\/\\$#()^?&{}]+$/.test(query.name) || parseInt(query.name) == query.name) {
		cb('reg-name-invalid-char');
		return;
	}
	
	query.giv_name = String(query.giv_name || '');
	query.fam_name = String(query.fam_name || '');
	query.wprovision = parseInt(query.wprovision) || cfg.defaultWProvision;
	query.lprovision = parseInt(query.lprovision) || cfg.defaultLProvision;
	query.birthday = query.birthday ? parseInt(query.birthday) : null;
	query.desc = String(query.desc);
	query.street = query.street ? String(query.street) : null;
	query.town = query.town ? String(query.town) : null;
	query.zipcode = query.zipcode ? String(query.zipcode) : null;
	
	if (query.wprovision < cfg.minWProvision || query.wprovision > cfg.maxWProvision ||
	    query.lprovision < cfg.minLProvision || query.lprovision > cfg.maxLProvision) 
		return cb('invalid-provision');
	
	if (!query.school) // e. g., empty string
		query.school = null;
	
	var betakey = query.betakey ? String(query.betakey).split('-') : [0,0];
	
	ctx.getConnection(function(conn) {
	conn.query('SET autocommit = 0; ' +
		'LOCK TABLES users WRITE, stocks WRITE, betakeys WRITE, inviteaccept WRITE, invitelink READ, schoolmembers WRITE, schooladmins WRITE' +
		(query.school ? ', schools WRITE' : '') + ';', [], function() {
	
	var commit = function(cb) {
		cb = cb || function() {};
		conn.query('COMMIT; UNLOCK TABLES; SET autocommit = 1;', [], function() { conn.release(); cb(); });
	};
	
	var rollback = function() {
		conn.query('ROLLBACK; UNLOCK TABLES; SET autocommit = 1;', [], function() { conn.release(); });
	};
	
	conn.query('SELECT email,name,id FROM users WHERE (email = ? AND email_verif) OR (name = ?) ORDER BY NOT(id != ?)',
		[query.email, query.name, uid], function(res) {
	conn.query('SELECT `key` FROM betakeys WHERE `id` = ?',
		[betakey[0]], function(βkey) {
		if (cfg.betakeyRequired && (βkey.length == 0 || βkey[0].key != betakey[1]) && type == 'register' && !ctx.access.has('userdb')) {
			rollback();
			cb('reg-beta-necessary');
			
			return;
		}
		
		if (res.length > 0 && res[0].id !== uid) {
			rollback();
			
			if (res[0].email.toLowerCase() == query.email.toLowerCase())
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
					
					query.school = res.insertId;
					
					gainUIDCBs.push(function() {
						assert.ok(uid != null);
						
						ctx.feed({'type': 'school-create', 'targetid': res.insertId, 'srcuser': uid});
					});
				}
				
				var updateCB = function(res) {
					commit(function() {
						if (uid === null)
							uid = res.insertId;
						
						assert.ok(uid != null);
						
						for (var i = 0; i < gainUIDCBs.length; ++i)
							gainUIDCBs[i]();

						if ((ctx.user && query.email == ctx.user.email) || (ctx.access.has('userdb') && query.nomail))
							cb('reg-success', {uid: uid}, 'repush');
						else 
							self.sendRegisterEmail(query,
								new qctx.QContext({user: {id: uid, uid: id}, access: ctx.access, parentComponent: self}),
								xdata,
								cb);
					});
				};
				
				var onPWGenerated = function(pwsalt, pwhash) {
					if (type == 'change') {
						conn.query('UPDATE users SET name = ?, giv_name = ?, fam_name = ?, realnamepublish = ?, delayorderhist = ?, pwhash = ?, pwsalt = ?, email = ?, email_verif = ?,' +
						'birthday = ?, `desc` = ?, wprovision = ?, lprovision = ?, street = ?, zipcode = ?, town = ?, traditye = ?, skipwalkthrough = ? '+
						'WHERE id = ?',
						[query.name, query.giv_name, query.fam_name, query.realnamepublish?1:0, query.delayorderhist?1:0, pwhash, pwsalt, query.email, query.email == ctx.user.email,
						query.birthday, query.desc, query.wprovision, query.lprovision, query.street, query.zipcode, query.town, query.traditye?1:0, query.skipwalkthrough?1:0, uid],
						updateCB);
						
						if (query.name != ctx.user.name) {
							ctx.feed({'type': 'user-namechange', 'targetid': uid, 'srcuser': uid, json: {'oldname': ctx.user.name, 'newname': query.name}});
							conn.query('UPDATE stocks SET name = ? WHERE leader = ?', ['Leader: ' + query.name, uid]);
						}
						
						if (query.school != ctx.user.school) {
							if (query.school == null)
								conn.query('DELETE FROM schoolmembers WHERE uid = ?', [uid]);
							else
								conn.query('REPLACE INTO schoolmembers (uid, schoolid, pending, jointime) '+
									'VALUES(?, ?, ' + (ctx.access.has('schooldb') ? '0' : '((SELECT COUNT(*) FROM schooladmins WHERE schoolid = ? AND status="admin") > 0)') + ', UNIX_TIMESTAMP())',
									[uid, String(query.school), String(query.school)]);
							
							if (ctx.user.school != null) 
								conn.query('DELETE FROM schooladmins WHERE uid = ? AND schoolid = ?', [uid, ctx.user.school]);
						}

						if (query.wprovision != ctx.user.wprovision || query.lprovision != ctx.user.lprovision)
							ctx.feed({'type': 'user-provchange', 'targetid': uid, 'srcuser': uid, json:
								{'oldwprov': ctx.user.wprovision, 'newwprov': query.wprovision,
								 'oldlprov': ctx.user.lprovision, 'newlprov': query.lprovision}});
						
						if (query.desc != ctx.user.desc)
							ctx.feed({'type': 'user-descchange', 'targetid': uid, 'srcuser': uid});
					} else {
						if (query.betakey)
							conn.query('DELETE FROM betakeys WHERE id = ?', [betakey[0]]);
						
						var inv = {};
						(query.invitekey ? function(cont) {
							conn.query('SELECT * FROM invitelink WHERE `key` = ?', [String(query.invitekey)], function(invres) {
								if (invres.length == 0)
									cont();
								
								assert.equal(invres.length, 1);
								
								inv = invres[0];
								if (inv.schoolid && !query.school || parseInt(query.school) == parseInt(inv.schoolid)) {
									query.school = inv.schoolid;
									inv.__schoolverif__ = 1;
								}
								
								gainUIDCBs.push(function() {
									conn.query('INSERT INTO inviteaccept (iid, uid, accepttime) VALUES(?, ?, UNIX_TIMESTAMP())', [inv.id, uid]);
								});
								
								cont();
							});
						} : function(cont) {
							cont();
						})(function() {
							conn.query('INSERT INTO users ' +
								'(name, giv_name, fam_name, realnamepublish, delayorderhist, pwhash, pwsalt, email, email_verif, ' +
								'traditye, street, zipcode, town, registertime, wprovision, lprovision)' +
								'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, UNIX_TIMESTAMP(), ?, ?)',
								[query.name, query.giv_name, query.fam_name, query.realnamepublish?1:0, query.delayorderhist?1:0, pwhash, pwsalt,
								query.email, (inv.email && inv.email == query.email) ? 1 : 0,
								query.traditye?1:0, query.street, query.zipcode, query.town,
								cfg.defaultWProvision, cfg.defaultLProvision],
							function(res) {
								uid = res.insertId;
								ctx.feed({'type': 'user-register', 'targetid': uid, 'srcuser': uid});
								conn.query('INSERT INTO stocks (stockid, leader, name, exchange, pieces) VALUES(?, ?, ?, ?, 100000000)',
									['__LEADER_' + uid + '__', uid, 'Leader: ' + query.name, 'tradity'], _.bind(updateCB, self, res));
									
								if (query.school) {
									conn.query('INSERT INTO schoolmembers (uid, schoolid, pending, jointime) ' +
										'VALUES(?, ?, ' + 
										(inv.__schoolverif__ ? '1' : '((SELECT COUNT(*) FROM schooladmins WHERE schoolid = ? AND status="admin") > 0) ') +
										', UNIX_TIMESTAMP())',
										[uid, String(query.school), String(query.school)]);
								}
							});
						});
					}
				};
				
				if (query.password)
					self.generatePWKey(query.password, onPWGenerated);
				else
					onPWGenerated(ctx.user.pwsalt, ctx.user.pwhash);
			};
			
			if (res.length == 0 && query.school !== null) {
				if (parseInt(query.school) == query.school || !query.school) {
					rollback();
					
					cb('reg-unknown-school');
					return;
				} else {
					conn.query('INSERT INTO schools (name, path) VALUES(?, CONCAT("/",MD5(?)))', [String(query.school), String(query.school)], schoolAddedCB);
				}
			} else {
				if (query.school !== null) {
					assert.ok(parseInt(query.school) != query.school || query.school == res[0].id);
					query.school = res[0].id;
				}
				
				_.bind(schoolAddedCB, self)([]);
			}
		};
		
		if (query.school !== null) {
			conn.query('SELECT id FROM schools WHERE ? IN (id, name, path)', [String(query.school)], schoolLookupCB);
		} else {
			_.bind(schoolLookupCB, self)([]);
		}
	
	});
	});
	});
	});
	
	});
};

UserDB.prototype.watchlistAdd = buscomponent.provideQT('client-watchlist-add', function(query, ctx, cb) {
	ctx.query('SELECT stockid, users.id AS uid, users.name, bid FROM stocks ' +
		'LEFT JOIN users ON users.id = stocks.leader WHERE stocks.id = ?',
		[String(query.stockid)], function(res) {
		if (res.length == 0)
			return cb('watchlist-add-notfound');
		var uid = res[0].uid;
		if (uid == ctx.user.id)
			return cb('watchlist-add-self');
		
		ctx.query('REPLACE INTO watchlists (watcher, watchstarttime, watchstartvalue, watched) VALUES(?, UNIX_TIMESTAMP(), ?, ?)',
			[ctx.user.id, res[0].bid, String(query.stockid)], function(r) {
			ctx.feed({
				type: 'watch-add',
				targetid: r.insertId,
				srcuser: 
				ctx.user.id,
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

UserDB.prototype.watchlistRemove = buscomponent.provideQT('client-watchlist-remove', function(query, ctx, cb) {
	ctx.query('DELETE FROM watchlists WHERE watcher = ? AND watched = ?', [ctx.user.id, String(query.stockid)], function() {
		ctx.feed({
			type: 'watch-remove',
			targetid: null,
			srcuser: ctx.user.id,
			json: { watched: query.stockid }
		});
		
		cb('watchlist-remove-success');
	}); 
});

UserDB.prototype.watchlistShow = buscomponent.provideQT('client-watchlist-show', function(query, ctx, cb) {
	ctx.query('SELECT s.*, s.name AS stockname, users.name AS username, users.id AS uid, w.watchstartvalue, w.watchstarttime, ' +
		'lastusetime AS lastactive, IF(rw.watched IS NULL, 0, 1) AS friends ' +
		'FROM watchlists AS w ' +
		'JOIN stocks AS s ON w.watched = s.id ' +
		'JOIN stocks AS rs ON rs.leader = w.watcher ' +
		'LEFT JOIN users ON users.id = s.leader ' +
		'LEFT JOIN watchlists AS rw ON rw.watched = rs.id AND rw.watcher = s.leader ' +
		'LEFT JOIN sessions ON sessions.lastusetime = (SELECT MAX(lastusetime) FROM sessions WHERE uid = rw.watched) AND sessions.uid = rw.watched ' +
		'WHERE w.watcher = ?', [ctx.user.id], function(res) {
		cb('watchlist-show-success', {'results': res});
	});
});

UserDB.prototype.getChat = buscomponent.provideQT('client-chat-get', function(query, ctx, cb) {
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
			containsOwnUser = containsOwnUser || (uid == ctx.user.id);
			if (parseInt(uid) != uid)
				return cb('format-error');
		}
		
		if (!containsOwnUser && ctx.user)
			query.endpoints.push(ctx.user.id);
		
		var endpointsList = query.endpoints.join(',');
		var numEndpoints = query.endpoints.length;
		
		whereString += 
			' (SELECT COUNT(*) FROM chatmembers AS cm JOIN users ON users.id = cm.userid WHERE cm.chatid = c.chatid ' +
			'AND cm.userid IN (' +  endpointsList + ')) = ? ';
		
		params.push(numEndpoints);
	}
	
	ctx.query('SELECT chatid, eventid AS chatstartevent FROM chats AS c ' +
		'LEFT JOIN events ON events.targetid = c.chatid AND events.type = "chat-start" '+
		'WHERE ' + whereString + ' ' +
		'ORDER BY (SELECT MAX(time) FROM events AS msgs WHERE msgs.type="comment" AND msgs.targetid = chatstartevent) DESC LIMIT 1', params, function(chatlist) {
		((chatlist.length == 0) ? function(cont) {
			if (query.failOnMissing)
				cont(null);
			
			ctx.query('INSERT INTO chats(creator) VALUE(?)', [ctx.user.id], function(res) {
				var members = [];
				var memberValues = [];
				for (var i = 0; i < query.endpoints.length; ++i) {
					members.push('(?, ?, UNIX_TIMESTAMP())');
					memberValues.push(res.insertId);
					memberValues.push(String(query.endpoints[i]));
				}
				
				ctx.query('INSERT INTO chatmembers(chatid, userid, jointime) VALUES ' + members.join(','), memberValues, function() {
					ctx.feed({
						type: 'chat-start',
						targetid: res.insertId, 
						srcuser: ctx.user.id,
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
		})(function(chat) {
			if (chat === null)
				return cb('chat-get-notfound');
			
			assert.notStrictEqual(chat.chatid, null);
			assert.notStrictEqual(chat.eventid, null);
			
			chat.endpoints = query.endpoints;
			
			if (query.noMessages)
				return cb('chat-get-success', chat);
			
			ctx.query('SELECT u.name AS username, u.id AS uid, url AS profilepic ' +
				'FROM chatmembers AS cm ' +
				'JOIN users AS u ON u.id = cm.userid ' +
				'LEFT JOIN httpresources ON httpresources.user = cm.userid AND httpresources.role = "profile.image" ' + 
				'WHERE cm.chatid = ?', [chat.chatid], function(endpoints) {
				assert.ok(endpoints.length > 0);
				chat.endpoints = endpoints;
				
				var ownUserIsEndpoint = false;
				for (var i = 0; i < chat.endpoints.length; ++i) {
					if (chat.endpoints[i].uid == ctx.user.id) {
						ownUserIsEndpoint = true;
						break;
					}
				}
				
				if (!ownUserIsEndpoint)
					return cb('chat-get-notfound');
				
				ctx.query('SELECT c.*,u.name AS username,u.id AS uid, url AS profilepic, trustedhtml ' + 
					'FROM ecomments AS c ' + 
					'LEFT JOIN users AS u ON c.commenter = u.id ' + 
					'LEFT JOIN httpresources ON httpresources.user = c.commenter AND httpresources.role = "profile.image" ' + 
					'WHERE c.eventid = ?', [chat.chatstartevent], function(comments) {
					chat.messages = comments;
					cb('chat-get-success', {chat: chat});
				});	
			});
		});
	});
});

UserDB.prototype.addUserToChat = buscomponent.provideQT('client-chat-adduser', function(query, ctx, cb) {
	var self = this;
	
	if (parseInt(query.userid) != query.userid || parseInt(query.chatid) != query.chatid)
		return cb('format-error');
	
	ctx.query('SELECT name FROM users WHERE id = ?', [query.userid], function(res) {
		if (res.length == 0)
			return cb('chat-adduser-user-notfound');
		
		assert.equal(res.length, 1);
		var username = res[0].name;
		
		self.getChat({
			chatid: query.chatid,
			failOnMissing: true
		}, ctx, function(status, chat) {
			switch (status) {
				case 'chat-get-notfound':
					return cb('chat-adduser-chat-notfound');
				case 'chat-get-success':
					break;
				default:
					return cb(status); // assume other error
			}
			
			ctx.query('INSERT INTO chatmembers (chatid, userid) VALUES (?, ?)', [query.chatid, query.userid], function(r) {
				var feedusers = _.pluck(chat.endpoints, 'uid');
				feedusers.push(query.userid);
				
				ctx.feed({
					type: 'chat-user-added',
					targetid: query.chatid, 
					srcuser: ctx.user.id,
					noFollowers: true,
					feedusers: chat.endpoints,
					json: {addedUser: query.userid, addedUserName: username, endpoints: chat.endpoints}
				});
				
				cb('chat-adduser-success');
			});
		});
	});
});

UserDB.prototype.listAllChats = buscomponent.provideQT('client-list-all-chats', function(query, ctx, cb) {
	ctx.query('SELECT c.chatid, c.creator, creator_u.name AS creatorname, u.id AS member, u.name AS membername, url AS profilepic, ' +
		'eventid AS chatstartevent ' +
		'FROM chatmembers AS cmi ' +
		'JOIN chats AS c ON c.chatid = cmi.chatid ' +
		'JOIN chatmembers AS cm ON cm.chatid = c.chatid ' +
		'JOIN users AS u ON cm.userid = u.id ' +
		'LEFT JOIN httpresources ON httpresources.user = u.id AND httpresources.role = "profile.image" ' +
		'JOIN users AS creator_u ON c.creator = creator_u.id ' +
		'JOIN events ON events.targetid = c.chatid AND events.type = "chat-start" ' +
		'WHERE cmi.userid = ?', [ctx.user.id], function(res) {
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
