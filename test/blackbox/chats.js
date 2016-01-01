'use strict';

const assert = require('assert');
const _ = require('lodash');
const testHelpers = require('./test-helpers.js');

describe('chats', function() {
  let socket, user;

  before(function() {
    return testHelpers.standardSetup().then(data => {
      socket = data.socket;
      user = data.user;
    });
  });

  beforeEach(testHelpers.standardReset);
  after(testHelpers.standardTeardown);

  describe('chat-get', function() {
    it('Should not create chats if failOnMissing is set', function() {
      return socket.emit('chat-get', {
        failOnMissing: true,
        endpoints: [ user.uid, user.uid + 1 ]
      }).then(res => {
        assert.equal(res.code, 'chat-get-notfound');
      });
    });
    
    it('Should create chats when appropiate and return identical ones later', function() {
      let endpoints, chatid, laterAddedUser;
      const chatMessageContent = 'Hi!';
      
      return socket.emit('list-all-users', {
        __sign__: true,
      }).then(res => {
        assert.equal(res.code, 'list-all-users-success');
        
        endpoints = _.pluck(res.results.slice(0, 3), 'uid');
        laterAddedUser = res.results[4].uid;
        
        return socket.emit('chat-get', {
          endpoints: endpoints
        });
      }).then(res => {
        assert.equal(res.code, 'chat-get-success');
        assert.ok(res.chat);
        assert.ok(res.chat.chatstartevent);
        
        chatid = res.chat.chatid;
        return socket.emit('comment', {
          eventid: res.chat.chatstartevent,
          comment: chatMessageContent
        });
      }).then(res => {
        assert.equal(res.code, 'comment-success');
        
        return socket.emit('chat-get', {
          endpoints: endpoints
        });
      }).then(res => {
        assert.equal(res.code, 'chat-get-success');
        assert.ok(res.chat);
        assert.equal(res.chat.chatid, chatid);
        assert.ok(res.chat.messages.length > 0);
        assert.equal(res.chat.messages[0].comment, chatMessageContent);
        
        return socket.emit('chat-adduser', {
          chatid: chatid,
          uid: laterAddedUser
        });
      }).then(res => {
        assert.equal(res.code, 'chat-adduser-success');
        
        return socket.emit('chat-get', {
          endpoints: endpoints.concat([laterAddedUser])
        });
      }).then(res => {
        assert.equal(res.code, 'chat-get-success');
        assert.ok(res.chat);
        assert.equal(res.chat.chatid, chatid);
        
        return socket.emit('chat-get', {
          endpoints: endpoints
        });
      }).then(res => {
        assert.equal(res.code, 'chat-get-success');
        assert.ok(res.chat);
        assert.notEqual(res.chat.chatid, chatid);
        
        return socket.emit('list-all-chats');
      }).then(res => {
        assert.equal(res.code, 'list-all-chats-success');
        assert.ok(res.chats[chatid]);
        
        // 2 extra users: ourselves + laterAddedUser
        assert.equal(res.chats[chatid].members.length, endpoints.length + 2);
      });
    });
  });
});
