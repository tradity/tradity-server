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
