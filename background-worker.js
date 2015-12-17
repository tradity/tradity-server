(function () { "use strict";

var _ = require('lodash');
var util = require('util');
var assert = require('assert');
var buscomponent = require('./stbuscomponent.js');
var PSemaphore = require('promise-semaphore');
var debug = require('debug')('sotrade:bw');

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
  var self = this;
  
  debug('Received prod');
  
  assert.ok(ctx.access);
  
  if (ctx.access.has('server') == -1)
    throw new self.SoTradeClientError('prod-not-allowed');
  
  var starttime, userdbtime;
  
  return self.sem.add(function() {
    starttime = Date.now();
  
    return self.request({name: 'regularCallbackUser', query: query, ctx: ctx}).then(function() {
      userdbtime = Date.now();
      return self.request({name: 'regularCallbackStocks', query: query, ctx: ctx});
    });
  }).then(function() {
    return { code: 'prod-ready', 'utime': userdbtime - starttime, 'stime': Date.now() - userdbtime };
  });
});

exports.BackgroundWorker = BackgroundWorker;

})();
