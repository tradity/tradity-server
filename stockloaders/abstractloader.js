(function () { "use strict";

var _ = require('lodash');
var Q = require('q');
var util = require('util');
var events = require('events');
var debug = require('debug')('sotrade:stockloader');

var MAXLEN_DEFAULT = 196;
var CACHE_TIME_DEFAULT = 25000;

function AbstractLoader(opt) {
	AbstractLoader.super_.apply(this);
	
	opt = opt || {};
	
	this.setMaxListeners(0);
	this.cacheTime = typeof opt.cacheTime == 'undefined' ? CACHE_TIME_DEFAULT : opt.cacheTime;
	this.maxlen = typeof opt.maxlen == 'undefined' ? MAXLEN_DEFAULT : opt.maxlen;
	this.cache = {};
}

util.inherits(AbstractLoader, events.EventEmitter);

AbstractLoader.prototype._handleRecord = function(record, cached) {
	if (!cached && record.failure == null) {
		if (!record.fetchTime)
			record.fetchTime = Date.now();

		this.cache['s-' + record.symbol] = record;
	}
	
	this.emit('record', record);
	
	return record;
};

AbstractLoader.prototype._makeQuoteRequest = function(stocklist) {
	var self = this;
	
	var cachedResults = [];
	stocklist = _.filter(stocklist, function(stockid) {
		var cv = self.cache['s-' + stockid];
		if (cv) {
			if (cv.fetchTime > Date.now() - self.cacheTime) {
				cachedResults.push(self._handleRecord(cv, true));
				return false;
			} else {
				delete self.cache['s-' + stockid];
			}
		}
		
		return true;
	});
	
	if (stocklist.length == 0) // everything was cached
		return Q(cachedResults);
	
	// split stocklist into groups of maximum length maxlen
	// and flatten the resulting chunked array of records
	var chunkedStocklist = _.chunk(stocklist, self.maxlen);
	
	debug('Fetching stock list', stocklist.length, chunkedStocklist.length + ' chunks');
	
	return Q.all(chunkedStocklist.map(function(chunk) {
		return self._makeQuoteRequestFetch(chunk);
	})).then(function(recordListChunks) {
		var fetchedRecordList = _.flatten(recordListChunks);
		
		var receivedStocks = [];
		_.each(fetchedRecordList, function(record) {
			if (record.isin) receivedStocks.push(record.isin);
			if (record.wkn)  receivedStocks.push(record.wkn);
		});
		
		var notReceivedStocks = _.difference(stocklist, receivedStocks);
		_.each(notReceivedStocks, function(failedName) {
			self._handleRecord({failure: failedName}, false);
		});
		
		return fetchedRecordList.concat(cachedResults).filter(function(record) {
			return !record.failure;
		});
	});
};

AbstractLoader.prototype.loadQuotesList = function(stocklist, filter) {
	var self = this;
	
	filter = filter || _.constant(true);
	
	return Q().then(function() {
		return self._makeQuoteRequest(stocklist);
	}).then(function(records) {
		return _.filter(records, filter);
	});
};

exports.AbstractLoader = AbstractLoader;

})();
