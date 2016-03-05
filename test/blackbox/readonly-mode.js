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
let socket, user;

before(function() {
  return testHelpers.standardSetup().then(data => {
    socket = data.socket;
    user = data.user;
  });
});

after(testHelpers.standardTeardown);

afterEach(function() {
  return socket.post('/force-readonly', {
    __sign__: true,
    body: {
      readonly: false
    }
  }).then(res => {
    assert.ok(res._success);
  });
});

describe('Readonly Login', function() {
  it('Provides means of logging in when the server has entered read-only mode', function() {
    return socket.post('/logout').then(res => {
      assert.ok(res._success);
      
      return socket.post('/force-readonly', {
        __sign__: true,
        body: {
          readonly: true
        }
      });
    }).then(res => {
      assert.ok(res._success);
      
      return socket.post('/login', {
        body: {
          name: user.name,
          pw: user.password,
          stayloggedin: false
        }
      });
    }).then(loginresult => {
      assert.ok(loginresult._success);
      
      return socket.get('/ping');
    }).then(res => {
      assert.ok(res._success);
      assert.equal(res.uid, user.uid);
    });
  });
});
