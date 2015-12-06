'use strict';

var assert = require('assert');
var _ = require('lodash');
var testHelpers = require('./test-helpers.js');
var socket, user;

before(function() {
	return testHelpers.standardSetup().then(function(data) {
		socket = data.socket;
		user = data.user;
	});
});

after(testHelpers.standardTeardown);

afterEach(function() {
	return socket.emit('force-readonly', {
		__sign__: true,
		readonly: false
	}).then(function(res) {
		assert.equal(res.code, 'force-readonly-success');
	});
});

if (!testHelpers.testPerformance)
describe('Readonly Login', function() {
	it('Provides means of logging in when the server has entered read-only mode', function() {
		return socket.emit('force-readonly', {
			__sign__: true,
			readonly: true
		}).then(function(res) {
			assert.equal(res.code, 'force-readonly-success');
			
			return socket.emit('logout');
		}).then(function(res) { // flush privileges
			assert.equal(res.code, 'server-readonly');
			
			return socket.emit('login', {
				name: user.name,
				pw: user.password,
				stayloggedin: false
			});
		}).then(function(loginresult) {
			assert.equal(loginresult.code, 'login-success');
			
			return socket.emit('ping');
		}).then(function(res) {
			assert.equal(res.code, 'pong');
			assert.equal(res.uid, user.uid);
		});
	});
});
