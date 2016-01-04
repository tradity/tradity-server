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

describe('misc', function() {
  let socket, user;

  before(function() {
    return testHelpers.standardSetup().then(data => {
      socket = data.socket;
      user = data.user;
    });
  });

  beforeEach(testHelpers.standardReset);
  after(testHelpers.standardTeardown);

  describe('get-own-options', function() {
    it('Should return information about own options', function() {
      return socket.emit('get-own-options').then(res => {
        assert.equal(res.code, 'get-own-options-success');
        assert.equal(res.result.name, user.name);
        assert.ok(!res.result.pwhash);
        assert.ok(!res.result.pwsalt);
      });
    });
  });
  
  describe('set-client-storage', function() {
    it('Should save information in arbitrary Buffers', function() {
      const buf = new Buffer(_.range(0, 256));
      
      return socket.emit('set-clientstorage', {
        storage: buf
      }).then(res => {
        assert.equal(res.code, 'set-clientstorage-success');
        
        return socket.emit('get-own-options');
      }).then(res => {
        assert.equal(res.code, 'get-own-options-success');
        
        assert.ok(res.result.clientstorage);
        assert.ok(testHelpers.bufferEqual(res.result.clientstorage, buf));
      });
    });
    
    it('Should fail with format-error when given invalid input', function() {
      return socket.emit('set-clientstorage', {
        storage: null
      }).then(res => {
        assert.equal(res.code, 'format-error');
      });
    });
  });
  
  describe('ping', function() {
    it('Should really not do much', function() {
      return socket.emit('ping').then(res => {
        assert.equal(res.code, 'pong');
      });
    });
  });
  
  describe('fetch-events', function() {
    it('Should return fetched-events', function() {
      return socket.emit('fetch-events', res => {
        assert.equal(res.code, 'fetched-events');
      });
    });
  });
});
