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
const deepupdate = require('./lib/deepupdate.js');
const _ = require('lodash');
const assert = require('assert');
const debug = require('debug')('sotrade:schools');
const api = require('./api.js');
const promiseUtil = require('./lib/promise-util.js');
const spread = promiseUtil.spread;

class SchoolUtilRequestable extends api.Requestable {
  constructor(opt) {
    super(opt);
  }
  
  // XXX This would best be implemented using a Decorator
  /**
   * Helper function to indicate that a client request requires school admin privileges
   * 
   * @param {boolean} [soft=false]   If this is set to true, the request does not fail with a
   *                                 <code>permission-denied</code> error if the <code>schoolid</code> property
   *                                 is not set.
   *                                 This is useful when a request does not always require privileges
   *                                 but rather only when it is applied to a school.
   * @param {Array} [status] Passed to `isSchoolAdmin`
   */
  requireSchoolAdmin(query, ctx, soft, status) {
    soft = soft || false;
    
    if (soft && !query.schoolid) {
      return;
    }
    
    return this.isSchoolAdmin(ctx, status, schoolid).then(schoolAdminResult => {
      if (!schoolAdminResult.ok) {
        throw new this.PermissionDenied(); // XXX
      }
      
      // in the case that schoolid was not numerical before
      query.schoolid = schoolAdminResult.schoolid;
    });
  }
  
  /**
   * Tests a user (precisely, a {@link module:qctx~QContext}) for school/group admin privileges.
   * 
   * @param {module:qctx~QContext} ctx  The query context whose user and access patterns are to be checked.
   * @param {?Array} status   A list of acceptable user status to be considered “admin”-Like.
   * @param {int} schoolid    The id of the schools whose admin tables are to be checked.
   *
   * @return {object}  Returns a Promise returning <code>{ ok: true, schoolid: … }</code> when successful,
   *                          otherwise with <code>{ ok: false, schoolid: null }</code>.
   */
  isSchoolAdmin(ctx, status, schoolid) {
    return (parseInt(schoolid) === parseInt(schoolid) ? Promise.resolve([{schoolid: schoolid}]) :
      ctx.query('SELECT schoolid FROM schools WHERE ? IN (schoolid, name, path)', [schoolid]))
    .then(res => {
      if (res.length === 0) {
        return {ok: false, schoolid: null};
      }
      
      assert.equal(res.length, 1);
      
      schoolid = res[0].schoolid;
      
      if (ctx.access.has('schooldb')) {
        return {ok: true, schoolid: schoolid};
      }
        
      status = status || ['admin', 'xadmin'];
      
      return this.loadSchoolAdmins(schoolid, ctx).then(admins => {
        const isAdmin = (admins.filter(a => {
          return status.indexOf(a.status) !== -1 && a.adminid === ctx.user.uid;
        }).length > 0);
        return {ok: isAdmin, schoolid: isAdmin ? schoolid : null};
      });
    });
  }

  /**
   * Load a list of admins for a given school/group.
   * 
   * @param {int} schoolid  The numerical id for the school.
   * @param {module:qctx~QContext} ctx  A QContext to provide database access
   * @return {object}  A Promise for a complete list of school admins and associated metadata.
   */
  loadSchoolAdmins(schoolid, ctx) {
    return ctx.query('SELECT sa.schoolid AS schoolid, sa.uid AS adminid, sa.status AS status, users.name AS adminname ' +
      'FROM schools AS c ' +
      'JOIN schools AS p ON c.path LIKE CONCAT(p.path, "%") OR p.schoolid = c.schoolid ' +
      'JOIN schooladmins AS sa ON sa.schoolid = p.schoolid ' +
      'JOIN users ON users.uid = sa.uid ' +
      'WHERE c.schoolid = ?', [parseInt(schoolid)]);
  }

