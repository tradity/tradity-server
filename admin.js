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

const parentPath = require('./lib/parentpath.js');
const assert = require('assert');
const debug = require('debug')('sotrade:admin');
const api = require('./api.js');
const promiseUtil = require('./lib/promise-util.js');
const spread = promiseUtil.spread;

class ListAllUsers extends api.Requestable {
  constructor() {
    super({
      url: '/users',
      methods: ['GET'],
      returns: [
        { code: 200 }
      ],
      requiredAccess: 'userdb',
      description: 'Returns all users and tons of information on them.'
    });
  }
  
  handle(query, ctx) {
    return ctx.query('SELECT birthday, deletiontime, street, zipcode, town, `desc`, users.name, giv_name, fam_name, ' +
      'users.uid, tradecount, email, email_verif AS emailverif, ' +
      'wprovision, lprovision, freemoney, totalvalue, wprov_sum, lprov_sum, registertime, lang, ' +
      'schools.path AS schoolpath, schools.schoolid, schoolclass, pending, jointime, ' +
      '(SELECT COUNT(*) FROM ecomments WHERE ecomments.commenter=users.uid) AS commentcount, '+
      '(SELECT MAX(time) FROM ecomments WHERE ecomments.commenter=users.uid) AS lastcommenttime FROM users ' +
      'JOIN users_data ON users.uid = users_data.uid ' +
      'JOIN users_finance ON users.uid = users_finance.uid ' +
      'LEFT JOIN schoolmembers AS sm ON sm.uid = users.uid ' +
      'LEFT JOIN schools ON schools.schoolid = sm.schoolid ').then(userlist => {
      return { code: 200, data: userlist };
    });
  }
}

class ListAllEvents extends api.Requestable {
  constructor() {
    super({
      url: '/events/all',
      methods: ['GET'],
      returns: [
        { code: 200 }
      ],
      requiredAccess: 'feed',
      description: 'Returns a list of all events for a given timespan.',
      depends: ['FeedFetcher']
    });
  }
  
  handle(query, ctx) {
    return this.load('FeedFetcher').fetch(query, ctx.clone())
      .then(evlist => ({ code: 200, data: evlist }));
  }
}

// XXX make impersonation *and* privileges permanent
class ImpersonateUser extends api.Requestable {
  constructor() {
    super({
      url: '/impersonate/:uid',
      methods: ['POST'],
      returns: [
        { code: 200 },
        { code: 404, identifier: 'user-not-found' }
      ],
      writing: true,
      schema: {
        type: 'object',
        properties: {
          uid: {
            type: 'integer',
            description: 'The user id to assign to the current session.'
          }
        },
        required: ['uid']
      },
      requiredAccess: 'server',
      description: 'Change the session user id.'
    });
  }
  
  handle(query, ctx) {
    const uid = query.uid;
    
    debug('Admin impersonation', ctx.user.uid, uid);
    
    return ctx.query('SELECT COUNT(*) AS c FROM users WHERE uid = ? LOCK IN SHARE MODE', [uid]).then(r => {
      assert.equal(r.length, 1);
      if (r[0].c === 0) {
        throw new this.ClientError('user-not-found');
      }
    
      return ctx.query('UPDATE sessions SET uid = ? WHERE id = ?', [uid, ctx.user.sid]);
    }).then(() => {
      return { code: 200, repush: true };
    });
  }
}

class DeleteUser extends api.Requestable {
  constructor() {
    super({
      url: '/user/:uid',
      methods: ['DELETE'],
      returns: [
        { code: 204 },
        { code: 403, identifier: 'self-not-allowed' },
      ],
      transactional: true,
      schema: {
        type: 'object',
        properties: {
          uid: {
            type: 'integer',
            description: 'Removes data for a given user from the database.'
          }
        },
        required: ['uid']
      },
      requiredAccess: 'userdb',
      description: 'Removes data for a given user from the database.'
    });
  }
  
