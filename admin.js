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

const commonUtil = require('tradity-connection');
const assert = require('assert');
const debug = require('debug')('sotrade:admin');
const buscomponent = require('./stbuscomponent.js');
const promiseUtil = require('./lib/promise-util.js');
const spread = promiseUtil.spread;

/**
 * Provides client requests for administrative tasks and information gathering.
 * 
 * @public
 * @module admin
 */

/**
 * Main object of the {@link module:admin} module
 * @public
 * @constructor module:admin~Admin
 * @augments module:stbuscomponent~STBusComponent
 */
class Admin extends buscomponent.BusComponent {
  constructor() {
    super();
  }
}

/**
 * Helper function to indicate that a client request requires admin privileges.
 * 
 * @param {string} required  The required privilege level
 * @param {QTXCallback} f  A standard QTX client request handler
 * 
 * @function module:admin~_reqpriv
 */
function _reqpriv (required, f) {
  const requiredPermission = required;
  
  return function(query, ctx, xdata) {
    if (ctx.user === null || !ctx.access.has(requiredPermission)) {
      throw new this.PermissionDenied();
    } else {
      return f.call(this, query, ctx, xdata);
    }
  };
}

/**
 * Returns all users and tons of information on them.
 * 
 * @example
 * Example ouput:
 * [ …, {
 *  birthday: 713923200000,
 *  deletiontime: null,
 *  street: 'null',
 *  zipcode: 'null',
 *  town: 'null',
 *  lang: …,
 *  desc: …,
 *  name: …,
 *  giv_name: …,
 *  fam_name: …,
 *  uid: 14,
 *  tradecount: 41,
 *  email: …,
 *  emailverif: 1,
 *  wprovision: 5,
 *  lprovision: 5,
 *  freemoney: 787240079,
 *  totalvalue: 787240064,
 *  wprov_sum: 0,
 *  lprov_sum: 0,
 *  registertime: 0,
 *  schoolpath: '/kit',
 *  schoolid: 27,
 *  pending: 0,
 *  jointime: 0,
 *  commentcount: 7,
 *  lastcommenttime: 1403753220 }, … ]
 * 
 * @return {object} Returns with <code>list-all-users-success</code> or a common error code
 *                  and populates <code>.results</code> with a
 *                  {@link module:user~UserEntryBase[]}, augmented by various data only
 *                  available to administrative users.
 * 
 * @function c2s~list-all-users
 */
Admin.prototype.listAllUsers = buscomponent.provideQT('client-list-all-users', _reqpriv('userdb', function(query, ctx) {
  return ctx.query('SELECT birthday, deletiontime, street, zipcode, town, `desc`, users.name, giv_name, fam_name, ' +
    'users.uid, tradecount, email, email_verif AS emailverif, ' +
    'wprovision, lprovision, freemoney, totalvalue, wprov_sum, lprov_sum, registertime, lang, ' +
    'schools.path AS schoolpath, schools.schoolid, schoolclass, pending, jointime, ' +
    '(SELECT COUNT(*) FROM ecomments WHERE ecomments.commenter=users.uid) AS commentcount, '+
    '(SELECT MAX(time) FROM ecomments WHERE ecomments.commenter=users.uid) AS lastcommenttime FROM users ' +
    'JOIN users_data ON users.uid = users_data.uid ' +
    'JOIN users_finance ON users.uid = users_finance.uid ' +
    'LEFT JOIN schoolmembers AS sm ON sm.uid = users.uid ' +
    'LEFT JOIN schools ON schools.schoolid = sm.schoolid ',
    []).then(userlist => {
    return { code: 'list-all-users-success', results: userlist };
  });
}));

/**
 * Returns a list of all events for a given timespan.
 * 
 * Internally calls {@link busreq~feedFetchEvents}.
 * 
 * @return {object} Returns with <code>list-all-events-success</code> or a common error code
 *                  and populates <code>.results</code> with a
 *                  {@link Event[]}.
 * 
 * @function c2s~list-all-events
 */
Admin.prototype.listAllEvents = buscomponent.provideQT('client-list-all-events', _reqpriv('feed', function(query, ctx) {
  return this.request({
    name: 'feedFetchEvents',
    query: query,
    ctx: ctx.clone()
  }).then(evlist => {
    return { code: 'list-all-events-success', results: evlist };
  });
}));

/**
 * Shuts down the server. Not really something for the typical user.
 * 
 * @return {object} Returns with <code>shutdown-success</code>.
 * 
 * @function c2s~shutdown
 */