  /**
   * Load all relevant public info for a given school
   * 
   * @param {(int|string)} lookfor  A school id or path to use for searching the group.
   * @param {module:qctx~QContext} ctx  A context to provide database access.
   * @param {object} cfg  The server base config.
   * 
   * @return {object}  A Promise for a { code: …, schoolinfo: … / null } object
   * 
   * @function module:schools~Schools#loadSchoolInfo
   */
  loadSchoolInfo(lookfor, ctx, cfg) {
    debug('Load school info', lookfor);
    
    let s;
    return ctx.query('SELECT schools.schoolid, schools.name, schools.path, descpage, config, eventid, type, targetid, time, srcuser, url AS banner '+
      'FROM schools ' +
      'LEFT JOIN events ON events.targetid = schools.schoolid AND events.type = "school-create" ' +
      'LEFT JOIN httpresources ON httpresources.groupassoc = schools.schoolid AND httpresources.role = "schools.banner" ' +
      'WHERE ? IN (schools.schoolid, schools.path, schools.name) ' + 
      'LIMIT 1', [String(lookfor)]).then(res => {
      if (res.length === 0) {
        throw new this.ClientError('not-found');
      }
      
      s = res[0]; 
      s.parentPath = null;
      
      assert.ok(s.eventid);
      
      if (s.config === '') {
        s.config = {};
      } else {
        s.config = JSON.parse(s.config);
      }
        
      assert.ok(s.config);
      
      return Promise.all([
        this.loadSchoolAdmins(s.schoolid, ctx), // admins
        ctx.query('SELECT * FROM schools AS c WHERE c.path LIKE ?', [s.path + '/%']), // subschools
        ctx.query('SELECT COUNT(uid) AS usercount ' +
          'FROM schools AS p '+
          'LEFT JOIN schools AS c ON c.path LIKE CONCAT(p.path, "/%") OR p.schoolid = c.schoolid ' +
          'LEFT JOIN schoolmembers AS sm ON sm.schoolid = c.schoolid AND NOT pending ' +
          'WHERE p.schoolid = ?', [s.schoolid]), // usercount[0].usercount
        ctx.query('SELECT c.*, u.name AS username, u.uid, url AS profilepic, trustedhtml ' +
          'FROM ecomments AS c '+
          'LEFT JOIN users AS u ON c.commenter = u.uid ' +
          'LEFT JOIN httpresources ON httpresources.uid = c.commenter AND httpresources.role = "profile.image" '+
          'WHERE c.eventid = ?',
          [s.eventid]), // comments
        ctx.query('SELECT * FROM blogposts ' +
          'JOIN feedblogs ON feedblogs.blogid = blogposts.blogid ' +
          'JOIN events ON events.targetid = blogposts.postid AND events.type="blogpost" ' +
          'WHERE feedblogs.schoolid = ?',
          [s.schoolid]).then(blogposts => {
            return blogposts.map(post => {
              const expost = _.extend(post, JSON.parse(post.postjson));
              delete expost.postjson;
              return expost;
            });
          }), // blogposts
        ctx.query('SELECT oh.stocktextid, oh.stockname, ' +
          'SUM(ABS(money)) AS moneysum, ' +
          'SUM(ABS(money) / (UNIX_TIMESTAMP() - buytime + 300)) AS wsum ' +
          'FROM orderhistory AS oh ' +
          'JOIN schoolmembers AS sm ON sm.uid = oh.uid AND sm.jointime < oh.buytime AND sm.schoolid = ? ' +
          'WHERE buytime > UNIX_TIMESTAMP() - 86400 * ? ' +
          'GROUP BY stocktextid ORDER BY wsum DESC LIMIT 10', [s.schoolid, cfg.popularStocksDays]), // popularStocks
        !ctx.access.has('wordpress') ? [] : 
          // compare wordpress-feed.js
          ctx.query('SELECT feedblogs.blogid, endpoint, category, schools.schoolid, path AS schoolpath, ' +
            'bloguser, COUNT(*) AS postcount, users.name ' +
            'FROM feedblogs ' + 
            'LEFT JOIN blogposts ON feedblogs.blogid = blogposts.blogid ' +
            'LEFT JOIN users ON feedblogs.bloguser = users.uid ' +
            'LEFT JOIN schools ON feedblogs.schoolid = schools.schoolid ' +
            'WHERE schools.schoolid = ? ' +
            'GROUP BY blogid', [s.schoolid]), // feedblogs
        Promise.resolve().then(() => {
          if (s.path.replace(/[^\/]/g, '').length !== 1) { // need higher-level 
            s.parentPath = commonUtil.parentPath(s.path);
          }
          
          return s.parentPath ? this.loadSchoolInfo(s.parentPath, ctx, cfg) :
            Promise.resolve({schoolinfo: null});
        }) // parentResult
      ]);
    }).then(spread((admins, subschools, usercount, comments, blogposts, popularStocks, feedblogs, parentResult) => {
      s.admins = admins;
      s.subschools = subschools;
      s.usercount = usercount[0].usercount;
      s.blogposts = blogposts;
      s.popularStocks = popularStocks;
      s.feedblogs = feedblogs;
      s.comments = comments.map(c => {
        c.isDeleted = ['gdeleted', 'mdeleted'].indexOf(c.cstate) !== -1;
        return c;
      });
      
      assert.ok(typeof parentResult.code === 'undefined' || parentResult.code === 'get-school-info-success');
      
      s.parentSchool = parentResult;
      s.config = deepupdate({}, cfg.schoolConfigDefaults,
        s.parentSchool ? s.parentSchool.config : {}, s.config);
      
      return { code: 200, schoolinfo: s };
    }));
  }
}

