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
const _ = require('lodash');
const os = require('os');
const abstractloader = require('./abstractloader.js');
const debug = require('debug')('sotrade:stockloader:bff');

const INFO_LINK_DEFAULT = 'http://mobileapi.dbagproject.de';
const USER_AGENT_DEFAULT = '(+tech@tradity.de node' + process.version + '@' + os.hostname() + ' http)';
const EXCHANGE_DEFAULT = 'FSE';

class BoerseFFQuoteLoader extends abstractloader.AbstractLoader {
  constructor(opt) {
    assert.ok(opt);
    assert.ok(opt.apiUsername);
    assert.ok(opt.apiPassword);
    
    super(opt);
    
    this.exchange = opt.exchange || EXCHANGE_DEFAULT;
    this.infoLink = opt.infoLink || INFO_LINK_DEFAULT;
    this.userAgent = 'Boerse Frankfurt API loader script; ' + (opt.userAgent || USER_AGENT_DEFAULT);
    
    this._loginInfo = { login: opt.apiUsername, password: opt.apiPassword };
    this._loginPromise = null;
    this._exchangeInfo = null;
  }
  
  _login() {
    const requrl = this.infoLink + '/session?lang=de&app=xetra.ios';
    const json = JSON.stringify(this._loginInfo);
    
    if (this._loginPromise) {
      return this._loginPromise;
    }
    
    return this._loginPromise = this.request(requrl, null, {
      'Content-Type': 'application/json'
    }, 'post', json).then(result_ => {
      const result = JSON.parse(result_);
      
      const exchanges = result.mappings.exchanges;
      this._exchangeInfo = exchanges.filter(e => e.gatrixxCode === this.exchange)[0];
      assert.ok(this._exchangeInfo);
      
      debug('Logged in, got API key');
      
      return {
        restAPI: result.sid,
        pushAPI: {
          url: result.lightstreamerURL,
          dataAdapter: result.lightstreamerDataAdapter,
          adapterSet: result.lightstreamerAdapterSet
        }
      };
    });
  }
  
  _makeQuoteRequestFetch(stocklist) {
    debug('Fetching stocks', stocklist.length);
    
    return Promise.all(stocklist.map(stockid => this._fetchSingleStockInfo(stockid)))
      .then(results => {
        debug('Fetched stocks', stocklist.length + ' queries', results.length + ' results');
        return results;
      });
  }
  
  _restAPICall(url) {
    const requrl = this.infoLink + url;
    
    return this._login().then(auth => {
      return this.request(requrl, null, {
        'Authorization': auth.restAPI
      }).catch(e => {
        if (e.statusCode === 404) {
          return 'null';
        }
        
        throw e;
      });
    }).then(JSON.parse);
  }
  
  _getBasicInfo(stockid) {
    return this._restAPICall('/papers/' + stockid).then(res => {
      debug('Basic stock info fetched', stockid, !!res);
      if (!res) {
        return null;
      }
      
      const exchangeInfo = (res.listings || [])
        .filter(l => l.exchangeSymbol === this.exchange)[0] || {};
      
      Object.assign(res, exchangeInfo);
      
      return {
        symbol: res.isin,
        ask: res.ask,
        bid: res.bid,
        currency_name: res.currency,
        lastTradePrice: res.price,
        name: res.name,
        exchange: res.exchangeSymbol === this._exchangeInfo.gatrixxCode ? this._exchangeInfo.name : res.exchangeSymbol
      };
    });
  }
  
  _getTradedAmountToday(stockid) {
    return this._login().then(() => { // need login for exchange info
      return this._restAPICall('/papers/' + stockid + '/quotes?exchange=' + this._exchangeInfo.id);
    }).then(res => {
      debug('Day-based stock info fetched', stockid, !!res);
      
      if (!res) {
        return null;
      }
      
      return res.quotes.map(q => q.s).reduce((a, b) => a + b, 0);
    });
  }
  
  _fetchSingleStockInfo(stockid) {
    return Promise.all([
      this._getBasicInfo(stockid),
      this._getTradedAmountToday(stockid)
    ]).then(r => {
      if (!r[0]) {
        return null;
      }
      
      r[0].pieces = r[1] || 0;
      return this._handleRecord(r[0], false);
    });
  }
}

exports.QuoteLoader = BoerseFFQuoteLoader;

function test() {
  const options = minimist(process.argv.slice(2));
  
  const ql = new BoerseFFQuoteLoader(options);
  ql.on('error', e => console.log(e, e.stack + ''));
  
  ql.loadQuotesList(['DE000BASF111', 'ZAE000149936']).then(rec => {
    console.log(rec.length, _.map(rec, 'name'));
  }).catch(e => {
    console.error('Sorry, an error was encountered:');
    console.trace(e);
  });
}

if (require.main === module) {
  test();
}
