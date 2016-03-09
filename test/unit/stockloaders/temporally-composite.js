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

'use strict';

const assert = require('assert');
const moment = require('moment-timezone');

const tcl = require('../../../stockloaders/temporally-composite.js');

describe('Temporally composite stockloader', function() {
  const tz = 'Antarctica/Troll';
  const stocklist = ['1', '2', '3'];
  let now;
  let currentIntervalConditions, unfulfilledConditions;
  
  before(function() {
    now = moment.tz(tz);
    currentIntervalConditions = [
      { type: 'after',  time: now.clone().subtract(1, 'minute').format('HH:mm') },
      { type: 'before', time: now.clone().add     (1, 'minute').format('HH:mm') }
    ];
    
    unfulfilledConditions = [
      { type: 'after',  time: now.clone().subtract(2, 'minute').format('HH:mm') },
      { type: 'before', time: now.clone().subtract(1, 'minute').format('HH:mm') }
    ];
  });
  
  const qlcall = (actual, expected, stocklist_) => {
    assert.strictEqual(stocklist, stocklist_);
    assert.strictEqual(actual, expected);
    
    return Promise.resolve();
  };
  
  const getMockQuoteLoaderProvider = expected => ({
    resolve(name) {
      return this[name];
    },
    
    A: {
      _makeQuoteRequestFetch(stocklist) {
        return qlcall('A', expected, stocklist);
      }
    },
    
    B: {
      _makeQuoteRequestFetch(stocklist) {
        return qlcall('B', expected, stocklist);
      }
    },
  });
  
  it('Should choose some stockloader depending on the current time', function() {
    const mockQuoteLoaderProvider = getMockQuoteLoaderProvider('A');
    
    const mockConfig = {
      timezone: tz,
      bases: [
        { loader: 'A', conditions: currentIntervalConditions },
        { loader: 'B' }
      ]
    };
    
    const loader = new tcl.QuoteLoader(mockConfig, mockQuoteLoaderProvider);
    return loader._makeQuoteRequestFetch(stocklist);
  });
  
  it('Should choose the first available loader', function() {
    const mockQuoteLoaderProvider = getMockQuoteLoaderProvider('A');
    
    const mockConfig = {
      timezone: tz,
      bases: [
        { loader: 'A' },
        { loader: 'B' }
      ]
    };
    
    const loader = new tcl.QuoteLoader(mockConfig, mockQuoteLoaderProvider);
    return loader._makeQuoteRequestFetch(stocklist);
  });
  
  it('Should choose the an alternative if the first loader is not available', function() {
    const mockQuoteLoaderProvider = getMockQuoteLoaderProvider('B');
    
    const mockConfig = {
      timezone: tz,
      bases: [
        { loader: 'A', conditions: unfulfilledConditions },
        { loader: 'B' }
      ]
    };
    
    const loader = new tcl.QuoteLoader(mockConfig, mockQuoteLoaderProvider);
    return loader._makeQuoteRequestFetch(stocklist);
  });
});
