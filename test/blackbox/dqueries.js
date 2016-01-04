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

  describe('dquery', function() {
    it('Should let users delay queries', function() {
      return socket.emit('dquery', {
        condition: 'time > ' + parseInt(Date.now()/1000 + 5),
        query: { type: 'ping' }
      }).then(res => {
        assert.equal(res.code, 'dquery-success');
        
        return promiseUtil.delay(10000);
      }).then(() => {
        return Promise.all([
          socket.once('dquery-exec'),
          socket.emit('dquery-checkall', { __sign__: true })
        ]);
      });
    });
  });
  
  describe('dquery-list', function() {
    it('Should list a user’s delayed queries', function() {
      return socket.emit('dquery', {
        condition: 'time > ' + parseInt(Date.now()/1000 + 60),
        query: { type: 'ping' }
      }).then(res => {
        assert.equal(res.code, 'dquery-success');
        
        return socket.emit('dquery-list');
      }).then(res => {
        assert.equal(res.code, 'dquery-list-success');
        assert.ok(res.results);
        assert.ok(res.results.length > 0);
      });
    });
  });
  
  describe('dquery-list', function() {
    it('Should remove a delayed query', function() {
      let queryid;
      
      return socket.emit('dquery', {
        condition: 'time > ' + parseInt(Date.now()/1000 + 60),
        query: { type: 'ping' }
      }).then(res => {
        assert.equal(res.code, 'dquery-success');
        queryid = res.queryid;
        
        return socket.emit('dquery-remove', {
          queryid: queryid
        });
      }).then(res => {
        assert.equal(res.code, 'dquery-remove-success');
        
        return socket.emit('dquery-list');
      }).then(res => {
        assert.equal(res.code, 'dquery-list-success');
        assert.ok(res.results);
        assert.equal(_.pluck(res.results, 'queryid').indexOf(queryid), -1);
      });
    });
  });
});
