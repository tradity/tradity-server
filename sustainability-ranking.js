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

const assert = require('assert');
const api = require('./api.js');

class SustainabilityRanking extends api.Requestable {
  constructor() {
    super({
      url: '/sustainability-ranking',
      methods: ['POST', 'GET'],
      returns: [
        { code: 200 },
      ],
      description: 'Create a sustainability ranking of all users in a specific group.',
      notes: 'The rules for creating such a ranking are not trivial (and certainly not fair) ' +
        'and may change in the future. If you have any questions about this, ask the ' +
        'organizational team.',
      schema: {
        type: 'object',
        properties: {
          scoreTable: {
            type: 'array',
            description: 'A list of ISINs and associated scores',
            items: {
              type: 'object',
              properties: {
                stocktextid: { type: 'string' },
                score: { type: 'number' }
              },
              required: ['stocktextid', 'score']
            },
            uniqueItems: true,
            minItems: 1
          },
          schoolid: {
            type: ['integer', 'string'],
            description: 'Only return users in the group specified by this id or path'
          }
        },
        required: ['scoreTable']
      },
      requiredAccess: 'sustainability-ranking'
    });
  }
  
  handle(query, ctx) {
    let likestringWhere = '';
    let likestringUnit = [];
    let likestring;
    let cacheKey;
    
    return ctx.query('DROP TEMPORARY TABLE IF EXISTS sranking_scores; ' +
      'CREATE TEMPORARY TABLE sranking_scores (' +
        'stocktextid VARCHAR(32), ' +
        'score DOUBLE' +
      ');' +
      'INSERT INTO sranking_scores (stocktextid, score) VALUES' + 
        query.scoreTable.map(entry => '(?,?)').join(',') +
      ';' +
      'SELECT u.uid, u.email, u.name, now_va.totalvalue AS totalvalue, ' +
      'weightedbuys.totalscore ' +
      'FROM users AS u ' +
      'LEFT JOIN (SELECT uid, SUM(COALESCE(score, 0) * money)/SUM(money) AS totalscore ' +
        'FROM orderhistory AS oh ' +
        'LEFT JOIN sranking_scores AS s ON s.stocktextid = oh.stocktextid ' +
        'WHERE amount > 0 ' +
        'GROUP BY uid' +
      ') AS weightedbuys ON weightedbuys.uid = u.uid ' +
      'LEFT JOIN schoolmembers AS sm ON u.uid = sm.uid ' +
      'LEFT JOIN schools AS c ON sm.schoolid = c.schoolid ' +
      'JOIN (SELECT uid, MAX(time) AS max_t FROM valuehistory GROUP BY uid) ' +
        'AS locator_va ON u.uid = locator_va.uid ' +
      'JOIN valuehistory AS now_va ON now_va.uid = u.uid AND now_va.time = locator_va.max_t ' +
      (query.schoolid ? 
        'JOIN schools AS p ON c.path LIKE CONCAT(p.path, "%") OR p.schoolid = c.schoolid ' : ''
      ) + 
      'WHERE hiddenuser != 1 AND deletiontime IS NULL AND email_verif != 0 ' +
        'AND tradecount > 0 ' +
      (query.schoolid ? 
        'AND (p.schoolid = ? OR p.path = ?) ' : ''
      ),
      query.scoreTable.map(entry => [entry.stocktextid, entry.score])
        .reduce((a, b) => a.concat(b), [])
        .concat(query.schoolid ? [query.schoolid, query.schoolid] : [])
    ).then(ranking => {
      return {
        code: 200,
        data: ranking[3] // 3rd query from above
      };
    });
  }
}

exports.components = [
  SustainabilityRanking
];
