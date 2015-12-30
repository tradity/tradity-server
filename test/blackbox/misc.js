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
