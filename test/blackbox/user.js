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
const promiseUtil = require('../../lib/promise-util.js');
const spread = promiseUtil.spread;

describe('user', function() {
  let socket, user;

  before(function() {
    return testHelpers.standardSetup().then(data => {
      socket = data.socket;
      user = data.user;
    });
  });

  beforeEach(testHelpers.standardReset);
  after(testHelpers.standardTeardown);

  describe('/user/…', function() {
    it('Should return no values with .nohistory', function() {
      return socket.get('/user/' + user.name, {
        qs: { nohistory: true },
        cache: false, __sign__: true
      }).then(res => {
        assert.ok(res._success);
        assert.ok(res.data);
        assert.ok(!res.comments);
        assert.ok(!res.orders);
        assert.ok(!res.values);
      });
    });
    
    it('Should return a valuehistory without .nohistory', function() {
      return socket.post('/regular-callback', {
        __sign__: true
      }).then(() => {
        return socket.get('/user/' + user.name, {
          cache: false, __sign__: true
        });
      }).then(res => {
        assert.ok(res._success);
        assert.ok(res.data);
        assert.ok(res.pinboard);
        assert.ok(res.orders);
        assert.ok(res.values);
      });
    });
    
    it('Should be able to search by name and by ID', function() {
      return Promise.all([
        socket.get('/user/' + user.name, {
          qs: { nohistory: true },
          cache: false, __sign__: true
        }),
        socket.get('/user/' + user.uid, {
          qs: { nohistory: true },
          cache: false, __sign__: true
        })
      ]).then(spread((byName, byID) => {
        assert.ok(byName._success);
        assert.ok(byID._success);
        assert.equal(byName.data.name, byID.data.name);
        assert.equal(byName.data.totalvalue, byID.data.totalvalue);
        assert.equal(byName.data.lstockid, byID.data.lstockid);
      }));
    });
  });
  
  describe('/validate-username', function() {
    it('Should allow valid user names', function() {
      return socket.get('/validate-username/Banana1992').then(res => {
        assert.ok(res._success);
      });
    });
    
    it('Should recognize invalid user names', function() {
      return socket.get('/validate-username/Banana 1992').then(res => {
        assert.equal(res.code, 403);
        assert.equal(res.identifier, 'invalid-char');
      });
    });
    
    it('Should recognize already present user names', function() {
      return socket.get('/validate-username/' + user.name).then(res => {
        assert.equal(res.code, 403);
        assert.equal(res.identifier, 'already-present');
      });
    });
  });
  
  describe('validate-email', function() {
    it('Should allow valid email addresses', function() {
      return socket.get('/validate-email/Banana1992@notsohotmail.com').then(res => {
        assert.ok(res._success);
      });
    });
    
    it('Should recognize invalid email addresses', function() {
      return socket.get('/validate-email/Banana 1992').then(res => {
        assert.equal(res.code, 403);
        assert.equal(res.identifier, 'invalid-email');
      });
    });
    
    it('Should recognize already present email addresses', function() {
      // need verified email address for this
      return socket.put('/user/' + user.uid + '/email', {
        __sign__: true,
        body: {
          emailverif: true,
          email: user.email
        }
      }).then(result => {
        assert.ok(result._success);
        
        return socket.get('/validate-email/' + user.email);
      }).then(res => {
        assert.equal(res.code, 403);
        assert.equal(res.identifier, 'already-present');
      });
    });
  });
});
