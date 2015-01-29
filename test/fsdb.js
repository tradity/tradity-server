'use strict';

var assert = require('assert');
var fs = require('fs');
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

describe('fsdb', function() {
	describe('publish', function() {
		it('Should publish files', function() {
			return Q.nfcall(fs.readFile, 'res/bob.jpg').then(function(data) {
				return socket.emit('publish', {
					base64: true,
					content: data.toString('base64'),
					role: 'profile.image',
					mime: 'image/jpeg',
					name: 'bob.jpg'
				});
			}).then(function(res) {
				assert.equal(res.code, 'publish-success');
				
				return socket.once('file-publish');
			}).then(function() {
				return socket.emit('get-user-info', {
					lookfor: '$self',
					nohistory: true
				});
			}).then(function(res) {
				assert.equal(res.code, 'get-user-info-success');
				assert.ok(res.result.profilepic);
				
				var externalURI = cfg.protocol + '://' + cfg.wshost + ':' + cfg.wsports[0] + res.result.profilepic;
				
				var deferred = Q.defer();
				
				require(cfg.protocol).get(externalURI, function(res) {
					deferred.resolve(res.statusCode);
				}).on('error', function(e) {
					deferred.reject(e);
				});
				
				return deferred.promise;
			}).then(function(status) {
				assert.equal(status, 200);
			});
		});
	});
});
