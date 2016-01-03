"use strict";

const assert = require('assert');
const abstractloader = require('./abstractloader.js');
const debug = require('debug')('sotrade:stockloader:loopback');

class LoopbackQuoteLoader extends abstractloader.AbstractLoader {
  constructor(opt) {
    super(opt);
    
    assert.ok(opt);
    assert.ok(opt.ctx);
    
    this.ctx = opt.ctx;
  }

  _makeQuoteRequestFetch(stocklist) {
    debug('Fetching stocks from table', stocklist.length);
    return this.ctx.query('SELECT * FROM stocks WHERE stocktextid IN (' +
      stocklist.map(() => '?').join(',') + ')', stocklist).then(results => {
      
      return results.map(record => {
        record.isin = record.stocktextid;
        record.symbol = record.isin;
        record.failure = null;
        record.currency_name = 'EUR';
        
        record.pieces = 10000;
        
        if (record.leader === null) {
          record.ask *= 1.000001 / 10000.0;
          record.bid *= 1.000001 / 10000.0;
        }
        
        record.last = (record.ask + record.bid)/2.0;
        record.lastTradePrice = record.last;
        
        return this._handleRecord(record, false);
      });
    });
  }
}

exports.QuoteLoader = LoopbackQuoteLoader;
