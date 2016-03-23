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

describe('/ranking', function() {
  let socket, user;

  before(function() {
    return testHelpers.standardSetup().then(data => {
      socket = data.socket;
      user = data.user;
    });
  });

  beforeEach(testHelpers.standardReset);
  after(testHelpers.standardTeardown);
  
  it('Should return a list of all users', function() {
    return socket.get('/ranking').then(res => {
      assert.ok(res._success);
      assert.ok(res.data);
      assert.ok(res.data.length > 0);
      assert.ok(res.data[0].name);
      assert.ok(res.data[0].totalvalue);
    });
  });
  
  it('Should be searchable for user names', function() {
    return socket.get('/ranking').then(res => {
      assert.ok(res._success);
      assert.ok(res.data);
      
      return socket.get('/ranking', {
        qs: { search: res.data[0].name }
      });
    }).then(res => {
      assert.ok(res._success);
      assert.ok(res.data);
      assert.strictEqual(res.data.length, 1);
    });
  });
  
  it('Should be searchable for school IDs', function() {
    let school;
    
    return socket.get('/schools').then(res => {
      assert.ok(res._success);
      assert.ok(res.data);
      
      school = res.data.filter(s => s.usercount > 0)[0];
      
      return socket.get('/ranking', {
        qs: { schoolid: school.path, includeAll: true }
      });
    }).then(res => {
      assert.ok(res._success);
      assert.ok(res.data);
      assert.ok(res.data.length >= school.usercount); // pending users included
    });
  });
});