/**
 * A school info object (specializes {@link Event}), as returned by {@link c2s~get-school-info}
 * 
 * @typedef module:schools~schoolinfo
 * @type {object}
 * 
 * @property {int} id  A numerical school id.
 * @property {string} name  A human-readable name for the school/group.
 * @property {string} path  A machine-readable path for the school/group, indicating its supergroups’ paths.
 * @property {string} descpage  A human-readable description of the school/group, usually written by its administrators.
 * @property {object} config  A config for the school containing various parameters, e.g. ranking information.
 * @property {int} eventid  The event for the school creation. Useful for writing comments on the pinboard.
 * @property {string} type  The event type for the school creation (<code>school-create</code>).
 * @property {int} targetid  The school id.
 * @property {int} time  The school creation time.
 * @property {string} banner  The public school banner.
 * @property {int} usercount  The number of school members.
 * @property {Comment[]} comments  The school “pinboard” (i.e. comments on the school creation event).
 * @property {Blogpost[]} blogposts  The school “blogposts” (Associated Wordpress blog posts).
 * @property {module:schools~schoolinfo[]} subschools  A list of subschools of this school
 *                                                     (in short notation, i.e. no event/comment information etc.).
 * @property {string} parentPath  The parent path of this school, or '/' if this school is top-level.
 * @property {object[]} popularStocks  See {@link c2s~list-popular-stocks}.
 * @property {object[]} feedblogs  See {@link c2s~list-wordpress-feeds}.
 */

/** */
class GetSchoolInfo extends SchoolUtilRequestable {
  constructor() {
    super({
      identifier: 'GetSchoolInfo',
      url: '/school/:lookfor',
      methods: ['GET'],
      returns: [
        { code: 200 },
        { code: 404, identifier: 'not-found' }
      ],
      schema: {
        type: 'object',
        properties: {
          lookfor: { type: ['string', 'integer'] }
        },
        required: ['lookfor']
      },
      description: 'Load all relevant public info for a given school.'
    });
  }
  
  handle(query, ctx, cfg) {
    return this.loadSchoolInfo(query.lookfor, ctx, cfg).then(result => {
      return { code: 200, data: result.schoolinfo };
    });
  }
}

