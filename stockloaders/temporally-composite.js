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
const moment = require('moment');
const abstractloader = require('./abstractloader.js');
const debug = require('debug')('sotrade:stockloader:tc');

class TemporallyCompositeLoader extends abstractloader.AbstractLoader {
  constructor(opt, quoteLoaderProvider) {
    super(opt);
    
    assert.ok(opt);
    assert.ok(opt.bases);
    assert.ok(opt.bases.length > 0);
    
    this.bases = opt.bases;
    this.timezone = opt.timezone;
    this.quoteLoaderProvider = quoteLoaderProvider;
    
    this.setupEventForwarding = false;
  }

  _makeQuoteRequestFetch(stocklist, options) {
    if (!this.setupEventForwarding) {
      this.setupEventForwarding = true;
      
      this.bases.forEach(b => {
        this.quoteLoaderProvider.resolve(b.loader)
          .on('record', r => this.emit('record', r));
      });
    }
    
    for (let i = 0; i < this.bases.length; ++i) {
      const base = this.bases[i];
      
      if (!this.conditionsFulfilled(base.conditions)) {
        continue;
      }
      
      debug('Using base loader', base.loader);
      const instance = this.quoteLoaderProvider.resolve(base.loader);
      
      return instance._makeQuoteRequestFetch(stocklist, options);
    }
    
    throw new Error('No base loader matching the current conditions found');
  }
  
  conditionsFulfilled(conditions) {
    if (!conditions) {
      return true;
    }
    
    const now = moment.tz(this.timezone);
    const resolveTime = t => moment.tz(t, 'HH:mm', this.timezone);
    
    // { 'type': 'after',  'time': '07:57' },
    // { 'type': 'before', 'time': '20:03' }
    return conditions.map(cond => {
      if (cond.type === 'after') {
        return now.isAfter(resolveTime(cond.time));
      } else if (cond.type === 'before') {
        return now.isBefore(resolveTime(cond.time));
      } else {
        throw Error('Unknown condition type ' + cond.type);
      }
    }).reduce((a, b) => a && b);
  }
}

exports.QuoteLoader = TemporallyCompositeLoader;
