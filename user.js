// Tradity.de Server
// Copyright (C) 2016 Tradity.de Tech Team <tech@tradity.de>

// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version. 

// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.

// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <http://www.gnu.org/licenses/>.

"use strict";

const _ = require('lodash');
const crypto = require('crypto');
const assert = require('assert');
const validator = require('validator');
const genders = require('genders');
const LoginIPCheck = require('./lib/loginIPCheck.js');
const sha256 = require('./lib/sha256.js');
const Cache = require('./lib/minicache.js').Cache;
const buscomponent = require('./stbuscomponent.js');
const Access = require('./access.js').Access;
const qctx = require('./qctx.js');
const debug = require('debug')('sotrade:user');
const promiseUtil = require('./lib/promise-util.js');
const spread = promiseUtil.spread;
require('datejs');

const randomBytes = promiseUtil.ncall(crypto.randomBytes);
const pseudoRandomBytes = promiseUtil.ncall(crypto.pseudoRandomBytes);
const pbkdf2 = promiseUtil.ncall(crypto.pbkdf2);

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
class User extends buscomponent.BusComponent {
  constructor() {
    super();
    
    this.cache = new Cache();
    
    this.loginIPCheck = null;
    this.getLoginIPCheck = function() {
      if (this.loginIPCheck) {
        return Promise.resolve(this.loginIPCheck);
      }
      
      return this.loginIPCheck = this.getServerConfig().then(cfg => {
        return new LoginIPCheck(cfg.login);
      });
    };
  }
}

/**
 * Generates a password hash and salt combination.
 * 
 * @param {string} pw  The password string to generate a salt+hash for.
 * 
 * @return {object}  A Promise for an object of the form { salt: …, hash: …, algorithm: … }
 * @function module:user~User#generatePWKey
 */
User.prototype.generatePWKey = function(pw) {
  let pwsalt, iterations;
  
  return randomBytes(32).then(pwsalt_ => {
    pwsalt = pwsalt_;
    
    return this.getServerConfig();
  }).then(cfg => {
    iterations = cfg.passwords.pbkdf2Iterations;
    assert.strictEqual(iterations, parseInt(iterations));
    assert.ok(iterations >= cfg.passwords.pbkdf2MinIterations);
    
    return pbkdf2(String(pw), pwsalt, 1 << iterations, 64);
  }).then(pwhash => {
    return {salt: pwsalt, hash: pwhash, algorithm: 'PBKDF2|' + iterations};
  });
};

/**
 * Writes a new hash/salt combination into the database.
 * 
 * @param {string} pw  The password string to generate a salt+hash for.
 * @param {string} timeName  Either <code>'changetime'</code> or <code>'issuetime'</code>,
 *                           depending on password type
 * @param {int} uid  The numerical user id for this password.
 * @param {object} conn  A connection to access the database with.
 * 
 * @return {object}  A Promise for having saved the password.
 * @function module:user~User#generatePassword
 */
User.prototype.generatePassword = function(pw, timeName, uid, conn) {
  assert.ok(['changetime', 'issuetime'].indexOf(timeName) >= 0);
  
  debug('Generate password', timeName, uid);
  
  return this.generatePWKey(pw).then(pwdata => {
    return conn.query('INSERT INTO passwords (pwsalt, pwhash, algorithm, uid, ' + timeName + ') ' +
      'VALUES(?, ?, ?, ?, UNIX_TIMESTAMP())',
      [pwdata.salt, pwdata.hash, pwdata.algorithm, uid]);
  });
};

/**
 * Verifies a password hash and salt combination.
 * 
 * @param {object} pwdata  The pwsalt, pwhash, algorithm tuple to be checked against
 * @param {string} pw  The password to be checked
 * 
 * @return {object}  A Promise for a boolean indicating success
 * @function module:user~User#verifyPassword
 */
User.prototype.verifyPassword = function(pwdata, pw) {
  debug('Verify password', pwdata.algorithm);
  
  if (pwdata.algorithm === 'SHA256') {
    return Promise.resolve(pwdata.pwhash !== sha256(pwdata.pwsalt + pw));
  }
  
  const pbkdf2Match = pwdata.algorithm.match(/^PBKDF2\|(\d+)$/);
  if (pbkdf2Match) {
    const iterations = parseInt(pbkdf2Match[1]);
    
    return this.getServerConfig().then(cfg => {
      if (iterations < cfg.passwords.pbkdf2MinIterations) {
        return false;
      }
      
      return pbkdf2(String(pw), pwdata.pwsalt, 1 << iterations, 64).then(pwhash => {
        return pwhash.toString('hex') === pwdata.pwhash.toString('hex');
      });
    });
  }
  
  console.warn('Unknown password hashing algorithm:', pwdata.algorithm);
  return Promise.resolve(false);
};

User.deprecatedPasswordAlgorithms = /^SHA256$/i;

/**
 * Sends an invite e-mail to a user.
 * 
 * @param {object} data  General information on sender and receiver of the e-mail.
 * @param {string} data.sender.name  The username of the sender.
 * @param {string} data.sender.email  The e-mail address of the sender.
 * @param {string} data.email  The e-mail adress of the receiver.
 * @param {string} data.url  The URL of the invite link.
 * @param {module:qctx~QContext} ctx  A QContext to provide database access.
 * 
 * @return  Returns with <code>create-invite-link-success</code>.
 * 
 * @function module:user~User#sendInviteEmail
 */
User.prototype.sendInviteEmail = function(data, ctx) {
  debug('Send invite email', data.email, data.url, ctx.user && ctx.user.uid);
  return this.request({name: 'sendTemplateMail',
    template: 'invite-email.eml',
    ctx: ctx,
    variables: {'sendername': data.sender.name, 'sendermail': data.sender.email, 'email': data.email, 'url': data.url}
  }).then(() => ({ code: 'create-invite-link-success' }));
};

/**
 * Sends the registation e-mail to a new user or after an e-mail address change.
 * 
 * @param {object} data  General information on the receiver of the email.
 * @param {string} data.name  The username of the receiver.
 * @param {string} data.email  The e-mail adress of the receiver.
 * @param {string} data.url  The URL of the e-mail address confirmation link.
 *
 * @return  Returns with <code>reg-success</code>.
 * 
 * @function module:user~User#sendRegisterEmail
 */
