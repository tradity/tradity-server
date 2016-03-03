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
const api = require('./api.js');
const debug = require('debug')('sotrade:user-info');
const promiseUtil = require('./lib/promise-util.js');
const spread = promiseUtil.spread;

// XXX includeme

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

/** */
class UserInfo extends api.Requestable {
  constructor() {
    super({
      url: '/user/:lookfor',
      methods: ['GET'],
      returns: [
        { code: 200 },
        { code: 404, 'user-not-found' }
      ],
      schema: {
        type: 'object',
        properties: {
          lookfor: {
            type: ['integer', 'string'],
            description: 'The user id or name for which data should be returned. As a special value, `$self` can be used to inspect own data.',
          },
          nohistory: {
            type: 'boolean',
            description: 'If true, returns only direct user information; Otherwise, all available information.'
          }
        },
        required: ['lookfor']
      }
      description: 'Return all available information on a single user.'
    });
  }
  
  handle(query, ctx, cfg) {
    let xuser;
    
    let resultCacheKey = '';
    const cacheable = !(ctx.access.has('caching') && query.noCache);
    
    query.nohistory = !!query.nohistory;
    
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
    if (String(lookfor) === String(query.lookfor)) {
      lookforColumn = 'uid';
    } else {
      lookfor = String(query.lookfor);
      lookforColumn = 'name';
    }
    
    return Promise.resolve().then(() => {
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
        throw new this.ClientError('user-not-found');
      }
      
      xuser = users[0];
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
      const levelArray = schools.map(s => s.path.replace(/[^\/]/g, '').length); // count '/'
      if (_.intersection(levelArray, _.range(1, levelArray.length+1)).length !== levelArray.length) {
        return this.load('PubSub').publish('error', new Error('Invalid school chain for user: ' + JSON.stringify(schools)));
      }
      
      xuser.schools = schools;
      
      const result = {
        code: 200, 
        data: xuser
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
    }));
  }
}

exports.components = [
  UserInfo
];
