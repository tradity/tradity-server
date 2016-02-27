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
const buscomponent = require('./stbuscomponent.js');
const PSemaphore = require('promise-semaphore');
const debug = require('debug')('sotrade:bw');

/**
 * Provides an entry point for client-induced regular cleanup
 * callbacks.
 * 
 * @public
 * @module background-worker
 */

/**
 * Main object of the {@link module:background-worker} module
 * 
 * @public
 * @constructor module:background-worker~BackgroundWorker
 * @augments module:stbuscomponent~STBusComponent
 */
class BackgroundWorker extends buscomponent.BusComponent {
  constructor() {
    super();
    
    this.sem = new PSemaphore();
  }
}

/**
 * Calls {@link busreq~regularCallbackUser} and {@link regularCallbackStocks}.
 * The query object is passed on to both of these.
 * 
 * @noreadonly
 * @loginignore
 * @function c2s~prod
 */
BackgroundWorker.prototype.prod = buscomponent.provideWQT('client-prod', function(query, ctx) {
  debug('Received prod');
  
  assert.ok(ctx.access);
  
  if (!ctx.access.has('server')) {
    throw new this.SoTradeClientError('prod-not-allowed');
  }
  
  let starttime, userdbtime;
  
  return this.sem.add(() => {
    starttime = Date.now();
  
    return this.request({name: 'regularCallbackUser', query: query, ctx: ctx}).then(() => {
      userdbtime = Date.now();
      return this.request({name: 'regularCallbackStocks', query: query, ctx: ctx});
    });
  }).then(() => {
    return { code: 'prod-ready', 'utime': userdbtime - starttime, 'stime': Date.now() - userdbtime };
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

exports.BackgroundWorker = BackgroundWorker;