class SchoolExists extends SchoolUtilRequestable {
  constructor() {
    super({
      url: '/school-exists/:lookfor',
      methods: ['GET'],
      returns: [
        { code: 200 },
      ],
      schema: {
        type: 'object',
        properties: {
          lookfor: { type: ['string', 'integer'] }
        },
        required: ['lookfor']
      },
      description: 'Check for the existence of a given school path/id/name.'
    });
  }
  
  handle(query, ctx) {
    return ctx.query('SELECT schoolid, path FROM schools WHERE ? IN (schoolid, path, name) OR LOWER(?) IN (schoolid, path, name)',
      [String(query.lookfor), String(query.lookfor)]).then(res => {
      return {
        code: 'school-exists-success',
        exists: res.length > 0,
        path: res.length > 0 ? res[0].path : null,
        schoolid: res.length > 0 ? res[0].schoolid : null
      };
    });
  }
}

class ChangeSchoolDescription extends SchoolUtilRequestable {
  constructor() {
    super({
      url: '/school/:schoolid/description',
      methods: ['PUT'],
      returns: [
        { code: 204 },
      ],
      writing: true,
      schema: {
        type: 'object',
        properties: {
          schoolid: {
            type: 'integer',
            description: 'A school id to operate on'
          },
          descpage: {
            type: 'string',
            description: 'A human-readable description of the school/group for display at a later time'
          }
        },
        required: ['schoolid', 'descpage']
      },
      description: 'Changes a school description text.'
    });
  }
  
  handle(query, ctx) {
    this.requireSchoolAdmin(query, ctx).then(() => {
      return ctx.query('UPDATE schools SET descpage = ? WHERE schoolid = ?',
        [String(query.descpage), query.schoolid]);
    }).then(() => ({ code: 204 }));
  }
}

class ChangeMemberStatus extends SchoolUtilRequestable {
  constructor() {
    super({
      url: '/school/:schoolid/members/:uid',
      methods: ['PUT'],
      transactional: true,
      returns: [
        { code: 204 },
      ],
      schema: {
        type: 'object',
        properties: {
          schoolid: {
            type: 'integer',
            description: 'A school id to operate on'
          },
          uid: {
            type: 'integer'
          },
          status: {
            type: 'string',
            description: 'If `member`, removes all admin status. Otherwise (esp. for `admin`), ' +
              'marks the given user as a school/group admin'
          }
        },
        required: ['schoolid', 'uid', 'status']
      },
      description: 'Makes a school member non-pending and, optionally, awards or removes admin status.'
    });
  }
  
  handle(query, ctx) {
    this.requireSchoolAdmin(query, ctx).then(() => {
      const uid = query.uid;
      const schoolid = query.schoolid;
      
      return ctx.query('UPDATE schoolmembers SET pending = 0 WHERE schoolid = ? AND uid = ?',
        [uid, schoolid]);
    }).then(() => {
      if (query.status === 'member') {
        return ctx.query('DELETE FROM schooladmins WHERE uid = ? AND schoolid = ?',
          [uid, schoolid]);
      } else {
        return ctx.query('REPLACE INTO schooladmins (uid, schoolid, status) VALUES(?, ?, ?)',
          [uid, schoolid, String(query.status)]);
      }
    }).then(() => {
      return { code: 204 };
    });
  }
}

class DeleteComment extends SchoolUtilRequestable {
  constructor() {
    super({
      url: '/school/:schoolid/comments/:commentid',
      methods: ['DELETE'],
      transactional: true,
      returns: [
        { code: 204 },
      ],
      schema: {
        type: 'object',
        properties: {
          schoolid: {
            type: 'integer',
            description: 'A school id to operate on'
          },
          commentid: {
            type: 'integer',
            description: 'The numeric id of the comment to delete.'
          }
        },
        required: ['schoolid', 'commentid']
      },
      description: 'Deletes a comment (replaces the text with a notice).'
    });
  }
  
