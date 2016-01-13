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

"use strict";

const _ = require('lodash');
const assert = require('assert');
const debug = require('debug')('sotrade:chats');

const buscomponent = require('./stbuscomponent.js');

/**
 * Provides methods for in-game chat messaging.
 * 
 * @public
 * @module chats
 */

/**
 * Main object of the {@link module:chats} module
 * 
 * @public
 * @constructor module:chats~Chats
 * @augments module:stbuscomponent~STBusComponent
 */
class Chats extends buscomponent.BusComponent {
  constructor() {
    super();
  }
}

/**
 * Represents an ingame chat session.
 * 
 * @typedef module:chats~Chat
 * @type object
 * 
 * @property {int} chatid  A numerical id for this chat.
 * @property {int} chatstartevent  The chat event id. Use this for messaging (i.e.,
 *                                 commenting on this event).
 * @property {int[]} endpoints  The numerical ids of all chat participants.
 * @property {Comment[]} messages  A list of chat messages.
 * @property {?module:user~UserEntryBase[]} query.members  Array of full user objects for the 
 *                                                         participants.
 */

/**
 * Informs users about starting a chat with them.
 * 
 * @typedef s2c~chat-start
 * @type {Event}
 * 
 * @property {int[]} endpoints  The list of numerical user ids of all chat members
 */

/**
 * Fetch or create a specific chat.
 * 
 * @param {?object[]} query.endpoints  Array of small user objects of the
 *                                     other participants in the chat.
 * @param {?int} query.chatid  The numerical chat id. Either this or query.endpoints
 *                             needs to be set.
 * @param {?boolean} query.failOnMissing  If there is no such chat, do not create it.
 * @param {?boolean} query.noMessages  If set, do not load the chat messages.
 * 
 * @return {object} Returns with <code>chat-get-notfound</code>,
 *                  <code>chat-get-success</code> or a common error code.
 *                  and populates <code>.chat</code> with a
 *                  {@link module:chats~Chat}
 * 
 * @function c2s~chat-get
 */