User.prototype.sendRegisterEmail = function(data, ctx, xdata) {
  ctx.access.drop('email_verif');
  
  debug('Prepare register email', data.email);
  
  let loginResp, key;
  return this.login({
    name: data.email,
    stayloggedin: true,
  }, ctx, xdata, true, true).then(loginResp_ => {
    loginResp = loginResp_;
    assert.equal(loginResp.code, 'login-success');
    
    return randomBytes(16);
  }).then(buf => {
    key = buf.toString('hex');
    
    return ctx.query('INSERT INTO email_verifcodes (`uid`, `time`, `key`) VALUES(?, UNIX_TIMESTAMP(), ?)', 
      [ctx.user.uid, key]);
  }).then(() => {
    return this.getServerConfig();
  }).then(cfg => {
    const url = cfg.varReplace(cfg.regurl
      .replace(/\{\$key\}/g, key)
      .replace(/\{\$uid\}/g, ctx.user.uid));
    
    debug('Send register email', data.email, data.lang, data.name, ctx.user.uid);
    return this.request({name: 'sendTemplateMail', 
      template: 'register-email.eml',
      ctx: ctx,
      lang: data.lang,
      variables: {'url': url, 'username': data.name, 'email': data.email}
    });
  }).then(() => {
    loginResp.code = 'reg-success';
    return loginResp;
  });
};

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
  ['query', 'ctx', 'xdata', 'useTransaction', 'ignorePassword'], function(query, ctx, xdata, useTransaction, ignorePassword) {
  const name = String(query.name);
  const pw = String(query.pw);
  let key, uid;
  
  debug('Login', xdata.remoteip, name, useTransaction, ignorePassword);
  
  return Promise.resolve()/*this.getLoginIPCheck().then(check => {
    return check.check(xdata.remoteip);
  })*/.then(() => {
    const query = 'SELECT passwords.*, users.email_verif ' +
      'FROM passwords ' +
      'JOIN users ON users.uid = passwords.uid ' +
      'WHERE (email = ? OR name = ?) AND deletiontime IS NULL ' +
      'ORDER BY email_verif DESC, users.uid DESC, changetime DESC FOR UPDATE';

    if (ctx.getProperty('readonly') || !useTransaction) {
      return ctx.query(query, [name, name]);
    }
    
    return ctx.startTransaction().then(conn => {
      return conn.query(query, [name, name]).then(conn.commit, conn.rollbackAndThrow);
    });
  }).then(res => {
    if (res.length === 0) {
      if (!useTransaction) {
        return this.login(query, ctx, xdata, true, ignorePassword);
      }
      
      throw new this.SoTradeClientError('login-badname');
    }
    
    /* if there is an user with a verified e-mail address
     * do not allow other users with the same e-mail address to log in */
    const haveVerifiedEMail = _.some(_.map(res, 'email_verif'));
    
    return res.map(r => {
      return (foundUser => {
        if (foundUser !== null) {
          return foundUser; // already found user id -> ok!
        }
        
        if (haveVerifiedEMail && !r.email_verif) {
          return null;
        }
        
        if (ignorePassword) {
          return r;
        }
        
        return this.verifyPassword(r, pw).then(passwordOkay => {
          return passwordOkay ? r : null;
        });
      });
    }).reduce((a,b) => Promise.resolve(a).then(b), Promise.resolve(null));
  }).then(r => {
    if (r === null) {
      if (!useTransaction) {
        return this.login(query, ctx, xdata, true, ignorePassword);
      }
      
      throw new this.SoTradeClientError('login-wrongpw');
    }
    
    uid = r.uid;
    assert.equal(parseInt(r.pwid), r.pwid);
    assert.equal(parseInt(uid), uid);
    
    if (ctx.getProperty('readonly')) {
      return;
    }
    
    debug('Update passwords', xdata.remoteip, name, uid, r.pwid);
    return Promise.all([
      ctx.query('DELETE FROM passwords WHERE pwid != ? AND uid = ?', [r.pwid, uid]),
      r.issuetime !== null ? ctx.query('UPDATE passwords SET changetime = UNIX_TIMESTAMP() WHERE pwid = ?', [r.pwid]) : Promise.resolve(),
      User.deprecatedPasswordAlgorithms.test(r.algorithm) ? this.generatePassword(pw, 'changetime', uid, ctx) : Promise.resolve()
    ]);
  }).then(() => {
    return randomBytes(16);
  }).then(buf => {
    key = buf.toString('hex');
    return this.getServerConfig();
  }).then(cfg => {
    const today = parseInt(Date.now() / 86400);
    if (ctx.getProperty('readonly')) {
      key = key.substr(0, 6);
      
      debug('Sign session key', xdata.remoteip, name, uid, today);
      
      let ret;
      return this.request({
        name: 'createSignedMessage',
        msg: {
          uid: uid,
          sid: key,
          date: today
        }
      }).then(sid => {
        ret = { code: 'login-success',
          key: ':' + sid,
          uid: uid,
          extra: 'repush' };
        
        return ret;
      });
    } else {
      return this.regularCallback({}, ctx).then(function() {
        return ctx.startTransaction();
      }).then(conn => {
        debug('Add session to table', xdata.remoteip, name, uid, today);
        
        return conn.query('INSERT INTO sessions(uid, `key`, logintime, lastusetime, endtimeoffset)' +
          'VALUES(?, ?, UNIX_TIMESTAMP(), UNIX_TIMESTAMP(), ?)',
          [uid, key, query.stayloggedin ? cfg.stayloggedinTime : cfg.normalLoginTime])
          .then(conn.commit, conn.rollbackAndThrow);
      }).then(() => {
        return { code: 'login-success', key: key, uid: uid, extra: 'repush' };
      });
    }
  });
});

/**
 * Logs a user out of their account.
 * 
 * @return {object} Returns with <code>logout-success</code> or a common error code.
 * 
 * @function c2s~logout
 */
User.prototype.logout = buscomponent.provideWQT('client-logout', function(query, ctx) {
  debug('Logout', query.key);
  
  return ctx.query('DELETE FROM sessions WHERE `key` = ?', [String(query.key)]).then(() => {
    return { code: 'logout-success' };
  });
});

