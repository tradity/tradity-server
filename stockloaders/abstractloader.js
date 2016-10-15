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
const request = require('request');
const debug = require('debug')('sotrade:stockloader');
const promiseUtil = require('../lib/promise-util.js');

const MAXLEN_DEFAULT = 196;
const CACHE_TIME_DEFAULT = 25000;

const chunk = (arr, len) => (
  [...Array(Math.ceil(arr.length/len)).keys()]
    .map(o => arr.slice(o * len, (o+1) * len))
);

class AbstractLoader extends promiseUtil.EventEmitter {
  constructor(opt) {
    super();
    opt = opt || {};
    
    this.setMaxListeners(0);
    this.cacheTime = typeof opt.cacheTime === 'undefined' ? CACHE_TIME_DEFAULT : opt.cacheTime;
    this.maxlen = typeof opt.maxlen === 'undefined' ? MAXLEN_DEFAULT : opt.maxlen;
    this.requestRetries = typeof opt.requestRetries === 'undefined' ? 10 : opt.requestRetries;
    this.cache = new Map();
  }

  _handleRecord(record, cached) {
    if (!cached && record.failure === null) {
      if (!record.fetchTime) {
        record.fetchTime = Date.now();
      }

      this.cache.set(record.symbol, record);
    }
    
    this.emit('record', record);
    
    return record;
  }

  _makeQuoteRequest(stocklist, options) {
    let cachedResults = [];
    stocklist = stocklist.filter(stockid => {
      const cv = this.cache.get(stockid);
      if (cv) {
        if (cv.fetchTime > Date.now() - this.cacheTime) {
          cachedResults.push(this._handleRecord(cv, true));
          return false;
        } else {
          this.cache.delete(stockid);
        }
      }
      
      return true;
    });
    
    if (stocklist.length === 0) { // everything was cached
      return Promise.resolve(cachedResults);
    }
    
    // split stocklist into groups of maximum length maxlen
    // and flatten the resulting chunked array of records
    const chunkedStocklist = this.maxlen !== null ? chunk(stocklist, this.maxlen) : [stocklist];
    
    debug('Fetching stock list', stocklist.length, chunkedStocklist.length + ' chunks');
    
    return Promise.all(chunkedStocklist.map(chunk => {
      return this._makeQuoteRequestFetch(chunk, options);
    })).then(recordListChunks => {
      const fetchedRecordList = [].concat(...recordListChunks).filter(entry => entry);
      
      const receivedStocks = new Set();
      fetchedRecordList.forEach(record => {
        if (record.symbol) { receivedStocks.add(record.symbol); }
        if (record.isin)   { receivedStocks.add(record.isin); }
        if (record.wkn)    { receivedStocks.add(record.wkn); }
      });
      
      const notReceivedStocks = stocklist.filter(s => !receivedStocks.has(s));
      notReceivedStocks.forEach(failedName => {
        return this._handleRecord({failure: failedName}, false);
      });
      
      return fetchedRecordList.concat(cachedResults).filter(record => !record.failure);
    });
  }

  loadQuotesList(stocklist, options) {
    options = options || {};
    
    const filter = options.filter || (() => true);
    
    return Promise.resolve().then(() => {
      return this._makeQuoteRequest(stocklist, options);
    }).then(records => records.filter(filter));
  }

  request(url, attemptsLeft, headers, method, content) {
    if (typeof attemptsLeft === 'undefined' || attemptsLeft === null) {
      attemptsLeft = this.requestRetries;
    }
    
    method = (method || 'get').toLowerCase();
    headers = Object.assign({
      'User-Agent': this.userAgent
    }, headers || {});
    
    if (content) {
      headers['Content-Length'] = content.length;
    }
    
    debug('Loading', url, method);

    return new Promise((resolve, reject) => {
      const req = request[method]({
        url: url,
        headers: headers,
        gzip: true,
        timeout: 5000
      }, (err, res, body) => {
        const retry = () => promiseUtil.delay(750).then(() =>
          this.request(url, attemptsLeft - 1, headers, method, content));
        
        if (err) {
          debug('Loaded [error]', url, attemptsLeft, err);
          
          if (attemptsLeft > 0) {
            return resolve(retry());
          }
          
          return reject(err);
        }
        
        if (res.statusCode >= 500 && res.statusCode <= 599 && attemptsLeft > 0) {
          debug('Loaded [retrying]', url, attemptsLeft, res.statusCode);
          return resolve(retry());
        }
        
        if (res.statusCode !== 200) {
          debug('Loaded [failed]', url, res.statusCode);
          err = new Error('Stock loader error: URL ' + url + ' returned status code ' + res.statusCode);
          err.statusCode = res.statusCode;
          
          return reject(err);
        }
        
        debug('Loaded', url, res.statusCode);
        
        return resolve(body);
      });
      
      if (method !== 'get') {
        assert.ok(typeof content !== 'undefined');
        
        req.end(content);
      }
    });
  }
}

exports.AbstractLoader = AbstractLoader;
