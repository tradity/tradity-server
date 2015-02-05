(function () { "use strict";

var _ = require('lodash');
var Q = require('q');
var util = require('util');
var events = require('events');

function AbstractLoader(opt) {
	AbstractLoader.super_.apply(this);
	
	opt = opt || {};
	
	this.setMaxListeners(0);
	this.cacheTime = opt.cacheTime || 25000;
	this.cache = {};
}

util.inherits(AbstractLoader, events.EventEmitter);

AbstractLoader.prototype._handleRecord = function(record, cached) {
	if (!cached && record.failure == null)
		this.cache['s-' + record.symbol] = record;
	
	this.emit('record', record);
};

AbstractLoader.prototype._makeQuoteRequest = function(stocklist) {
	var self = this;
	
	stocklist = _.filter(stocklist, function(stockid) {
		var cv = self.cache['s-' + stockid];
		if (cv) {
			if (cv.fetchTime > Date.now() - self.cacheTime) {
				self._handleRecord(cv, true);
				return false;
			} else {
				delete self.cache['s-' + stockid];
			}
		}
		
		return true;
	});
	
	if (stocklist.length > self.maxlen) {
		self._makeQuoteRequest(stocklist.slice(self.maxlen));
		self._makeQuoteRequest(stocklist.slice(0, self.maxlen));
		return;
	}
	
	if (stocklist.length == 0) // everything was cached
		return;
	
	return self._makeQuoteRequestFetch(stocklist);
};

AbstractLoader.prototype.loadQuotes = function(stocklist, filter, callback) {
	var self = this;
	
	filter = filter || function() { return true; };
	callback = callback || function() {};
	
	if (stocklist.length == 0) {
		self.emit('error', new Error('Called with empty stocklist'));
		return;
	}
	
	_.each(stocklist, function(e) {
		var cb = function(record) {
			// .indexOf uses strict comparison
			if ([record.isin, record.wkn, record.failure].map(String).indexOf(String(e)) != -1 && filter(record)) {
				self.removeListener('record', cb);
				callback(record);
			}
		};
		
		self.on('record', cb);
	});
	
	self._makeQuoteRequest(stocklist);
};

AbstractLoader.prototype.loadQuotesList = function(stocklist, filter, callback) {
	filter = filter || function() { return true; };
	callback = callback || function() {};
	
	var resultNames = [];
	var results = [];
	
	if (stocklist.length == 0) {
		callback([]);
		return Q([]);
	}
	
	var deferred = Q.defer();
	this.loadQuotes(stocklist, null, function(rec) {
		if (results === null)
			return;
		
		if (rec.isin) {
			resultNames.push(rec.isin);
			resultNames.push(rec.wkn);
			resultNames.push(rec.name);
			results.push(rec);
		}
		
		if (rec.failure)
			resultNames.push(rec.failure);
		
		if (_.difference(stocklist, resultNames).length == 0) {
			var filteredResults = _.filter(results, filter);
			
			deferred.resolve(filteredResults);
			callback(filteredResults);
			results = null;
		}
	});
	
	return deferred.promise;
};

exports.AbstractLoader = AbstractLoader;

})();
