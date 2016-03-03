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
const debug = require('debug')('sotrade:watchlist');

/**
 * Indicates that one user added a stock or another user to their watchlist.
 * 
 * @typedef s2c~watch-add
 * @type {Event}
 * 
 * @property {int} watched  The numerical ID of the watched stock
 * @property {?int} watcheduser  The numerical ID of the watched leader
 * @property {?string} watchedname  The name chosen by the watched leader
 */

/** */
class WatchlistAdd extends api.Requestable {
  constructor() {
    super({
      url: '/watchlist',
      transactional: true,
      methods: ['POST'],
      returns: [
        { code: 204 },
        { code: 404, identifier: 'stock-notfound',
          description: 'No such stock found' },
        { code: 403, identifier: 'add-self',
          description: 'Cannot add self' }
      ],
      description: 'Adds a stock to the current user’s watchlist.',
      schema: {
        type: 'object',
        properties: {
          stockid: {
            type: 'integer',
            description: 'The numerical stock id or symbol of the stock to be added'
          }
        },
        required: ['stockid']
      }
    });
  }
  
  handle(query, ctx) {
    let uid, res;
    
    debug('watchlist-add', query.stockid, ctx.user.uid);
    
    return ctx.query('SELECT stockid, stocktextid, users.uid AS uid, users.name, bid FROM stocks ' +
      'LEFT JOIN users ON users.uid = stocks.leader WHERE stocks.stockid = ? OR stocks.stocktextid = ? LOCK IN SHARE MODE',
      [String(query.stockid), String(query.stockid)]).then(res_ => {
      res = res_;
      if (res.length === 0) {
        throw new this.ClientError('stock-notfound');
      }
      
      uid = res[0].uid;
      if (uid === ctx.user.uid) {
        throw new this.ClientError('add-self');
      }
      
      return ctx.query('REPLACE INTO watchlists ' +
        '(watcher, watchstarttime, watchstartvalue, watched) '+
        'VALUES(?, UNIX_TIMESTAMP(), ?, ?)',
        [ctx.user.uid, res[0].bid, res[0].stockid]);
    }).then(r => {
      if (r.affectedRows !== 1) { // REPLACE INTO did not add a new entry
        return { code: 204 };
      }
      
      return ctx.feed({
        type: 'watch-add',
        targetid: r.insertId,
        srcuser: ctx.user.uid,
        json: {
          watched: query.stockid, 
          watcheduser: uid,
          watchedname: res[0].name,
          stocktextid: res[0].stocktextid
        },
        feedusers: uid ? [uid] : []
      });
    }).then(() => {
      return { code: 204 };
    });
  }
}

class WatchlistRemove extends api.Requestable {
  constructor() {
    super({
      url: '/watchlist/:stockid',
      writing: true,
      methods: ['DELETE'],
      returns: [
        { code: 204 }
      ],
      description: 'Removes an entry to the current user’s watchlist.',
      schema: {
        type: 'object',
        properties: {
          stockid: {
            type: 'integer',
            description: 'The numerical stock id or symbol of the stock to be removed'
          },
        },
        required: ['stockid']
      }
    });
  }
  
  handle(query, ctx) {
    debug('watchlist-remove', query.stockid, ctx.user.uid);
    
    return ctx.query('DELETE FROM watchlists WHERE watcher = ? AND watched = ?', [ctx.user.uid, String(query.stockid)]).then(() => {
      return ctx.feed({
        type: 'watch-remove',
        targetid: null,
        srcuser: ctx.user.uid,
        json: { watched: String(query.stockid) }
      });
    }).then(() => {
      return { code: 204 };
    });
  }
}


/**
 * Represents a single watchlist entry.
 * @typedef module:watchlist~StockRecord
 * @type object
 * 
 * @property {?string} username  The name of the leader if this refers to a leader stock.
 * @property {?int} uid  The numerical id of the leader if this refers to a leader stock.
 * @property {number} watchstartvalue  The stock (bid) value when this
 *                                     entry was added to the watchlist.
 * @property {int} watchstarttime  Unix timestamp of the addition of this
 *                                 entry to the watchlist.
 * @property {boolean} friends  Indicates whether the leader and the user watch each other.
 * @property {int} lastactive  If <code>friends</code> is true and the watched user
 *                             has an active session, this is that sessions last activity
 *                             timestamp.
 */

/** */
class WatchlistShow extends api.Requestable {
  constructor() {
    super({
      url: '/watchlist',
      methods: ['GET'],
      returns: [
        { code: 200 }
      ],
      description: 'Returns all entries of the current user’s watchlist.'
    });
  }
  
  handle(query, ctx) {
    return ctx.query('SELECT s.*, s.name AS stockname, users.name AS username, users.uid AS uid, w.watchstartvalue, w.watchstarttime, ' +
      'lastusetime AS lastactive, IF(rw.watched IS NULL, 0, 1) AS friends ' +
      'FROM watchlists AS w ' +
      'JOIN stocks AS s ON w.watched = s.stockid ' +
      'JOIN stocks AS rs ON rs.leader = w.watcher ' +
      'LEFT JOIN users ON users.uid = s.leader ' +
      'LEFT JOIN watchlists AS rw ON rw.watched = rs.stockid AND rw.watcher = s.leader ' +
      'LEFT JOIN sessions ON sessions.lastusetime = (SELECT MAX(lastusetime) FROM sessions WHERE uid = rw.watched) AND sessions.uid = rw.watched ' +
      'WHERE w.watcher = ?', [ctx.user.uid]).then(res => {
      return { code: 200, data: res };
    });
  }
}

exports.components = [
  WatchlistAdd,
  WatchlistRemove,
  WatchlistShow
];
