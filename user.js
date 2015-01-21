(function () { "use strict";

var _ = require('lodash');
var util = require('util');
var crypto = require('crypto');
var assert = require('assert');
var Q = require('q');
var serverUtil = require('./server-util.js');
var buscomponent = require('./stbuscomponent.js');
var Access = require('./access.js').Access;
var qctx = require('./qctx.js');
require('datejs');

/**
 * Provides all single-user non-financial client requests.
 * 
 * @public
 * @module user
 */

/**
 * Main object of the {@link module:user} module
 * @public
 * @constructor module:user~User
 * @augments module:stbuscomponent~STBusComponent
 */
function User () {
	User.super_.apply(this, arguments);
}

util.inherits(User, buscomponent.BusComponent);

/**
 * Generates a password hash and salt combination.
 * 
 * @param {string} pw  The password string to generate a salt+hash for.
 * 
 * @return  A Q promise for an object of the form { salt: …, hash: … }
 * @function module:user~User#generatePWKey
 */
User.prototype.generatePWKey = function(pw) {
	return Q.nfcall(crypto.randomBytes, 16).then(function(buf) {
		var pwsalt = buf.toString('hex');
		var pwhash = serverUtil.sha256(pwsalt + String(pw));
		
		return {salt: pwsalt, hash: pwhash};
	});
};

/**
 * Sends an invite e-mail to a user.
 * 
 * @param {object} data  General information on sender and receiver of the e-mail.
 * @param {string} data.sender.name  The username of the sender.
 * @param {string} data.sender.email  The e-mail address of the sender.
 * @param {string} data.email  The e-mail adress of the receiver.
 * @param {string} data.url  The URL of the invite link.
 * @param {module:qctx~QContext} ctx  A QContext to provide database access.
 * @param {function} cb  A callback which will be called with
 *                       <code>create-invite-link-success</code>.
 * 
 * @function module:user~User#sendInviteEmail
 */
User.prototype.sendInviteEmail = function(data, ctx, cb) {
	var self = this;
	
	return self.request({name: 'sendTemplateMail',
		template: 'invite-email.eml',
		ctx: ctx,
		variables: {'sendername': data.sender.name, 'sendermail': data.sender.email, 'email': data.email, 'url': data.url}
	}).then(function() {
		return cb('create-invite-link-success');
	});
};

/**
 * Sends the registation e-mail to a new user or after an e-mail address change.
 * 
 * @param {object} data  General information on the receiver of the email.
 * @param {string} data.name  The username of the receiver.
 * @param {string} data.email  The e-mail adress of the receiver.
 * @param {string} data.url  The URL of the e-mail address confirmation link.
 * @param {function} cb  A callback which will be called with
 *                       <code>reg-success</code>.
 * 
 * @function module:user~User#sendRegisterEmail
 */
User.prototype.sendRegisterEmail = function(data, ctx, xdata, cb) {
	var self = this;
	
	ctx.access.drop('email_verif');
	
	return self.login({
		name: data.email,
		stayloggedin: true,
	}, ctx, xdata, true, function(code, loginResp) {
		assert.equal(code, 'login-success');
		
		return Q.nfcall(crypto.randomBytes, 16).then(ctx.errorWrap(function(buf) {
			var key = buf.toString('hex');
			
			return ctx.query('INSERT INTO email_verifcodes (`userid`, `time`, `key`) VALUES(?, UNIX_TIMESTAMP(), ?)', 
				[ctx.user.id, key]);
		})).then(function(res) {
			return self.getServerConfig();
		}).then(function(cfg) {
			var url = (cfg.regurl
				.replace(/\{\$key\}/g, key)
				.replace(/\{\$uid\}/g, ctx.user.id)
				.replace(/\{\$hostname\}/g, cfg.hostname));
			
			return self.request({name: 'sendTemplateMail', 
				template: 'register-email.eml',
				ctx: ctx,
				variables: {'url': url, 'username': data.name, 'email': data.email}
			});
		.then(function() {
			return cb('reg-success', loginResp, 'repush');
		});
	});
};

/**
 * Lists the most popular stocks.
 * 
 * These are ordered according to a weighted average of the money amounts
 * involved in the relevant trades, specifically:
 * 
 * <ul>
 *     <li>No trades older than 3 weeks are taken into consideration</li>
 *     <li>Each trade’s value is added to its stock according to:
 *         <math mode="display" xmlns="http://www.w3.org/1998/Math/MathML">
 *             <mfrac>
 *                 <mrow>| money involved in trade |</mrow>
 *                 <mrow>| time difference now - trade time in seconds + 300 |</mrow>
 *             </mfrac>
 *         </math>
 *     </li>
 * </ul>
 * 
 * @return {object} Returns with <code>list-popular-stocks-success</code>,
 *                  with <code>.results</code> being set to a list of stocks,
 *                  which carry the properties <code>stockid, stockname, moneysum, wsum</code>,
 *                  the latter being the sum of the above formula over all trades for that stock.
 * 
 * @function c2s~list-popular-stocks
 */
User.prototype.listPopularStocks = buscomponent.provideQT('client-list-popular-stocks', function(query, ctx, cb) {
	return ctx.query('SELECT oh.stocktextid AS stockid, oh.stockname, ' +
		'SUM(ABS(money)) AS moneysum, ' +
		'SUM(ABS(money) / (UNIX_TIMESTAMP() - buytime + 300)) AS wsum ' +
		'FROM orderhistory AS oh ' +
		'WHERE buytime > UNIX_TIMESTAMP() - 86400*21 ' +
		'GROUP BY stocktextid ORDER BY wsum DESC LIMIT 20', []).then(function(popular) {
		cb('list-popular-stocks-success', {'results': popular});
	});
});

/**
 * Logs a user into their account.
 * 
 * This is usually achieved by creating a session and writing it
 * into the database. Should, however, the server be in read-only mode,
 * a message is created and signed with this server’s private key which
 * is valid for one day.
 * 
 * @param {string} query.name  A user name or e-mail address.
 * @param {string} query.pw  The user’s password.
 * @param {boolean} query.stayloggedin  Whether the user wishes to be logged in
 *                                      for an extended period of time (e.g. when
 *                                      using their personal computer).
 * 
 * @return {object} Returns with <code>login-wrongpw</code>,
 *                  <code>login-badname</code>, <code>login-success</code> or a common error code and,
 *                  in case of success, sets <code>.key</code> (a session id) and <code>.uid</code>
 *                  accordingly.
 * 
 * @loginignore
 * @function c2s~login
 */
User.prototype.login = buscomponent.provide('client-login', 
	['query', 'ctx', 'xdata', 'ignorePassword', 'reply'], function(query, ctx, xdata, ignorePassword, cb) {
	var self = this;
	
	var name = String(query.name);
	var pw = String(query.pw);
	
	/* use an own connection to the server with write access
	 * (otherwise we might end up with slightly outdated data) */
	return ctx.startTransaction().then(function(conn) {
		return conn.query('SELECT id, pwsalt, pwhash '+
			'FROM users ' +
			'WHERE (email = ? OR name = ?) AND deletiontime IS NULL ' +
			'ORDER BY id DESC', [name, name]);
	}).then(function(res) {
		if (res.length == 0) {
			cb('login-badname');
			return;
		}
		
		var uid = res[0].id;
		var pwsalt = res[0].pwsalt;
		var pwhash = res[0].pwhash;
		if (pwhash != serverUtil.sha256(pwsalt + pw) && !ignorePassword) {
			cb('login-wrongpw');
			return;
		}
		
		Q.nfcall(crypto.randomBytes, 16).then(ctx.errorWrap(function(ex, buf) {
			return self.getServerConfig();
		})).then(function(cfg) {
			var key = buf.toString('hex');
			
			if (ctx.getProperty('readonly')) {
				key = key.substr(0, 6);
				var today = parseInt(Date.now() / 86400);
				
				return self.request({
					name: 'createSignedMessage',
					msg: {
						uid: uid,
						sid: key,
						date: today
					}
				}).then(function(sid) {
					return cb('login-success', {
						key: ':' + sid,
						uid: uid
					}, 'repush');
				});
			} else {
				self.regularCallback({}, ctx);
				
				return conn.query('INSERT INTO sessions(uid, `key`, logintime, lastusetime, endtimeoffset)' +
					'VALUES(?, ?, UNIX_TIMESTAMP(), UNIX_TIMESTAMP(), ?)',
					[uid, key, query.stayloggedin ? cfg.stayloggedinTime : cfg.normalLoginTime]).then(function() {
					return conn.commit();
				}).then(function() {
					cb('login-success', {key: key, uid: uid}, 'repush')
				});
			}
		});
	});
});

/**
 * Logs a user out of their account.
 * 
 * @return {object} Returns with <code>logout-success</code> or a common error code.
 * 
 * @function c2s~logout
 */
User.prototype.logout = buscomponent.provideWQT('client-logout', function(query, ctx, cb) {
	return ctx.query('DELETE FROM sessions WHERE `key` = ?', [String(query.key)]).then(function() {
		return cb('logout-success');
	});
});

/**
 * Represents the information publicly available about a single user.
 * @typedef module:user~UserEntryBase
 * @type object
 * 
 * @property {int} uid  Often aliased to <code>id</code>, this is the user’s numerical id.
 *                      Use of the attribute <code>id</code> is deprecated, though, and it
 *                      will be removed somewhen in the future.
 * @property {string} name  The name chosen by the user.
 * @property {int} school  Usually the numerical id of the group in which this user is a member.
 * @property {string} schoolpath  The path of the school in which this user is a member.
 * @property {string} schoolname  The human-readable name of the school in which this user is a member.
 * @property {?int} jointime  The unix timestamp of the time when this user joined their current group.
 * @property {?boolean} pending  If this user is a group member, this flag indicates whether
 *                               the user has been accepted yet.
 * @property {?boolean} hastraded  Indicates whether the user has traded at least once.
 * @property {number} totalvalue  The total value of the user at the most recent available data point.
 * @property {number} prov_sum    The total sum of provisions for this user at the most recent available data point.
 * @property {?string} giv_name  This user’s given name.
 * @property {?string} fam_name  This user’s family name.
 * @property {number} xp  This user’s experience point count.
 */

/**
 * Represents the information available about a single user in the ranking table,
 * extending {@link module:user~UserEntryBase}.
 * <br>
 * The following variables will be used for brevity:
 * <ul>
 *     <li><math mode="display" xmlns="http://www.w3.org/1998/Math/MathML">
 *         <mrow><msub><mi>P</mi><mn>now</mn></msub> = current possession of follower shares</mrow>
 *     </math></li>
 *     <li><math mode="display" xmlns="http://www.w3.org/1998/Math/MathML">
 *         <mrow><msub><mi>P</mi><mn>past</mn></msub> = past possession of follower shares</mrow>
 *     </math></li>
 *     <li><math mode="display" xmlns="http://www.w3.org/1998/Math/MathML">
 *         <mrow><msub><mi>B</mi><mn>now</mn></msub> = current <abbr title="accumulated">acc.</abbr> value of
 *              bought follower shares</mrow>
 *     </math></li>
 *     <li><math mode="display" xmlns="http://www.w3.org/1998/Math/MathML">
 *         <mrow><msub><mi>B</mi><mn>past</mn></msub> = past <abbr title="accumulated">acc.</abbr> value of
 *              bought follower shares</mrow>
 *     </math></li>
 *     <li><math mode="display" xmlns="http://www.w3.org/1998/Math/MathML">
 *         <mrow><msub><mi>S</mi><mn>now</mn></msub> = current <abbr title="accumulated">acc.</abbr> value of
 *              sold follower shares</mrow>
 *     </math></li>
 *     <li><math mode="display" xmlns="http://www.w3.org/1998/Math/MathML">
 *         <mrow><msub><mi>S</mi><mn>past</mn></msub> = past <abbr title="accumulated">acc.</abbr> value of
 *              sold follower shares</mrow>
 *     </math></li>
 * </ul>
 * 
 * @typedef module:user~RankingEntry
 * @type object
 * 
 * @property {number} past_totalvalue  The total value of the user at the oldest available data point.
 * @property {number} past_prov_sum    The total sum of provisions for this user at the oldest available data point.
 * @property {number} fperf    The relative performance gained via follower shares in the given time span as given by:
 *                             <math mode="display" xmlns="http://www.w3.org/1998/Math/MathML">
 *                                 <mfrac>
 *                                     <mrow><msub><mi>P</mi><mn>now</mn></msub> +
 *                                           <msub><mi>S</mi><mn>now</mn></msub> -
 *                                           <msub><mi>S</mi><mn>past</mn></msub></mrow>
 *                                     <mrow><msub><mi>B</mi><mn>now</mn></msub> -
 *                                           <msub><mi>B</mi><mn>past</mn></msub> +
 *                                           <msub><mi>P</mi><mn>past</mn></msub></mrow>
 *                                 </mfrac>
 *                             </math>
 * @property {number} fperfval An absolute performance measure as given by:
 *                             <math mode="display" xmlns="http://www.w3.org/1998/Math/MathML">
 *                                 <mfrac>
 *                                     <mrow>(<msub><mi>P</mi><mn>now</mn></msub> +
 *                                            <msub><mi>S</mi><mn>now</mn></msub> -
 *                                            <msub><mi>S</mi><mn>past</mn></msub>) -
 *                                           (<msub><mi>B</mi><mn>now</mn></msub> -
 *                                            <msub><mi>B</mi><mn>past</mn></msub> +
 *                                            <msub><mi>P</mi><mn>past</mn></msub>)</mrow>
 *                                     <mrow>max{70 % · default starting value, past total value}</mrow>
 *                                 </mfrac>
 *                             </math>
 */

/**
 * Lists all users and the information necessary for evaluating and displaying rankings.
 * 
 * It might be helpful to understand that none of the evaluation of ranking information
 * is performed on the server side; It is rather gathered and sent to the client,
 * so that it can create various ranking tables from the raw data for a number of ranking
 * criteria and filters.
 * 
 * For each user, the first value history entries after the starting time and last before
 * the end time will be used to provide the requested data.
 * Since not necessarily <em>all</em> users have been registered during the entire period
 * in between, the ranking does <em>not</em> start and end for all users at the same time.
 * 
 * @param {?int} [query.since=0]  The ranking starting time as a unix timestamp.
 * @param {?int} [query.upto=now]  The ranking end time as a unix timestamp.
 * @param {?string} [query.search]  A string to use for filtering by user names and,
 *                                  if permitted by the them, their real names.
 * @param {?int|string} [query.schoolid]  When given, only return users in the group specified
 *                                        by this id or path.
 * @param {?boolean} [query.includeAll=false]  Whether users should be included that are not
 *                                             considered qualified for ranking entries
 *                                             (e.g. without verified e-mail address).
 * 
 * @return {object} Returns with <code>get-ranking-success</code> or a common error code
 *                  and populates <code>.result</code> with a {@link module:user~RankingEntry[]}
 * 
 * @function c2s~get-ranking
 */
User.prototype.getRanking = buscomponent.provideQT('client-get-ranking', function(query, ctx, cb) {
	var self = this;
	
	query.since = parseInt(query.since) || 0;
	query.upto = parseInt(query.upto) || parseInt(Date.now() / 10000) * 10;
	// upto is rounded so that the SQL query cache will be used more effectively
	
	if (parseInt(query.since) != query.since)
		return cb('format-error');
	
	var likestringWhere = '';
	var likestringUnit = [];
	
	var join = 'FROM users AS u ' +
		'JOIN users_data ON users_data.id = u.id ' +
		'LEFT JOIN schoolmembers AS sm ON u.id = sm.uid ' +
		'LEFT JOIN schools AS c ON sm.schoolid = c.id ' +
		'JOIN (SELECT userid, MIN(time) AS min_t, MAX(time) AS max_t FROM valuehistory ' +
			'WHERE time > ? AND time < ? GROUP BY userid) AS locator_va ON u.id = locator_va.userid ' +
		'JOIN valuehistory AS past_va ON past_va.userid = u.id AND past_va.time = locator_va.min_t ' +
		'JOIN valuehistory AS now_va ON now_va.userid = u.id AND now_va.time = locator_va.max_t ';
			
	if (!query.includeAll)
		likestringWhere += ' AND email_verif != 0 ';

	if (query.search) {
		var likestring = '%' + (String(query.search)).replace(/%/g, '\\%') + '%';
		likestringWhere += 'AND ((u.name LIKE ?) OR (realnamepublish != 0 AND (giv_name LIKE ? OR fam_name LIKE ?))) ';
		likestringUnit.push(likestring, likestring, likestring);
	}
	
	return (query.schoolid ? function(cont) {
		join += 'JOIN schools AS p ON c.path LIKE CONCAT(p.path, "/%") OR p.id = c.id ';
		likestringWhere += 'AND (p.id = ? OR p.path = ?) ';
		likestringUnit.push(String(query.schoolid), String(query.schoolid).toLowerCase());
		
		return self.request({name: 'isSchoolAdmin', ctx: ctx, status: ['xadmin'], schoolid: query.schoolid}, cont);
	} : function(cont) { return cont(ctx.access.has('userdb')); })(function(schoolAdminResult) {
		var fullData = schoolAdminResult.ok;
		
		return ctx.query('SELECT u.id AS uid, u.name AS name, ' +
			'c.path AS schoolpath, c.id AS school, c.name AS schoolname, jointime, pending, ' +
			'tradecount != 0 as hastraded, ' + 
			'now_va.totalvalue AS totalvalue, past_va.totalvalue AS past_totalvalue, ' +
			'now_va.wprov_sum + now_va.lprov_sum AS prov_sum, past_va.wprov_sum + past_va.lprov_sum AS past_prov_sum, ' +
			'((now_va.fperf_cur + now_va.fperf_sold - past_va.fperf_sold) / ' +
				'(now_va.fperf_bought - past_va.fperf_bought + past_va.fperf_cur)) AS fperf, ' +
			'((now_va.fperf_cur + now_va.fperf_sold - past_va.fperf_sold) - ' +
				'(now_va.fperf_bought - past_va.fperf_bought + past_va.fperf_cur))/GREATEST(700000000, past_va.totalvalue) AS fperfval, ' +
			(fullData ? '' : 'IF(realnamepublish != 0,giv_name,NULL) AS ') + ' giv_name, ' +
			(fullData ? '' : 'IF(realnamepublish != 0,fam_name,NULL) AS ') + ' fam_name, ' +
			'(SELECT COALESCE(SUM(xp), 0) FROM achievements WHERE achievements.userid = u.id) AS xp ' +
			join + /* needs query.since and query.upto parameters */
			'WHERE hiddenuser != 1 AND deletiontime IS NULL ' +
			likestringWhere,
			[query.since, query.upto].concat(likestringUnit))
	}).then(function(ranking) {
		return cb('get-ranking-success', {'result': ranking});
	});
});

/**
 * Represents the information publicly available about a single user including some performance data,
 * extending {@link module:user~UserEntryBase}.
 * @typedef module:user~UserEntry
 * @type object
 * 
 * @property {boolean} schoolpending  Alias of what is called <code>pending</code>.
 * @property {boolean} schooljointime  Alias of what is called <code>jointime</code>.
 * @property {boolean} dschoolid  Alias of what is called <code>schoolid</code>.
 * 
 * @property {int} birthday  A user’s birthday as a unix timestamp.
 * @property {string} desc  A user’s self-chosen description text.
 * @property {number} wprovision  The provision for followers to pay when they
 *                                profit from this leader’s gains (in per cent).
 * @property {number} lprovision  The provision for followers to pay when they
 *                                suffer from this leader’s losses (in per cent).
 * @property {int} lstockid  The stock id associated with this user as a leader.
 * @property {?string} profilepic  A reference to a profile image for this user.
 * @property {int} registerevent  The event id of this user’s registration.
 *                                Useful for commenting onto the user’s pinboard.
 * @property {int} registertime  The unix timestamp of this user’s registration.
 * @property {number} dayfperf  Day following performance. See {@link module:user~RankingEntry}.
 * @property {number} dayoperf  Day non-following performance. See {@link module:user~RankingEntry}.
 * @property {number} weekfperf  Week following performance. See {@link module:user~RankingEntry}.
 * @property {number} weekoperf  Week non-following performance. See {@link module:user~RankingEntry}.
 * @property {number} totalfperf  All-time following performance. See {@link module:user~RankingEntry}.
 * @property {number} totaloperf  All-time non-following performance. See {@link module:user~RankingEntry}.
 * @property {number} freemoney  Money currently available to the user.
 * @property {number} prov_sum  Total earns (or losses, if negative) by acting as a leader
 *                              and receiving provision.
 * @property {number} weekstarttotalvalue  Total value at the start of the week.
 * @property {number} daystarttotalvalue   Total value at the start of the day.
 * @property {?int} f_count  Number of current followers.
 * @property {?int} f_amount  Number of shares currently sold followers.
 * @property {Array} schools  All schools of which this user is a member as <code>{path, id, name}</code> objects.
 * 
 * @property {boolean} isSelf  Indicates whether this user object corresponds to the user which requested it.
 */

/**
 * Return all available information on a single user.
 * 
 * @param {string|int} query.lookfor  The user id or name for which data should be returned.
 *                                    As a special value, '$self' can be used to inspect own data.
 * @param {?boolean} query.nohistory  If true, returns only direct user information;
 *                                    Otherwise, all available information.
 * 
 * @return {object} Returns with <code>get-user-info-success</code>, 
 *                  <code>get-user-info-notfound</code> or a common error code
 *                  and populates <code>.result</code> with a {@link module:user~UserEntry},
 *                  <code>.orders</code> with a trade info list,
 *                  <code>.achievements</code> with an achievement info list,
 *                  <code>.values</code> with finance history data (see also {@link s2c~trade}) and
 *                  <code>.pinboard</code> with a {@link Comment[]} array of pinboard entries.
 * 
 * @function c2s~get-user-info
 */
User.prototype.getUserInfo = buscomponent.provideQT('client-get-user-info', function(query, ctx, cb) {
	var self = this;
	
	return self.getServerConfig().then(function(cfg) {
	
	if (query.lookfor == '$self' && ctx.user)
		query.lookfor = ctx.user.id;
	
	var columns = (ctx.access.has('userdb') || query.lookfor == ctx.user.id ? [
		'u.*', 'ud.*', 'uf.*',
	] : [
		'IF(realnamepublish != 0,giv_name,NULL) AS giv_name',
		'IF(realnamepublish != 0,fam_name,NULL) AS fam_name'
	]).concat([
		'u.id AS uid', 'u.name AS name', 'birthday',
		'sm.pending AS schoolpending', 'sm.schoolid AS dschoolid', 'sm.jointime AS schooljointime',
		'`desc`', 'wprovision', 'lprovision', 'uf.totalvalue', 'delayorderhist',
		'lastvalue', 'daystartvalue', 'weekstartvalue', 'stocks.id AS lstockid',
		'url AS profilepic', 'eventid AS registerevent', 'events.time AS registertime',
		'((uf.fperf_cur + uf.fperf_sold -  day_va.fperf_sold) / (uf.fperf_bought -  day_va.fperf_bought +  day_va.fperf_cur)) AS  dayfperf',
		'((uf.operf_cur + uf.operf_sold -  day_va.operf_sold) / (uf.operf_bought -  day_va.operf_bought +  day_va.operf_cur)) AS  dayoperf',
		'((uf.fperf_cur + uf.fperf_sold - week_va.fperf_sold) / (uf.fperf_bought - week_va.fperf_bought + week_va.fperf_cur)) AS weekfperf',
		'((uf.operf_cur + uf.operf_sold - week_va.operf_sold) / (uf.operf_bought - week_va.operf_bought + week_va.operf_cur)) AS weekoperf',
		'(uf.fperf_cur + uf.fperf_sold) / uf.fperf_bought AS totalfperf',
		'(uf.operf_cur + uf.operf_sold) / uf.operf_bought AS totaloperf',
		'freemoney', 'uf.wprov_sum + uf.lprov_sum AS prov_sum',
		'week_va.totalvalue AS weekstarttotalvalue',
		'day_va.totalvalue  AS daystarttotalvalue'
	]).join(', ');
		
	return ctx.query('SELECT ' + columns + ' FROM users AS u ' +
		'JOIN users_finance AS uf ON u.id = uf.id ' +
		'JOIN users_data AS ud ON u.id = ud.id ' +
		'LEFT JOIN valuehistory AS week_va ON week_va.userid = u.id AND week_va.time = (SELECT MIN(time) FROM valuehistory WHERE userid = u.id AND time > ?) ' +
		'LEFT JOIN valuehistory AS day_va  ON day_va.userid  = u.id AND day_va.time  = (SELECT MIN(time) FROM valuehistory WHERE userid = u.id AND time > ?) ' +
		'LEFT JOIN schoolmembers AS sm ON u.id = sm.uid '+
		'LEFT JOIN stocks ON u.id = stocks.leader '+
		'LEFT JOIN httpresources ON httpresources.user = u.id AND httpresources.role = "profile.image" '+
		'LEFT JOIN events ON events.targetid = u.id AND events.type = "user-register" '+
		'WHERE u.id = ? OR u.name = ?', 
		[Date.parse('Sunday').getTime() / 1000, Date.parse('00:00').getTime() / 1000,
			parseInt(query.lookfor) == query.lookfor ? query.lookfor : -1, String(query.lookfor)]);
	}).then(function(users) {
		if (users.length == 0)
			return cb('get-user-info-notfound');
		
		var xuser = users[0];
		xuser.isSelf = (ctx.user && xuser.uid == ctx.user.uid);
		if (xuser.isSelf) 
			xuser.access = ctx.access.toArray();
		
		assert.ok(xuser.registerevent);
		
		delete xuser.pwhash;
		delete xuser.pwsalt;
		
		return ctx.query('SELECT SUM(amount) AS samount, SUM(1) AS sone ' +
			'FROM depot_stocks AS ds WHERE ds.stockid=?', [xuser.lstockid]).then(function(followers) {
			xuser.f_amount = followers[0].samount || 0;
			xuser.f_count = followers[0].sone || 0;
				
			return ctx.query('SELECT p.name, p.path, p.id FROM schools AS c ' +
				'JOIN schools AS p ON c.path LIKE CONCAT(p.path, "/%") OR p.id = c.id ' + 
				'WHERE c.id = ? ORDER BY LENGTH(p.path) ASC', [xuser.dschoolid]);
		}).then(function(schools) {
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
		
			ctx.query('SELECT oh.*, l.name AS leadername FROM orderhistory AS oh ' +
				'LEFT JOIN users AS l ON oh.leader = l.id ' + 
				'WHERE userid = ? AND buytime <= (UNIX_TIMESTAMP() - ?) ' + 
				'ORDER BY buytime DESC',
				[xuser.uid, (!ctx.user || (xuser.delayorderhist && xuser.uid != ctx.user.uid && !ctx.access.has('stocks')))
					? cfg.delayOrderHistTime : 0]).then(function(orders) {
				return ctx.query('SELECT * FROM achievements ' +
					'LEFT JOIN events ON events.type="achievement" AND events.targetid = achid ' +
					'WHERE userid = ?', [xuser.uid]);
			}).then(function(achievements) {
				return ctx.query('SELECT time, totalvalue FROM valuehistory WHERE userid = ?', [xuser.uid]);
			}).then(function(values) {
				return ctx.query('SELECT c.*,u.name AS username,u.id AS uid, url AS profilepic, trustedhtml ' + 
					'FROM ecomments AS c ' + 
					'LEFT JOIN users AS u ON c.commenter = u.id ' + 
					'LEFT JOIN httpresources ON httpresources.user = c.commenter AND httpresources.role = "profile.image" ' + 
					'WHERE c.eventid = ?', [xuser.registerevent]);
			}).then(function(comments) {
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

/**
 * Regularly called function to perform various cleanup and update tasks.
 * 
 * Flushes outdated sessions out of the system and weekly 
 * removes memberless groups that were not created by 
 * administrative users.
 * 
 * @param {Query} query  A query structure, indicating which actions should be performed
 * @param {Query} query.weekly  Clean up schools without members
 * @param {module:qctx~QContext} ctx  A QContext to provide database access.
 * 
 * @function busreq~regularCallbackUser
 */
User.prototype.regularCallback = buscomponent.provide('regularCallbackUser', ['query', 'ctx', 'reply'], function(query, ctx, cb) {
	cb = cb || function() {};
	
	if (ctx.getProperty('readonly'))
		return cb();
	
	return Q.all([
		ctx.query('DELETE FROM sessions WHERE lastusetime + endtimeoffset < UNIX_TIMESTAMP()', []),
		ctx.query('SELECT p.id, p.path, users.access FROM schools AS p ' +
			'JOIN events ON events.type="school-create" AND events.targetid = p.id ' +
			'JOIN users ON users.id = events.srcuser ' +
			'WHERE ' +
			'(SELECT COUNT(uid) FROM schoolmembers WHERE schoolmembers.schoolid = p.id) = 0 AND ' +
			'(SELECT COUNT(*) FROM schools AS c WHERE c.path LIKE CONCAT(p.path, "/%")) = 0', []).then(function(schools) {
			return Q.all(schools.filter(function(school) {
				return !Access.fromJSON(school.access).has('schooldb') &&
					(school.path.replace(/[^\/]/g, '').length == 1 || (query && query.weekly));
			}).map(function(school) {
				return ctx.query('DELETE FROM schools WHERE id = ?', [school.id]);
			})).then(cb);
		})
	]);
});

/**
 * Verify a user’s e-mail address with the key from the confirmation link.
 * 
 * @param {string} query.uid  The assigned user id.
 * @param {string} query.key  The key from the confirmation link.
 * 
 * @return {object} Returns with <code>email-verify-failure</code>,
 *                  <code>email-verify-already-verified</code>,
 *                  or passes on information to {@link c2s~login}.
 * 
 * @noreadonly
 * @function c2s~emailverif
 */
User.prototype.emailVerify = buscomponent.provideWQTX('client-emailverif', function(query, ctx, xdata, cb) {
	var self = this;
	
	var uid = parseInt(query.uid);
	var key = String(query.key);
	
	if (uid != query.uid)
		return cb('format-error');
	
	return ctx.query('SELECT email_verif AS v, 42 AS y, email FROM users WHERE id = ? ' +
	'UNION SELECT COUNT(*) AS v, 41 AS y, "Wulululu" AS email FROM email_verifcodes WHERE userid = ? AND `key` = ?',
		[uid, uid, key], function(res) {
		if (res.length != 2) {
			console.warn('strange email-verif stuff', res);
			return cb('email-verify-failure');
		}
		
		var email = null;
		for (var i = 0; i < res.length; ++i) {
			if (res[i].y == 42) {
				email = res[i].email;
					
				if (res[i].y == 42 && res[i].v != 0) 
					return cb('email-verify-already-verified');
			}
			
			if (res[i].y == 41 && res[i].v < 1 && !ctx.access.has('userdb'))
				return cb('email-verify-failure');
		}
		
		return ctx.query('SELECT COUNT(*) AS c FROM users WHERE email = ? AND email_verif = 1 AND id != ?', [email, uid], function(res) {
			if (res[0].c > 0)
				return cb('email-verify-other-already-verified');
		
			return ctx.query('DELETE FROM email_verifcodes WHERE userid = ?', [uid]).then(function() {
				return ctx.query('UPDATE users SET email_verif = 1 WHERE id = ?', [uid])
			}).then(function() {
				ctx.access.grant('email_verif');
				
				return self.login({
					name: email,
					stayloggedin: true,
				}, new qctx.QContext({access: ctx.access, parentComponent: self}), xdata, true, cb);
			});
		});
	});
});

/**
 * Write session and statistics information to the database.
 * 
 * Sets the session’s last use date to make sure it does not expire.
 * This function usually writes data at most once per minute to 
 * reduce database writes.
 * 
 * @param {module:user~UserEntry} user  The currently active user
 * @param {module:qctx~QContext} ctx  A QContext to provide database access and user information.
 * @param {boolean} force  If true, writes the data even if waiting would have been 
 *                         the normal response.
 * @param {function} cb  Callback that will be called when the cleanup is done.
 * 
 * @function busreq~updateUserStatistics
 */
User.prototype.updateUserStatistics = buscomponent.provide('updateUserStatistics',
	['user', 'ctx', 'force', 'reply'], function(user, ctx, force, reply)
{
	reply = reply || function() {};
	
	if (!user)
		return reply();
	
	var now = Date.now();
	var lastSessionUpdate = ctx.getProperty('lastSessionUpdate');
	
	if (((!lastSessionUpdate || (now - lastSessionUpdate) < 60000) && !force) || ctx.getProperty('readonly') || !user) {
		// don't update things yet
		ctx.setProperty('pendingTicks', ctx.getProperty('pendingTicks') + 1);
	} else {
		ctx.query('UPDATE sessions SET lastusetime = UNIX_TIMESTAMP() WHERE id = ?', [user.sid]);
		ctx.query('UPDATE globalvars SET value = ? + value WHERE name="ticks"', [ctx.getProperty('pendingTicks'), user.id]);
		ctx.setProperty('pendingTicks', 0);
		ctx.setProperty('lastSessionUpdate', now);
	}
	
	return reply();
});

/**
 * Load information on the current user from the database.
 * 
 * This function is usually one of the first ones called on each client query.
 * 
 * @param {string} key  The current session id.
 * @param {module:qctx~QContext} ctx  A QContext to provide database access and user information.
 * @param {function} cb  Callback that will be called with a {module:user~UserEntry} object
 *                       (or null in case of no match or an expired session).
 * 
 * @function busreq~loadSessionUser
 */
User.prototype.loadSessionUser = buscomponent.provide('loadSessionUser', ['key', 'ctx', 'reply'], function(key, ctx, cb) {
	var self = this;
	
	var signedLogin = (key[0] == ':');
	
	return (signedLogin ? function(cont) {
		// was signed login, e. g. during read-only period
		return self.request({
			name: 'verifySignedMessage',
			msg: key.substr(1),
		}, function(msg) {
			var today = parseInt(Date.now() / 86400);
			if (!msg || msg.date <= today - 1) // message at least 24 hours old
				return cb(null);
			
			return cont(msg.uid, msg.sid);
		});
	} : function(cont) {
		return cont(null, key);
	})(function(uid, key) {
		return ctx.query('SELECT users.*, users_finance.*, users_data.*, users.id AS uid, ' +
			(signedLogin ? '' : 'sessions.id AS sid, ') +
			'schools.path AS schoolpath, schools.id AS school, schools.name AS schoolname, jointime, sm.pending AS schoolpending ' +
			'FROM users ' +
			'JOIN users_finance ON users_finance.id = users.id ' +
			'JOIN users_data ON users_data.id = users.id ' +
			(signedLogin ? '' : 'JOIN sessions ON sessions.uid = users.id ') +
			'LEFT JOIN schoolmembers AS sm ON sm.uid = users.id ' +
			'LEFT JOIN schools ON schools.id = sm.schoolid ' +
			'WHERE ' + (signedLogin ? 'uid = ? ' : '`key` = ? ' +
			(ctx.getProperty('readonly') ? '' : 'AND lastusetime + endtimeoffset > UNIX_TIMESTAMP() ')) +
			'LIMIT 1', [signedLogin ? uid : key]).then(function(res) {
			if (res.length == 0) {
				return cb(null);
			} else {
				assert.equal(res.length, 1);
				var user = res[0];
				user.id = user.uid;
				user.realnamepublish = !!user.realnamepublish;
				user.delayorderhist = !!user.delayorderhist;
				
				try {
					user.clientopt = JSON.parse(user.clientopt);
				} catch (e) {
					user.clientopt = {};
				}
				
				if (signedLogin)
					user.sid = key;
				
				self.updateUserStatistics(user, ctx);
				
				return cb(user);
			}
		});
	});
});

/**
 * Sets up a new user.
 * See {@link module:user~User#updateUser} for detailed documentation,
 * including parameters and possible return codes.
 * 
 * @noreadonly
 * @loginignore
 * @function c2s~register
 */
User.prototype.register = buscomponent.provideWQTX('client-register', function(query, ctx, xdata, cb) {
	if (ctx.user !== null)
		return cb('already-logged-in');
	return this.updateUser(query, 'register', ctx, xdata, cb);
});

/**
 * Changes the settings and general information for the current user.
 * See {@link module:user~User#updateUser} for detailed documentation,
 * including parameters and possible return codes.
 * 
 * @noreadonly
 * @function c2s~change-options
 */
User.prototype.changeOptions = buscomponent.provideWQTX('client-change-options', function(query, ctx, xdata, cb) {
	return this.updateUser(query, 'change', ctx, xdata, cb);
});

/**
 * Indicates that a user changed their username
 * 
 * @typedef s2c~user-namechange
 * @type {Event}
 * 
 * @property {string} oldname  The user’s name before the change
 * @property {string} newname  The user’s name after the change
 */

/**
 * Indicates that a user changed their leader provisions
 * 
 * @typedef s2c~user-provchange
 * @type {Event}
 * 
 * @property {int} oldwprov  The user’s gain provision before the change
 * @property {int} newwprov  The user’s gain provision after the change
 * @property {int} oldlprov  The user’s loss provision before the change
 * @property {int} newlprov  The user’s loss provision after the change
 */

/**
 * Indicates that a user changed their description text
 * 
 * @typedef s2c~user-descchange
 * @type {Event}
 */

/**
 * Updates or creates the info for the current user.
 * invoked by registering or changing one’s options.
 * 
 * If necessary (in case of registration or when changing the
 * e-mail address), {@link module:user~User#sendRegisterEmail}
 * will be called and determines the return code of this function.
 * 
 * This method is currently in horrible shape and should be refactored.
 * 
 * @return {object} This method can return with the following codes:
 *                  <ul>
 *                      <li><code>reg-too-short-pw</code></li>
 *                      <li><code>reg-name-invalid-char</code></li>
 *                      <li><code>invalid-provision</code></li>
 *                      <li><code>reg-beta-necessary</code></li>
 *                      <li><code>reg-email-already-present</code></li>
 *                      <li><code>reg-name-already-present</code></li>
 *                      <li><code>reg-success</code></li>
 *                      <li><code>reg-unknown-school</code></li>
 *                      <li>
 *                          <code>reg-email-failed</code> as per 
 *                          {@link module:user~User#sendRegisterEmail}
 *                      </li>
 *                      <li>or a common error code</li>
 *                  </ul>
 * 
 * @noreadonly
 * @function module:user~User#updateUser
 */
User.prototype.updateUser = function(query, type, ctx, xdata, cb) {
	var self = this;
	
	return self.getServerConfig().then(function(cfg) {
		var uid = ctx.user !== null ? ctx.user.id : null;
		if (!query.name || !query.email)
			return cb('format-error');
		
		if ((query.password || type != 'change') && (!query.password || query.password.length < 5))
			return cb('reg-too-short-pw');
		
		query.email = String(query.email);
		query.name = String(query.name);
		if (!/^[^\.,@<>\x00-\x20\x7f!"'\/\\$#()^?&{}]+$/.test(query.name) || parseInt(query.name) == query.name)
			return cb('reg-name-invalid-char');
		
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
		
		return ctx.startTransaction([
			{ name: 'users', mode: 'w', },
			{ name: 'users_finance', mode: 'w', },
			{ name: 'users_data', mode: 'w', },
			{ name: 'stocks', mode: 'w', },
			{ name: 'betakeys', mode: 'w', },
			{ name: 'inviteaccept', mode: 'w', },
			{ name: 'invitelink', mode: 'r', },
			{ name: 'schoolmembers', mode: 'w', },
			{ name: 'schooladmins', mode: 'w', },
			{ name: 'schools', mode: 'w', },
			{ name: 'stocks', alias: 'stocks1', mode: 'r' }, // feed
			{ name: 'events', mode: 'w' }, // feed
			{ name: 'events_users', mode: 'w' }, // feed
			{ name: 'depot_stocks', mode: 'r' }, // feed
			{ name: 'watchlists', mode: 'r' } // feed
		]).then(function(conn) {
			return conn.query('SELECT email,name,id FROM users WHERE (email = ? AND email_verif) OR (name = ?) ORDER BY NOT(id != ?)',
				[query.email, query.name, uid]);
		}).then(function(res) {
			return conn.query('SELECT `key` FROM betakeys WHERE `id` = ?',
				[betakey[0]]);
		}).then(function(βkey) {
			if (cfg.betakeyRequired && (βkey.length == 0 || βkey[0].key != betakey[1]) && 
				type == 'register' && !ctx.access.has('userdb')) {
				return conn.rollback().then(function() {
					return cb('reg-beta-necessary');
				});
			}
			
			if (res.length > 0 && res[0].id !== uid) {
				return conn.rollback().then(function() {
					if (res[0].email.toLowerCase() == query.email.toLowerCase())
						return cb('reg-email-already-present');
					else
						return cb('reg-name-already-present');
				});
			}
			
			(query.school !== null ?
				conn.query('SELECT id FROM schools WHERE ? IN (id, name, path)', [String(query.school)])
				: Q([])).then(function(res) {
				return ((res.length == 0 && query.school !== null) ? function(cont) {
					if (parseInt(query.school) == query.school || !query.school) {
						return conn.rollback().then(function() {
							return cb('reg-unknown-school');
						});
					}
					
					return conn.query('INSERT INTO schools (name, path) VALUES(?, CONCAT("/",LOWER(MD5(?))))',
						[String(query.school), String(query.school)], cont);
				} : function() {
					if (query.school !== null) {
						assert.ok(parseInt(query.school) != query.school || query.school == res[0].id);
						query.school = res[0].id;
					}
					
					return cont([]);
				})(function(res) {
					var gainUIDCBs = [];
					
					if (res && res.insertId) {
						// in case school was created
						
						query.school = res.insertId;
						
						gainUIDCBs.push(function() {
							assert.ok(uid != null);
							
							return ctx.feed({'type': 'school-create', 'targetid': res.insertId, 'srcuser': uid});
						});
					}
					
					var updateCB = function(res) {
						if (uid === null)
							uid = res.insertId;
						
						assert.ok(uid != null);
						
						return Q.all(gainUIDCBs).then(function() {
							return conn.commit();
						}).then(function() {
							if ((ctx.user && query.email == ctx.user.email) || (ctx.access.has('userdb') && query.nomail))
								return cb('reg-success', {uid: uid}, 'repush');
							else
								return self.sendRegisterEmail(query,
									new qctx.QContext({user: {id: uid, uid: uid}, access: ctx.access,
										parentComponent: self}),
									xdata,
									cb);
						});
					};
					
					(query.password ? self.generatePWKey(query.password) :
						Q({salt: ctx.user.pwsalt, hash: ctx.user.pwhash}))
						.then(ctx.errorWrap(function(pwdata) {
						if (type == 'change') {
							return conn.query('UPDATE users SET name = ?, pwhash = ?, pwsalt = ?, email = ?, email_verif = ?, ' +
								'delayorderhist = ?, skipwalkthrough = ? WHERE id = ?',
								[String(query.name), pwdata.hash, pwdata.salt,
								String(query.email), query.email == ctx.user.email ? 1 : 0, 
								query.delayorderhist ? 1:0, query.skipwalkthrough ? 1:0, uid]).then(function() {
							return conn.query('UPDATE users_data SET giv_name = ?, fam_name = ?, realnamepublish = ?, ' +
								'birthday = ?, `desc` = ?, street = ?, zipcode = ?, town = ?, traditye = ?, ' +
								'clientopt = ?, dla_optin = ? WHERE id = ?',
								[String(query.giv_name), String(query.fam_name), query.realnamepublish?1:0,
								query.birthday, String(query.desc), String(query.street),
								String(query.zipcode), String(query.town), JSON.stringify(query.clientopt || {}),
								query.traditye?1:0, query.dla_optin?1:0, uid]);
							}).then(function() {
							return conn.query('UPDATE users_finance SET wprovision = ?, lprovision = ? WHERE id = ?',
								[query.wprovision, query.lprovision, uid]);
							}).then(updateCB)
							.then(function() {
							if (query.school != ctx.user.school) {
								if (query.school == null)
									return conn.query('DELETE FROM schoolmembers WHERE uid = ?', [uid]);
								else
									return conn.query('REPLACE INTO schoolmembers (uid, schoolid, pending, jointime) '+
										'VALUES(?, ?, ' + (ctx.access.has('schooldb') ? '0' :
											'((SELECT COUNT(*) FROM schooladmins WHERE schoolid = ? AND status="admin") > 0)') + ', UNIX_TIMESTAMP())',
										[uid, String(query.school), String(query.school)]);
								
								if (ctx.user.school != null) 
									return conn.query('DELETE FROM schooladmins WHERE uid = ? AND schoolid = ?', [uid, ctx.user.school]);
							}
							}).then(function() {
							if (query.name != ctx.user.name) {
								return ctx.feed({
									'type': 'user-namechange',
									'targetid': uid,
									'srcuser': uid,
									'json': {'oldname': ctx.user.name, 'newname': query.name},
									'conn': conn
								}).then(function() {
									conn.query('UPDATE stocks SET name = ? WHERE leader = ?', ['Leader: ' + query.name, uid]);
								});
							}
							}).then(function() {
							if (query.wprovision != ctx.user.wprovision || query.lprovision != ctx.user.lprovision)
								return ctx.feed({'type': 'user-provchange', 'targetid': uid, 'srcuser': uid, json:
									{'oldwprov': ctx.user.wprovision, 'newwprov': query.wprovision,
									 'oldlprov': ctx.user.lprovision, 'newlprov': query.lprovision}, 'conn': conn});
							}).then(function() {
							if (query.desc != ctx.user.desc)
								return ctx.feed({'type': 'user-descchange', 'targetid': uid, 'srcuser': uid, 'conn': conn});
							});
						} else {
							var inv = {};
							(query.betakey ?
								conn.query('DELETE FROM betakeys WHERE id = ?', [betakey[0]]) :
								Q(null)).then(function() {
							if (!query.invitekey)
								return;
							
							return conn.query('SELECT * FROM invitelink WHERE `key` = ?', [String(query.invitekey)]).then(function() {
								if (invres.length == 0)
									return;
								
								assert.equal(invres.length, 1);
								
								inv = invres[0];
								if (inv.schoolid && !query.school || parseInt(query.school) == parseInt(inv.schoolid)) {
									query.school = inv.schoolid;
									inv.__schoolverif__ = 1;
								}
								
								gainUIDCBs.push(function() {
									return ctx.query('INSERT INTO inviteaccept (iid, uid, accepttime) VALUES(?, ?, UNIX_TIMESTAMP())', [inv.id, uid]);
								});
							});
							}).then(function() {
								return conn.query('INSERT INTO users ' +
									'(name, delayorderhist, pwhash, pwsalt, email, email_verif, registertime)' +
									'VALUES (?, ?, ?, ?, ?, ?, UNIX_TIMESTAMP())',
									[String(query.name), query.delayorderhist?1:0, pwdata.hash, pwdata.salt,
									String(query.email), (inv.email && inv.email == query.email) ? 1 : 0]);
							}).then(function(res) {
								uid = res.insertId;
								return conn.query('INSERT INTO users_data (id, giv_name, fam_name, realnamepublish, traditye, ' +
									'street, zipcode, town) VALUES (?, ?, ?, ?, ?, ?, ?, ?); ' +
									'INSERT INTO users_finance(id, wprovision, lprovision, freemoney, totalvalue) '+
									'VALUES (?, ?, ?, ?, ?)',
									[uid, String(query.giv_name), String(query.fam_name), query.realnamepublish?1:0,
									query.traditye?1:0, String(query.street), String(query.zipcode), String(query.town),
									uid, cfg.defaultWProvision, cfg.defaultLProvision,
									cfg.defaultStartingMoney, cfg.defaultStartingMoney]);
							}).then(function() {
								return ctx.feed({'type': 'user-register', 'targetid': uid, 'srcuser': uid, 'conn': conn});
							}).then(function() {
								return conn.query('INSERT INTO stocks (stockid, leader, name, exchange, pieces) VALUES(?, ?, ?, ?, 100000000)',
									['__LEADER_' + uid + '__', uid, 'Leader: ' + query.name, 'tradity']);
							}).then(_.bind(updateCB, self, res)).then(function() {
								if (query.school) {
									return conn.query('INSERT INTO schoolmembers (uid, schoolid, pending, jointime) ' +
										'VALUES(?, ?, ' + 
										(inv.__schoolverif__ ? '1' : '((SELECT COUNT(*) FROM schooladmins WHERE schoolid = ? AND status="admin") > 0) ') +
										', UNIX_TIMESTAMP())',
										[uid, String(query.school), String(query.school)]);
								}
							});
						}
					}));
				});
			});
		
		});
	});
};

/**
 * Resets the current user financially into their initial state.
 * This is only available for users with appropiate privileges
 * or when resets are allowed (config option <code>.resetAllowed</code>)
 * 
 * @return {object}  Returns with <code>reset-user-success</code> or
 *                   a common error code.
 * 
 * @noreadonly
 * @function c2s~reset-user
 */
User.prototype.resetUser = buscomponent.provideWQT('client-reset-user', function(query, ctx, cb) {
	var self = this;
	
	self.getServerConfig().then(function(cfg) {
		if (!cfg.resetAllowed && !ctx.access.has('userdb'))
			return cb('permission-denied');
		
		assert.ok(ctx.user);
		assert.ok(ctx.access);
		
		return ctx.query('DELETE FROM depot_stocks WHERE userid = ?', [ctx.user.uid]).then(function() {
			return ctx.query('UPDATE users_finance SET freemoney = ?, totalvalue = ?, ' +
				'fperf_bought = 0, fperf_cur = 0, fperf_sold = 0, ' + 
				'operf_bought = 0, operf_cur = 0, operf_sold = 0, ' + 
				'wprov_sum = 0, lprov_sum = 0 ' + 
				'WHERE id = ?', [cfg.defaultStartingMoney, cfg.defaultStartingMoney, ctx.user.uid]);
		}).then(function() {
			return self.request({name: 'sellAll', query: query, ctx: ctx});
		}).then(function() {
			var val = cfg.defaultStartingMoney / 1000;
			return ctx.query('UPDATE stocks SET lastvalue = ?, ask = ?, bid = ?, ' +
					'daystartvalue = ?, weekstartvalue = ?, lastchecktime = UNIX_TIMESTAMP() WHERE leader = ?',
					[val, val, val, val, val, ctx.user.uid]);
		}).then(function() {
			return ctx.query('DELETE FROM valuehistory WHERE userid = ?', [ctx.user.uid]);
		}).then(function() {
			return ctx.feed({'type': 'user-reset', 'targetid': ctx.user.uid, 'srcuser': ctx.user.uid});
		}).then(function() {
			return self.request({name: 'dqueriesResetUser', ctx: ctx});
		}).then(function() {
			return cb('reset-user-success');
		});
	});
});

/**
 * Resets the current user’s password.
 * Currently, a new password is mailed to the user; This will change
 * due to #268 into sending a link to a password reset page.
 * 
 * @return {object}  Returns with <code>password-reset-success</code>, 
 *                   <code>password-reset-notfound</code>, or
 *                   a common error code.
 * 
 * @loginignore
 * @noreadonly
 * @function c2s~password-reset
 */
User.prototype.passwordReset = buscomponent.provideWQT('client-password-reset', function(query, ctx, cb) {
	var self = this;
	
	if (ctx.user)
		return cb('already-logged-in');
	
	var name = String(query.name);
	
	return ctx.query('SELECT id, email FROM users WHERE name = ? OR email = ? AND deletiontime IS NULL LIMIT 1',
		[name, name]).then(function(res) {
		if (res.length == 0)
			return cb('password-reset-notfound');
		
		var u = res[0];
		assert.ok(u);
		
		return Q.nfcall(crypto.randomBytes, 6).then(ctx.errorWrap(function(buf) {
			var pw = buf.toString('hex');
			return self.generatePWKey(pw);
		}).then(ctx.errorWrap(function(pwdata) {
			return ctx.query('UPDATE users SET pwsalt = ?, pwhash = ? WHERE id = ?', [pwdata.salt, pwdata.hash, u.id]);
		})).then(function() {
			return self.request({name: 'sendTemplateMail', 
				template: 'password-reset-email.eml',
				ctx: ctx,
				variables: {'password': pw, 'username': query.name, 'email': u.email},
			});
		}).then(function() {
			return cb('password-reset-success');
		});
	});
});

/**
 * Returns basic information on an invitation key.
 * 
 * @return {object}  Returns with <code>get-invitekey-info-notfound</code>
 *                   or <code>get-invitekey-info-success</code> and, in the
 *                   latter case, sets <code>.result.email</code> and 
 *                   <code>.result.schoolid</code> appropiately.
 * 
 * @function c2s~get-invitekey-info
 */
User.prototype.getInviteKeyInfo = buscomponent.provideQT('client-get-invitekey-info', function(query, ctx, cb) {
	var self = this;
	
	return ctx.query('SELECT email, schoolid FROM invitelink WHERE `key` = ?', [String(query.invitekey)]).then(function(res) {
		if (res.length == 0) {
			return cb('get-invitekey-info-notfound');
		}
	
		return self.getServerConfig().then(function(cfg) {
			assert.equal(res.length, 1);
			
			res[0].url = cfg.inviteurl.replace(/\{\$key\}/g, query.invitekey).replace(/\{\$hostname\}/g, cfg.hostname);
			
			return cb('get-invitekey-info-success', {result: res[0]});
		});
	});
});

/**
 * See {@link c2s~create-invite-link} for specifications.
 * 
 * @noreadonly
 * @function busreq~createInviteLink
 */
User.prototype.createInviteLink = buscomponent.provideWQT('createInviteLink', function(query, ctx, cb) {
	var self = this;
	ctx = ctx.clone(); // so we can’t lose the user object during execution
	
	return self.getServerConfig().then(function(cfg) {
		query.email = query.email ? String(query.email) : null;
		
		if (!ctx.access.has('userdb')) {
			if (query.email && !/([\w_+.-]+)@([\w.-]+)$/.test(query.email))
				return cb('create-invite-link-invalid-email');
			
			if (!ctx.access.has('email_verif'))
				return cb('create-invite-link-not-verif');
		}
		
		return Q.nfcall(crypto.randomBytes, 16).then(ctx.errorWrap(function(buf) {
			var key = buf.toString('hex');
			var sendKeyToCaller = ctx.access.has('userdb');
			return ctx.query('INSERT INTO invitelink ' +
				'(uid, `key`, email, ctime, schoolid) VALUES ' +
				'(?, ?, ?, UNIX_TIMESTAMP(), ?)', 
				[ctx.user.id, key, query.email, query.schoolid ? parseInt(query.schoolid) : null])).then(function() {
			var url = cfg.inviteurl.replace(/\{\$key\}/g, key).replace(/\{\$hostname\}/g, cfg.hostname);
		
			return (query.email ? function() {
				return self.sendInviteEmail({
					sender: ctx.user,
					email: query.email,
					url: url
				}, ctx);
			} : function() {
				sendKeyToCaller = true;
				return Q('create-invite-link-success');
			}).then(function(status) {
				return cb(status, sendKeyToCaller ? {'url': url, 'key': key} : null);
			});
		});
	});
});

exports.User = User;

})();
