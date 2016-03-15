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
const promiseEvents = require('promise-events');
const abstractloader = require('./abstractloader.js');
const debug = require('debug')('sotrade:stockloader:bff');

const INFO_LINK_DEFAULT = 'http://mobileapi.dbagproject.de';
const USER_AGENT_DEFAULT = '(+tech@tradity.de node' + process.version + '@' + os.hostname() + ' http)';
const EXCHANGE_DEFAULT = 'FSE';

// Using lightstreamer-client is purely optional
class BoerseFFPushCacheService extends promiseEvents.EventEmitter {
  constructor(opt) {
    assert.ok(opt.url);
    assert.ok(opt.dataAdapter);
    assert.ok(opt.adapterSet);
    
    super();
    
    this.ls = null;
    try {
      this.ls = require('lightstreamer-client');
    } catch (e) {
      console.error(e);
    }
    
    this.subscribedStocks = new Set();
    
    this.opt = opt;
    this.reset();
  }
  
  reset() {
    this.conn = null;
    this.connectionPromise = null;
    this.subscription = null;
    this.subscriptionPromise = null;
  }
  
  connect() {
    if (!this.ls) {
      const err = new Error('LightStreamer features not available');
      err.isLSUnavailable = true;
      return Promise.reject(err);
    }
    
    if (this.connectionPromise) {
      return this.connectionPromise;
    }
    
    return this.connectionPromise = new Promise((resolve, reject) => {
      debug('LS connecting', this.opt.url);
      this.conn = new this.ls.LightstreamerClient(this.opt.url, this.opt.adapterSet);
      this.conn.addListener({
        onStatusChange: (newStatus) => {
          debug('LS connection status change', newStatus);
          if (/^CONNECTED:.*(STREAMING|POLLING)$/i.test(newStatus)) {
            resolve(this.conn);
          } else if (/^(DISCONNECTED|STALLED)/i.test(newStatus)) {
            this.reset();
            reject(new Error('LS Received status ' + newStatus));
          } else if (/^(CONNECTED:STREAM-SENSING|CONNECTING)$/i.test(newStatus)) {
            // do nothing
          } else {
            this.emit('error', new Error('LS Unknown status: ' + newStatus));
          }
        },
        
        onServerError: (errorCode, errorMessage) => {
          this.emit('error', new Error('LS Server error: ' + errorCode + ', ' + errorMessage));
        }
      });
      
      this.conn.connect();
    });
  }
  
  subscribe(needResubscribe) {
    if (this.subscriptionPromise && !needResubscribe) {
      return this.subscriptionPromise;
    }
    
    return this.subscriptionPromise = this.connect().then(() => {
      if (this.subscription) {
        this.conn.unsubscribe(this.subscription);
        this.subscription = null;
      }
      
      const s = new this.ls.Subscription(
        'MERGE',
        Array.from(this.subscribedStocks),
        this.opt.fields);
      
      this.subscription = s;
      
      s.setDataAdapter(this.opt.dataAdapter);
      s.setRequestedSnapshot('yes');
      
      return new Promise((resolve, reject) => {
        s.addListener({
          onSubscription: () => {
            debug('LS Subcribed with ' + this.subscribedStocks.size + ' stocks');
            resolve();
          },
          onItemUpdate: (obj) => {
            debug('LS Update', obj.getItemName());
            
            return Promise.resolve().then(() => {
              return this.emit('update', Object.assign.apply(null,
                s.getFields().map(f => ({ [f]: obj.getValue(f) }))
                .concat([{
                  subscriptionID: obj.getItemName()
                }])));
            }).catch(e => this.emit('error', e));
          }
        });
        
        this.conn.subscribe(this.subscription);
      });
    });
  }
  
  subscribeStockInfos(stocklist) {
    const needResubscribe = stocklist.map(subscriptionID => {
      if (this.subscribedStocks.has(subscriptionID)) {
        return false;
      }
      
      this.subscribedStocks.add(subscriptionID);
      return true;
    }).some(x => x);
    
    return this.subscribe(needResubscribe).catch(e => this.emit('error', e));
  }
}

