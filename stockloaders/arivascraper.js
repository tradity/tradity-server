#!/usr/bin/env node
"use strict";

const assert = require('assert');
const minimist = require('minimist');
const _ = require('lodash');
const abstractloader = require('./abstractloader.js');
const debug = require('debug')('sotrade:stockloader:arivascraper');

const INFO_LINK_DEFAULT = 'http://www.ariva.de/search/search.m?searchname=%{isin}';
const BASE_LINK_DEFAULT = 'http://www.ariva.de/';
const USER_AGENT_DEFAULT = 'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:42.0) Gecko/20100101 Firefox/42.0';

function ArivaScraperQuoteEntry(record) {
  _.each(record, (value, key) => {
    if (parseFloat(value) === parseFloat(value)) {
      this[key] = parseFloat(value);
    } else {
      this[key] = value;
    }
  });
  
  this.ask = this.ask || this.last;
  this.bid = this.bid || this.last;
  
  this.symbol = this.isin;
  this.lastTradePrice = this.last;
  this.exchange = this.boerse_name;
  this.failure = null;
}

class ArivaScraperQuoteLoader extends abstractloader.AbstractLoader {
  constructor(opt) {
    super(opt);
    
    this.infoLink = opt.infoLink || INFO_LINK_DEFAULT;
    this.baseLink = opt.baseLink || BASE_LINK_DEFAULT;
    this.userAgent = opt.userAgent || USER_AGENT_DEFAULT;
    this.maxlen = 1; // overrides AbstractLoader.maxlen
  }

  _makeQuoteRequestFetch(stocklist) {
    debug('Fetching stocks', stocklist.length);
    assert.equal(stocklist.length, 1);
    const requrl = this.infoLink.replace(/%\{isin\}/g, stocklist[0].toUpperCase());
    
    return this.request(requrl).then(body => {
      const content = {};
      
      content.last = body.match(/<span\s*itemprop="price"\s*content="([^"]+)">/)[1];
      content.currency_name = body.match(/<span\s*itemprop="pricecurrency"\s*content="([^"]+)">/)[1];
      content.name = body.match(/<span\s*itemprop="name"\s*>([^<]+) (\w+)<\/span>/)[1];
      content.isin = body.match(/ISIN: ([A-Z0-9]{12})\b/)[1];
      content.wkn = body.match(/WKN: ([A-Z0-9]{6})\b/)[1];
      content.boerse_name = 'Frankfurt';// sorry
      
      const valuesLink = body.match(/href="\/([^"]+\/kurs)">Kurse<\/a>/)[1];
      return this.request(this.baseLink + valuesLink).then(body2 => {
        content.pieces = body2.match(/<span class="[A-Za-z0-9_]+@1.22_V_format=int">([0-9\.,]+)<\/span>/)[1].replace(/\./g, '').replace(/,/g, '.');
        content.bid = body2.match(/<span class="[A-Za-z0-9_]+@1.22_b_format=auto_blink" >([0-9\.,]+)<\/span>/)[1].replace(/\./g, '').replace(/,/g, '.');
        content.ask = body2.match(/<span class="[A-Za-z0-9_]+@1.22_a_format=auto_blink" >([0-9\.,]+)<\/span>/)[1].replace(/\./g, '').replace(/,/g, '.');
        
        return [this._handleRecord(new ArivaScraperQuoteEntry(content), false)];
      });
    });
  }
}

exports.QuoteLoader = ArivaScraperQuoteLoader;

function test() {
  const options = minimist(process.argv.slice(2));
  
  const ql = new ArivaScraperQuoteLoader(options);
  ql.on('error', e => console.log(e, e.stack + ''));
  
  ql.loadQuotesList(['DE000BAY0017', 'ZAE000149936']).then(rec => {
    console.log(rec.length, _.pluck(rec, 'name'));
  }).catch(e => {
    console.error('Sorry, an error was encountered:');
    console.log(e);
    console.log(e.stack);
  });
}

if (require.main === module) {
  test();
}
