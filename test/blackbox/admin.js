'use strict';

var assert = require('assert');
var _ = require('lodash');
var Q = require('q');
var sha256 = require('../../lib/sha256.js');
var commonUtil = require('tradity-connection');
var testHelpers = require('./test-helpers.js');

describe('admin', function() {
	var user, socket;

	before(function() {
		return testHelpers.standardSetup().then(function(data) {
			user = data.user;
			socket = data.socket;
		});
	});

	beforeEach(testHelpers.standardReset);
	after(testHelpers.standardTeardown);

	describe('list-all-users', function() {
		if (!testHelpers.testPerformance)
		it('Should fail for non-admin users', function() {
			return socket.emit('list-all-users').then(function(result) {
				assert.equal(result.code, 'permission-denied');
			});
		});
		
		it('Should provide a list of all users', function() {
			return socket.emit('list-all-users', { __sign__: true }).then(function(result) {
				assert.equal(result.code, 'list-all-users-success');
				
				assert.ok(result.results.length > 0);
				var ownUserEntry = result.results.filter(function(listedUser) {
					return listedUser.name === user.name;
				})[0];
				
				assert.ok(ownUserEntry);
				assert.equal(ownUserEntry.giv_name, 'John');
				assert.ok(ownUserEntry.registertime > Date.now()/1000 - 1000);
				assert.ok(ownUserEntry.registertime < Date.now()/1000);
			});
		});
	});
	
	if (!testHelpers.testPerformance)
	describe('impersonate-user', function() {
		it('Should fail for non-admin users', function() {
			return socket.emit('impersonate-user').then(function(result) {
				assert.equal(result.code, 'permission-denied');
			});
		});
		
		it('Should leave the session untouched when impersonating the active user', function() {
			return socket.emit('impersonate-user', {
				__sign__: true,
				uid: user.uid
			}).then(function(result) {
				assert.equal(result.code, 'impersonate-user-success');
				
				return socket.emit('get-user-info', {
					lookfor: '$self',
					noCache: true, __sign__: true
				});
			}).then(function(userInfo) {
				assert.equal(userInfo.code, 'get-user-info-success');
				
				assert.strictEqual(userInfo.result.uid, user.uid);
				assert.strictEqual(userInfo.result.name, user.name);
			});
		});
	});
	
	describe('change-user-email', function() {
		it('Should be able to change the active user’s mail address', function() {
			var email = 'nonexistent' + parseInt(Math.random() * 100000) + '@invalid.invalid';
			
			return socket.emit('change-user-email', {
				__sign__: true,
				uid: user.uid,
				emailverif: 1,
				email: email
			}).then(function(result) {
				user.email = email;
				assert.equal(result.code, 'change-user-email-success');
			});
		});
	});
	
	describe('change-comment-text', function() {
		it('Should be able to change the text of a recently made comment', function() {
			var newCommentText = '<a>New comment</a>';
			var newCState = 'Banananana';
			
			return socket.emit('get-user-info', {
				lookfor: '$self',
				noCache: true, __sign__: true
			}).then(function(userInfo) {
				assert.equal(userInfo.code, 'get-user-info-success');
				assert.ok(userInfo.result.registerevent);
				
				return socket.emit('comment', {
					eventid: userInfo.result.registerevent,
					comment: 'Old comment'
				});
			}).then(function(result) {
				assert.equal(result.code, 'comment-success');
				
				return socket.emit('get-user-info', {
					lookfor: '$self',
					noCache: true, __sign__: true
				});
			}).then(function(userInfo) {
				assert.equal(userInfo.code, 'get-user-info-success');
				
				assert.ok(userInfo.pinboard);
				assert.ok(userInfo.pinboard.length > 0);
				
				return socket.emit('change-comment-text', {
					__sign__: true,
					comment: newCommentText,
					trustedhtml: 1,
					commentid: userInfo.pinboard[0].commentid,
					cstate: newCState
				});
			}).then(function(result) {
				assert.equal(result.code, 'change-comment-text-success');
				
				return socket.emit('get-user-info', {
					lookfor: '$self',
					noCache: true, __sign__: true
				});
			}).then(function(userInfo) {
				assert.equal(userInfo.code, 'get-user-info-success');
				
				assert.ok(userInfo.pinboard);
				assert.ok(userInfo.pinboard.length > 0);
				assert.equal(userInfo.pinboard[0].comment, newCommentText);
				assert.equal(userInfo.pinboard[0].cstate, newCState);
			});
		});
	});
	
	describe('notify-unstick-all', function() {
		it('Should remove the sticky flag from all moderator notifications', function() {
			return socket.emit('notify-unstick-all', {
				__sign__: true
			}).then(function(result) {
				assert.equal(result.code, 'notify-unstick-all-success');
			});
		});
	});
	
	describe('notify-all', function() {
		it('Should write events to all feeds', function() {
			return socket.emit('notify-all', {
				__sign__: true,
				content: 'DON’T PANIC',
				sticky: 1,
			}).then(function(result) {
				assert.equal(result.code, 'notify-all-success');
				
				return socket.once('mod-notification');
			});
		});
	});
	
	describe('rename-school', function() {
		it('Should change the name of a school', function() {
			var school;
			
			return socket.emit('list-schools').then(function(res) {
				assert.ok(res.result.length > 0);
				school = res.result.filter(function(s) {
					return commonUtil.parentPath(s) == '/';
				})[0];
				
				return socket.emit('rename-school', {
					__sign__: true,
					schoolid: school.schoolid,
					schoolname: 'SCHOOL 42',
					schoolpath: '/nonexistent/invalidPath'
				});
			}).then(function(res) {
				assert.equal(res.code, 'rename-school-notfound');
				
				return socket.emit('rename-school', {
					__sign__: true,
					schoolid: school.schoolid,
					schoolname: 'SCHOOL 42',
					schoolpath: '/' + sha256(school.path)
				});
			}).then(function(res) {
				assert.equal(res.code, 'rename-school-success');
			});
		});
	});
	
	describe('join-schools', function() {
		it('Should merge two schools together', function() {
			var prefix = 'S' + Date.now(), id1, id2;
			
			return Q.all([prefix + 'Aj', prefix + 'Bj'].map(function(name) {
				return socket.emit('create-school', {
					__sign__: true,
					schoolname: name,
				}).then(function(res) {
					assert.equal(res.code, 'create-school-success');
					
					return socket.emit('school-exists', {
						lookfor: res.path
					});
				}).then(function(res) {
					assert.equal(res.code, 'school-exists-success');
					assert.ok(res.exists);
					assert.ok(res.path);
					assert.strictEqual(parseInt(res.schoolid), res.schoolid);
					
					return res.schoolid;
				});
			})).spread(function(id1_, id2_) {
				id1 = id1_, id2 = id2_;
				
				return socket.emit('join-schools', {
					__sign__: true,
					masterschool: id1,
					subschool: id2
				});
			}).then(function(res) {
				assert.equal(res.code, 'join-schools-success');
				
				return socket.emit('list-schools');
			}).then(function(res) {
				assert.equal(res.code, 'list-schools-success');
				assert.ok(res.result);
				assert.notEqual(_.pluck(res.result, 'schoolid').indexOf(id1), -1);
				assert.equal   (_.pluck(res.result, 'schoolid').indexOf(id2), -1);
			});
		});
		
		it('Should fail if one of the schools does not exist', function() {
			return socket.emit('list-schools').then(function(res) {
				assert.equal(res.code, 'list-schools-success');
				assert.ok(res.result);
				
				var existentIDs = _.pluck(res.result, 'schoolid');
				var nonexistentID = (Math.max.apply(Math, existentIDs) || 0) + 1;
				
				return socket.emit('join-schools', {
					__sign__: true,
					masterschool: nonexistentID,
					subschool: nonexistentID + 1,
				});
			}).then(function(res) {
				assert.equal(res.code, 'join-schools-notfound');
			});
		});
	});
	
	describe('get-followers', function() {
		it('Should provide a list of followers', function() {
			var leader;
			var amount = 7;
			
			return socket.emit('list-all-users', {
				__sign__: true
			}).then(function(result) {
				assert.equal(result.code, 'list-all-users-success');
				
				assert.ok(result.results.length > 0);
				
				leader = result.results[0];
				
				return socket.emit('stock-buy', {
					amount: amount,
					value: null,
					stockid: null,
					leader: leader.uid,
					forceNow: true
				});
			}).then(function(result) {
				assert.equal(result.code, 'stock-buy-success');
				
				return socket.emit('get-followers', {
					__sign__: true,
					uid: leader.uid
				});
			}).then(function(result) {
				assert.equal(result.code, 'get-followers-success');
				assert.ok(result.results.length > 0);
				
				var ownUserFollowerEntry = result.results.filter(function(follower) {
					return follower.uid == user.uid;
				})[0];
				
				assert.ok(ownUserFollowerEntry);
				assert.equal(ownUserFollowerEntry.amount, amount);
			});
		});
	});
	
	if (!testHelpers.testPerformance)
	describe('get-server-statistics', function() {
		it('Should return a list of servers', function() {
			return socket.emit('get-server-statistics', { __sign__: true }).then(function(res) {
				assert.equal(res.code, 'get-server-statistics-success');
				assert.ok(res.servers.length > 0);
			});
		});
	});
	
	if (!testHelpers.testPerformance)
	describe('get-ticks-statistics', function() {
		it('Should return a timeline of tick statistics', function() {
			return socket.emit('prod', { __sign__: true }).then(function() {
				return socket.emit('get-ticks-statistics', { __sign__: true });
			}).then(function(res) {
				assert.equal(res.code, 'get-ticks-statistics-success');
				assert.ok(res.results.length > 0);
				assert.ok(res.results[0].timeindex);
				assert.ok(res.results[0].ticksum);
			});
		});
	});
});
