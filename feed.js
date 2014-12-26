(function () { "use strict";

var _ = require('lodash');
var util = require('util');
var assert = require('assert');
var buscomponent = require('./stbuscomponent.js');

/**
 * Provides interfaces to the user feeds and event tables
 * 
 * @public
 * @module feed
 */

/**
 * Main object of the {@link module:feed} module
 * @public
 * @constructor module:feed~FeedController
 * @augments module:stbuscomponent~STBusComponent
 */
function FeedController () {
	FeedController.super_.apply(this, arguments);
};

util.inherits(FeedController, buscomponent.BusComponent);

/**
 * Inserts an event into the event tables and user feeds.
 * 
 * Your local {@link module:qctx~QContext}’s <code>feed</code> method
 * invokes this – if available, consider using it in order to map all
 * actions to the current context.
 * 
 * @param {string} data.type  A short identifier for the kind of event
 * @param {int} data.srcuser  The numerical identifier of the user who
 *                            caused this event
 * @param {object} data.json  Additional information specific to the event type
 * @param {boolean} data.everyone  Write this event to all user feeds
 * @param {boolean} data.noFollowers  Do not write this event automatically to
 *                                    follower feeds
 * @param {int[]}  data.feedusers  A list of users to whose feeds this event should
 *                                 be written
 * @param {int}  data.feedchat   The ID of a chat of which all members should be
 *                               notified of this event
 * @param {int}  data.feedschool  The ID of a group of which all members should be
 *                                notified of this event
 * @param {module:qctx~QContext} ctx  A QContext to provide database access
 * @param {object} conn  An optional database connection to be used
 * 
 * @function busreq~feed
 */
FeedController.prototype.feed = buscomponent.provide('feed',
	['data', 'ctx', 'conn', 'onEventId', 'reply'], function(data, ctx, conn, onEventId, done) {
	var self = this;
	
	done = done || function() {};
	assert.ok(data.type);
	assert.ok(data.type.length);
	assert.ok(data.srcuser);
	
	var json = JSON.stringify(data.json ? data.json : {});
	data = _.extend(data, data.json);
	
	conn = conn || ctx; // both db connections and QContexts expose .query()
	
	conn.query('INSERT INTO events(`type`, targetid, time, srcuser, json) VALUES (?, ?, UNIX_TIMESTAMP(), ?, ?)',
		[String(data.type), data.targetid ? parseInt(data.targetid) : null, parseInt(data.srcuser), json], function(r) {
		var eventid = r.insertId;
		onEventId(eventid);
		
		var query, params, subselects;
		
		if (!data.everyone) {
			var additional = data.feedusers && data.feedusers.slice(0) || [];
			if (additional.indexOf(data.srcuser) == -1)
				additional.push(data.srcuser);
			
			query = 'INSERT INTO events_users (eventid,userid) ';
			subselects = [];
			params = [];
			
			if (!data.noFollowers) {
				// all followers
				subselects.push('SELECT ?, userid ' +
					'FROM depot_stocks ' +
					'JOIN stocks ON depot_stocks.stockid = stocks.id AND stocks.leader = ?');
				// all users in watchlist
				subselects.push('SELECT ?, watcher ' +
					'FROM stocks AS stocks1 ' +
					'JOIN watchlists ON stocks1.id = watched WHERE stocks1.leader = ?');
				params.push(eventid, data.srcuser, eventid, data.srcuser);
			}
			
			if (data.feedschool) {
				subselects.push(
					'SELECT ?, sm.uid FROM schools AS p ' +
					'JOIN schools AS c ON c.path LIKE CONCAT(p.path, "%") OR p.id = c.id ' +
					'JOIN schoolmembers AS sm ON sm.schoolid = c.id AND sm.pending = 0 ' +
					'WHERE p.id = ?');
				params.push(eventid, data.feedschool);
			}
			
			if (data.feedchat) {
				subselects.push('SELECT ?, userid FROM chatmembers WHERE chatid = ?');
				params.push(eventid, data.feedchat);
			}
			 
			for (var i = 0; i < additional.length; ++i) {
				if (parseInt(additional[i]) != additional[i])
					return self.emitError(new Error('Bad additional user for feed event: ' + additional[i]));
				
				subselects.push('SELECT ?,?');
				params.push(eventid, additional[i]);
			}
			query += subselects.join(' UNION ');
		} else {
			query = 'INSERT INTO events_users (eventid, userid) SELECT ?, id FROM users';
			params = [eventid];
		}
		
		conn.query(query, params, function() {
			process.nextTick(function() {
				self.emitGlobal('feed-' + data.type, data);
				self.emitGlobal('push-events');
				done();
			});
		});
	});
});

/**
 * Loads events for a given user’s feed.
 * 
 * @param {int} query.since  A unix timestamp indicating the maximum age of events
 * @param {?int} query.count  A maximum count of events to return
 * 
 * @function busreq~feedFetchEvents
 */
FeedController.prototype.fetchEvents = buscomponent.provideQT('feedFetchEvents', function(query, ctx, cb) {
	ctx.query('SELECT events.*, events_users.*, c.*, oh.*, events.time AS eventtime, events.eventid AS eventid, ' +
		'e2.eventid AS baseeventid, e2.type AS baseeventtype, trader.id AS traderid, trader.name AS tradername, ' +
		'schools.id AS schoolid, schools.name AS schoolname, schools.path AS schoolpath, ' +
		'su.name AS srcusername, notif.content AS notifcontent, notif.sticky AS notifsticky, url AS profilepic, ' +
		'achievements.achname, achievements.xp, sentemails.messageid, sentemails.sendingtime, sentemails.bouncetime, ' +
		'sentemails.mailtype, sentemails.recipient AS mailrecipient, sentemails.diagnostic_code ' +
		'FROM events_users ' +
		'JOIN events ON events_users.eventid = events.eventid ' +
		'LEFT JOIN ecomments AS c ON c.commentid = events.targetid AND events.type="comment" ' +
		'LEFT JOIN events AS e2 ON c.eventid = e2.eventid ' +
		'LEFT JOIN orderhistory AS oh ON oh.orderid = IF(events.type="trade", events.targetid, IF(e2.type="trade", e2.targetid, NULL)) ' +
		'LEFT JOIN users AS su ON su.id = events.srcuser ' +
		'LEFT JOIN users AS trader ON trader.id = IF(e2.type="trade", oh.userid, IF(e2.type="user-register", e2.targetid, NULL)) ' +
		'LEFT JOIN schools ON schools.id = e2.targetid AND e2.type="school-create" ' +
		'LEFT JOIN achievements ON achievements.achid = events.targetid AND events.type="achievement" ' +
		'LEFT JOIN mod_notif AS notif ON notif.notifid = events.targetid AND events.type="mod-notification" ' +
		'LEFT JOIN httpresources ON httpresources.user = c.commenter AND httpresources.role = "profile.image" ' +
		'LEFT JOIN sentemails ON sentemails.mailid = events.targetid AND events.type="email-bounced" ' +
		'WHERE events_users.userid = ? AND events.time > ? ORDER BY events.time DESC LIMIT ?',
		[ctx.user.uid, query ? parseInt(query.since) : 0, query && query.count !== null ? parseInt(query.count) : 1000000], function(r) {
		cb(_.chain(r).map(function(ev) {
			if (ev.json) {
				var json = JSON.parse(ev.json);
				if (json.delay && (Date.now()/1000 - ev.eventtime < json.delay) && ctx.user.uid != ev.srcuser)
					return null;
				ev = _.extend(ev, json);
			}
			
			delete ev.json;
			return ev;
		}).reject(function(ev) { return !ev; }).value());
	});
});

/**
 * Indicates that the current user has been notified a given event.
 * 
 * @param {int} query.eventid  The numerical identifier of the target event.
 * 
 * @return {object}  Returns with <code>mark-as-seen-success</code> or a common error code.
 * 
 * @function c2s~mark-as-seen
 */
FeedController.prototype.markAsSeen = buscomponent.provideWQT('client-mark-as-seen', function(query, ctx, cb) {
	if (parseInt(query.eventid) != query.eventid)
		return cb('format-error');
	
	ctx.query('UPDATE events_users SET seen = 1 WHERE eventid = ? AND userid = ?', [parseInt(query.eventid), ctx.user.id], function() {
		cb('mark-as-seen-success');
	});
});

/**
 * Comment on a gieven event.
 * 
 * @param {string} query.comment  The comment’s text.
 * @param {boolean} query.ishtml  Whether the comment’s content should be considered HTML.
 * @param {int} query.eventid  The numerical identifier of the target event.
 * 
 * @return {object}  Returns with <code>comment-success</code>, <code>comment-notfound</code>
 *                   or a common error code.
 * 
 * @function c2s~comment
 */
FeedController.prototype.commentEvent = buscomponent.provideWQT('client-comment', function(query, ctx, cb) {
	if (!query.comment)
		return cb('format-error');
	
	ctx.query('SELECT events.type,events.targetid,oh.userid AS trader FROM events '+
		'LEFT JOIN orderhistory AS oh ON oh.orderid = events.targetid WHERE eventid = ?', [parseInt(query.eventid)], function(res) {
		if (res.length == 0)
			return cb('comment-notfound');
		
		var feedschool = null;
		var feedchat = null;
		var feedusers = [];
		var r = res[0];
		var noFollowers = false;
		
		switch (r.type) {
			case 'user-register':
				assert.notStrictEqual(r.targetid, null);
				feedusers.push(r.targetid);
				break;
			case 'trade':
				assert.notStrictEqual(r.trader, null);
				feedusers.push(r.trader);
				break;
			case 'school-create':
				assert.notStrictEqual(r.targetid, null);
				feedschool = r.targetid;
				break;
			case 'chat-start':
				assert.notStrictEqual(r.targetid, null);
				feedchat = r.targetid;
				noFollowers = true;
				break;
		}
		
		ctx.query('INSERT INTO ecomments (eventid, commenter, comment, trustedhtml, time) VALUES(?, ?, ?, ?, UNIX_TIMESTAMP())', 
			[parseInt(query.eventid), ctx.user.id, String(query.comment), query.ishtml && ctx.access.has('comments') ? 1 : 0], function(res) {
			ctx.feed({
				type: 'comment',
				targetid: res.insertId,
				srcuser: ctx.user.id,
				feedusers: feedusers,
				feedschool: feedschool,
				feedchat: feedchat,
				noFollowers: noFollowers
			});
			cb('comment-success');
		});
	});
});

exports.FeedController = FeedController;

})();
