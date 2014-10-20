(function () { "use strict";

var _ = require('underscore');
var util = require('util');
var assert = require('assert');
var buscomponent = require('./bus/buscomponent.js');

function BackgroundWorker () {
	this.quoteLoader = null;
}
util.inherits(BackgroundWorker, buscomponent.BusComponent);

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