Admin.prototype.shutdown = buscomponent.provideQT('client-shutdown', function(query, ctx) {
  debug('Administrative server shutdown');
  
  if (!ctx.access.has('server')) {
    throw new this.PermissionDenied();
  }
  
  promiseUtil.delay(2000).then(() => this.emit('globalShutdown'));
  
  return { code: 'shutdown-success' };
});

/**
 * Change the session user id.
 * 
 * @param {int} query.uid  The user id to assign to the current session.
 * 
 * @return {object} Returns with <code>impersonate-user-success</code> or
 *                  <code>impersonate-user-notfound</code> or a common error code.
 * 
 * @function c2s~impersonate-user
 */
Admin.prototype.impersonateUser = buscomponent.provideTXQT('client-impersonate-user', _reqpriv('server', function(query, ctx) {
  const uid = parseInt(query.uid);
  if (uid !== uid) {
    throw new this.PermissionDenied();
  }
  
  debug('Admin impersonation', ctx.user.uid, uid);
  
  return ctx.query('SELECT COUNT(*) AS c FROM users WHERE uid = ? LOCK IN SHARE MODE', [uid]).then(r => {
    assert.equal(r.length, 1);
    if (r[0].c === 0) {
      throw new this.SoTradeClientError('impersonate-user-notfound');
    }
  
    return ctx.query('UPDATE sessions SET uid = ? WHERE id = ?', [uid, ctx.user.sid]);
  }).then(() => {
    return { code: 'impersonate-user-success', extra: 'repush' };
  });
}));

/**
 * Removes data for a given user from the database.
 * 
 * @param {int} query.uid  The numerical id of the user to be removed.
 * 
 * @return {object} Returns with <code>delete-user-self-notallowed</code> or
 *                  <code>delete-user-success</code> or a common error code.
 * 
 * @function c2s~delete-user
 */
Admin.prototype.deleteUser = buscomponent.provideTXQT('client-delete-user', _reqpriv('userdb', function(query, ctx) {
  const uid = parseInt(query.uid);
  if (uid !== uid) { // NaN
    throw new this.FormatError();
  }
  
  if (ctx.user.uid === uid) {
    throw new this.SoTradeClientError('delete-user-self-notallowed');
  }
  
  debug('Deleting user', ctx.user.uid, uid);
  
  return Promise.all([
    ctx.query('DELETE FROM sessions WHERE uid = ?', [uid]),
    ctx.query('DELETE FROM schoolmembers WHERE uid = ?', [uid]),
    ctx.query('UPDATE stocks SET name = CONCAT("leader:deleted", ?) WHERE leader = ?', [uid, uid]),
    ctx.query('UPDATE users_data SET giv_name="__user_deleted__", fam_name="", birthday = NULL, ' +
      'street="", zipcode="", town="", traditye=0, `desc`="", realnamepublish = 0, gender = NULL, ' +
      'schoolclass = "" WHERE uid = ?', [uid]),
    ctx.query('UPDATE users_finance SET wprovision=0, lprovision=0 WHERE uid = ?', [uid]),
    ctx.query('UPDATE users SET name = CONCAT("user_deleted", ?), email = CONCAT("deleted:", email), ' +
      'deletiontime = UNIX_TIMESTAMP() WHERE uid = ?', [uid, uid]),
    ctx.query('DELETE FROM passwords WHERE uid = ?', [uid])
  ]).then(function() {
    return { code: 'delete-user-success' };
  });
}));

/**
 * Change a user’s e-mail address administratively.
 * 
 * @param {int} query.uid  The numerical id of the target user.
 * @param {string} query.email  The new e-mail address.
 * @param {boolean} query.emailverif  If truthy, automatically set the e-mail
 *                                    address to being verified.
 * 
 * @return {object} Returns with <code>change-user-email-success</code> or
 *                  a common error code.
 * 
 * @function c2s~change-user-email
 */
Admin.prototype.changeUserEMail = buscomponent.provideWQT('client-change-user-email', _reqpriv('userdb', function(query, ctx) {
  const uid = parseInt(query.uid);
  if (uid !== uid) {
    throw new this.FormatError();
  }
  
  return ctx.query('UPDATE users SET email = ?, email_verif = ? WHERE uid = ?',
    [String(query.email), query.emailverif ? 1 : 0, uid]).then(function() {
    return { code: 'change-user-email-success' };
  });
}));

