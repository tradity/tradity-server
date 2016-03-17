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
const nock = require('nock');

const bff = require('../../../stockloaders/boerse-frankfurt.js');

const lightstreamerURL = "http://push.dbagproject.de/";
const lightstreamerDataAdapter = "MDS5";
const lightstreamerAdapterSet = "SmarthouseFeed";

class LSEventEmitter {
  constructor() {
    this.listeners = [];
  }
  
  addListener(l) {
    this.listeners.push(l);
  }
}

const mockLightstreamer = {
  LightstreamerClient: class LightstreamerClient extends LSEventEmitter {
    constructor(url, adapterSet) {
      super();
      
      assert.strictEqual(url, lightstreamerURL);
      assert.strictEqual(adapterSet, lightstreamerAdapterSet);
    }
    
    connect() {
      return this.listeners.map(l => {
        return l.onStatusChange('CONNECTED:WS-STREAMING');
      });
    }
    
    subscribe(subscription) {
      return Promise.all(subscription.listeners.map(l => l.onSubscription()))
        .then(() => Promise.all(subscription.listeners.map(l => {
          return l.onItemUpdate(subscription.fakeItem);
        })));
    }
  },
  
  Subscription: class Subscription extends LSEventEmitter {
    constructor(mode, items, fields) {
      super();
      
      assert.strictEqual(typeof mode, 'string');
      assert.ok(Array.isArray(items));
      assert.ok(Array.isArray(fields));
      
      this.fields = fields;
      
      this.fakeItem = {
        getItemName() {
          return 'X00000A020011450563';
        },
        getValue(fieldName) {
          assert.ok(this.hasOwnProperty(fieldName));
          
          return this[fieldName];
        },
        quotetime: '2016-03-17T17:59:09Z',
        bid: 65.0,
        ask: 65.8
      };
    }
    
    getFields() {
      return this.fields;
    }
    
    setDataAdapter(adapter) {
      assert.strictEqual(adapter, lightstreamerDataAdapter);
    }
    
    setRequestedSnapshot(b) {
      assert.ok(b === 'yes' || b === 'no');
    }
    
    setRequestedMaxFrequency(freq) {
      assert.ok(freq === null || typeof freq === 'number');
    }
  }
};

describe('Börse Frankfurt stock loader', function() {
  const defaultOptions = {
    apiUsername: 'username',
    apiPassword: 'password',
    exchange: 'FSE',
    lightstreamer: mockLightstreamer
  };
  
  before(function() {
    nock('http://mobileapi.dbagproject.de')
      .persist()
      .post(/^\/session?/)
      .reply(200, (uri, requestBody) => {
        assert.strictEqual(requestBody.login,    defaultOptions.apiUsername);
        assert.strictEqual(requestBody.password, defaultOptions.apiPassword);
        
        return {
          "sid": "4f7fa85e-521f-43ef-8ced-e6af566da221",
          "mappings": {
            "exchanges": [
              {"id":1,"name":"Forex Rates","gatrixxCode":"FXR"},
              {"id":3,"name":"Frankfurt","gatrixxCode":"FSE"},
            ],
          },
          "lightstreamerURL":lightstreamerURL,
          "lightstreamerDataAdapter":lightstreamerDataAdapter,
          "lightstreamerAdapterSet":lightstreamerAdapterSet
        };
      })
      .get(/\/papers\/([^/]+)$/)
      .reply(200, {
        "isin": "DE000BASF111",
        "listings": [
          {
            "currency": "EUR",
            "pushCode": "X00000A020011450563",
            "exchangeSymbol": "FSE",
            "timestamp": "2016-03-17T17:59:07Z",
            "price": 65.2,
            "yesterday": 65.45,
            "bid": 64.881,
            "ask": 65.2
          }
        ],
        "wkn": "BASF11",
        "name": "BASF",
        "symbol": "BAS",
        "type": "Share",
        "isPercent": false,
        "isTradeable": true,
        "haveOrderbook": true,
        "haveFrankfurtRealtime": true
      })
      .get(/\/papers\/(.+)\/quotes/)
      .reply(200, {
        "currency": null,
        "exchange": "FSE",
        "quotes": [
          {
            "d": "2016-03-17T07:00:25Z",
            "o": 65.6, "h": 65.6, "l": 65.6, "c": 65.6, "v": 175, "s": 175
          },
          {
            "d": "2016-03-17T07:04:57Z",
            "o": 65.844, "h": 65.844, "l": 65.844, "c": 65.844, "v": 50, "s": 50
          },
          {
            "d": "2016-03-17T07:23:31Z",
            "o": 65.97, "h": 65.97, "l": 65.97, "c": 65.97, "v": 30, "s": 30
          },
          {
            "d": "2016-03-17T08:00:27Z",
            "o": 66.113, "h": 66.113, "l": 66.113, "c": 66.113, "v": 155, "s": 155
          },
          {
            "d": "2016-03-17T08:02:39Z",
            "o": 66.03, "h": 66.03, "l": 66.03, "c": 66.03, "v": 400, "s": 400
          }
        ]
      });
  });
  
  it('Loads stock infos and quote infos', function() {
    const ql = new bff.QuoteLoader(Object.assign({}, defaultOptions, {
      lightstreamer: null
    }));
    
    return ql.loadQuotesList(['DE000BASF111', 'ZAE000149936'], {
      needCurrentPieces: true,
      loadFromPush: true
    }).then(results => {
      assert.equal(results.length, 2);
    });
  });
  
  it('Fails to attach to a PUSH API when connecting fails', function() {
    const ql = new bff.QuoteLoader(Object.assign({}, defaultOptions, {
      lightstreamer: {
        LightstreamerClient: class {
          constructor(/*url, adapterSet*/) {
            throw new Error('PUSH API not available');
          }
        }
      }
    }));
    
    return Promise.all([
      new Promise((resolve, reject) => {
        ql.on('error', err => {
          if (err.message.match(/PUSH API not available/)) {
            resolve();
          } else {
            reject(err);
          }
        });
      }),
      ql.loadQuotesList(['DE000BASF111'], {
        needCurrentPieces: false,
        loadFromPush: true
      })
    ]);
  });
  
  it('Attaches to a PUSH API when available', function() {
    const ql = new bff.QuoteLoader(defaultOptions);
    
    return new Promise((resolve, reject) => {
      ql.on('error', reject);
      
      let recordCount = 0;
      ql.on('record', record => {
        assert.strictEqual(typeof record.ask, 'number');
        assert.strictEqual(typeof record.bid, 'number');
        
        if (++recordCount === 2) {
          resolve();
        }
      });
      
      return ql.loadQuotesList(['DE000BASF111'], {
        needCurrentPieces: false,
        loadFromPush: true
      }).then(results => {
        assert.equal(results.length, 1);
      }).catch(reject);
    });
  });
});