class BoerseFFQuoteLoader extends abstractloader.AbstractLoader {
  constructor(opt) {
    assert.ok(opt);
    assert.ok(opt.apiUsername);
    assert.ok(opt.apiPassword);
    
    super(Object.assign({}, opt, { maxlen: null }));
    
    this.exchange = opt.exchange || EXCHANGE_DEFAULT;
    this.infoLink = opt.infoLink || INFO_LINK_DEFAULT;
    this.userAgent = 'Boerse FF API loader script ' + (opt.userAgent || USER_AGENT_DEFAULT);
    
    this._loginInfo = { login: opt.apiUsername, password: opt.apiPassword };
    this._loginPromise = null;
    this._exchangeInfo = null;
    
    this._pushService = null;
    
    this._stockinfoCache = new Map();
    this._pushReverseLookup = new Map();
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
      
      this._pushService = new BoerseFFPushCacheService({
        url: result.lightstreamerURL,
        dataAdapter: result.lightstreamerDataAdapter,
        adapterSet: result.lightstreamerAdapterSet,
        fields: ['quotetime', 'bid', 'ask']
      });
      
      this._pushService.on('error', e => {
        if (e.isLSUnavailable) {
          console.info('lightstreamer PUSH API connection not available');
          return;
        }
        
        return this.emit('error', e);
      });
      
      this._pushService.on('update', data => {
        const stockid = this._pushReverseLookup.get(data.subscriptionID);
        assert.ok(stockid);
        
        const cacheEntry = this._stockinfoCache.get(stockid);
        assert.ok(cacheEntry);
        
        return Promise.resolve(cacheEntry.data).then(cacheData => {
          assert.ok(cacheData);
          
          debug('Updating cached data from push API', stockid);
          Object.assign(cacheData, data);
          cacheEntry.isLive = true;
          
          return this._handleRecord(cacheData);
        });
      });
      
      return {
        restAPI: result.sid
      };
    });
  }
  
  _restAPICall(url) {
    const requrl = this.infoLink + url;
    
    return this._login().then(auth => {
      return this.request(requrl, null, {
        'Authorization': auth.restAPI
      }).catch(e => {
        if (e && e.statusCode === 404) {
          return '{"statusCode":404}';
        }
        
        throw e;
      });
    }).then(JSON.parse);
  }
  
  _getBasicInfo(stockid, loadFromPush) {
    const cacheEntry = this._getStockinfoCacheEntry(stockid);
    
    // debug('Regular data cache', stockid, cacheEntry, cacheEntry, loadFromPush);
    
    if (cacheEntry.isLive) {
      return cacheEntry.data;
    }
    
    if (this._nonexistentStocks.has(stockid)) {
      return null;
    }
    
    return cacheEntry.data = this._restAPICall('/papers/' + stockid).then(res => {
      debug('Basic stock info fetched', stockid, !!res);
      if (res && res.statusCode === 404) {
        debug('Marking stock as nonexistent', stockid);
        this._nonexistentStocks.add(stockid);
        return null;
      }
      
      if (!res) {
        return null;
      }
      
      const exchangeInfos = (res.listings || [])
        .filter(l => l.exchangeSymbol === this.exchange && l.price);
      
      if (exchangeInfos.length === 0) {
        return null;
      }
      
      assert.strictEqual(exchangeInfos.length, 1);
      Object.assign(res, exchangeInfos[0]);
      
      if (res.ask === null || res.bid === null) {
        return null;
      }
      
      if (res.pushCode) {
        this._pushReverseLookup.set(res.pushCode, stockid);
      }
      
      return {
        symbol: res.isin,
        ask: res.ask,
        bid: res.bid,
        currency_name: res.currency,
        lastTradePrice: res.price,
        name: res.name,
        exchange: res.exchangeSymbol === this._exchangeInfo.gatrixxCode ? this._exchangeInfo.name : res.exchangeSymbol,
        pushCode: res.pushCode
      };
    });
  }
  
  _getTradedAmountToday(stockid, needCurrent) {
    const cacheEntry = this._getStockinfoCacheEntry(stockid);
    
    // debug('Pieces cache hm', stockid, cacheEntry, needCurrent);
    if (cacheEntry.pieces && !needCurrent) {
      return cacheEntry.pieces;
    }
    
    return cacheEntry.pieces = this._login().then(() => { // need login for exchange info
      return this._restAPICall('/papers/' + stockid + '/quotes?exchange=' + this._exchangeInfo.id);
    }).then(res => {
      debug('Day-based stock info fetched', stockid, !!res);
      
      if (!res || res.statusCode === 404) {
        return null;
      }
      
      return res.quotes.map(q => q.s).reduce((a, b) => a + b, 0);
    });
  }
  
  _fetchSingleStockInfo(stockid, options) {
    return Promise.all([
      this._getBasicInfo(stockid, options.loadFromPush),
      this._getTradedAmountToday(stockid, options.needCurrentPieces)
    ]).then(r => {
      if (!r[0]) {
        return null;
      }
      
      r[0].pieces = r[1] || 0;
      return this._handleRecord(r[0], false);
    });
  }
  
  _makeQuoteRequestFetch(stocklist, options) {
    debug('Fetching stocks', stocklist.length, JSON.stringify(options), process.pid);
    
    return Promise.all(stocklist.map(stockid => this._fetchSingleStockInfo(stockid, options)))
      .then(results => {
        debug('Fetched stocks', stocklist.length + ' queries', results.length + ' results');
        
        if (options.loadFromPush) {
          const pushCodes = results.map(r => r && r.pushCode).filter(c => c);
          
          this._pushService.subscribeStockInfos(pushCodes);
        }
        
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
    console.log(rec.length, _.map(rec, 'name'));
  }).catch(e => {
    console.error('Sorry, an error was encountered:');
    console.trace(e);
  });
}

if (require.main === module) {
  test();
}
