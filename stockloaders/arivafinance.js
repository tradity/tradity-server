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

"use strict";

const assert = require('assert');
const minimist = require('minimist');
const xml2js = require('xml2js');
const _ = require('lodash');
const os = require('os');
const abstractloader = require('./abstractloader.js');
const debug = require('debug')('sotrade:stockloader:ariva');

const INFO_LINK_DEFAULT = 'http://data.ariva.de/boersefrankfurt/%{apiKey}/q.xml?%{isins}&cols=ask,bid,pieces,last,boerse_id,boerse_name,delay,isin,wkn,currency_name,name';
const USER_AGENT_DEFAULT = '(+tech@tradity.de node' + process.version + '@' + os.hostname() + ' http)';

function ArivaFinanceQuoteEntry(record) {
  _.each(record, (value, key) => {
    if (parseFloat(value[0]) === parseFloat(value[0])) {
      this[key] = parseFloat(value[0]);
    } else {
      this[key] = value[0];
    }
  });
  
  this.ask = this.ask || this.last;
  this.bid = this.bid || this.last;
  
  this.symbol = this.isin;
  this.lastTradePrice = this.last;
  this.exchange = this.boerse_name;
  this.failure = null;
}

class ArivaFinanceQuoteLoader extends abstractloader.AbstractLoader {
  constructor(opt) {
    assert.ok(opt);
    assert.ok(opt.apiKey);
    
    super(opt);
    
    this.infoLink = (opt.infoLink || INFO_LINK_DEFAULT).replace(/%\{apiKey\}/g, opt.apiKey);
    this.userAgent = 'Ariva.de loader script; ' + (opt.userAgent || USER_AGENT_DEFAULT);
  }
  
  _makeQuoteRequestFetch(stocklist) {
    debug('Fetching stocks', stocklist.length);
    const sl = _.chain(stocklist).map(code => {
      return (code.length === 6 ? 'wkn=' : 'isin=') + code.toUpperCase() + '@1';
    }).reduce((memo, code) => memo + '&' + code, '').value();
    
    const requrl = this.infoLink.replace(/%\{isins\}/g, sl);
    
    return this.request(requrl).then(body => {
      const parserDeferred = Promise.defer();
    
      const parser = new xml2js.Parser();
      parser.on('error', e => {
        throw e;
      });
      
      parser.on('end', results => {
        if (!results) {
          return parserDeferred.reject(new Error('Ariva loader error: URL ' + requrl + ' returned invalid XML'));
        }
        
        let resultList = [];
        
        if (results.quotes) {
          resultList = results.quotes.quote.map(record => {
            return this._handleRecord(new ArivaFinanceQuoteEntry(record), false);
          });
        }
        
        parserDeferred.resolve(resultList);
      });
      
      parser.on('error', e => parserDeferred.reject(e));
      parser.parseString(body);
      
      return parserDeferred.promise;
    });
  }
}

exports.QuoteLoader = ArivaFinanceQuoteLoader;

function test() {
  const options = minimist(process.argv.slice(2));
  
  const ql = new ArivaFinanceQuoteLoader(options);
  ql.on('error', e => console.log(e, e.stack + ''));
  
  ql.loadQuotesList(['AT00000AMAG3', 'ZAE000149936']).then(rec => {
    console.log(rec.length, _.pluck(rec, 'name'));
  }).catch(e => {
    console.error('Sorry, an error was encountered:');
    console.trace(e);
  });
}

if (require.main === module) {
  test();
}
