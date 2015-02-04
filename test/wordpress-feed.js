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

describe('wordpress-feed', function() {
	describe('process-wordpress-feed', function() {
		it('Should work', function() {
			return socket.emit('process-wordpress-feed', {
				__sign__: true
			}).then(function(res) {
				assert.equal(res.code, 'process-wordpress-feed-success');
			});
		});
	});
	
	describe('add-wordpress-feed', function() {
		it('Should add a wordpress feed entry which can later be removed', function() {
			var endpoint = 'https://example.com/' + Date.now();
			
			return socket.emit('add-wordpress-feed', {
				__sign__: true,
				endpoint: endpoint,
				category: null,
				schoolid: null,
				bloguser: user.uid
			}).then(function(res) {
				assert.equal(res.code, 'add-wordpress-feed-success');
				
				return socket.emit('list-wordpress-feeds');
			}).then(function(res) {
				assert.equal(res.code, 'list-wordpress-feeds-success');
				
				var recentEntry = res.results.filter(function(blog) {
					return blog.endpoint == endpoint;
				})[0];
				
				assert.ok(recentEntry);
				
				return socket.emit('remove-wordpress-feed', {
					blogid: recentEntry.blogid
				});
			}).then(function(res) {
				assert.equal(res.code, 'remove-wordpress-feed-success');
				
				return socket.emit('list-wordpress-feeds');
			}).then(function(res) {
				assert.equal(res.code, 'list-wordpress-feeds-success');
				
				assert.equal(_.pluck(res.results, 'endpoint').indexOf(endpoint), -1);
			});
		});
	});
});