Chats.prototype.getChat = buscomponent.provideQT('client-chat-get', function(query, ctx) {
  let whereString = '';
  let params = [];
  let chatid = typeof query.chatid === 'undefined' || query.chatid === null ?
    null : parseInt(query.chatid);
  
  if (!query.endpoints || !query.endpoints.length) {
    if (chatid !== chatid) { // NaN
      throw new this.FormatError();
    }
    
    whereString += ' chatid = ?';
    params.push(chatid);
  } else {
    if (chatid !== null) {
      throw new this.FormatError();
    }
    
    let containsOwnChats = false;
    for (let i = 0; i < query.endpoints.length; ++i) {
      const uid = parseInt(query.endpoints[i]);
      if (uid !== uid) { // NaN
        throw new this.FormatError();
      }
      
      containsOwnChats = containsOwnChats || (uid === ctx.user.uid);
    }
    
    if (!containsOwnChats && ctx.user) {
      query.endpoints.push(ctx.user.uid);
    }
    
    const endpointsList = query.endpoints.join(',');
    const numEndpoints = query.endpoints.length;
    
    whereString += 
      ' (SELECT COUNT(*) FROM chatmembers AS cm JOIN users ON users.uid = cm.uid WHERE cm.chatid = c.chatid ' +
      '  AND cm.uid IN (' +  endpointsList + ')) = ? ' +
      'AND (SELECT COUNT(*) FROM chatmembers AS cm WHERE cm.chatid = c.chatid) = ? ';
    
    params.push(numEndpoints, numEndpoints);
  }
  
  let chat;
  return ctx.query('SELECT chatid, eventid AS chatstartevent ' + 
    'FROM chats AS c ' +
    'LEFT JOIN events ON events.targetid = c.chatid AND events.type = "chat-start" '+
    'WHERE ' + whereString + ' ' +
    'ORDER BY (SELECT MAX(time) FROM events AS msgs WHERE msgs.type="comment" AND msgs.targetid = chatstartevent) DESC ' +
    'LIMIT 1', params).then(chatlist => {
    if (chatlist.length !== 0) {
      return chatlist[0];
    }
    
    if (query.failOnMissing || !query.endpoints || ctx.getProperty('readonly')) {
      return null;
    }
    
    // query.endpoints has undergone validation and can be assumed to be all integers
    return ctx.query('SELECT COUNT(*) AS c FROM users WHERE uid IN (' + query.endpoints.join(',') + ')',
      []).then(endpointUserCount => {
      if (endpointUserCount[0].c !== query.endpoints.length) {
        return null;
      }
      
      debug('Creating new chat', query.endpoints.length, 'users');
      
      return ctx.query('INSERT INTO chats(creator) VALUE(?)', [ctx.user.uid]).then(res => {
        chatid = res.insertId;
        
        const members = [];
        const memberValues = [];
        for (let i = 0; i < query.endpoints.length; ++i) {
          members.push('(?, ?, UNIX_TIMESTAMP())');
          memberValues.push(res.insertId);
          memberValues.push(String(query.endpoints[i]));
        }
        
        return ctx.query('INSERT INTO chatmembers(chatid, uid, jointime) VALUES ' + members.join(','), memberValues);
      }).then(() => {
        return ctx.feed({
          type: 'chat-start',
          targetid: chatid, 
          srcuser: ctx.user.uid,
          noFollowers: true,
          feedusers: query.endpoints,
          json: {endpoints: query.endpoints}
        });
      }).then(eventid => {
        return {chatid: chatid, chatstartevent: eventid};
      });
    });
  }).then(chat_ => {
    chat = chat_;
    if (chat === null) {
      if (ctx.getProperty('readonly')) {
        throw new this.SoTradeClientError('server-readonly');
      } else {
        throw new this.SoTradeClientError('chat-get-notfound');
      }
    }
    
    assert.equal(parseInt(chat.chatid), chat.chatid);
    assert.equal(parseInt(chat.chatstartevent), chat.chatstartevent);
    
    chat.eventid = chat.chatstartevent; // backwards compatibility
    chat.endpoints = query.endpoints;
    
    if (query.noMessages) {
      return { code: 'chat-get-success', chat: chat };
    }
    
    return ctx.query('SELECT u.name AS username, u.uid AS uid, url AS profilepic ' +
      'FROM chatmembers AS cm ' +
      'JOIN users AS u ON u.uid = cm.uid ' +
      'LEFT JOIN httpresources ON httpresources.uid = cm.uid AND httpresources.role = "profile.image" ' + 
      'WHERE cm.chatid = ?', [chat.chatid]);
  }).then(endpoints => {
    assert.ok(endpoints.length > 0);
    chat.endpoints = endpoints;
    
    let ownChatsIsEndpoint = false;
    for (let i = 0; i < chat.endpoints.length; ++i) {
      if (chat.endpoints[i].uid === ctx.user.uid) {
        ownChatsIsEndpoint = true;
        break;
      }
    }
    
    if (!ownChatsIsEndpoint) {
      throw new this.SoTradeClientError('chat-get-notfound');
    }
    
    return ctx.query('SELECT c.*,u.name AS username,u.uid AS uid, url AS profilepic, trustedhtml ' + 
      'FROM ecomments AS c ' + 
      'LEFT JOIN users AS u ON c.commenter = u.uid ' + 
      'LEFT JOIN httpresources ON httpresources.uid = c.commenter AND httpresources.role = "profile.image" ' + 
      'WHERE c.eventid = ?', [chat.chatstartevent]).then(comments => {
      chat.messages = comments.map(c => {
        c.isDeleted = ['gdeleted', 'mdeleted'].indexOf(c.cstate) !== -1;
        return c;
      });
      
      return { code: 'chat-get-success', chat: chat };
    }); 
  });
});

/**
 * Informs users about new participants in chats
 * 
 * @typedef s2c~chat-user-added
 * @type {Event}
 * 
 * @property {int[]} endpoints  The list of numerical user ids of all chat members
 * @property {int} addedChats  The numerical user id of the new participant
 * @property {string} addedChatsName  The chosen user name of the new participant
 */

