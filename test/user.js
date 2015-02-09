'use strict';

var assert = require('assert');
var _ = require('lodash');
var Q = require('q');
var testHelpers = require('./test-helpers.js');
var socket, user;

before(function() {
	return testHelpers.standardSetup().then(function(data) {
		socket = data.socket;
		user = data.user;
	});
});

beforeEach(testHelpers.standardReset);
after(testHelpers.standardTeardown);

describe('user', function() {
	describe('get-user-info', function() {
		it('Should return no values with .nohistory', function() {
			return socket.emit('get-user-info', {
				lookfor: user.name,
				nohistory: true
			}).then(function(res) {
				assert.equal(res.code, 'get-user-info-success');
				assert.ok(res.result);
				assert.ok(!res.comments);
				assert.ok(!res.orders);
				assert.ok(!res.values);
			});
		});
		
		it('Should return a valuehistory without .nohistory', function() {
			return socket.emit('prod', {
				__sign__: true
			}).then(function() {
				return socket.emit('get-user-info', {
					lookfor: user.name
				});
			}).then(function(res) {
				assert.equal(res.code, 'get-user-info-success');
				assert.ok(res.result);
				assert.ok(res.pinboard);
				assert.ok(res.orders);
				assert.ok(res.values);
			});
		});
		
		it('Should be able to search by name and by ID', function() {
			return Q.all([socket.emit('get-user-info', {
				lookfor: user.name,
				nohistory: true
			}), socket.emit('get-user-info', {
				lookfor: user.uid,
				nohistory: true
			})]).spread(function(byName, byID) {
				assert.equal(byName.code, 'get-user-info-success');
				assert.equal(byID.code, 'get-user-info-success');
				assert.equal(byName.result.name, byID.result.name);
				assert.equal(byName.result.totalvalue, byID.result.totalvalue);
				assert.equal(byName.result.lstockid, byID.result.lstockid);
			});
		});
	});
	
	describe('get-ranking', function() {
		it('Should return a list of all users', function() {
			return socket.emit('get-ranking').then(function(res) {
				assert.equal(res.code, 'get-ranking-success');
				assert.ok(res.result);
				assert.ok(res.result.length > 0);
				assert.ok(res.result[0].name);
				assert.ok(res.result[0].totalvalue);
			});
		});
	});
});
