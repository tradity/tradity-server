'use strict';

var assert = require('assert');
var Q = require('q');
var _ = require('lodash');
var LoginIPCheck = require('../lib/loginIPCheck.js');

function mean(a) {
	return _.sum(a) / a.length;
}

function cov(a, b) {
	assert.strictEqual(a.length, b.length);
	var N = a.length;
	
	var Ea = mean(a), Eb = mean(b);
	
	return 1/(N - 1) * _.sum(_.range(N), function(i) {
		return (a[i] - Ea) * (b[i] - Eb);
	});
}

function correlation(a, b) {
	return cov(a, b) / (Math.sqrt(cov(a, a) * cov(b, b)));
}

describe('loginIPCheck', function() {
	it('should increase waiting time with the number of login attempts', function() {
		var check = new LoginIPCheck({
			base: 2,
			baseWait: 10
		});
		
		var deltas = [];
		var N = 7;
		
		var prev = Date.now();
		return _.range(N).map(function() {
			return function() {
				var now = Date.now();
				deltas.push(Math.log(now - prev));
				prev = now;
				
				return check.check('1.2.3.4');
			};
		}).reduce(Q.when, Q()).then(function() {
			var r = correlation(deltas, _.range(N));
			assert.ok(r > 0.5, 'Correlation was only ' + r);
		});
	});
	
	it('should respect the minimum and maximum waiting time', function() {
		var maxWait = 100, minWait = 80;
		
		var check = new LoginIPCheck({
			base: 2,
			baseWait: minWait / 2,
			minWait: minWait,
			maxWait: maxWait
		});
		
		var N = 7;
		
		var prev = Date.now();
		return _.range(N).map(function(i) {
			return function() {
				var now = Date.now();
				
				assert.ok(i == 0 || now - prev <= maxWait * 1.5);
				assert.ok(i == 0 || now - prev >= minWait);
				
				prev = now;
				
				return check.check('1.2.3.4');
			};
		}).reduce(Q.when, Q());
	});
});