  handle(query, ctx) {
    const uid = query.uid;
    
    if (ctx.user.uid === uid) {
      throw new this.ClientError('self-not-allowed');
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
    ]).then(() => {
      return { code: 204 };
    });
  }
}

class ChangeUserEmail extends api.Requestable {
  constructor() {
    super({
      url: '/user/:uid/email',
      methods: ['PUT'],
      returns: [
        { code: 204 }
      ],
      writing: true,
      schema: {
        type: 'object',
        properties: {
          uid: {
            type: 'integer',
            description: 'Removes data for a given user from the database.'
          },
          email: {
            type: 'string',
            description: 'The new e-mail address'
          },
          emailverif: {
            type: 'boolean',
            description: 'If truthy, automatically mark the e-mail address as verified.'
          }
        },
        required: ['uid', 'email', 'emailverif']
      },
      requiredAccess: 'userdb',
      description: 'Removes data for a given user from the database.'
    });
  }
  
  handle(query, ctx) {
    const uid = query.uid;
    
    return ctx.query('UPDATE users SET email = ?, email_verif = ? WHERE uid = ?',
      [String(query.email), query.emailverif ? 1 : 0, uid]).then(() => {
      return { code: 204 };
    });
  }
}

class ChangeCommentText extends api.Requestable {
  constructor() {
    super({
      url: '/events/comments/:commentid',
      methods: ['PUT'],
      returns: [
        { code: 204 }
      ],
      writing: true,
      schema: {
        type: 'object',
        properties: {
          commentid: {
            type: 'integer',
            description: 'The numerical id of the target comment'
          },
          comment: {
            type: 'string',
            description: 'The new comment text'
          },
          cstate: {
            type: 'string',
            description: 'The new comment state'
          },
          trustedhtml: {
            type: 'boolean',
            description: 'If truthy, the new text is HTML-formatted.'
          }
        },
        required: ['commentid', 'comment', 'cstate', 'trustedhtml']
      },
      requiredAccess: 'moderate',
      description: 'Changes the text and status of a comment.'
    });
  }
  
  handle(query, ctx) {
    return ctx.query('UPDATE ecomments SET comment = ?, trustedhtml = ?, cstate = ? WHERE commentid = ?',
      [String(query.comment),
       ctx.access.has('server') && query.trustedhtml ? 1:0,
       String(query.cstate || ''), parseInt(query.commentid)]).then(() => {
      return { code: 204 };
    });
  }
}

class NotificationsUnstickAll extends api.Requestable {
  constructor() {
    super({
      url: '/mod-notifications/unstick-all',
      methods: ['POST'],
      returns: [
        { code: 204 }
      ],
      writing: true,
      requiredAccess: 'moderate',
      description: 'Remove the `sticky` flag from all notifications.'
    });
  }
  
  handle(query, ctx) {
    return ctx.query('UPDATE mod_notif SET sticky = 0').then(() => {
      return { code: 204 };
    });
  }
}

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

/** */
class NotificationsPost extends api.Requestable {
  constructor() {
    super({
      url: '/mod-notifications',
      methods: ['POST'],
      returns: [
        { code: 204 }
      ],
      schema: {
        type: 'object',
        properties: {
          content: {
            type: 'string',
            description: 'The message to be displayed'
          },
          sticky: {
            type: 'boolean',
            description: 'If truthy, display the message on top of each feed.'
          }
        },
        required: ['content', 'sticky']
      },
      writing: true,
      requiredAccess: 'moderate',
      description: 'Inserts a message into all user feeds.'
    });
  }
  
  handle(query, ctx) {
    return ctx.query('INSERT INTO mod_notif (content, sticky) VALUES (?, ?)',
      [String(query.content), query.sticky ? 1 : 0]).then(res => {
      return ctx.feed({
        'type': 'mod-notification',
        'targetid': res.insertId,
        'srcuser': ctx.user.uid,
        'everyone': true
      });
    }).then(() => ({ code: 204 }));
  }
}

