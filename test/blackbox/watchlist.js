'use strict';

var assert = require('assert');
var _ = require('lodash');
var testHelpers = require('./test-helpers.js');

describe('watchlist', function() {
	var socket;
	
	before(function() {
		return testHelpers.standardSetup().then(function(data) {
			socket = data.socket;
		});
	});

	beforeEach(testHelpers.standardReset);
	after(testHelpers.standardTeardown);

	describe('watchlist-add', function() {
		it('Can add stocks to the watchlist', function() {
			var stock;
			
			return socket.emit('list-popular-stocks', {
				__sign__: true,
				days: 2000,
			}).then(function(res) {
				assert.equal(res.code, 'list-popular-stocks-success');
				assert.ok(res.results);
				assert.ok(res.results.length > 0);
				
				stock = res.results[0].stockid;
				
				return socket.emit('watchlist-add', {
					stockid: stock
				});
			}).then(function(res) {
				assert.equal(res.code, 'watchlist-add-success');
			});
		});
		
		it('Can add leaders to the watchlist', function() {
			var stock;
			
			return socket.emit('get-ranking').then(function(res) {
				assert.equal(res.code, 'get-ranking-success');
				assert.ok(res.result);
				assert.ok(res.result.length > 0);
				
				stock = '__LEADER_' + res.result[0].uid + '__';
				
				return socket.emit('watchlist-add', {
					stockid: stock
				});
			}).then(function(res) {
				assert.equal(res.code, 'watchlist-add-success');
			});
		});
	});
	
	describe('watchlist-remove', function() {
		it('Can remove stocks from the watchlist', function() {
			var stock;
			var uid;
			
			return socket.emit('get-ranking').then(function(res) {
				assert.equal(res.code, 'get-ranking-success');
				assert.ok(res.result);
				assert.ok(res.result.length > 0);
				
				uid = res.result[0].uid;
				stock = '__LEADER_' + uid + '__';
				
				return socket.emit('watchlist-add', {
					stockid: stock
				});
			}).then(function(res) {
				assert.equal(res.code, 'watchlist-add-success');
				
				return socket.emit('watchlist-show');
			}).then(function(res) {
				assert.equal(res.code, 'watchlist-show-success');
				assert.ok(res.results);
				
				var entry = res.results.filter(function(watchlistEntry) {
					return watchlistEntry.uid == uid;
				})[0];
				assert.ok(entry);
				
				return socket.emit('watchlist-remove', {
					stockid: entry.stockid
				});
			}).then(function(res) {
				assert.equal(res.code, 'watchlist-remove-success');
				
				return socket.emit('watchlist-show');
			}).then(function(res) {
				assert.equal(res.code, 'watchlist-show-success');
				assert.ok(res.results);
				
				assert.equal(_.pluck(res.results, 'uid').indexOf(uid), -1);
			});
		});
	});
});