/**
 * Change a comment’s text.
 * 
 * @param {int} query.commentid  The numerical id of the target comment.
 * @param {string} query.comment The new comment text.
 * @param {string} query.cstate  The new comment state.
 * @param {boolean} query.trustedhtml  If truthy, the new text is HTML-formatted.
 * 
 * @return {object} Returns with <code>change-comment-text-success</code> or
 *                  a common error code.
 * 
 * @function c2s~change-comment-text
 */
Admin.prototype.changeCommentText = buscomponent.provideWQT('client-change-comment-text', _reqpriv('moderate', function(query, ctx) {
  return ctx.query('UPDATE ecomments SET comment = ?, trustedhtml = ?, cstate = ? WHERE commentid = ?',
    [String(query.comment),
     ctx.access.has('server') && query.trustedhtml ? 1:0,
     String(query.cstate || ''), parseInt(query.commentid)]).then(function() {
    return { code: 'change-comment-text-success' };
  });
}));

/**
 * Remove the <code>sticky</code> flag from all notifications.
 * 
 * @return {object} Returns with <code>notify-unstick-all-success</code> or
 *                  a common error code.
 * 
 * @function c2s~notify-unstick-all
 */
Admin.prototype.notifyUnstickAll = buscomponent.provideWQT('client-notify-unstick-all', _reqpriv('moderate', function(query, ctx) {
  return ctx.query('UPDATE mod_notif SET sticky = 0').then(function() {
    return { code: 'notify-unstick-all-success' };
  });
}));

/**
 * A notice from the admins to the general community.
 * 
 * @typedef s2c~mod-notification
 * @type {Event}
 * 
 * @property {string} notifcontent  The HTML string to display to the readers
 * @property {boolean} sticky  Whether to move the notification to the to of
 *                             the feed when displaying
 */

/**
 * Inserts a message into all user feeds.
 * 
 * @param {string} query.content  The message to be displayed.
 * @param {boolean} query.sticky  If truthy, display the message on top of each feed.
 * 
 * @return {object} Returns with <code>notify-all-success</code> or
 *                  a common error code.
 * 
 * @function c2s~notify-all
 */
Admin.prototype.notifyAll = buscomponent.provideWQT('client-notify-all', _reqpriv('moderate', function(query, ctx) {
  return ctx.query('INSERT INTO mod_notif (content, sticky) VALUES (?, ?)',
    [String(query.content), query.sticky ? 1 : 0]).then(res => {
    return ctx.feed({
      'type': 'mod-notification',
      'targetid': res.insertId,
      'srcuser': ctx.user.uid,
      'everyone': true
    });
  }).then(() => {
    return { code: 'notify-all-success' };
  });
}));

/**
 * Changes a school’s name and/or path.
 * This is the proper way to change a group’s supergroup.
 * 
 * @param {int} query.schoolid  The numerical id of the target school.
 * @param {string} query.schoolpath  The school’s new path. (Will be converted to lower case)
 * @param {string} query.schoolname  The school’s new human-readable name.
 * 
 * @return {object} Returns with <code>rename-school-notfound</code>,
 *                  <code>rename-school-success</code> or
 *                  a common error code.
 * 
 * @function c2s~rename-school
 */
Admin.prototype.renameSchool = buscomponent.provideTXQT('client-rename-school', _reqpriv('schooldb', function(query, ctx) {
  query.schoolpath = String(query.schoolpath || '/').toLowerCase();
  
  let oldpath;
  return ctx.query('SELECT path FROM schools WHERE schoolid = ? FOR UPDATE', [parseInt(query.schoolid)]).then(r => {
    if (r.length === 0) {
      throw new this.SoTradeClientError('rename-school-notfound');
    }
    
    oldpath = r[0].path;
    assert.ok(oldpath);
    assert.ok(oldpath.length > 1);

    return ctx.query('SELECT COUNT(*) AS c FROM schools WHERE path = ? LOCK IN SHARE MODE',
      [commonUtil.parentPath(query.schoolpath)]);
  }).then(pr => {
    assert.equal(pr.length, 1);
    if (pr[0].c !== (commonUtil.parentPath(query.schoolpath) !== '/' ? 1 : 0)) {
      throw new this.SoTradeClientError('rename-school-notfound');
    }
    
    return ctx.query('SELECT path FROM schools WHERE path = ? FOR UPDATE', [query.schoolpath]);
  }).then(er => {
    if (query.schoolpath !== '/' && er.length > 0 && er[0].path.toLowerCase() === query.schoolpath) {
      throw new this.SoTradeClientError('rename-school-already-exists');
    }
    
    return ctx.query('UPDATE schools SET name = ? WHERE schoolid = ?',
      [String(query.schoolname), parseInt(query.schoolid)]);
  }).then(() => {
    if (query.schoolpath === '/') {
      return;
    }
      
    return ctx.query('UPDATE schools SET path = CONCAT(?, SUBSTR(path, ?)) WHERE path LIKE ? OR path = ?',
      [query.schoolpath, oldpath.length + 1, oldpath + '/%', oldpath]);
  }).then(() => {
    return { code: 'rename-school-success' };
  });
}));

