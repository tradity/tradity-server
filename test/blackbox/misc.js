'use strict';

var assert = require('assert');
var _ = require('lodash');
var Q = require('q');
var testHelpers = require('./test-helpers.js');

describe('misc', function() {
  var socket, user;

  before(function() {
    return testHelpers.standardSetup().then(function(data) {
      socket = data.socket;
      user = data.user;
    });
  });

  beforeEach(testHelpers.standardReset);
  after(testHelpers.standardTeardown);

  describe('get-own-options', function() {
    it('Should return information about own options', function() {
      return socket.emit('get-own-options').then(function(res) {
        assert.equal(res.code, 'get-own-options-success');
        assert.equal(res.result.name, user.name);
        assert.ok(!res.result.pwhash);
        assert.ok(!res.result.pwsalt);
      });
    });
  });
  
  describe('set-client-storage', function() {
    it('Should save information in arbitrary Buffers', function() {
      var buf = new Buffer(_.range(0, 256));
      
      return socket.emit('set-clientstorage', {
        storage: buf
      }).then(function(res) {
        assert.equal(res.code, 'set-clientstorage-success');
        
        return socket.emit('get-own-options');
      }).then(function(res) {
        assert.equal(res.code, 'get-own-options-success');
        
        assert.ok(res.result.clientstorage);
        assert.ok(testHelpers.bufferEqual(res.result.clientstorage, buf));
      });
    });
    
    it('Should fail with format-error when given invalid input', function() {
      return socket.emit('set-clientstorage', {
        storage: null
      }).then(function(res) {
        assert.equal(res.code, 'format-error');
      });
    });
  });
  
  describe('ping', function() {
    it('Should really not do much', function() {
      return socket.emit('ping').then(function(res) {
        assert.equal(res.code, 'pong');
      });
    });
  });
});