class RenameSchool extends api.Requestable {
  constructor() {
    super({
      url: '/school/:schoolid/name',
      methods: ['PUT'],
      returns: [
        { code: 204 },
        { code: 404, identifier: 'school-not-found' },
        { code: 404, identifier: 'parent-not-found' },
        { code: 403, identifier: 'already-exists' }
      ],
      schema: {
        type: 'object',
        properties: {
          schoolid: {
            type: 'integer',
            description: 'A school id to operate on'
          },
          schoolpath: {
            type: 'string',
            description: 'The school’s new path (will be converted to lowercase)'
          },
          schoolname: {
            type: 'string',
            description: 'The school’s new human-readable name'
          }
        },
        required: ['schoolid', 'schoolpath', 'schoolname']
      },
      transactional: true,
      requiredAccess: 'schooldb',
      description: 'Changes a school’s name and/or path.',
      notes: 'This is also the proper way to change a group’s supergroup.'
    });
  }
  
  handle(query, ctx) {
    query.schoolpath = String(query.schoolpath || '/').toLowerCase();
    
    let oldpath;
    return ctx.query('SELECT path FROM schools WHERE schoolid = ? FOR UPDATE', [parseInt(query.schoolid)]).then(r => {
      if (r.length === 0) {
        throw new this.ClientError('school-not-found');
      }
      
      oldpath = r[0].path;
      assert.ok(oldpath);
      assert.ok(oldpath.length > 1);

      return ctx.query('SELECT COUNT(*) AS c FROM schools WHERE path = ? LOCK IN SHARE MODE',
        [parentPath(query.schoolpath)]);
    }).then(pr => {
      assert.equal(pr.length, 1);
      if (pr[0].c !== (parentPath(query.schoolpath) !== '/' ? 1 : 0)) {
        throw new this.ClientError('parent-not-found');
      }
      
      return ctx.query('SELECT path FROM schools WHERE path = ? FOR UPDATE', [query.schoolpath]);
    }).then(er => {
      if (query.schoolpath !== '/' && er.length > 0 && er[0].path.toLowerCase() === query.schoolpath) {
        throw new this.ClientError('already-exists');
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
      return { code: 204 };
    });
  }
}

class MergeSchools extends api.Requestable {
  constructor() {
    super({
      url: '/school/:masterschool/merge/:subschool',
      methods: ['POST'],
      returns: [
        { code: 204 },
        { code: 404, identifier: 'school-not-found' },
        { code: 403, identifier: 'different-parents' },
        { code: 403, identifier: 'no-subschools-allowed' }
      ],
      schema: {
        type: 'object',
        properties: {
          masterschool: {
            type: ['integer', 'null'],
            description: 'The numerical id of the target school'
          },
          subschool: {
            type: 'integer',
            description: 'The numerical id of the source school'
          }
        },
        required: ['subschool']
      },
      transactional: true,
      requiredAccess: 'schooldb',
      description: 'Merges two schools into a large school.',
      notes: 'These schools need to have the same parent school.'
    });
  }
  
