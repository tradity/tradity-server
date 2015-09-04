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

describe('chats', function() {
	describe('chat-get', function() {
		it('Should not create chats if failOnMissing is set', function() {
			return socket.emit('chat-get', {
				failOnMissing: true,
				endpoints: [ user.uid, user.uid + 1 ]
			}).then(function(res) {
				assert.equal(res.code, 'chat-get-notfound');
			});
		});
		
		it('Should create chats when appropiate and return identical ones later', function() {
			var endpoints, chatid, laterAddedUser;
			var chatMessageContent = 'Hi!';
			
			return socket.emit('list-all-users', {
				__sign__: true,
			}).then(function(res) {
				assert.equal(res.code, 'list-all-users-success');
				
				endpoints = _.pluck(res.results.slice(0, 3), 'uid');
				laterAddedUser = res.results[4].uid;
				
				return socket.emit('chat-get', {
					endpoints: endpoints
				});
			}).then(function(res) {
				assert.equal(res.code, 'chat-get-success');
				assert.ok(res.chat);
				assert.ok(res.chat.chatstartevent);
				
				console.log(res.chat, chatMessageContent);
				chatid = res.chat.chatid;
				return socket.emit('comment', {
					eventid: res.chat.chatstartevent,
					comment: chatMessageContent
				});
			}).then(function(res) {
				assert.equal(res.code, 'comment-success');
				
				return socket.emit('chat-get', {
					endpoints: endpoints
				});
			}).then(function(res) {
				assert.equal(res.code, 'chat-get-success');
				assert.ok(res.chat);
				assert.equal(res.chat.chatid, chatid);
				assert.ok(res.chat.messages.length > 0);
				assert.ok(res.chat.messages[0].comment == chatMessageContent);
				
				return socket.emit('chat-adduser', {
					chatid: chatid,
					uid: laterAddedUser
				});
			}).then(function(res) {
				assert.equal(res.code, 'chat-adduser-success');
				
				return socket.emit('chat-get', {
					endpoints: endpoints.concat([laterAddedUser])
				});
			}).then(function(res) {
				assert.equal(res.code, 'chat-get-success');
				assert.ok(res.chat);
				assert.equal(res.chat.chatid, chatid);
				
				return socket.emit('chat-get', {
					endpoints: endpoints
				});
			}).then(function(res) {
				assert.equal(res.code, 'chat-get-success');
				assert.ok(res.chat);
				assert.notEqual(res.chat.chatid, chatid);
				
				return socket.emit('list-all-chats');
			}).then(function(res) {
				assert.equal(res.code, 'list-all-chats-success');
				assert.ok(res.chats[chatid]);
				
				// 2 extra users: ourselves + laterAddedUser
				assert.ok(res.chats[chatid].members.length == endpoints.length + 2);
			});
		});
	});
});
