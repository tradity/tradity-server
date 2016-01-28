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
const testHelpers = require('./test-helpers.js');

describe('stocks', function() {
  let socket, user;

  before(function() {
    return testHelpers.standardSetup().then(data => {
      socket = data.socket;
      user = data.user;
    });
  });
  
  beforeEach(function() {
    /* do standard reset, then clear depot */
    return testHelpers.standardReset().then(() => {
      return socket.emit('list-own-depot');
    }).then(data => {
      assert.equal(data.code, 'list-own-depot-success');
      assert.ok(data.results);
      
      return Promise.all(data.results.map(r => {
        return socket.emit('stock-buy', {
          __sign__: true,
          amount: -r.amount,
          value: null,
          stocktextid: r.stockid,
          leader: null,
          forceNow: true
        });
      }));
    });
  });

  beforeEach(testHelpers.standardReset);
  after(testHelpers.standardTeardown);
  
  const standardISIN = 'DE000BAY0017';
  const umlautNameISIN = 'DE0005565204';

  if (!testHelpers.testPerformance) {
  describe('prod', function() {
    it('Works', function() {
      return socket.emit('prod', {
        __sign__: true
      }).then(res => {
        assert.equal(res.code, 'prod-ready');
      });
    });
  });
  }
  
  describe('stock-search', function() {
    it('Returns information based on the ISIN', function() {
      return socket.emit('stock-search', {
        name: standardISIN
      }).then(res => {
        assert.equal(res.code, 'stock-search-success');
        assert.equal(res.results.length, 1);
        const stockinfo = res.results[0];
        
        assert.ok(stockinfo);
        assert.strictEqual(stockinfo.stocktextid, standardISIN);
        assert.strictEqual(stockinfo.leader, null);
        assert.strictEqual(stockinfo.leadername, null);
        assert.strictEqual(stockinfo.lprovision, 0);
        assert.strictEqual(stockinfo.wprovision, 0);
      });
    });
    
    it('Should handle umlauts correctly', function() {
      return socket.emit('stock-search', {
        name: umlautNameISIN
      }).then(res => {
        assert.equal(res.code, 'stock-search-success');
        assert.equal(res.results.length, 1);
        const stockinfo = res.results[0];
        
        assert.ok(stockinfo);
        assert.strictEqual(stockinfo.stockid, umlautNameISIN);
        assert.strictEqual(stockinfo.leader, null);
        assert.strictEqual(stockinfo.leadername, null);
        assert.ok(/ü/.test(stockinfo.name));
      });
    });
    
    it('Returns information based on the username', function() {
      return socket.emit('stock-search', {
        name: user.name
      }).then(res => {
        assert.equal(res.code, 'stock-search-success');
        assert.equal(res.results.length, 1);
        const stockinfo = res.results[0];
        
        assert.ok(stockinfo);
        assert.strictEqual(stockinfo.leader, user.uid);
        assert.strictEqual(stockinfo.leadername, user.name);
        assert.notStrictEqual(stockinfo.wprovision, 0);
      });
    });
  });
  
  describe('stock-buy', function() {
    it('Can buy and sell stocks via forceNow', function() {
      const amount = 1;
      
      /* clear depot first */
      return socket.emit('stock-buy', {
        __sign__: true,
        amount: amount,
        value: null,
        stocktextid: standardISIN,
        leader: null,
        forceNow: true,
        skipTest: true
      }).then(res => {
        assert.equal(res.code, 'stock-buy-success');
        
        return socket.once('trade');
      }).then(() => {
        return socket.emit('list-own-depot');
      }).then(data => {
        assert.equal(data.code, 'list-own-depot-success');
        assert.ok(data.results);
        assert.equal(data.results.length, 1);
        assert.equal(data.results[0].stockid, standardISIN);
        assert.equal(data.results[0].amount, amount);
        
        return socket.emit('stock-buy', {
          __sign__: true,
          amount: -amount,
          value: null,
          stocktextid: standardISIN,
          leader: null,
          forceNow: true,
          skipTest: true
        });
      }).then(res => {
        assert.ok(res.code === 'stock-buy-success' ||
                  res.code === 'stock-buy-not-enough-stocks');
        
        return socket.once('trade');
      }).then(() => {
        return socket.emit('list-own-depot');
      }).then(data => {
        assert.equal(data.code, 'list-own-depot-success');
        assert.ok(data.results);
        assert.equal(data.results.length, 0);
        
        return socket.emit('stock-buy', {
          __sign__: true,
          amount: -amount,
          value: null,
          stocktextid: standardISIN,
          leader: null,
          forceNow: true,
          skipTest: true
        });
      }).then(data => {
        assert.equal(data.code, 'stock-buy-not-enough-stocks');
        
        return socket.emit('list-transactions');
      }).then(data => {
        assert.equal(data.code, 'list-transactions-success');
        assert.ok(data.results);
        assert.ok(data.results.length > 0);
        
        return socket.emit('get-user-info', {
          lookfor: '$self',
          noCache: true, __sign__: true
        });
      }).then(res => {
        assert.equal(res.code, 'get-user-info-success');
        
        assert.ok(res.orders);
        assert.ok(res.orders.length > 0);
        
        return socket.emit('get-trade-info', {
          tradeid: res.orders[0].orderid
        });
      }).then(res => {
        assert.equal(res.code, 'get-trade-info-success');
        
        assert.ok(res.trade);
        assert.equal(res.trade.uid, user.uid);
      });
    });
  });
});
