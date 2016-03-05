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
      return socket.get('/depot');
    }).then(result => {
      assert.ok(result._success);
      assert.ok(result.data);
      
      return Promise.all(result.data.map(r => {
        return socket.post('/trade', {
          __sign__: true,
          body: {
            amount: -r.amount,
            value: null,
            stocktextid: r.stockid,
            leader: null,
            forceNow: true
          }
        });
      }));
    });
  });

  beforeEach(testHelpers.standardReset);
  after(testHelpers.standardTeardown);
  
  const standardISIN = 'DE000BAY0017';
  const umlautNameISIN = 'DE0005565204';

  describe('/regular-callback', function() {
    it('Works', function() {
      return socket.post('/regular-callback', {
        __sign__: true
      }).then(res => {
        assert.ok(res._success);
      });
    });
  });
  
  describe('/stocks/search', function() {
    it('Returns information based on the ISIN', function() {
      return socket.get('/stocks/search', {
        qs: { name: standardISIN }
      }).then(res => {
        assert.ok(res._success);
        assert.equal(res.data.length, 1);
        const stockinfo = res.data[0];
        
        assert.ok(stockinfo);
        assert.strictEqual(stockinfo.stocktextid, standardISIN);
        assert.strictEqual(stockinfo.leader, null);
        assert.strictEqual(stockinfo.leadername, null);
        assert.strictEqual(stockinfo.lprovision, 0);
        assert.strictEqual(stockinfo.wprovision, 0);
      });
    });
    
    it('Should handle umlauts correctly', function() {
      return socket.get('/stocks/search', {
        qs: { name: umlautNameISIN }
      }).then(res => {
        assert.ok(res._success);
        assert.equal(res.data.length, 1);
        const stockinfo = res.data[0];
        
        assert.ok(stockinfo);
        assert.strictEqual(stockinfo.stocktextid, umlautNameISIN);
        assert.strictEqual(stockinfo.leader, null);
        assert.strictEqual(stockinfo.leadername, null);
        assert.ok(/ü/.test(stockinfo.name));
      });
    });
    
    it('Returns information based on the username', function() {
      return socket.get('/stocks/search', {
        qs: { name: user.name }
      }).then(res => {
        assert.ok(res._success);
        assert.equal(res.data.length, 1);
        const stockinfo = res.data[0];
        
        assert.ok(stockinfo);
        assert.strictEqual(stockinfo.leader, user.uid);
        assert.strictEqual(stockinfo.leadername, user.name);
        assert.notStrictEqual(stockinfo.wprovision, 0);
      });
    });
  });
  
  describe('/trade', function() {
    it('Can buy and sell stocks via forceNow', function() {
      const amount = 1;
      
      /* clear depot first */
      return Promise.all([
        socket.post('/trade', {
          __sign__: true,
          body: {
            amount: amount,
            value: null,
            stocktextid: standardISIN,
            leader: null,
            forceNow: true,
            skipTest: true
          }
        }).then(res => {
          assert.ok(res._success);
        }),
        socket.once('feed-trade')
      ]).then(() => {
        return socket.get('/depot');
      }).then(result => {
        assert.ok(result._success);
        assert.ok(result.data);
        assert.equal(result.data.length, 1);
        assert.equal(result.data[0].stocktextid, standardISIN);
        assert.equal(result.data[0].amount, amount);
        
        return socket.post('/trade', {
          __sign__: true,
          body: {
            amount: -amount,
            value: null,
            stocktextid: standardISIN,
            leader: null,
            forceNow: true,
            skipTest: true
          }
        });
      }).then(res => {
        assert.ok(res.code === 200 ||
                  res.identifier === 'not-enough-stocks');
        
        return socket.get('/depot');
      }).then(result => {
        assert.ok(result._success);
        assert.ok(result.data);
        assert.equal(result.data.length, 0);
        
        return socket.post('/trade', {
          __sign__: true,
          body: {
            amount: -amount,
            value: null,
            stocktextid: standardISIN,
            leader: null,
            forceNow: true,
            skipTest: true
          }
        });
      }).then(result => {
        assert.equal(result.code, 403);
        assert.equal(result.identifier, 'not-enough-stocks');
        
        return socket.get('/transactions');
      }).then(result => {
        assert.ok(result._success);
        assert.ok(result.data);
        assert.ok(result.data.length > 0);
        
        return socket.get('/user/$self', {
          qs: { lookfor: '$self' },
          cache: false, __sign__: true
        });
      }).then(res => {
        assert.ok(res._success);
        
        assert.ok(res.orders);
        assert.ok(res.orders.length > 0);
        
        return socket.get('/trade/' + res.orders[0].orderid);
      }).then(res => {
        assert.ok(res._success);
        
        assert.ok(res.data);
        assert.equal(res.data.uid, user.uid);
      });
    });
  });
});