  handle(query, ctx) {
    query.masterschool = parseInt(query.masterschool);
    query.subschool    = parseInt(query.subschool);
    
    if (query.masterschool !== query.masterschool) {
      query.masterschool = null;
    }
    
    return Promise.all([
      ctx.query('SELECT path FROM schools WHERE schoolid = ? LOCK IN SHARE MODE', [query.masterschool]),
      ctx.query('SELECT path FROM schools WHERE schoolid = ? FOR UPDATE', [query.subschool]),
    ]).then(spread((mr, sr) => {
      assert.ok(mr.length <= 1);
      assert.ok(sr.length <= 1);
      
      if (sr.length === 0 || ((mr.length === 0 || mr[0].path === sr[0].path) && query.masterschool !== null)) {
        throw new this.ClientError('school-not-found');
      }
      
      if (mr.length > 0 && parentPath(mr[0].path) !== parentPath(sr[0].path)) {
        throw new this.ClientError('different-parents');
      }
      
      if (query.masterschool === null) {
        return ctx.query('SELECT COUNT(*) AS c FROM schools WHERE path LIKE ?', [sr[0].path + '/%']).then(ssr => {
          assert.equal(ssr.length, 1);
          
          if (ssr[0].c > 0) {
            throw new this.ClientError('no-subschools-allowed');
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
    })).then(() => {
      return ctx.query('DELETE FROM schools WHERE schoolid = ?', [query.subschool]);
    }).then(() => {
      return { code: 204 };
    });
  }
}

class ListFollowers extends api.Requestable {
  constructor() {
    super({
      url: '/user/:lookfor/followers',
      methods: ['GET'],
      returns: [
        { code: 200 }
      ],
      schema: {
        type: 'object',
        properties: {
          uid: {
            type: 'integer',
            description: 'The numerical id of the leader to be inspected'
          }
        },
        required: ['uid']
      },
      requiredAccess: 'userdb',
      description: 'Return all current followers of a given leader account.'
    });
  }
  
  handle(query, ctx) {
    return ctx.query('SELECT u.name, u.uid, ds.* ' +
      'FROM stocks AS s ' +
      'JOIN depot_stocks AS ds ON ds.stockid = s.stockid ' +
      'JOIN users AS u ON ds.uid = u.uid ' +
      'WHERE s.leader = ?', [query.uid]).then(res => {
      return { code: 200, data: res };
    });
  }
}

class TickStatistics extends api.Requestable {
  constructor() {
    super({
      url: '/activity/ticks',
      methods: ['GET'],
      returns: [
        { code: 200 }
      ],
      schema: {
        type: 'object',
        properties: {
          ndays: {
            type: 'integer',
            description: 'Number of days to look into the past. Defaults to 365.'
          }
        },
        required: []
      },
      requiredAccess: 'userdb',
      description: 'Returns game usage statistics.'
    });
  }
  
  handle(query, ctx) {
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
      return { code: 200, data: res };
    });
  }
}

class EventStatistics extends api.Requestable {
  constructor() {
    super({
      url: '/activity/events',
      methods: ['GET'],
      returns: [
        { code: 200 }
      ],
      schema: {
        type: 'object',
        properties: {
          ndays: {
            type: 'integer',
            description: 'Number of days to look into the past. Defaults to 365.'
          },
          types: {
            type: 'string',
            description: 'Comma-separated list of event types to filer for'
          }
        },
        required: []
      },
      requiredAccess: 'feed',
      description: 'Returns a per-day histogram of event frequency.'
    });
  }
  
  handle(query, ctx) {
    const now = Math.floor(Date.now() / 1000);
    const todayEnd = now - (now % 86400) + 86400;
    const ndays = parseInt(query.ndays) || 365;
    const timespanStart = todayEnd - ndays * 86400;
    const types = String(query.types || '').split(',');
    
    return ctx.query('SELECT FLOOR(time/?)*? AS timeindex, COUNT(eventid) AS nevents, COUNT(DISTINCT srcuser) AS nuser ' +
      'FROM events ' +
      'WHERE time >= ? ' +
      (types.length > 0 ? 'AND type IN (' + types.map(() => '?').join(',') + ') ' : ' ') +
      'GROUP BY timeindex',
      [86400, 86400, timespanStart].concat(types)).then(res => {
      return { code: 200, data: res };
    });
  }
}

exports.components = [
  ListAllUsers,
  ListAllEvents,
  ImpersonateUser,
  DeleteUser,
  ChangeUserEmail,
  ChangeCommentText,
  NotificationsUnstickAll,
  NotificationsPost,
  RenameSchool,
  MergeSchools,
  ListFollowers,
  TickStatistics,
  EventStatistics
];
