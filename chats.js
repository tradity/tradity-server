(function () { "use strict";

var _ = require('lodash');
var util = require('util');
var assert = require('assert');

var buscomponent = require('./stbuscomponent.js');

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
function Chats () {
	Chats.super_.apply(this, arguments);
}

util.inherits(Chats, buscomponent.BusComponent);

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
 * @param {?module:user~UserEntryBase[]} query.members  Array of full user objects for the 
 *                                                      participants.
 * @param {?int} query.chatid  The numerical chat id. Either this or query.endpoints
 *                             need to be set.
 * @param {?boolean} query.failOnMissing  If there is no such chat, do not create it.
 * @param {?boolean} query.noMessages  If set, do not load the chat messages.
 * 
 * @return {object} Returns with <code>chat-get-notfound</code>,
 *                  <code>chat-get-success</code> or a common error code.
 *                  and populates <code>.chat</code> with a
 *                  {@link module:chats~Chat}
 * 
 * @function c2s~get-chat
 */
Chats.prototype.getChats = buscomponent.provideQT('client-chat-get', function(query, ctx, cb) {
	var whereString = '';
	var params = [];
	
	if (!query.endpoints || !query.endpoints.length) {
		if (!query.chatid || parseInt(query.chatid) != query.chatid)
			return cb('format-error');
		
		whereString += ' chatid = ?';
		params.push(query.chatid);
	} else {
		if (query.chatid)
			return cb('format-error');
		
		var containsOwnChats = false;
		for (var i = 0; i < query.endpoints.length; ++i) {
			var uid = query.endpoints[i];
			containsOwnChats = containsOwnChats || (uid == ctx.user.id);
			if (parseInt(uid) != uid)
				return cb('format-error');
		}
		
		if (!containsOwnChats && ctx.user)
			query.endpoints.push(ctx.user.id);
		
		var endpointsList = query.endpoints.join(',');
		var numEndpoints = query.endpoints.length;
		
		whereString += 
			' (SELECT COUNT(*) FROM chatmembers AS cm JOIN users ON users.id = cm.userid WHERE cm.chatid = c.chatid ' +
			'AND cm.userid IN (' +  endpointsList + ')) = ? ';
		
		params.push(numEndpoints);
	}
	
	ctx.query('SELECT chatid, eventid AS chatstartevent FROM chats AS c ' +
		'LEFT JOIN events ON events.targetid = c.chatid AND events.type = "chat-start" '+
		'WHERE ' + whereString + ' ' +
		'ORDER BY (SELECT MAX(time) FROM events AS msgs WHERE msgs.type="comment" AND msgs.targetid = chatstartevent) DESC ' +
		'LIMIT 1', params, function(chatlist) {
		((chatlist.length == 0) ? function(cont) {
			if (query.failOnMissing || !query.endpoints)
				return cont(null);
			
			if (ctx.getProperty('readonly'))
				return cb('server-readonly');
			
			ctx.query('SELECT COUNT(*) AS c FROM users WHERE id IN (' + query.endpoints.join(',') + ')',
				[] , function(endpointUserCount) {
				if (endpointUserCount[0].c != query.endpoints.length)
					return cont(null);
				
			ctx.query('INSERT INTO chats(creator) VALUE(?)', [ctx.user.id], function(res) {
				var members = [];
				var memberValues = [];
				for (var i = 0; i < query.endpoints.length; ++i) {
					members.push('(?, ?, UNIX_TIMESTAMP())');
					memberValues.push(res.insertId);
					memberValues.push(String(query.endpoints[i]));
				}
				
				ctx.query('INSERT INTO chatmembers(chatid, userid, jointime) VALUES ' + members.join(','), memberValues, function() {
					ctx.feed({
						type: 'chat-start',
						targetid: res.insertId, 
						srcuser: ctx.user.id,
						noFollowers: true,
						feedusers: query.endpoints,
						json: {endpoints: query.endpoints}
					}, function(eventid) {
						cont({chatid: res.insertId, eventid: eventid});
					});
				});
			});
			});
		} : function(cont) {
			cont(chatlist[0]);
		})(function(chat) {
			if (chat === null)
				return cb('chat-get-notfound');
			
			assert.notStrictEqual(chat.chatid, null);
			assert.notStrictEqual(chat.eventid, null);
			
			chat.endpoints = query.endpoints;
			
			if (query.noMessages)
				return cb('chat-get-success', chat);
			
			ctx.query('SELECT u.name AS username, u.id AS uid, url AS profilepic ' +
				'FROM chatmembers AS cm ' +
				'JOIN users AS u ON u.id = cm.userid ' +
				'LEFT JOIN httpresources ON httpresources.user = cm.userid AND httpresources.role = "profile.image" ' + 
				'WHERE cm.chatid = ?', [chat.chatid], function(endpoints) {
				assert.ok(endpoints.length > 0);
				chat.endpoints = endpoints;
				
				var ownChatsIsEndpoint = false;
				for (var i = 0; i < chat.endpoints.length; ++i) {
					if (chat.endpoints[i].uid == ctx.user.id) {
						ownChatsIsEndpoint = true;
						break;
					}
				}
				
				if (!ownChatsIsEndpoint)
					return cb('chat-get-notfound');
				
				ctx.query('SELECT c.*,u.name AS username,u.id AS uid, url AS profilepic, trustedhtml ' + 
					'FROM ecomments AS c ' + 
					'LEFT JOIN users AS u ON c.commenter = u.id ' + 
					'LEFT JOIN httpresources ON httpresources.user = c.commenter AND httpresources.role = "profile.image" ' + 
					'WHERE c.eventid = ?', [chat.chatstartevent], function(comments) {
					chat.messages = comments;
					cb('chat-get-success', {chat: chat});
				});	
			});
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
 * @param {int} query.userid  The numerical id of the user to be added.
 * @param {int} query.chatid  The numerical id of the target chat.
 * 
 * @return {object} Returns with <code>chat-adduser-notfound</code>,
 *                  <code>chat-adduser-success</code> or a common error code.
 * 
 * @function c2s~chat-adduser
 */
Chats.prototype.addChatsToChats = buscomponent.provideWQT('client-chat-adduser', function(query, ctx, cb) {
	var self = this;
	
	if (parseInt(query.userid) != query.userid || parseInt(query.chatid) != query.chatid)
		return cb('format-error');
	
	ctx.query('SELECT name FROM users WHERE id = ?', [query.userid], function(res) {
		if (res.length == 0)
			return cb('chat-adduser-user-notfound');
		
		assert.equal(res.length, 1);
		var username = res[0].name;
		
		self.getChats({
			chatid: query.chatid,
			failOnMissing: true
		}, ctx, function(status, chat) {
			switch (status) {
				case 'chat-get-notfound':
					return cb('chat-adduser-chat-notfound');
				case 'chat-get-success':
					break;
				default:
					return cb(status); // assume other error
			}
			
			ctx.query('INSERT INTO chatmembers (chatid, userid) VALUES (?, ?)', [query.chatid, query.userid], function(r) {
				var feedusers = _.pluck(chat.endpoints, 'uid');
				feedusers.push(query.userid);
				
				ctx.feed({
					type: 'chat-user-added',
					targetid: query.chatid, 
					srcuser: ctx.user.id,
					noFollowers: true,
					feedusers: chat.endpoints,
					json: {addedChats: query.userid, addedChatsName: username, endpoints: chat.endpoints}
				});
				
				cb('chat-adduser-success');
			});
		});
	});
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
Chats.prototype.listAllChats = buscomponent.provideQT('client-list-all-chats', function(query, ctx, cb) {
	ctx.query('SELECT c.chatid, c.creator, creator_u.name AS creatorname, u.id AS member, u.name AS membername, url AS profilepic, ' +
		'eventid AS chatstartevent ' +
		'FROM chatmembers AS cmi ' +
		'JOIN chats AS c ON c.chatid = cmi.chatid ' +
		'JOIN chatmembers AS cm ON cm.chatid = c.chatid ' +
		'JOIN users AS u ON cm.userid = u.id ' +
		'LEFT JOIN httpresources ON httpresources.user = u.id AND httpresources.role = "profile.image" ' +
		'JOIN users AS creator_u ON c.creator = creator_u.id ' +
		'JOIN events ON events.targetid = c.chatid AND events.type = "chat-start" ' +
		'WHERE cmi.userid = ?', [ctx.user.id], function(res) {
		var ret = {};
		
		for (var i = 0; i < res.length; ++i) {
			if (!ret[res[i].chatid]) {
				ret[res[i].chatid] = _.pick(res[i], 'chatid', 'creator', 'creatorname', 'chatstartevent');
				ret[res[i].chatid].members = [];
			}
			
			ret[res[i].chatid].members.push({id: res[i].member, name: res[i].membername, profilepic: res[i].profilepic});
		}
		
		cb('list-all-chats-success', {chats: ret});
	});
});

exports.Chats = Chats;

})();
