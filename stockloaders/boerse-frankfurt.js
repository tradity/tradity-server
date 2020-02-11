#!/usr/bin/env node
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

// Additional permission under AGPL section 7
// If you modify this Program, or any covered work, by linking or combining it
// with libraries that are available as modules in the public npm registry
// at https://www.npmjs.com/, the licensors of this Program grant you additional
// permission to convey the resulting work.

"use strict";

const assert = require('assert');
const minimist = require('minimist');
const os = require('os');
const abstractloader = require('./abstractloader.js');
const debug = require('debug')('sotrade:stockloader:bff');

const USER_AGENT_DEFAULT = '(+tech@tradity.de node' + '@' + os.hostname() + ' http)';
const EXCHANGE_DEFAULT = 'XETR';

class BoerseFFQuoteLoader extends abstractloader.AbstractLoader {
  constructor(opt) {
    assert.ok(opt);
    assert.ok(opt.infoLink);
    assert.ok(opt.mic);
    
    super(Object.assign({}, opt, { maxlen: null }));
    
    this.mic = opt.mic || EXCHANGE_DEFAULT;
    this.infoLink = opt.infoLink;
    this.userAgent = 'Boerse FF API loader script ' + (opt.userAgent || USER_AGENT_DEFAULT);
    
    this._stockinfoCache = new Map();
    this._nonexistentStocks = new Set();
  }
  
  _getStockinfoCacheEntry(stockid) {
    if (this._stockinfoCache.has(stockid)) {
      return this._stockinfoCache.get(stockid);
    }
    
    const entry = {};
    this._stockinfoCache.set(stockid, entry);
    return entry;
  }
  
  _restAPICall(url) {
    const requrl = this.infoLink + url;
    
    return this.request(requrl, null).catch(e => {
      if (e && (e.statusCode === 500 || e.statusCode === 404)) {
        return '{"statusCode":' + e.statusCode + '}';
      }
      
      throw e;
    }).then(JSON.parse);
  }
  
  _getPriceInfo(stockid) {
    const cacheEntry = this._getStockinfoCacheEntry(stockid);
    
    // debug('Regular data cache', stockid, cacheEntry, cacheEntry, loadFromPush);
    
    if (cacheEntry.isLive) {
      return cacheEntry.data;
    }
    
    return cacheEntry.data = this._restAPICall('/data/bid_ask_overview/single?isin=' + stockid + '&mic=' + this.mic).then(res => {
      debug('Stock price info fetched', stockid, !!res);
      if (!res || res.statusCode === 500 || res.statusCode === 404) {
        debug('Marking stock as nonexistent', stockid);
        this._nonexistentStocks.add(stockid);
        return null;
      }
      
      assert.strictEqual(res.isin, stockid);
      
      if (res.data.length === 0) {
        return null;
      }

      const data = res.data[0];

      // protect against api nonsense
      if (data.askPrice <= 0 || data.askPrice > 100000 || data.bidPrice <= 0 || data.bidPrice > 100000) return null;
      
      return {
        symbol: res.isin,
        ask: data.askPrice,
        bid: data.bidPrice,
        currency_name: 'EUR',
        lastTradePrice: (data.askPrice + data.bidPrice) / 2, // temporary workaround
        exchange: this.mic
      };
    });
  }

  _getName(stockid) {
    const cacheEntry = this._getStockinfoCacheEntry(stockid);
    if (cacheEntry.name) return cacheEntry.name;

    return this._restAPICall('/global_search/limitedsearch/de?searchTerms=' + stockid).then(res => {
      debug('Stock name fetched', stockid, !!res);

      if (!res || res.length === 0) {
        debug('Marking stock as nonexistent', stockid);
        this._nonexistentStocks.add(stockid);
        return null;
      }

      assert.strictEqual(res[0][0].isin, stockid);

      return res[0][0].name;
    });
  }
  
  _getTradedAmountToday(stockid, needCurrent) {
    const cacheEntry = this._getStockinfoCacheEntry(stockid);
    
    // debug('Pieces cache hm', stockid, cacheEntry, needCurrent);
    if (cacheEntry.pieces && !needCurrent) {
      return cacheEntry.pieces;
    }
    
    return cacheEntry.pieces = this._restAPICall('/papers/' + stockid + '/quotes?exchange=' + this.mic + '&period=d').then(res => {
      debug('Day-based stock info fetched', stockid, !!res);
      
      if (!res || res.statusCode === 500 || res.statusCode === 404) {
        debug('Marking stock as nonexistent', stockid);
        this._nonexistentStocks.add(stockid);
        return null;
      }

      if (res.quotes.length === 0) return 0;
      
      return res.quotes[0].pieces;
    });
  }
  
  _fetchSingleStockInfo(stockid, options) {
    if (this._nonexistentStocks.has(stockid)) {
      return null;
    }
    return Promise.all([
      this._getPriceInfo(stockid),
      this._getName(stockid),
      this._getTradedAmountToday(stockid, options.needCurrentPieces)
    ]).then(r => {
      if (!r[0] || !r[1]) {
        return null;
      }
      
      r[0].name = r[1];
      r[0].pieces = r[2] || 0;
      return this._handleRecord(r[0], false);
    });
  }
  
  _makeQuoteRequestFetch(stocklist, options) {
    debug('Fetching stocks', stocklist.length, JSON.stringify(options), process.pid);
    
    return Promise.all(stocklist.map(stockid => this._fetchSingleStockInfo(stockid, options)))
      .then(results => {
        debug('Fetched stocks', stocklist.length + ' queries', results.length + ' results');
        
        return results;
      });
  }
}

exports.QuoteLoader = BoerseFFQuoteLoader;

function test() {
  const options = minimist(process.argv.slice(2));
  
  const ql = new BoerseFFQuoteLoader(options);
  ql.on('error', e => console.log(e, e.stack + ''));
  
  ql.loadQuotesList(['DE000BASF111', 'ZAE000149936'], {
    needCurrentPieces: true,
    loadFromPush: true
  }).then(rec => {
    console.log(rec.length, rec.map(r => r.name));
  }).catch(e => {
    console.error('Sorry, an error was encountered:');
    console.trace(e);
  });
}

if (require.main === module) {
  test();
}
