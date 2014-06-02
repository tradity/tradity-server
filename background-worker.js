(function () { "use strict";

var _ = require('underscore');
var util = require('util');
var assert = require('assert');
var buscomponent = require('./buscomponent.js');

function BackgroundWorker () {
	this.quoteLoader = null;
}
util.inherits(BackgroundWorker, buscomponent.BusComponent);

BackgroundWorker.prototype.prod = buscomponent.provideQUA('client-prod', function(query, user, access, cb) {
	assert.ok(access);
	
	if (access.has('server') == -1)
		return cb('prod-not-allowed');
		
	var starttime = new Date().getTime();
	
	this.request({name: 'regularCallbackUser', query: query}, function() {
		var userdbtime = new Date().getTime();
		this.request({name: 'regularCallbackStocks', query: query}, function() {
			cb('prod-ready', {'utime': userdbtime - starttime, 'stime': new Date().getTime() - userdbtime});
		});
	});
});

exports.BackgroundWorker = BackgroundWorker;

})();
