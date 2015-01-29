'use strict';

var assert = require('assert');
var testHelpers = require('./test-helpers.js');
var socket;

before(function() {
	return testHelpers.standardSetup().then(function(data) {
		socket = data.socket;
	});
});

beforeEach(testHelpers.standardReset);
after(testHelpers.standardTeardown);

describe('wordpress-feed', function() {
	describe('process-wordpress-feed', function() {
		it('Should work', function() {
			return socket.emit('process-wordpress-feed').then(function(res) {
				assert.equal(res.code, 'process-wordpress-feed-success');
			});
		});
	});
});
