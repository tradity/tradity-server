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
const _ = require('lodash');
const testHelpers = require('./test-helpers.js');

describe('watchlist', function() {
  let socket;
  
  before(function() {
    return testHelpers.standardSetup().then(data => {
      socket = data.socket;
    });
  });

  beforeEach(testHelpers.standardReset);
  after(testHelpers.standardTeardown);

  describe('/watchlist (POST)', function() {
    it('Can add stocks to the watchlist', function() {
      let stock;
      
      return socket.get('/stocks/popular', {
        __sign__: true,
        qs: { days: 10000 },
      }).then(res => {
        assert.ok(res._success);
        assert.ok(res.data);
        assert.ok(res.data.length > 0);
        
        stock = res.data[0].stocktextid;
        
        return socket.post('/watchlist', {
          body: { stockid: stock }
        });
      }).then(res => {
        assert.ok(res._success);
      });
    });
    
    it('Can add leaders to the watchlist', function() {
      let stock;
      
      return socket.get('/ranking').then(res => {
        assert.ok(res._success);
        assert.ok(res.data);
        assert.ok(res.data.length > 0);
        
        stock = '__LEADER_' + res.data[0].uid + '__';
        
        return socket.post('/watchlist', {
          body: { stockid: stock }
        });
      }).then(res => {
        assert.ok(res._success);
      });
    });
  });
  
  describe('/watchlist/… (DELETE)', function() {
    it('Can remove stocks from the watchlist', function() {
      let stock, uid;
      
      return socket.get('/ranking').then(res => {
        assert.ok(res._success);
        assert.ok(res.data);
        assert.ok(res.data.length > 0);
        
        uid = res.data[0].uid;
        stock = '__LEADER_' + uid + '__';
        
        return socket.post('/watchlist', {
          body: { stockid: stock }
        });
      }).then(res => {
        assert.ok(res._success);
        
        return socket.get('/watchlist');
      }).then(res => {
        assert.ok(res._success);
        assert.ok(res.data);
        
        const entry = res.data
          .filter(watchlistEntry => watchlistEntry.uid === uid)[0];
        
        assert.ok(entry);
        
        return socket.delete('/watchlist/' + entry.stockid);
      }).then(res => {
        assert.ok(res._success);
        
        return socket.get('/watchlist');
      }).then(res => {
        assert.ok(res._success);
        assert.ok(res.data);
        
        assert.equal(_.map(res.data, 'uid').indexOf(uid), -1);
      });
    });
  });
});
