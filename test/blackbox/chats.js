// Tradity.de Server
// Copyright (C) 2016 Tradity.de Tech Team <tech@tradity.de>

// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version. 

// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.

// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <http://www.gnu.org/licenses/>.

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
        
        endpoints = _.map(res.results.slice(0, 3), 'uid');
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
