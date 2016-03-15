// Tradity.de Server
// Copyright (C) 2016 Tradity.de Tech Team <tech@tradity.de>

// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version. 

// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.

// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <http://www.gnu.org/licenses/>.

"use strict";

const assert = require('assert');
const abstractloader = require('./abstractloader.js');
const debug = require('debug')('sotrade:stockloader:loopback');

class LoopbackQuoteLoader extends abstractloader.AbstractLoader {
  constructor(opt) {
    super(opt);
    
    assert.ok(opt);
    assert.ok(opt.ctx);
    assert.equal(typeof opt.literal, 'boolean');
    
    this.literal = opt.literal;
    this.ctx = opt.ctx;
  }

  _makeQuoteRequestFetch(stocklist/*, options*/) {
    debug('Fetching stocks from table', stocklist.length);
    return this.ctx.query('SELECT * FROM stocks WHERE stocktextid IN (' +
      stocklist.map(() => '?').join(',') + ')', stocklist).then(results => {
      
      return results.map(record => {
        record.isin = record.stocktextid;
        record.symbol = record.isin;
        record.failure = null;
        record.currency_name = 'EUR';
        
        record.lastvalue /= 10000.0;
        record.ask /= 10000.0;
        record.bid /= 10000.0;
        
        record.last = record.lastvalue;
        
        if (!this.literal) {
          record.pieces = 10000;
          
          if (record.leader === null) {
            record.ask *= 1.000001;
            record.bid *= 1.000001;
          }
          
          record.last = (record.ask + record.bid)/2.0;
        }
        
        record.lastTradePrice = record.last;
        
        return this._handleRecord(record, false);
      });
    });
  }
}

exports.QuoteLoader = LoopbackQuoteLoader;
