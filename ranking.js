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

const api = require('./api.js');
const debug = require('debug')('sotrade:ranking');

// XXX includeme

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

class RankingListing extends api.Requestable {
  constructor() {
    super({
      url: '/ranking',
      methods: ['GET'],
      returns: [
        { code: 200 },
      ],
      description: 'Lists all users and the information necessary for evaluating and displaying rankings.',
      notes: 'It might be helpful to understand that none of the evaluation of ranking information ' +
        'is performed on the server side; It is rather gathered and sent to the client, ' +
        'so that it can create various ranking tables from the raw data for a number of ranking ' +
        'criteria and filters.\n' +
        '\n' +
        'For each user, the first value history entries after the starting time and last before ' +
        'the end time will be used to provide the requested data. ' +
        'Since not necessarily <em>all</em> users have been registered during the entire period ' +
        'in between, the ranking does <em>not</em> start and end for all users at the same time.',
      schema: {
        type: 'object',
        properties: {
          since: {
            type: 'integer',
            description: 'The ranking starting time as a unix timestamp'
          },
          upto: {
            type: 'integer',
            description: 'The ranking end time as a unix timestamp'
          },
          schoolid: {
            type: ['integer', 'string'],
            description: 'Only return users in the group specified by this id or path'
          },
          includeAll: {
            type: 'boolean',
            description: 'Whether users should be included that are not considered qualified for ranking entries (e.g. without verified e-mail address)'
          }
        },
        required: []
      },
      depends: ['GetSchoolInfo']
    });
  }
  
  handle(query, ctx) {
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
    
    return Promise.resolve().then(() => {
      if (!query.schoolid) {
        return ctx.access.has('userdb');
      }
      
      join += 'JOIN schools AS p ON c.path LIKE CONCAT(p.path, "/%") OR p.schoolid = c.schoolid ';
      likestringWhere += 'AND (p.schoolid = ? OR p.path = ?) ';
      likestringUnit.push(String(query.schoolid), String(query.schoolid).toLowerCase());
      
      return this.load('GetSchoolInfo').isSchoolAdmin(ctx, ['xadmin'], query.schoolid).then(ISAResult => {
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
        code: 200,
        data: ranking
      };
    });
  }
}

exports.components = [
  RankingListing
];
