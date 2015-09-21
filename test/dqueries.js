'use strict';

var assert = require('assert');
var _ = require('lodash');
var Q = require('q');
var testHelpers = require('./test-helpers.js');

describe('dqueries', function() {
	var socket;

	before(function() {
		return testHelpers.standardSetup().then(function(data) {
			socket = data.socket;
		});
	});

	beforeEach(testHelpers.standardReset);
	after(testHelpers.standardTeardown);

	describe('dquery', function() {
		it('Should let users delay queries', function() {
			return socket.emit('dquery', {
				condition: 'time > ' + parseInt(Date.now()/1000 + 2),
				query: { type: 'ping' }
			}).then(function(res) {
				assert.equal(res.code, 'dquery-success');
				
				return Q.delay(2000);
			}).then(function() {
				return Q.all([
					socket.once('dquery-exec'),
					socket.emit('dquery-checkall', { __sign__: true })
				]);
			});
		});
	});
	
	describe('dquery-list', function() {
		it('Should list a user’s delayed queries', function() {
			return socket.emit('dquery', {
				condition: 'time > ' + parseInt(Date.now()/1000 + 60),
				query: { type: 'ping' }
			}).then(function(res) {
				assert.equal(res.code, 'dquery-success');
				
				return socket.emit('dquery-list');
			}).then(function(res) {
				assert.equal(res.code, 'dquery-list-success');
				assert.ok(res.results);
				assert.ok(res.results.length > 0);
			});
		});
	});
	
	describe('dquery-list', function() {
		it('Should remove a delayed query', function() {
			var queryid;
			
			return socket.emit('dquery', {
				condition: 'time > ' + parseInt(Date.now()/1000 + 60),
				query: { type: 'ping' }
			}).then(function(res) {
				assert.equal(res.code, 'dquery-success');
				queryid = res.queryid;
				
				return socket.emit('dquery-remove', {
					queryid: queryid
				});
			}).then(function(res) {
				assert.equal(res.code, 'dquery-remove-success');
				
				return socket.emit('dquery-list');
			}).then(function(res) {
				assert.equal(res.code, 'dquery-list-success');
				assert.ok(res.results);
				assert.ok(_.pluck(res.results, 'queryid').indexOf(queryid) == -1);
			});
		});
	});
});
