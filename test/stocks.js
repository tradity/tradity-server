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

beforeEach(testHelpers.standardReset);
after(testHelpers.standardTeardown);

var standardISIN = 'CA7500801039';
describe('stocks', function() {
	describe('prod', function() {
		it('Works', function() {
			return socket.emit('prod').then(function(res) {
				assert.equal(res.code, 'prod-ready');
			});
		});
	});
	
	describe('stock-search', function() {
		it('Returns information based on the ISIN', function() {
			return socket.emit('stock-search', {
				name: standardISIN
			}).then(function(res) {
				assert.equal(res.code, 'stock-search-success');
				assert.equal(res.results.length, 1);
				var stockinfo = res.results[0];
				
				assert.ok(stockinfo);
				assert.strictEqual(stockinfo.stockid, standardISIN);
				assert.strictEqual(stockinfo.leader, null);
				assert.strictEqual(stockinfo.leadername, null);
				assert.strictEqual(stockinfo.lprovision, 0);
				assert.strictEqual(stockinfo.wprovision, 0);
			});
		});
		
		it('Returns information based on the username', function() {
			return socket.emit('stock-search', {
				name: user.name
			}).then(function(res) {
				assert.equal(res.code, 'stock-search-success');
				assert.equal(res.results.length, 1);
				var stockinfo = res.results[0];
				
				assert.ok(stockinfo);
				assert.strictEqual(stockinfo.leader, user.uid);
				assert.strictEqual(stockinfo.leadername, user.name);
				assert.notStrictEqual(stockinfo.wprovision, 0);
			});
		});
	});
	
	describe('stock-buy', function() {
		it('Can buy and sell stocks via forceNow', function() {
			var amount = 5;
			
			return socket.emit('stock-buy', {
				__sign__: true,
				amount: amount,
				value: null,
				stockid: standardISIN,
				leader: null,
				forceNow: true
			}).then(function(res) {
				assert.equal(res.code, 'stock-buy-success');
				
				return socket.once('trade');
			}).then(function() {
				return socket.emit('list-own-depot');
			}).then(function(data) {
				assert.equal(data.code, 'list-own-depot-success');
				assert.ok(data.results);
				assert.equal(data.results.length, 1);
				assert.equal(data.results[0].stockid, standardISIN);
				assert.equal(data.results[0].amount, amount);
				
				return socket.emit('stock-buy', {
					__sign__: true,
					amount: -amount,
					value: null,
					stockid: standardISIN,
					leader: null,
					forceNow: true
				});
			}).then(function(res) {
				assert.ok(res.code == 'stock-buy-success' ||
						  res.code == 'stock-buy-not-enough-stocks');
				
				return socket.once('trade');
			}).then(function() {
				return socket.emit('list-own-depot');
			}).then(function(data) {
				assert.equal(data.code, 'list-own-depot-success');
				assert.ok(data.results);
				assert.equal(data.results.length, 0);
				
				return socket.emit('stock-buy', {
					__sign__: true,
					amount: -amount,
					value: null,
					stockid: standardISIN,
					leader: null,
					forceNow: true
				});
			}).then(function(data) {
				assert.equal(data.code, 'stock-buy-not-enough-stocks');
				
				return socket.emit('list-transactions');
			}).then(function(data) {
				assert.equal(data.code, 'list-transactions-success');
				assert.ok(data.results);
				assert.ok(data.results.length > 0);
				
				return socket.emit('get-user-info', {
					lookfor: '$self',
					noCache: true, __sign__: true
				});
			}).then(function(res) {
				assert.equal(res.code, 'get-user-info-success');
				
				assert.ok(res.orders);
				assert.ok(res.orders.length > 0);
				
				return socket.emit('get-trade-info', {
					tradeid: res.orders[0].orderid
				});
			}).then(function(res) {
				assert.equal(res.code, 'get-trade-info-success');
				
				assert.ok(res.trade);
				assert.equal(res.trade.uid, user.uid);
			});
		});
	});
});
