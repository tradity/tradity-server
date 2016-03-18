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

  describe('/options (GET)', function() {
    it('Should return information about own options', function() {
      return socket.get('/options').then(res => {
        assert.ok(res._success);
        assert.equal(res.data.name, user.name);
        assert.ok(!res.data.pwhash);
        assert.ok(!res.data.pwsalt);
      });
    });
  });
  
  describe('/options/clientstorage', function() {
    it('Should save information in arbitrary Buffers', function() {
      const buf = new Buffer([...Array(256).keys()]);
      
      return socket.put('/options/clientstorage', {
        body: buf,
        json: false
      }).then(res => {
        assert.ok(res._success);
        
        return socket.get('/options');
      }).then(res => {
        assert.ok(res._success);
        
        assert.ok(res.data.clientstorage);
        assert.ok(testHelpers.bufferEqual(new Buffer(res.data.clientstorage), buf));
      });
    });
  });
  
  describe('/ping', function() {
    it('Should really not do much', function() {
      return socket.get('/ping').then(res => {
        assert.equal(res.ping, 'pong');
      });
    });
  });
  
  describe('/_srvstats', function() {
    it('Should return some server statistics', function() {
      return socket.get('/_srvstats', { __sign__: true }).then(res => {
        assert.ok(res.data);
        assert.strictEqual(typeof res.data.pid, 'number');
        assert.strictEqual(typeof res.data.hostname, 'string');
        assert.strictEqual(typeof res.data.creationTime, 'number');
        assert.strictEqual(typeof res.data.now, 'number');
        assert.strictEqual(typeof res.data.msgCount, 'number');
        assert.strictEqual(typeof res.data.readonly, 'boolean');
        assert.strictEqual(typeof res.data.dbstats, 'object');
      });
    });
  });
  
  describe('Artificially created error testing', function() {
    beforeEach('Set SOTRADE_DO_NOT_OUTPUT_ERRORS', function() {
      process.env.SOTRADE_DO_NOT_OUTPUT_ERRORS = 'y';
    });
    
    afterEach('Unset SOTRADE_DO_NOT_OUTPUT_ERRORS', function() {
      process.env.SOTRADE_DO_NOT_OUTPUT_ERRORS = '';
    });
  
    describe('/artificial-error', function() {
      it('Should emit an internal "error" event', function() {
        return Promise.all([
          socket.once('error').then(err => {
            assert.ok(err.message.match(/Client-induced non-failure/));
          }),
          socket.post('/artificial-error', { __sign__: true })
        ]);
      });
    });
    
    describe('/artificial-db-error', function() {
      it('Leads to an artificial database error', function() {
        return Promise.all([
          socket.post('/artificial-db-error', { __sign__: true }).then(res => {
            assert.ok(res._success);
            assert.ok(res.data.err);
          }),
          socket.once('error').then(err => {
            console.log(err);
            assert.ok(err.message.match(/ER_PARSE_ERROR/));
          })
        ]);
      });
    });
  });
});
