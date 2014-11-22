(function () { "use strict";

var _ = require('lodash');
var util = require('util');
var assert = require('assert');
var buscomponent = require('./stbuscomponent.js');

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
function BackgroundWorker () {
	BackgroundWorker.super_.apply(this, arguments);
}
util.inherits(BackgroundWorker, buscomponent.BusComponent);

/**
 * Calls {@link busreq~regularCallbackUser} and {@link regularCallbackStocks}.
 * The query object is passed on to both of these.
 * 
 * @loginignore
 * @function c2s~prod
 */
BackgroundWorker.prototype.prod = buscomponent.provideWQT('client-prod', function(query, ctx, cb) {
	var self = this;
	
	assert.ok(ctx.access);
	
	if (ctx.access.has('server') == -1)
		return cb('prod-not-allowed');
		
	var starttime = Date.now();
	
	self.request({name: 'regularCallbackUser', query: query, ctx: ctx}, function() {
		var userdbtime = Date.now();
		self.request({name: 'regularCallbackStocks', query: query, ctx: ctx}, function() {
			cb('prod-ready', {'utime': userdbtime - starttime, 'stime': Date.now() - userdbtime});
		});
	});
});

exports.BackgroundWorker = BackgroundWorker;

})();
