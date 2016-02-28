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

const api = require('./api.js');

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

/** */
class GetChat extends api.Requestable {
  constructor() {
    super({
      url: '/chats/load',
      methods: ['POST', 'GET'],
      returns: [
        { code: 200 },
        { code: 404, identifier: 'not-found' }
      ],
      transactional: true,
      schema: {
        type: 'object',
        properties: {
          endpoints: {
            type: 'array',
            items: { type: 'integer' },
            description: 'Array of UIDs of the other participants in the chat'
          },
          chatid: {
            type: 'integer',
            description: 'The numerical chat id.',
            notes: 'Either this or query.endpoints needs to be set'
          },
          failOnMissing: {
            type: 'boolean',
            description: 'If there is no such chat, do not create it'
          },
          noMessages: {
            type: 'boolean',
            description: 'If set, do not load the chat messages.'
          }
        },
        required: []
      },
      description: 'Fetch or create a specific chat.'
    });
  }
  
  handle(query, ctx) {
    let whereString = '';
    let params = [];
    let chatid = typeof query.chatid === 'undefined' || query.chatid === null ?
      null : parseInt(query.chatid);
    
    if (!query.endpoints || !query.endpoints.length) {
      if (isNaN(chatid)) {
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
          throw new this.ClientError('server-readonly'); // XXX
        } else {
          throw new this.ClientError('not-found');
        }
      }
      
      assert.equal(parseInt(chat.chatid), chat.chatid);
      assert.equal(parseInt(chat.chatstartevent), chat.chatstartevent);
      
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
        throw new this.ClientError('not-found');
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
        
        return { code: 200, chat: chat };
      }); 
    });
  }
}

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

/** */
class AddUserToChat extends api.Requestable {
  constructor() {
    super({
      url: '/chats/:chatid/add',
      methods: ['POST'],
      returns: [
        { code: 200 },
        { code: 404, identifier: 'not-found' }
      ],
      transactional: true,
      schema: {
        type: 'object',
        properties: {
          uid: {
            type: 'integer',
            description: 'The numerical id of the user to be added'
          },
          chatid: {
            type: 'integer',
            description: 'The numerical id of the target chat'
          },
        },
        required: ['uid', 'chatid']
      },
      description: 'Add a user to a specific chat.',
      depends: [GetChat]
    });
  }
  
  handle(query, ctx) {
    debug('Add user to chat', query.userid, query.chatid);
    
    const uid = query.uid;
    const chatid = query.chatid;
    
    let username, chat;
    
    return ctx.query('SELECT name FROM users WHERE uid = ? LOCK IN SHARE MODE', [uid]).then(res => {
      if (res.length === 0) {
        throw new this.ClientError('not-found');
      }
      
      assert.equal(res.length, 1);
      username = res[0].name;
      
      return this.load(GetChat).handle({
        chatid: query.chatid,
        failOnMissing: true
      }, ctx);
    }).then(getChatsResult => {
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
    }).then(() => ({ code: 204 }));
  }
}

class ListAllChats extends api.Requestable {
  constructor() {
    super({
      url: '/chats',
      methods: ['GET'],
      returns: [
        { code: 200 }
      ],
      description: 'List all chats for the current user.'
    });
  }
  
  handle(query, ctx) {
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
          uid: res[i].member,
          name: res[i].membername,
          profilepic: res[i].profilepic
        });
      }
      
      return { code: 200, data: ret };
    });
  }
}

exports.components = [
  GetChat,
  AddUserToChat,
  ListAllChats
];