/**
 * Merges two schools into a large school.
 * These schools need to have the same parent school.
 * 
 * @param {int} query.masterschool  The numerical id of the target school.
 * @param {int} query.subschool     The numerical id of the source school.
 * 
 * @return {object} Returns with <code>join-schools-notfound</code>,
 *                  <code>join-schools-success</code>,
 *                  <code>join-schools-diff-parent</code> or
 *                  a common error code.
 * 
 * @function c2s~join-schools
 */
Admin.prototype.joinSchools = buscomponent.provideTXQT('client-join-schools', _reqpriv('schooldb', function(query, ctx) {
  query.masterschool = parseInt(query.masterschool);
  query.subschool    = parseInt(query.subschool);
  
  if (query.masterschool !== query.masterschool) {
    query.masterschool = null;
  }
  
  if (query.subschool !== query.subschool) {
    throw new this.FormatError();
  }
  
  return Promise.all([
    ctx.query('SELECT path FROM schools WHERE schoolid = ? LOCK IN SHARE MODE', [query.masterschool]),
    ctx.query('SELECT path FROM schools WHERE schoolid = ? FOR UPDATE', [query.subschool]),
  ]).then(spread((mr, sr) => {
    assert.ok(mr.length <= 1);
    assert.ok(sr.length <= 1);
    
    if (sr.length === 0 || ((mr.length === 0 || mr[0].path === sr[0].path) && query.masterschool !== null)) {
      throw new this.SoTradeClientError('join-schools-notfound');
    }
    
    if (mr.length > 0 && commonUtil.parentPath(mr[0].path) !== commonUtil.parentPath(sr[0].path)) {
      throw new this.SoTradeClientError('join-schools-diff-parent');
    }
    
    if (query.masterschool === null) {
      return ctx.query('SELECT COUNT(*) AS c FROM schools WHERE path LIKE ?', [sr[0].path + '/%']).then(ssr => {
        assert.equal(ssr.length, 1);
        
        if (ssr[0].c > 0) {
          throw new this.SoTradeClientError('join-schools-delete-nosubschools');
        }
      }).then(() => {
        return Promise.all([
          ctx.query('DELETE FROM schoolmembers WHERE schoolid = ?', [query.subschool]),
          ctx.query('DELETE FROM feedblogs WHERE schoolid = ?', [query.subschool]),
          ctx.query('DELETE FROM invitelink WHERE schoolid = ?', [query.subschool]),
          ctx.query('DELETE FROM schooladmins WHERE schoolid = ?', [query.subschool])
        ]);
      });
    } else {
      return Promise.all([
        ctx.query('UPDATE schoolmembers SET schoolid = ? WHERE schoolid = ?',
          [query.masterschool, query.subschool]),
        ctx.query('UPDATE feedblogs SET schoolid = ? WHERE schoolid = ?',
          [query.masterschool, query.subschool]),
        ctx.query('UPDATE invitelink SET schoolid = ? WHERE schoolid = ?',
          [query.masterschool, query.subschool]),
        ctx.query('UPDATE schools SET path = CONCAT(?, SUBSTR(path, ?)) WHERE path LIKE ?',
          [mr[0].path, sr[0].path.length + 1, sr[0].path + '/%']),
        ctx.query('DELETE FROM schooladmins WHERE schoolid = ?', [query.subschool])
      ]);
    }
  })).then(function() {
    return ctx.query('DELETE FROM schools WHERE schoolid = ?', [query.subschool]);
  }).then(() => {
    return { code: 'join-schools-success' };
  });
}));

/**
 * Return all current followers of a given leader account.
 * 
 * @param {int} query.uid  The numerical user id of the leader.
 * 
 * @return {object} Returns with <code>get-followers-success</code>
 *                  a common error code and, in case of success, sets
 *                  <code>.results</code> accordingly.
 * 
 * @function c2s~get-followers
 */
