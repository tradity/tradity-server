'use strict';

const assert = require('assert');
const _ = require('lodash');
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

if (!testHelpers.testPerformance)
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