  handle(query, ctx) {
    this.requireSchoolAdmin(query, ctx).then(() => {
      return ctx.query('SELECT c.commentid AS cid FROM ecomments AS c ' +
        'JOIN events AS e ON e.eventid = c.eventid ' +
        'WHERE c.commentid = ? AND e.targetid = ? AND e.type = "school-create"',
        [parseInt(query.commentid), parseInt(query.schoolid)]);
    }).then(res => {
      if (res.length === 0) {
        throw new this.PermissionDenied();
      }
      
      assert.ok(res.length === 1);
      assert.ok(res[0].cid === query.commentid);
      
      return ctx.query('UPDATE ecomments SET cstate = "gdeleted" WHERE commentid = ?',
        [parseInt(query.commentid)]);
    }).then(() => {
      return { code: 204 };
    });
  }
}

class KickUser extends SchoolUtilRequestable {
  constructor() {
    super({
      url: '/school/:schoolid/members/:uid',
      methods: ['DELETE'],
      transactional: true,
      returns: [
        { code: 204 },
      ],
      schema: {
        type: 'object',
        properties: {
          schoolid: {
            type: 'integer',
            description: 'A school id to operate on'
          },
          uid: {
            type: 'integer',
            description: 'The numeric id of the user to remove.'
          }
        },
        required: ['schoolid', 'uid']
      },
      description: 'Removes a user from the school member list.'
    });
  }
  
  handle(query, ctx) {
    return this.requireSchoolAdmin(query, ctx).then(() => {
      const uid = query.uid;
      const schoolid = query.schoolid;
      
      return ctx.query('DELETE FROM schoolmembers WHERE uid = ? AND schoolid = ?', 
        [uid, schoolid]);
    }).then(() => {
      return ctx.query('DELETE FROM schooladmins WHERE uid = ? AND schoolid = ?', 
        [uid, schoolid]);
    }).then(() => {
      return { code: 204 };
    });
  }
}

/**
 * Informs users that a new group/school has been created.
 * 
 * @typedef s2c~school-create
 * @type {Event}
 * 
 * @property {int} schoolid  The numerical ID of the new school
 * @property {string} schoolname  The human-readable name of the new school
 * @property {string} schoolpath  The new school’s path indicating its place in the
 *                                school tree
 */

/** */
class CreateSchool extends api.Requestable {
  constructor() {
    super({
      url: '/school',
      methods: ['POST'],
      transactional: true,
      returns: [
        { code: 200 },
        { code: 403, identifier: 'already-exists' },
        { code: 404, identifier: 'missing-parent' }
      ],
      schema: {
        type: 'object',
        properties: {
          schoolpath: {
            type: 'string',
            description: 'The path for the new school',
            notes: 'If not given, a path will be generated from the school’s name.\n' + 
              'Note that this indicates potential parent groups.'
          },
          schoolname: {
            type: 'string',
            description: 'A human-readable identifier of the school.'
          }
        },
        required: ['schoolname']
      },
      description: 'Creates a new school.'
    });
  }
  
  handle(query, ctx) {
    query.schoolname = String(query.schoolname || '');
    
    if (!query.schoolpath) {
      query.schoolpath = '/' + query.schoolname.toLowerCase().replace(/[^\w_-]/g, '');
    }
      
    return ctx.query('SELECT COUNT(*) AS c FROM schools WHERE path = ?', [String(query.schoolpath)]).then(r => {
      assert.equal(r.length, 1);
      if (r[0].c === 1 || !query.schoolname.trim() || 
        !/^(\/[\w_-]+)+$/.test(query.schoolpath)) {
        throw new this.ClientError('already-exists');
      }
      
      if (String(query.schoolpath).replace(/[^\/]/g, '').length === 1) {
        return [{c: 1}];
      } else {
        return ctx.query('SELECT COUNT(*) AS c FROM schools WHERE path = ?',
        [commonUtil.parentPath(String(query.schoolpath))]);
      }
    }).then(r => {
      assert.equal(r.length, 1);
      
      if (r[0].c !== 1) {
        throw new this.ClientError('missing-parent');
      }
      
      return ctx.query('INSERT INTO schools (name, path) VALUES(?, ?)',
        [String(query.schoolname), String(query.schoolpath)]);
    }).then(res => {
      return ctx.feed({
        'type': 'school-create',
        'targetid': res.insertId,
        'srcuser': ctx.user.uid
      });
    }).then(() => {
      return { code: 200, path: String(query.schoolpath) };
    });
  }
}