/**
 * Add a user to a specific chat.
 * 
 * @param {int} query.uid  The numerical id of the user to be added.
 * @param {int} query.chatid  The numerical id of the target chat.
 * 
 * @return {object} Returns with <code>chat-adduser-notfound</code>,
 *                  <code>chat-adduser-success</code> or a common error code.
 * 
 * @function c2s~chat-adduser
 */
Chats.prototype.addUserToChat = buscomponent.provideTXQT('client-chat-adduser', function(query, ctx) {
  debug('Add user to chat', query.userid, query.chatid);
  
  /* backwards compatibility */
  const uid = parseInt(query.uid) || parseInt(query.userid);
  const chatid = parseInt(query.chatid);
  
  if (uid !== uid || chatid !== chatid) {
    throw new this.FormatError();
  }
  
  let username, chat;
  
  return ctx.query('SELECT name FROM users WHERE uid = ? LOCK IN SHARE MODE', [uid]).then(res => {
    if (res.length === 0) {
      throw new this.SoTradeClientError('chat-adduser-user-notfound');
    }
    
    assert.equal(res.length, 1);
    username = res[0].name;
    
    return this.getChat({
      chatid: query.chatid,
      failOnMissing: true
    }, ctx);
  }).then(getChatsResult => {
    const status = getChatsResult.code;
    switch (status) {
      case 'chat-get-notfound':
        throw new this.SoTradeClientError('chat-adduser-chat-notfound');
      case 'chat-get-success':
        break;
      default:
        throw new this.SoTradeClientError(status);
    }
    
    chat = getChatsResult.chat;
    
    return ctx.query('INSERT INTO chatmembers (chatid, uid) VALUES (?, ?)', [chatid, uid]);
  }).then(() => {
    const feedusers = _.map(chat.endpoints, 'uid');
    feedusers.push(uid);
    
    return ctx.feed({
      type: 'chat-user-added',
      targetid: chatid,
      srcuser: ctx.user.uid,
      noFollowers: true,
      feedusers: _.map(chat.endpoints, 'uid'),
      json: {addedChats: uid, addedChatsName: username, endpoints: chat.endpoints}
    });
  }).then(() => ({ code: 'chat-adduser-success' }));
});

/**
 * List all chats for the current user.
 * 
 * @return {object} Returns with <code>list-all-chats-success</code>
 *                  or a common error code and populates <code>.chats</code>
 *                  with an {@link module:chats~Chat}
 * 
 * @function c2s~list-all-chats
 */
Chats.prototype.listAllChats = buscomponent.provideQT('client-list-all-chats', function(query, ctx) {
  return ctx.query('SELECT c.chatid, c.creator, creator_u.name AS creatorname, u.uid AS member, u.name AS membername, ' +
    'url AS profilepic, eventid AS chatstartevent ' +
    'FROM chatmembers AS cmi ' +
    'JOIN chats AS c ON c.chatid = cmi.chatid ' +
    'JOIN chatmembers AS cm ON cm.chatid = c.chatid ' +
    'JOIN users AS u ON cm.uid = u.uid ' +
    'LEFT JOIN httpresources ON httpresources.uid = u.uid AND httpresources.role = "profile.image" ' +
    'JOIN users AS creator_u ON c.creator = creator_u.uid ' +
    'JOIN events ON events.targetid = c.chatid AND events.type = "chat-start" ' +
    'WHERE cmi.uid = ?', [ctx.user.uid]).then(res => {
    const ret = {};
    
    for (let i = 0; i < res.length; ++i) {
      if (!ret[res[i].chatid]) {
        ret[res[i].chatid] = _.pick(res[i], 'chatid', 'creator', 'creatorname', 'chatstartevent');
        ret[res[i].chatid].members = [];
      }
      
      ret[res[i].chatid].members.push({
        id: res[i].member, /* backwards compatibility */
        uid: res[i].member,
        name: res[i].membername,
        profilepic: res[i].profilepic
      });
    }
    
    return { code: 'list-all-chats-success', chats: ret };
  });
});

exports.Chats = Chats;
