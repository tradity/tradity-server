(function () { "use strict";

var Q = require('q');
var assert = require('assert');
var util = require('util');
var _ = require('lodash');
var config = require('../config.js');
var abstractloader = require('./abstractloader.js');
var debug = require('debug')('sotrade:stockloader:loopback');

function LoopbackQuoteLoader (opt) {
	assert.ok(opt);
	assert.ok(opt.ctx);
	
	LoopbackQuoteLoader.super_.apply(this, opt);
	
	this.ctx = opt.ctx;
}
util.inherits(LoopbackQuoteLoader, abstractloader.AbstractLoader);

LoopbackQuoteLoader.prototype._makeQuoteRequestFetch = function(stocklist) {
	var self = this;
	
	debug('Fetching stocks from table', stocklist.length);
	return self.ctx.query('SELECT * FROM stocks WHERE stocktextid IN (' +
		_.map(stocklist, _.constant('?')).join(',') + ')', stocklist).then(function(results) {
		
		return _.map(results, function(record) {
			record.isin = record.stocktextid;
			record.symbol = record.isin;
			record.failure = null;
			record.currency_name = 'EUR';
            record.pieces = 10000;
			
            if (record.leader === null) {
              record.ask *= 1.0001;
              record.bid *= 1.0001;
            }
			
			record.last = (record.ask + record.bid)/2.0;
			record.lastTradePrice = record.last;
			
			return self._handleRecord(record, false);
		});
	});
};

exports.QuoteLoader = LoopbackQuoteLoader;

})();
