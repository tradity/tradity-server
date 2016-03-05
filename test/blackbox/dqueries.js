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
const promiseUtil = require('../../lib/promise-util.js');

describe('dqueries', function() {
  let socket;

  before(function() {
    return testHelpers.standardSetup().then(data => {
      socket = data.socket;
    });
  });

  beforeEach(testHelpers.standardReset);
  after(testHelpers.standardTeardown);

  describe('/dqueries (POST)', function() {
    it('Should let users delay queries', function() {
      return socket.post('/dqueries', {
        body: {
          condition: 'time > ' + parseInt(Date.now()/1000 + 5),
          query: { type: 'Ping' }
        }
      }).then(res => {
        assert.ok(res._success);
      }).then(() => {
        return Promise.all([
          //socket.once('dquery-exec'),
          socket.post('/dqueries/check-all', { __sign__: true })
        ]);
      });
    });
  });
  
  describe('/dqueries (GET)', function() {
    it('Should list a user’s delayed queries', function() {
      return socket.post('/dqueries', {
        body: {
          condition: 'time > ' + parseInt(Date.now()/1000 + 60),
          query: { type: 'Ping' }
        }
      }).then(res => {
        assert.ok(res._success);
        
        return socket.get('/dqueries');
      }).then(res => {
        assert.ok(res._success);
        assert.ok(res.data);
        assert.ok(res.data.length > 0);
      });
    });
  });
  
  describe('/dqueries/… (DELETE)', function() {
    it('Should remove a delayed query', function() {
      let queryid;
      
      return socket.post('/dqueries', {
        body: {
          condition: 'time > ' + parseInt(Date.now()/1000 + 60),
          query: { type: 'Ping' }
        }
      }).then(res => {
        assert.ok(res._success);
        queryid = res.queryid;
        
        return socket.delete('/dqueries/' + queryid);
      }).then(res => {
        assert.ok(res._success);
        
        return socket.get('/dqueries');
      }).then(res => {
        assert.ok(res._success);
        assert.ok(res.data);
        assert.equal(_.map(res.data, 'queryid').indexOf(queryid), -1);
      });
    });
  });
});
