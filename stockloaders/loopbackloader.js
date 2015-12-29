(function () { "use strict";

var assert = require('assert');
var util = require('util');
var _ = require('lodash');
var config = require('../config.js');
var abstractloader = require('./abstractloader.js');
var debug = require('debug')('sotrade:stockloader:loopback');

class LoopbackQuoteLoader extends abstractloader.AbstractLoader {
  constructor(opt) {
    super(opt);
    
    assert.ok(opt);
    assert.ok(opt.ctx);
    
    this.ctx = opt.ctx;
  }

  _makeQuoteRequestFetch(stocklist) {
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
          record.ask *= 1.0001 / 10000;
          record.bid *= 1.0001 / 10000;
        }
        
        record.last = (record.ask + record.bid)/2.0;
        record.lastTradePrice = record.last;
        
        return self._handleRecord(record, false);
      });
    });
  }
}

exports.QuoteLoader = LoopbackQuoteLoader;

})();
