var assert = require('assert');
var _ = require('lodash');
var Q = require('q');
var testHelpers = require('./test-helpers.js');
var cfg = require('../config.js').config;
var socket, user;

before(function() {
	return testHelpers.standardSetup().then(function(data) {
		socket = data.socket;
		user = data.user;
	});
});

beforeEach(testHelpers.standardReset);
after(testHelpers.standardTeardown);

describe('misc', function() {
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
			buf = new Buffer(_.range(0, 256));
			
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
	});
	
	describe('ping', function() {
		it('Should really not do much', function() {
			return socket.emit('ping').then(function(res) {
				assert.equal(res.code, 'pong');
			});
		});
	});
	
	describe('artificial-error', function() {
		it('Should produce an error', function() {
			return socket.emit('artificial-error', {
				__sign__: true
			}).then(function(res) {
				assert.equal(res.code, 'artificial-error-success');
			});
		});
	});
	
	describe('artificial-deadlock', function() {
		it('Should produce a deadlock', function() {
			return socket.emit('artificial-deadlock', {
				__sign__: true
			}).then(function(res) {
				assert.equal(res.code, 'artificial-deadlock-success');
			});
		});
	});
	
	describe('artificial-dberror', function() {
		it('Should produce a database error', function() {
			return socket.emit('artificial-dberror', {
				__sign__: true
			}).then(function(res) {
				assert.equal(res.code, 'artificial-dberror-success');
			});
		});
	});
});
