'use strict';

var assert = require('assert');
var _ = require('lodash');
var Q = require('q');
var testHelpers = require('./test-helpers.js');
var socket;

before(function() {
	return testHelpers.standardSetup().then(function(data) {
		socket = data.socket;
	});
});

beforeEach(testHelpers.standardReset);
after(testHelpers.standardTeardown);

describe('achievements', function() {
	describe('list-all-achievements', function() {
		it('Should be successful and return multiple achievement types', function() {
			return socket.emit('list-all-achievements').then(function(result) {
				assert.equal(result.code, 'list-all-achievements-success');
				
				assert.ok(result.result.length > 0);
				
				for (var i = 0; i < result.length; ++i) {
					assert.ok(result[i].name);
					assert.ok(result[i].xp >= 0);
					assert.ok(result[i].category);
				}
			});
		});
	});
	
	describe('get-daily-login-certificate', function() {
		it('Should be successful and return a valid server certificate', function() {
			return socket.emit('get-daily-login-certificate').then(function(result) {
				assert.equal(result.code, 'get-daily-login-certificate-success');
				
				assert.ok(result.cert);
			});
		});
	});
	
	describe('achievement', function() {
		it('Should fail for unknown achievements', function() {
			return socket.emit('achievement', {
				name: 'NONEXISTENT_ACHIEVEMENT'
			}).then(function(result) {
				assert.equal(result.code, 'achievement-unknown-name');
			});
		});
		
		it('Should work for known achievements and result in an user-info-listed achievement', function() {
			var clientAchievementName;
			
			return socket.emit('list-all-achievements').then(function(res) {
				assert.equal(res.code, 'list-all-achievements-success');
				
				var clientAchievements = res.result.filter(function(ach) {
					return ach.isClientAchievement && !ach.requireVerified;
				});
				
				assert.notEqual(clientAchievements.length, 0);
				
				clientAchievementName = clientAchievements[0].name;
				
				return socket.emit('achievement', {
					name: clientAchievementName
				});
			}).then(function(result) {
				assert.equal(result.code, 'achievement-success');
				
				return socket.emit('get-user-info', {
					lookfor: '$self'
				});
			}).then(function(userInfo) {
				assert.equal(userInfo.code, 'get-user-info-success');
				
				var achievementNames = userInfo.achievements.map(function(ach) {
					return ach.achname;
				});
				
				assert.ok(achievementNames.indexOf(clientAchievementName) != -1);
			});
		});
	});
	
	describe('dl-achievement', function() {
		it('Should register achievements for being logged in multiple days in a row', function() {
			var N = 10;
			
			return _.range(2, 10).map(function(N) {
				return function() {
					var now = Date.now();
					
					// compute dates of the previous 10 days
					var dates = _.map(_.range(0, N), function(x) {
						return new Date(now - x * 86400 * 1000).toJSON().substr(0, 10);
					});
					
					return Q.all(dates.map(function(date) {
						return socket.emit('get-daily-login-certificate', {
							__sign__: true,
							today: date
						}).then(function(result) {
							assert.equal(result.code, 'get-daily-login-certificate-success');
							
							return result.cert;
						});
					})).then(function(certs) {
						return socket.emit('dl-achievement', {
							certs: certs
						});
					}).then(function(result) {
						assert.equal(result.code, 'dl-achievement-success');
						
						return socket.emit('get-user-info', {
							lookfor: '$self'
						});
					}).then(function(userInfo) {
						assert.equal(userInfo.code, 'get-user-info-success');
						
						var achievementNames = userInfo.achievements.map(function(ach) {
							return ach.achname;
						});
						
						assert.ok(achievementNames.indexOf('DAILY_LOGIN_DAYS_' + N) != -1);
					});
				};
			}).reduce(Q.when, Q());
		});
	});
});