Admin.prototype.getFollowers = buscomponent.provideQT('client-get-followers', _reqpriv('userdb', function(query, ctx) {
  const uid = parseInt(query.uid);
  if (uid !== uid) { // NaN
    throw new this.FormatError();
  }
  
  return ctx.query('SELECT u.name, u.uid, ds.* ' +
    'FROM stocks AS s ' +
    'JOIN depot_stocks AS ds ON ds.stockid = s.stockid ' +
    'JOIN users AS u ON ds.uid = u.uid ' +
    'WHERE s.leader = ?', [uid]).then(res => {
    
    /* backwards compatibility */
    for (let i = 0; i < res.length; ++i) {
      res[i].id = res[i].uid;
    }
    
    return { code: 'get-followers-success', results: res };
  });
}));

/**
 * Return various server statistics information.
 * 
 * @param {boolean} qctxDebug  Whether to include debugging information on the local QContexts
 * 
 * @return {object} Returns with <code>get-server-statistics-success</code> or
 *                  a common error code and, in case of success, sets
 *                  <code>.servers</code> to an array of results of
 *                  calls to {@link busreq~internalServerStatistics}.
 * 
 * @function c2s~get-server-statistics
 */
Admin.prototype.getServerStatistics = buscomponent.provideQT('client-get-server-statistics', _reqpriv('userdb', function(query) {
  debug('Requesting server statistics');
  
  return this.requestGlobal({name: 'internalServerStatistics', qctxDebug: query.qctxDebug ? 1 : 0}).then(replies => {
    return { code: 'get-server-statistics-success', servers: replies };
  });
}));

/**
 * Returns game usage statistics.
 * 
 * This is likely to be subjected to larger modifications due to #270.
 * 
 * @param {?int} query.ndays  Number of days to look into the past. Default 365.
 * 
 * @return {object} Returns with <code>get-ticks-statistics</code> or
 *                  a common error code and, in case of success, sets
 *                  <code>.results</code> appropiately.
 * 
 * @function c2s~get-ticks-statistics
 */
Admin.prototype.getTicksStatistics = buscomponent.provideQT('client-get-ticks-statistics', _reqpriv('userdb', function(query, ctx) {
  const now = Math.floor(Date.now() / 1000);
  const todayStart = now - now % 86400;
  const ndays = parseInt(query.ndays) || 365;
  const timespanStart = todayStart - ndays * 86400;
  const dt = 300;
  
  debug('Fetching ticks statistics');
  
  return ctx.query('SELECT FLOOR(time/?)*? AS timeindex, SUM(ticks) AS ticksum, COUNT(ticks) AS tickcount ' +
    'FROM tickshistory ' +
    'WHERE time >= ? AND time < ? ' +
    'GROUP BY timeindex',
    [dt, dt, timespanStart, todayStart]).then(res => {
    return { code: 'get-ticks-statistics-success', results: res };
  });
}));

/**
 * Returns a per-day histogram of event frequency.
 * 
 * @param {?int} query.ndays  Number of days to look into the past. Default 365.
 * @param {?Array} query.types  List of event types to filer for.
 * 
 * @return {object} Returns with <code>get-event-histogram-success</code> or a common error code
 *                  and populates <code>.result</code> with information about event frequency.
 * 
 * @function c2s~get-event-statistics
 */
Admin.prototype.getEventStatistics = buscomponent.provideQT('client-get-event-statistics', _reqpriv('feed', function(query, ctx) {
  const now = Math.floor(Date.now() / 1000);
  const todayEnd = now - (now % 86400) + 86400;
  const ndays = parseInt(query.ndays) || 365;
  const timespanStart = todayEnd - ndays * 86400;
  const types = Array.from(query.types || []).map(String);
  
  return ctx.query('SELECT FLOOR(time/?)*? AS timeindex, COUNT(eventid) AS nevents, COUNT(DISTINCT srcuser) AS nuser ' +
    'FROM events ' +
    'WHERE time >= ? ' +
    (types.length > 0 ? 'AND type IN (' + types.map(() => '?').join(',') + ') ' : ' ') +
    'GROUP BY timeindex',
    [86400, 86400, timespanStart].concat(types)).then(res => {
    return { code: 'get-event-statistics-success', result: res };
  });
}));

exports.Admin = Admin;
