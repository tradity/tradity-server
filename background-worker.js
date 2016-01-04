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

exports.BackgroundWorker = BackgroundWorker;