/**
 * Represents the information publicly available about a single user.
 * @typedef module:user~UserEntryBase
 * @type object
 * 
 * @property {int} uid  Often aliased to <code>id</code>, this is the user’s numerical id.
 *                      Use of the attribute <code>id</code> is deprecated, though, and it
 *                      will be removed at some point in the future.
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
 * @param {?string} [query.search]  A string to use for filtering by user names and
 *                                  their real names (if permitted by them).
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
User.prototype.getRanking = buscomponent.provideQT('client-get-ranking', function(query, ctx) {
  let likestringWhere = '';
  let likestringUnit = [];
  let cacheKey;
  
  let join = 'FROM users AS u ' +
    'JOIN users_data ON users_data.uid = u.uid ' +
    'LEFT JOIN schoolmembers AS sm ON u.uid = sm.uid ' +
    'LEFT JOIN schools AS c ON sm.schoolid = c.schoolid ' +
    'JOIN (SELECT uid, MIN(time) AS min_t, MAX(time) AS max_t FROM valuehistory ' +
      'WHERE time > ? AND time < ? GROUP BY uid) AS locator_va ON u.uid = locator_va.uid ' +
    'JOIN valuehistory AS past_va ON past_va.uid = u.uid AND past_va.time = locator_va.min_t ' +
    'JOIN valuehistory AS now_va  ON  now_va.uid = u.uid AND  now_va.time = locator_va.max_t ';
  
  if (!query.includeAll) {
    likestringWhere += ' AND email_verif != 0 ';
  }

  if (query.search) {
    const likestring = '%' + (String(query.search)).replace(/%/g, '\\%') + '%';
    likestringWhere += 'AND ((u.name LIKE ?) OR (realnamepublish != 0 AND (giv_name LIKE ? OR fam_name LIKE ?))) ';
    likestringUnit.push(likestring, likestring, likestring);
  }
  
  return Promise.resolve().then(() => {
    if (!query.schoolid) {
      return ctx.access.has('userdb');
    }
    
    join += 'JOIN schools AS p ON c.path LIKE CONCAT(p.path, "/%") OR p.schoolid = c.schoolid ';
    likestringWhere += 'AND (p.schoolid = ? OR p.path = ?) ';
    likestringUnit.push(String(query.schoolid), String(query.schoolid).toLowerCase());
    
    return this.request({name: 'isSchoolAdmin', ctx: ctx, status: ['xadmin'], schoolid: query.schoolid})
      .then(ISAResult => {
      assert.equal(typeof ISAResult.ok, 'boolean');
      
      return ISAResult.ok;
    });
  }).then(schoolAdminResult => {
    const fullData = schoolAdminResult.ok;
    
    query.since = parseInt(query.since) || 0;
    query.upto = parseInt(query.upto) || 'now';
    const now = Date.now();
    
    cacheKey = JSON.stringify(['ranking', query.since, query.upto, query.search, query.schoolid, query.includeAll, fullData]);
    if (this.cache.has(cacheKey)) {
      return this.cache.use(cacheKey);
    }
    
    if (query.upto === 'now') {
      // upto is rounded so that the SQL query cache will be used more effectively
      query.upto = parseInt(now / 20000) * 20;
    }
    
    return this.cache.add(cacheKey, 30000, ctx.query('SELECT u.uid AS uid, u.name AS name, ' +
      'c.path AS schoolpath, c.schoolid AS school, c.name AS schoolname, jointime, pending, ' +
      'tradecount != 0 as hastraded, ' + 
      'now_va.totalvalue AS totalvalue, past_va.totalvalue AS past_totalvalue, ' +
      'now_va.wprov_sum + now_va.lprov_sum AS prov_sum, past_va.wprov_sum + past_va.lprov_sum AS past_prov_sum, ' +
      '((now_va.fperf_cur + now_va.fperf_sold - past_va.fperf_sold) / ' +
        '(now_va.fperf_bought - past_va.fperf_bought + past_va.fperf_cur)) AS fperf, ' +
      '((now_va.fperf_cur + now_va.fperf_sold - past_va.fperf_sold) - ' +
        '(now_va.fperf_bought - past_va.fperf_bought + past_va.fperf_cur))/GREATEST(700000000, past_va.totalvalue) AS fperfval, ' +
      (fullData ? '' : 'IF(realnamepublish != 0,giv_name,NULL) AS ') + ' giv_name, ' +
      (fullData ? '' : 'IF(realnamepublish != 0,fam_name,NULL) AS ') + ' fam_name, ' +
      '(SELECT COALESCE(SUM(xp), 0) FROM achievements WHERE achievements.uid = u.uid) AS xp ' +
      join + /* needs query.since and query.upto parameters */
      'WHERE hiddenuser != 1 AND deletiontime IS NULL ' +
      likestringWhere,
      [query.since, query.upto].concat(likestringUnit)));
  }).then(ranking => {
    return {
      code: 'get-ranking-success',
      result: ranking,
      cc__: {
        fields: ['result'],
        validity: 30000,
        key: cacheKey,
        cache: this.cache
      }
    };
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
User.prototype.getUserInfo = buscomponent.provideQT('client-get-user-info', function(query, ctx) {
  let cfg, xuser;
  
  let resultCacheKey = '';
  const cacheable = !(ctx.access.has('caching') && query.noCache);
  
  query.nohistory = !!query.nohistory;
  
  return this.getServerConfig().then(cfg_ => {
    cfg = cfg_;
  
    if (query.lookfor === '$self' && ctx.user) {
      query.lookfor = ctx.user.uid;
    }
    
    const columns = (ctx.access.has('userdb') || query.lookfor === ctx.user.uid ? [
      'u.*', 'ud.*', 'uf.*',
    ] : [
      'IF(realnamepublish != 0,giv_name,NULL) AS giv_name',
      'IF(realnamepublish != 0,fam_name,NULL) AS fam_name'
    ]).concat([
      'u.uid AS uid', 'u.name AS name', 'birthday',
      'sm.pending AS schoolpending', 'sm.schoolid AS dschoolid', 'sm.jointime AS schooljointime',
      '`desc`', 'wprovision', 'lprovision', 'uf.totalvalue', 'delayorderhist',
      'lastvalue', 'daystartvalue', 'weekstartvalue', 'stocks.stockid AS lstockid',
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
    
    let lookfor = parseInt(query.lookfor), lookforColumn;
    if (lookfor === lookfor) {
      lookforColumn = 'uid';
    } else {
      lookfor = String(query.lookfor);
      lookforColumn = 'name';
    }
    
    resultCacheKey += 'get-user-info-result:' + columns.length;
    const cacheKey = 'get-user-info1:' + columns.length + ':' + lookforColumn + '=' + lookfor;
    if (this.cache.has(cacheKey) && cacheable) {
      return this.cache.use(cacheKey);
    }
    
    return this.cache.add(cacheKey, 60000, ctx.query('SELECT ' + columns + ' FROM users AS u ' +
      'JOIN users_finance AS uf ON u.uid = uf.uid ' +
      'JOIN users_data AS ud ON u.uid = ud.uid ' +
      'LEFT JOIN valuehistory AS week_va ON week_va.uid = u.uid AND week_va.time = ' +
        '(SELECT MIN(time) FROM valuehistory WHERE uid = u.uid AND time > ?) ' +
      'LEFT JOIN valuehistory AS day_va  ON day_va.uid  = u.uid AND day_va.time =  ' +
        '(SELECT MIN(time) FROM valuehistory WHERE uid = u.uid AND time > ?) ' +
      'LEFT JOIN schoolmembers AS sm ON u.uid = sm.uid ' +
      'LEFT JOIN stocks ON u.uid = stocks.leader ' +
      'LEFT JOIN httpresources ON httpresources.uid = u.uid AND httpresources.role = "profile.image" ' +
      'LEFT JOIN events ON events.targetid = u.uid AND events.type = "user-register" ' +
      'WHERE u.' + lookforColumn + ' = ?',
      [Date.parse('Sunday').getTime() / 1000, Date.parse('00:00').getTime() / 1000, lookfor]));
  }).then(users => {
    if (users.length === 0) {
      throw new this.SoTradeClientError('get-user-info-notfound');
    }
    
    xuser = users[0];
    xuser.id = xuser.uid; // backwards compatibility
    xuser.isSelf = (ctx.user && xuser.uid === ctx.user.uid);
    if (xuser.isSelf) {
      xuser.access = ctx.access.toArray();
    }
    
    assert.ok(xuser.registerevent);
    
    delete xuser.pwhash;
    delete xuser.pwsalt;
  }).then(() => {
    const cacheKey2 = 'get-user-info2:' + xuser.lstockid + ':' + xuser.dschoolid;
    if (this.cache.has(cacheKey2) && cacheable) {
      return this.cache.use(cacheKey2);
    }
    
    return this.cache.add(cacheKey2, 60000, 
      Promise.all([
        ctx.query('SELECT SUM(amount) AS samount, SUM(1) AS sone ' +
          'FROM depot_stocks AS ds WHERE ds.stockid = ?', [xuser.lstockid]), 
        ctx.query('SELECT p.name, p.path, p.schoolid FROM schools AS c ' +
          'JOIN schools AS p ON c.path LIKE CONCAT(p.path, "/%") OR p.schoolid = c.schoolid ' + 
          'WHERE c.schoolid = ? ORDER BY LENGTH(p.path) ASC', [xuser.dschoolid])
      ]));
  }).then(spread((followers, schools) => {
    xuser.f_amount = followers[0].samount || 0;
    xuser.f_count = followers[0].sone || 0;
    
    /* do some validation on the schools array.
     * this is not necessary; however, it may help catch bugs long 
     * before they actually do a lot of harm. */
    const levelArray = schools.map(s => { return s.path.replace(/[^\/]/g, '').length; }); // count '/'
    if (_.intersection(levelArray, _.range(1, levelArray.length+1)).length !== levelArray.length) {
      return this.emitError(new Error('Invalid school chain for user: ' + JSON.stringify(schools)));
    }
    
    /* backwards compatibility */
    for (let i = 0; i < schools.length; ++i) {
      schools[i].id = schools[i].schoolid;
    }
    
    xuser.schools = schools;
    
    const result = {
      code: 'get-user-info-success', 
      result: xuser
    };
    
    resultCacheKey += ':' + xuser.uid + ':' + query.nohistory;
    
    const viewDOHPermission = ctx.user && (!xuser.delayorderhist || xuser.uid === ctx.user.uid || ctx.access.has('stocks'));
    const cacheKey3 = 'get-user-info3:' + xuser.uid + ':' + viewDOHPermission;
    
    if (query.nohistory) {
      return result;
    }
    
    resultCacheKey += '/' + cacheKey3;
    
    return Promise.resolve().then(() => {
      if (this.cache.has(cacheKey3) && cacheable) {
        return this.cache.use(cacheKey3);
      }
      
      return this.cache.add(cacheKey3, 120000, Promise.all([
        // orders
        ctx.query('SELECT oh.*, l.name AS leadername FROM orderhistory AS oh ' +
          'LEFT JOIN users AS l ON oh.leader = l.uid ' + 
          'WHERE oh.uid = ? AND buytime <= (UNIX_TIMESTAMP() - ?) ' + 
          'ORDER BY buytime DESC',
          [xuser.uid, viewDOHPermission ? 0 : cfg.delayOrderHistTime]),
        // achievements
        ctx.query('SELECT * FROM achievements ' + 
          'LEFT JOIN events ON events.type="achievement" AND events.targetid = achid ' +
          'WHERE uid = ?', [xuser.uid]),
        // values
        ctx.query('SELECT time, totalvalue FROM valuehistory WHERE uid = ?', [xuser.uid]),
      ]));
    }).then(spread((orders, achievements, values) => {
      result.orders = orders;
      result.achievements = achievements;
      result.values = values;
      
      return ctx.query('SELECT c.*, u.name AS username,u.uid AS uid, url AS profilepic, trustedhtml ' + 
        'FROM ecomments AS c ' + 
        'LEFT JOIN users AS u ON c.commenter = u.uid ' + 
        'LEFT JOIN httpresources ON httpresources.uid = c.commenter AND httpresources.role = "profile.image" ' + 
        'WHERE c.eventid = ?', [xuser.registerevent]);
    })).then(comments => {
      result.pinboard = comments.map(c => {
        c.isDeleted = ['gdeleted', 'mdeleted'].indexOf(c.cstate) !== -1;
        return c;
      });
      
      return result;
    });
  })).then(result => {
    if (cacheable) {
      result.cc__ = {
        fields: ['result', 'orders', 'achievements', 'values'],
        validity: 60000,
        key: resultCacheKey,
        cache: this.cache
      };
    }
    
    return result;
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
User.prototype.regularCallback = buscomponent.provide('regularCallbackUser', ['query', 'ctx'], function(query, ctx) {
  if (ctx.getProperty('readonly')) {
    return Promise.resolve();
  }
  
  debug('Regular callback');
  
  return Promise.all([
    ctx.query('DELETE FROM sessions WHERE lastusetime + endtimeoffset < UNIX_TIMESTAMP()'),
    ctx.query('DELETE FROM passwords WHERE changetime IS NULL AND issuetime < UNIX_TIMESTAMP() - 7*86400'),
    ctx.query('UPDATE users SET email=CONCAT("deleted:erased:", uid), email_verif = 0 ' +
      'WHERE deletiontime IS NOT NULL AND deletiontime < UNIX_TIMESTAMP() - 70*86400'),
    ctx.query('SELECT p.schoolid, p.path, users.access FROM schools AS p ' +
      'JOIN events ON events.type="school-create" AND events.targetid = p.schoolid ' +
      'JOIN users ON users.uid = events.srcuser ' +
      'WHERE ' +
      '(SELECT COUNT(uid) FROM schoolmembers WHERE schoolmembers.schoolid = p.schoolid) = 0 AND ' +
      '(SELECT COUNT(*) FROM schools AS c WHERE c.path LIKE CONCAT(p.path, "/%")) = 0 AND ' +
      '(SELECT COUNT(*) FROM feedblogs WHERE feedblogs.schoolid = p.schoolid) = 0 AND ' +
      '(SELECT COUNT(*) FROM invitelink WHERE invitelink.schoolid = p.schoolid) = 0').then(schools => {
      return Promise.all(schools.filter(school => {
        return !Access.fromJSON(school.access).has('schooldb') &&
          (school.path.replace(/[^\/]/g, '').length === 1 || (query && query.weekly));
      }).map(school => {
        return ctx.query('DELETE FROM schools WHERE schoolid = ?', [school.schoolid]);
      }));
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
User.prototype.emailVerify = buscomponent.provideWQT('client-emailverif', function(query, ctx, xdata) {
  const uid = parseInt(query.uid);
  const key = String(query.key);
  let email;
  
  if (uid !== uid) {
    throw new this.FormatError();
  }
  
  debug('Verify email', uid);
  
  return ctx.startTransaction().then(conn => {
    return conn.query('SELECT email_verif, email FROM users WHERE uid = ? LOCK IN SHARE MODE', [uid])
    .then(res => {
      if (res.length !== 1) {
        throw new this.SoTradeClientError('email-verify-failure');
      }
      
      email = res[0].email;
      if (res[0].email_verif) {
        throw new this.SoTradeClientError('email-verify-already-verified');
      }
      
      return conn.query('SELECT COUNT(*) AS c FROM email_verifcodes WHERE uid = ? AND `key` = ? FOR UPDATE', [uid, key]);
    }).then(res => {
      assert.equal(res.length, 1);
      
      if (res[0].c < 1 && !ctx.access.has('userdb')) {
        throw new this.SoTradeClientError('email-verify-failure');
      }
      
      return conn.query('SELECT COUNT(*) AS c FROM users WHERE email = ? AND email_verif = 1 AND uid != ? LOCK IN SHARE MODE', [email, uid]);
    }).then(res => {
      if (res[0].c > 0) {
        throw new this.SoTradeClientError('email-verify-other-already-verified');
      }
    
      return conn.query('DELETE FROM email_verifcodes WHERE uid = ?', [uid]);
    }).then(() => {
      return conn.query('UPDATE users SET email_verif = 1 WHERE uid = ?', [uid]);
    }).then(() => {
      ctx.access.grant('email_verif');
    }).then(conn.commit, conn.rollbackAndThrow);
  }).then(() => {
    return this.login({
      name: email,
      stayloggedin: true,
    }, new qctx.QContext({access: ctx.access, parentComponent: this}), xdata, true, true);
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
 * 
 * @function busreq~updateUserStatistics
 */
User.prototype.updateUserStatistics = buscomponent.provide('updateUserStatistics',
  ['user', 'ctx', 'force'], function(user, ctx, force)
{
  if (!user) {
    return Promise.resolve();
  }
  
  const now = Date.now();
  const lastSessionUpdate = ctx.getProperty('lastSessionUpdate');
  
  if (((!lastSessionUpdate || (now - lastSessionUpdate) < 60000) && !force) || ctx.getProperty('readonly') || !user) {
    // don't update things yet
    ctx.setProperty('pendingTicks', ctx.getProperty('pendingTicks') + 1);
    
    return Promise.resolve();
  } else {
    const ticks = ctx.getProperty('pendingTicks');
    ctx.setProperty('pendingTicks', 0);
    ctx.setProperty('lastSessionUpdate', now);
    
    debug('Adding ticks', user.uid, ticks);
    
    return Promise.all([
      ctx.query('UPDATE sessions SET lastusetime = UNIX_TIMESTAMP() WHERE id = ?', [user.sid]),
      ctx.query('UPDATE globalvars SET value = ? + value WHERE name="ticks"', [ticks, user.uid])
    ]);
  }
});

/**
 * Load information on the current user from the database.
 * 
 * This function is usually one of the first ones called on each client query.
 * 
 * @param {string} key  The current session id.
 * @param {module:qctx~QContext} ctx  A QContext to provide database access and user information.
 * 
 * @return A {module:user~UserEntry} object (or null in case of no match or an expired session).
 * 
 * @function busreq~loadSessionUser
 */
User.prototype.loadSessionUser = buscomponent.provide('loadSessionUser', ['key', 'ctx'], function(key, ctx) {
  const signedLogin = (key[0] === ':');
  
  return Promise.resolve().then(() => {
    if (!signedLogin) {
      return {uid: null, key: key};
    }
    
    // was signed login, e. g. during read-only period
    return this.request({
      name: 'verifySignedMessage',
      msg: key.substr(1),
    }).then(msg => {
      const today = parseInt(Date.now() / 86400);
      if (!msg || msg.date <= today - 1) { // message at least 24 hours old
        return null;
      }
      
      debug('Verified user in readonly mode', msg.uid);
      return {uid: msg.uid, key: msg.sid};
    });
  }).then(loginInfo => {
    if (!loginInfo) {
      return null;
    }
    
    return ctx.query('SELECT users.*, users_finance.*, users_data.*, users.uid AS uid, ' +
      (signedLogin ? '' : 'sessions.id AS sid, ') +
      'schools.path AS schoolpath, schools.schoolid AS schoolid, schools.name AS schoolname, jointime, sm.pending AS schoolpending ' +
      'FROM users ' +
      'JOIN users_finance ON users_finance.uid = users.uid ' +
      'JOIN users_data ON users_data.uid = users.uid ' +
      (signedLogin ? '' : 'JOIN sessions ON sessions.uid = users.uid ') +
      'LEFT JOIN schoolmembers AS sm ON sm.uid = users.uid ' +
      'LEFT JOIN schools ON schools.schoolid = sm.schoolid ' +
      'WHERE ' + (signedLogin ? 'users.uid = ? ' : '`key` = ? ' +
      (ctx.getProperty('readonly') ? '' : 'AND lastusetime + endtimeoffset > UNIX_TIMESTAMP() ')) +
      'LIMIT 1', [signedLogin ? loginInfo.uid : loginInfo.key])
    .then(res => {
      if (res.length === 0) {
        return null;
      }
      
      assert.equal(res.length, 1);
      const user = res[0];
      /* backwards compatibility */
      user.id = user.uid;
      user.school = user.schoolid;
      
      assert.ok(user.uid === loginInfo.uid || loginInfo.uid === null);
      
      user.realnamepublish = !!user.realnamepublish;
      user.delayorderhist = !!user.delayorderhist;
      
      try {
        user.clientopt = JSON.parse(user.clientopt);
      } catch (e) {
        user.clientopt = {};
      }
      
      if (signedLogin) {
        user.sid = loginInfo.key;
      }
      
      debug('Loaded user', user.uid);
      
      return this.updateUserStatistics(user, ctx).then(() => user);
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
User.prototype.register = buscomponent.provideWQT('client-register', function(query, ctx, xdata) {
  if (ctx.user !== null) {
    throw new this.SoTradeClientError('already-logged-in');
  }
  
  return this.updateUser(query, 'register', ctx, xdata);
});

/**
 * Changes the settings and general information for the current user.
 * See {@link module:user~User#updateUser} for detailed documentation,
 * including parameters and possible return codes.
 * 
 * @noreadonly
 * @function c2s~change-options
 */
User.prototype.changeOptions = buscomponent.provideWQT('client-change-options', function(query, ctx, xdata) {
  return this.updateUser(query, 'change', ctx, xdata);
});

/**
 * Checks that a username is valid.
 * 
 * @param {string} query.name  The (possible) user name.
 * @param {?int} query.uid     (Used internally).
 * 
 * @return {object} Returns with <code>reg-name-invalid-char</code>,
 *                  <code>reg-name-already-present</code> or
 *                  <code>validate-username-valid</code>.
 * 
 * @loginignore
 * @function c2s~validate-username
 */
User.prototype.validateUsername = buscomponent.provideQT('client-validate-username', function(query, ctx) {
  query.name = String(query.name);
  let uid = parseInt(query.uid);
  
  if (uid !== uid) {
    uid = null;
  }
  
  if (!/^[^\.,@<>\x00-\x20\x7f!"'\/\\$#()^?&{}]+$/.test(query.name) ||
    parseInt(query.name) === parseInt(query.name)) {
    throw new this.SoTradeClientError('reg-name-invalid-char');
  }
  
  return ctx.query('SELECT uid FROM users ' +
    'WHERE (name = ?) ORDER BY NOT(uid != ?) FOR UPDATE',
    [query.name, uid]).then(res => {
    
    if (res.length > 0 && res[0].uid !== uid) {
      throw new this.SoTradeClientError('reg-name-already-present');
    }
    
    return { code: 'validate-username-valid' };
  });
});

/**
 * Checks that an email address is valid.
 * 
 * @param {string} query.email  The (possible) email address.
 * @param {?int} query.uid     (Used internally).
 * 
 * @return {object} Returns with <code>reg-invalid-email</code>,
 *                  <code>reg-email-already-present</code> or
 *                  <code>validate-email-valid</code>.
 * 
 * @loginignore
 * @function c2s~validate-email
 */
User.prototype.validateEMail = buscomponent.provideQT('client-validate-email', function(query, ctx) {
  let uid = parseInt(query.uid);
  query.email = String(query.email);
  
  if (uid !== uid) {
    uid = null;
  }
  
  if (!validator.isEmail(query.email)) {
    throw new this.SoTradeClientError('reg-invalid-email');
  }
  
  return ctx.query('SELECT uid FROM users ' +
    'WHERE email = ? AND email_verif ORDER BY NOT(uid != ?) FOR UPDATE',
    [query.email, uid]).then(res => {
    if (res.length > 0 && res[0].uid !== uid) {
      throw new this.SoTradeClientError('reg-email-already-present');
    }
    
    return { code: 'validate-email-valid' };
  });
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
 *                      <li><code>reg-unknown-gender</code></li>
 *                      <li><code>invalid-provision</code></li>
 *                      <li><code>reg-beta-necessary</code></li>
 *                      <li><code>reg-invalid-email</code></li>
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
User.prototype.updateUser = function(query, type, ctx, xdata) {
  debug('Update user', type, ctx.user && ctx.user.uid);
  
  const betakey = query.betakey ? String(query.betakey).split('-') : [0,0];
  
  let uid, cfg;
  let gainUIDCBs = [];
  
  return this.getServerConfig().then(cfg_ => {
    cfg = cfg_;
    uid = ctx.user !== null ? ctx.user.uid : null;
    if (!query.name || !query.email) {
      throw new this.FormatError();
    }
    
    if ((query.password || type !== 'change') && (!query.password || query.password.length < 5)) {
      throw new this.SoTradeClientError('reg-too-short-pw');
    }
    
    query.email = String(query.email);
    query.name = String(query.name);
    query.gender = query.gender ? String(query.gender) : null;
    
    if (query.gender !== null && genders.genders.indexOf(query.gender) === -1) {
      throw new this.SoTradeClientError('reg-unknown-gender');
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
      query.lprovision < cfg.minLProvision || query.lprovision > cfg.maxLProvision) {
      throw new this.SoTradeClientError('invalid-provision');
    }
    
    query.lang = String(query.lang || cfg.languages[0].id);
    if (_.chain(cfg.languages).map('id').indexOf(query.lang).value() === -1) {
      throw new this.SoTradeClientError('reg-invalid-language');
    }
    
    if (!query.school) { // e. g., empty string
      query.school = null;
    }
    
    return ctx.startTransaction();
  }).then(conn => {
    return Promise.all([
      (ctx.user && query.email === ctx.user.email) ||
        this.validateEMail({ email: query.email, uid: uid }, conn),
      (ctx.user && query.name === ctx.user.name) ||
        this.validateUsername({ name: query.name, uid: uid }, conn)
    ]).then(() => {
    return conn.query('SELECT `key` FROM betakeys WHERE `id` = ? FOR UPDATE',
      [betakey[0]]);
  }).then(βkey => {
    if (cfg.betakeyRequired && (βkey.length === 0 || βkey[0].key !== betakey[1]) && 
      type === 'register' && !ctx.access.has('userdb')) {
      throw new this.SoTradeClientError('reg-beta-necessary');
    }
    
    if (query.school === null) {
      return [];
    }
    
    return conn.query('SELECT schoolid FROM schools WHERE ? IN (schoolid, name, path) FOR UPDATE', [String(query.school)]);
  }).then(res => {
    if (res.length === 0 && query.school !== null) {
      if (parseInt(query.school) === parseInt(query.school) || !query.school) {
        throw new this.SoTradeClientError('reg-unknown-school');
      }
      
      let possibleSchoolPath = '/' + String(query.school).toLowerCase().replace(/[^\w_-]/g, '');
      
      return conn.query('SELECT COUNT(*) AS c FROM schools WHERE path = ?', [possibleSchoolPath]).then(psRes => {
        assert.equal(psRes.length, 1);
        
        if (psRes[0].c === 0) { /* no collision, no additional identifier needed */
          return null;
        }
        
        return pseudoRandomBytes(3);
      }).then(rand => {
        if (rand) {
          possibleSchoolPath += '-' + rand.toString('base64') + String(Date.now()).substr(3, 4);
        }
        
        debug('Create school for user update', possibleSchoolPath);
        
        return conn.query('INSERT INTO schools (name, path) VALUES(?, ?)',
          [String(query.school), possibleSchoolPath]);
      });
    } else {
      if (query.school !== null) {
        assert.ok(parseInt(query.school) !== query.school || query.school === res[0].schoolid);
        query.school = res[0].schoolid;
      }
      
      return [];
    }
  }).then(res => {
    if (res && res.insertId) {
      // in case school was created
      
      const schoolid = res.insertId;
      query.school = schoolid;
      
      gainUIDCBs.push(() => {
        assert.equal(uid, parseInt(uid));
        
        return ctx.feed({
          'type': 'school-create',
          'targetid': schoolid,
          'srcuser': uid,
          'conn': conn
        });
      });
    }
    
    if (type === 'change') {
      return Promise.all([
        conn.query('UPDATE users SET name = ?, email = ?, email_verif = ?, ' +
          'delayorderhist = ?, skipwalkthrough = ? WHERE uid = ?',
          [String(query.name),
          String(query.email), query.email === ctx.user.email ? 1 : 0, 
          query.delayorderhist ? 1:0, query.skipwalkthrough ? 1:0, uid]),
        conn.query('UPDATE users_data SET giv_name = ?, fam_name = ?, realnamepublish = ?, ' +
          'birthday = ?, `desc` = ?, street = ?, zipcode = ?, town = ?, traditye = ?, ' +
          'clientopt = ?, dla_optin = ?, schoolclass = ?, lang = ?, gender = ? WHERE uid = ?',
          [String(query.giv_name), String(query.fam_name), query.realnamepublish?1:0,
          query.birthday, String(query.desc), String(query.street),
          String(query.zipcode), String(query.town), JSON.stringify(query.clientopt || {}),
          query.traditye?1:0, query.dla_optin?1:0, String(query.schoolclass || ''),
          String(query.lang), query.gender, uid]),
        conn.query('UPDATE users_finance SET wprovision = ?, lprovision = ? WHERE uid = ?',
          [query.wprovision, query.lprovision, uid]),
        query.password ? this.generatePassword(query.password, 'changetime', uid, conn) : Promise.resolve()
      ]).then(() => {
        if (query.school === ctx.user.school) {
          return;
        }
        
        return Promise.resolve().then(() => {
          if (ctx.user.school !== null) {
            return conn.query('DELETE FROM schooladmins WHERE uid = ? AND schoolid = ?', [uid, ctx.user.school]);
          }
        }).then(() => {
          if (query.school === null) {
            return conn.query('DELETE FROM schoolmembers WHERE uid = ?', [uid]);
          }
          
          return conn.query('REPLACE INTO schoolmembers (uid, schoolid, pending, jointime) '+
            'VALUES(?, ?, ' + (ctx.access.has('schooldb') ? '0' :
              '((SELECT COUNT(*) FROM schooladmins WHERE schoolid = ? AND status="admin") > 0)') + ', UNIX_TIMESTAMP())',
            [uid, String(query.school), String(query.school)]);
        });
      }).then(() => {
        if (query.name === ctx.user.name) {
          return;
        }
        
        return ctx.feed({
          'type': 'user-namechange',
          'targetid': uid,
          'srcuser': uid,
          'json': {'oldname': ctx.user.name, 'newname': query.name},
          'conn': conn
        }).then(() => {
          return conn.query('UPDATE stocks SET name = ? WHERE leader = ?', ['Leader: ' + query.name, uid]);
        });
      }).then(() => {
        if (query.wprovision === ctx.user.wprovision && query.lprovision === ctx.user.lprovision) {
          return;
        }
        
        return ctx.feed({'type': 'user-provchange', 'targetid': uid, 'srcuser': uid, json:
          {'oldwprov': ctx.user.wprovision, 'newwprov': query.wprovision,
           'oldlprov': ctx.user.lprovision, 'newlprov': query.lprovision}, 'conn': conn});
      }).then(() => {
        if (query.desc === ctx.user.desc) {
          return;
        }
        
        return ctx.feed({'type': 'user-descchange', 'targetid': uid, 'srcuser': uid, 'conn': conn});
      });
    } else {
      let inv = {};
      return Promise.resolve().then(() => {
        if (query.betakey) {
          return conn.query('DELETE FROM betakeys WHERE id = ?', [betakey[0]]);
        }
      }).then(() => {
        if (!query.invitekey) {
          return;
        }
        
        return conn.query('SELECT * FROM invitelink WHERE `key` = ?', [String(query.invitekey)]).then(invres => {
          if (invres.length === 0) {
            return;
          }
          
          assert.equal(invres.length, 1);
          
          inv = invres[0];
          if (inv.schoolid && !query.school || parseInt(query.school) === parseInt(inv.schoolid)) {
            query.school = inv.schoolid;
            inv.__schoolverif__ = 1;
          }
          
          gainUIDCBs.push(() => {
            return conn.query('INSERT INTO inviteaccept (iid, uid, accepttime) VALUES(?, ?, UNIX_TIMESTAMP())', [inv.iid, uid]);
          });
        });
      }).then(() => {
        return conn.query('INSERT INTO users ' +
          '(name, delayorderhist, email, email_verif, registertime) ' +
          'VALUES (?, ?, ?, ?, UNIX_TIMESTAMP())',
          [String(query.name), query.delayorderhist?1:0,
          String(query.email), (inv.email && inv.email === query.email) ? 1 : 0]);
      }).then(res => {
        uid = res.insertId;
        
        return query.password ? this.generatePassword(query.password, 'changetime', uid, conn) : Promise.resolve();
      }).then(() => {
        return conn.query('INSERT INTO users_data (uid, giv_name, fam_name, realnamepublish, traditye, ' +
          'street, zipcode, town, schoolclass, lang, gender) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?); ' +
          'INSERT INTO users_finance(uid, wprovision, lprovision, freemoney, totalvalue) '+
          'VALUES (?, ?, ?, ?, ?)',
          [uid, String(query.giv_name), String(query.fam_name), query.realnamepublish?1:0,
          query.traditye?1:0, String(query.street), String(query.zipcode), String(query.town),
          String(query.schoolclass || ''), String(query.lang), query.gender,
          uid, cfg.defaultWProvision, cfg.defaultLProvision,
          cfg.defaultStartingMoney, cfg.defaultStartingMoney]);
      }).then(() => {
        return ctx.feed({'type': 'user-register', 'targetid': uid, 'srcuser': uid, 'conn': conn});
      }).then(() => {
        return conn.query('INSERT INTO stocks (stocktextid, leader, name, exchange, pieces) VALUES(?, ?, ?, ?, 100000000)',
          ['__LEADER_' + uid + '__', uid, 'Leader: ' + query.name, 'tradity']);
      }).then(() => {
        if (query.school) {
          return conn.query('INSERT INTO schoolmembers (uid, schoolid, pending, jointime) ' +
            'VALUES(?, ?, ' + 
            (inv.__schoolverif__ ? '1' : '((SELECT COUNT(*) FROM schooladmins WHERE schoolid = ? AND status="admin") > 0) ') +
            ', UNIX_TIMESTAMP())',
            [uid, String(query.school), String(query.school)]);
        }
      });
    }
  }).then(() => {
    assert.strictEqual(uid, parseInt(uid));
    
    return gainUIDCBs.reduce((a,b) => Promise.resolve(a).then(b), Promise.resolve());
  }).then(conn.commit, conn.rollbackAndThrow);
  }).then(() => {
    if ((ctx.user && query.email === ctx.user.email) || (ctx.access.has('userdb') && query.nomail)) {
      return { code: 'reg-success', uid: uid, extra: 'repush' };
    }
    
    return this.sendRegisterEmail(query,
      new qctx.QContext({user: {uid: uid}, access: ctx.access,
        parentComponent: this}),
      xdata);
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
User.prototype.resetUser = buscomponent.provideWQT('client-reset-user', function(query, ctx) {
  debug('Reset user', ctx.user.uid);
  
  return this.getServerConfig().then(cfg => {
    if (!cfg.resetAllowed && !ctx.access.has('userdb')) {
      throw new this.PermissionDenied();
    }
    
    assert.ok(ctx.user);
    assert.ok(ctx.access);
    
    return ctx.query('DELETE FROM depot_stocks WHERE uid = ?', [ctx.user.uid]).then(() => {
      return ctx.query('UPDATE users_finance SET freemoney = ?, totalvalue = ?, ' +
        'fperf_bought = 0, fperf_cur = 0, fperf_sold = 0, ' + 
        'operf_bought = 0, operf_cur = 0, operf_sold = 0, ' + 
        'wprov_sum = 0, lprov_sum = 0 ' + 
        'WHERE uid = ?', [cfg.defaultStartingMoney, cfg.defaultStartingMoney, ctx.user.uid]);
    }).then(() => {
      return this.request({name: 'sellAll', query: query, ctx: ctx});
    }).then(() => {
      const val = cfg.defaultStartingMoney / 1000;
      
      return Promise.all([
        ctx.query('UPDATE stocks SET lastvalue = ?, ask = ?, bid = ?, ' +
          'daystartvalue = ?, weekstartvalue = ?, lastchecktime = UNIX_TIMESTAMP() WHERE leader = ?',
          [val, val, val, val, val, ctx.user.uid]),
        ctx.query('DELETE FROM valuehistory WHERE uid = ?', [ctx.user.uid]),
        ctx.feed({'type': 'user-reset', 'targetid': ctx.user.uid, 'srcuser': ctx.user.uid}),
        this.request({name: 'dqueriesResetUser', ctx: ctx})
      ]);
    }).then(() => ({ code: 'reset-user-success' }));
  });
});

/**
 * Returns a list of genders for users to pick from.
 * 
 * @return Returns with <code>list-genders-success</code>. <code>.genders</code>
 *         is set to a data structure in <a href="https://github.com/addaleax/genders">this</a>
 *         format.
 * 
 * @loginignore
 * @function c2s~list-genders
 */
User.prototype.listGenders = buscomponent.provideQT('client-list-genders', function(query, ctx) {
  return Promise.resolve().then(() => {
    if (this.cache.has('gender-statistics')) {
      return this.cache.use('gender-statistics');
    }
    
    return this.cache.add('gender-statistics', 60000,
      ctx.query('SELECT gender, COUNT(gender) AS gc FROM users_data GROUP BY gender ORDER BY gc DESC'));
  }).catch(e => {
    console.error('Error loading gender list', e);
    /* if something went wrong, everything still is just fine */
    return [];
  }).then(stats => {
    const genderRanking = _.map(stats, 'gender').slice(0, 4);
    genders.genders = _.sortBy(genders.genders, gender => {
      let rankingIndex = genderRanking.indexOf(gender);
      if (rankingIndex === -1) {
        rankingIndex = Infinity;
      }
      
      return [rankingIndex, gender];
    });
    
    return {
      code: 'list-genders-success',
      genders: genders
    };
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
User.prototype.passwordReset = buscomponent.provideTXQT('client-password-reset', function(query, ctx) {
  if (ctx.user) {
    throw new this.SoTradeClientError('already-logged-in');
  }
  
  const name = String(query.name);
  let pw, u;
  
  debug('Reset password', name);
  
  return ctx.query('SELECT users.uid, email, lang ' +
    'FROM users ' +
    'JOIN users_data ON users.uid = users_data.uid ' +
    'WHERE name = ? OR email = ? AND deletiontime IS NULL ' +
    'LIMIT 1 FOR UPDATE',
    [name, name]).then(res => {
    if (res.length === 0) {
      throw new this.SoTradeClientError('password-reset-notfound');
    }
    
    u = res[0];
    assert.ok(u);
    
    return randomBytes(8);
  }).then(buf => {
    pw = buf.toString('hex');
    return this.generatePassword(pw, 'issuetime', u.uid, ctx);
  }).then(() => {
    return this.request({name: 'sendTemplateMail', 
      template: 'password-reset-email.eml',
      ctx: ctx,
      uid: u.uid,
      lang: u.lang,
      variables: {'password': pw, 'username': query.name, 'email': u.email},
    });
  }).then(() => ({ code: 'password-reset-success' }));
});

/**
 * Returns basic information on an invitation key.
 * 
 * @return {object}  Returns with <code>get-invitekey-info-notfound</code>
 *                   or <code>get-invitekey-info-success</code> and, in the
 *                   latter case, sets <code>.result.email</code> and 
 *                   <code>.result.schoolid</code> appropiately.
 * 
 * @loginignore
 * @function c2s~get-invitekey-info
 */
User.prototype.getInviteKeyInfo = buscomponent.provideQT('client-get-invitekey-info', function(query, ctx) {
  return Promise.all([
    ctx.query('SELECT email, schoolid FROM invitelink WHERE `key` = ?', [String(query.invitekey)]),
    this.getServerConfig()
  ]).then(spread((res, cfg) => {
    if (res.length === 0) {
      throw new this.SoTradeClientError('get-invitekey-info-notfound');
    }
  
    assert.equal(res.length, 1);
    
    res[0].url = cfg.varReplace(cfg.inviteurl.replace(/\{\$key\}/g, String(query.invitekey)));
    
    return { code: 'get-invitekey-info-success', result: res[0] };
  }));
});

/**
 * See {@link c2s~create-invite-link} for specifications.
 * 
 * @noreadonly
 * @function busreq~createInviteLink
 */
User.prototype.createInviteLink = buscomponent.provideWQT('createInviteLink', function(query, ctx) {
  ctx = ctx.clone(); // so we can’t lose the user object during execution
  
  debug('Create invite link for', ctx.user.uid, query.email, query.schoolid);
  
  let sendKeyToCaller = ctx.access.has('userdb');
  let key, url, cfg;
  
  if (query.schoolid && parseInt(query.schoolid) !== parseInt(query.schoolid)) {
    throw new this.FormatError();
  }
  
  return this.getServerConfig().then(cfg_ => {
    cfg = cfg_;
    query.email = query.email ? String(query.email) : null;
    
    if (!ctx.access.has('userdb')) {
      if (query.email && !/([\w_+.-]+)@([\w.-]+)$/.test(query.email)) {
        throw new this.SoTradeClientError('create-invite-link-invalid-email');
      }
      
      if (!ctx.access.has('email_verif')) {
        throw new this.SoTradeClientError('create-invite-link-not-verif');
      }
    }
    
    return Promise.all([
      pseudoRandomBytes(16),
      ctx.query('SELECT COUNT(*) AS c FROM schools WHERE schoolid = ?', [query.schoolid])
    ]);
  }).then(spread((buf, schoolcountres) => {
    if (query.schoolid && schoolcountres[0].c !== 1) {
      throw new this.SoTradeClientError('create-invite-link-school-not-found');
    }
    
    key = buf.toString('hex');
    return ctx.query('INSERT INTO invitelink ' +
      '(uid, `key`, email, ctime, schoolid) VALUES ' +
      '(?, ?, ?, UNIX_TIMESTAMP(), ?)', 
      [ctx.user.uid, key, query.email, query.schoolid ? parseInt(query.schoolid) : null]);
  })).then(() => {
    url = cfg.varReplace(cfg.inviteurl.replace(/\{\$key\}/g, key));
  
    if (query.email) {
      return this.sendInviteEmail({
        sender: ctx.user,
        email: query.email,
        url: url
      }, ctx);
    } else {
      sendKeyToCaller = true;
      return { code: 'create-invite-link-success' };
    }
  }).then(ret => {
    if (sendKeyToCaller) {
      ret.url = url;
      ret.key = key; 
    }
    
    return ret;
  });
});

exports.User = User;
