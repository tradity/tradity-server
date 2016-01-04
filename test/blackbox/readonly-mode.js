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
  return socket.emit('force-readonly', {
    __sign__: true,
    readonly: false
  }).then(res => {
    assert.equal(res.code, 'force-readonly-success');
  });
});

if (!testHelpers.testPerformance) {
describe('Readonly Login', function() {
  it('Provides means of logging in when the server has entered read-only mode', function() {
    return socket.emit('force-readonly', {
      __sign__: true,
      readonly: true
    }).then(res => {
      assert.equal(res.code, 'force-readonly-success');
      
      return socket.emit('logout');
    }).then(res => { // flush privileges
      assert.equal(res.code, 'server-readonly');
      
      return socket.emit('login', {
        name: user.name,
        pw: user.password,
        stayloggedin: false
      });
    }).then(loginresult => {
      assert.equal(loginresult.code, 'login-success');
      
      return socket.emit('ping');
    }).then(res => {
      assert.equal(res.code, 'pong');
      assert.equal(res.uid, user.uid);
    });
  });
});
}