class ListSchools extends api.Requestable {
  constructor() {
    super({
      url: '/schools',
      methods: ['GET'],
      returns: [
        { code: 200 }
      ],
      schema: {
        type: 'object',
        properties: {
          parentPath: {
            type: 'string',
            description: 'Enumerate only subgroups of the one specified via this path'
          },
          search: {
            type: 'string',
            description: 'Search group paths and names for this string'
          }
        },
        required: []
      },
      description: 'Creates a new school.'
    });
  }
  
  handle(query, ctx) {
    query.parentPath = String(query.parentPath || '').toLowerCase();
    
    let where = 'WHERE 1 ';
    let params = [];
    if (query.parentPath) {
      where = 'AND p.path LIKE ? OR p.path = ? ';
      params.push(query.parentPath + '/%', query.parentPath);
    }
    
    if (query.search) {
      const likestring = '%' + (String(query.search)).replace(/%/g, '\\%') + '%';
      
      where += 'AND (p.name LIKE ? OR p.path LIKE ?) ';
      params.push(likestring, likestring);
    }
    
    return ctx.query('SELECT p.schoolid, p.name, COUNT(sm.uid) AS usercount, p.path, url AS banner ' +
      'FROM schools AS p '+
      'LEFT JOIN schools AS c ON c.path LIKE CONCAT(p.path, "/%") OR p.schoolid = c.schoolid ' +
      'LEFT JOIN schoolmembers AS sm ON sm.schoolid = c.schoolid AND NOT pending ' +
      'LEFT JOIN httpresources ON httpresources.groupassoc = p.schoolid AND httpresources.role = "schools.banner" ' +
      where +
      'GROUP BY p.schoolid', params).then(results => {
      return { code: 200, data: results };
    });
  }
}

class PublishBanner extends SchoolUtilRequestable {
  constructor() {
    super({
      url: '/school/:schoolid/banner',
      methods: ['PUT'],
      writing: true,
      returns: [
        { code: 204 }
      ],
      schema: {
        type: 'object',
        properties: {
          schoolid: {
            type: 'integer',
            description: 'The numerical id of the school to publish the banner for'
          }
        },
        required: ['schoolid']
      },
      description: 'Publish the school banner for a given group.',
      depends: ['PublishFile']
    });
  }
  
  handleWithRequestInfo(query, ctx, cfg, xdata) {
    return this.requireSchoolAdmin(query, ctx, false).then(() => {
      return this.load('PublishFile').handle(query, ctx, cfg, xdata, {
        groupassoc: query.schoolid,
        role: 'schools.banner'
      });
    });
  }
}

class CreateInviteLinkGroup extends SchoolUtilRequestable {
  constructor() {
    super({
      url: '/school/:schoolid/create-invitelink',
      methods: ['POST'],
      writing: true,
      returns: [
        { code: 204 },
        { code: 403, identifier: 'invalid-email' },
        { code: 403, identifier: 'email-not-verified' },
        { code: 404, identifier: 'school-not-found' }
      ],
      schema: {
        type: 'object',
        properties: {
          schoolid: {
            type: 'integer',
            description: 'The numerical id of the school to create an invite link for'
          },
          email: {
            type: 'string',
            description: 'The email to send the invite link to'
          }
        },
        required: []
      },
      description: 'Create an invite link, optionally for a given school/group and/or send it to an email adress.',
      depends: ['CreateInviteLink']
    });
  }
  
  handle(query, ctx, cfg) {
    return this.requireSchoolAdmin(query, ctx, true).then(() => {
      return this.load('CreateInviteLink').handle(query, ctx, cfg, this);
    });
  }
}

exports.Schools = Schools;
