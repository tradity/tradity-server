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
const buscomponent = require('./stbuscomponent.js');
const debug = require('debug')('sotrade:feed');

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
class FeedController extends buscomponent.BusComponent {
  constructor() {
    super();
  }
}

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
  ['data', 'ctx', 'conn', 'onEventId'], function(data, ctx, conn, onEventId) {
  debug('Feed event', data.type);
  
  assert.ok(data.type);
  assert.ok(data.type.length);
  assert.equal(data.srcuser, parseInt(data.srcuser));
  
  const json = JSON.stringify(data.json ? data.json : {});
  data = _.extend(data, data.json);
  
  conn = conn || ctx; // both db connections and QContexts expose .query()
  
  let eventid;
  return conn.query('INSERT INTO events(`type`, targetid, time, srcuser, json) VALUES (?, ?, ?, ?, ?)',
    [String(data.type), data.targetid ? parseInt(data.targetid) : null,
    data.time ? data.time : parseInt(Date.now() / 1000), parseInt(data.srcuser), json]).then(r => {
    eventid = r.insertId;
    onEventId(eventid);
    
    let query, params, subselects;
    
    if (!data.everyone) {
      const additional = data.feedusers && data.feedusers.slice(0) || [];
      if (additional.indexOf(data.srcuser) === -1) {
        additional.push(data.srcuser);
      }
      
      query = 'INSERT INTO events_users (eventid, uid) ';
      subselects = [];
      params = [];
      
      if (!data.noFollowers) {
        // all followers
        subselects.push('SELECT ?, uid ' +
          'FROM depot_stocks ' +
          'JOIN stocks ON depot_stocks.stockid = stocks.stockid AND stocks.leader = ?');
        // all users in watchlist
        subselects.push('SELECT ?, watcher ' +
          'FROM stocks AS stocks1 ' +
          'JOIN watchlists ON stocks1.stockid = watched ' +
          'WHERE stocks1.leader = ?');
        params.push(eventid, data.srcuser, eventid, data.srcuser);
      }
      
      if (data.feedschool) {
        subselects.push(
          'SELECT ?, sm.uid FROM schools AS p ' +
          'JOIN schools AS c ON c.path LIKE CONCAT(p.path, "%") OR p.schoolid = c.schoolid ' +
          'JOIN schoolmembers AS sm ON sm.schoolid = c.schoolid AND sm.pending = 0 ' +
          'WHERE p.schoolid = ?');
        params.push(eventid, data.feedschool);
      }
      
      if (data.feedchat) {
        subselects.push('SELECT ?, uid FROM chatmembers WHERE chatid = ?');
        params.push(eventid, data.feedchat);
      }
       
      for (let i = 0; i < additional.length; ++i) {
        const additionalUser = parseInt(additional[i]);
        if (additionalUser !== additionalUser) { // NaN
          return this.emitError(new Error('Bad additional user for feed event: ' + additional[i]));
        }
        
        subselects.push('SELECT ?, ?');
        params.push(eventid, additional[i]);
      }
      query += subselects.join(' UNION ');
    } else {
      query = 'INSERT INTO events_users (eventid, uid) SELECT ?, uid FROM users';
      params = [eventid];
    }
    
    return conn.query(query, params);
  }).then(() => {
    debug('Invoking push-events', data.type);
    this.emitGlobal('feed-' + data.type, data);
    this.emitGlobal('push-events');
    return eventid;
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
FeedController.prototype.fetchEvents = buscomponent.provideQT('feedFetchEvents', function(query, ctx) {
  let since, count;
  if (query) {
    since = parseInt(query.since);
    count = parseInt(query.count);
    
    if (since !== since) {
      since = 0;
    }
    
    if (count !== count) {
      count = 10000;
    }
  }
  
  return ctx.query('SELECT events.*, events_users.*, c.*, oh.*, events.time AS eventtime, events.eventid AS eventid, ' +
    'e2.eventid AS baseeventid, e2.type AS baseeventtype, trader.uid AS traderid, trader.name AS tradername, ' +
    'schools.schoolid, schools.name AS schoolname, schools.path AS schoolpath, ' +
    'su.name AS srcusername, notif.content AS notifcontent, notif.sticky AS notifsticky, url AS profilepic, ' +
    'achievements.achname, achievements.xp, sentemails.messageid, sentemails.sendingtime, sentemails.bouncetime, ' +
    'sentemails.mailtype, sentemails.recipient AS mailrecipient, sentemails.diagnostic_code, ' +
    'blogposts.* ' +
    'FROM events_users ' +
    'JOIN events ON events_users.eventid = events.eventid ' +
    'LEFT JOIN ecomments AS c ON c.commentid = events.targetid AND events.type="comment" ' +
    'LEFT JOIN events AS e2 ON c.eventid = e2.eventid ' +
    'LEFT JOIN orderhistory AS oh ON oh.orderid = IF(events.type="trade", events.targetid, IF(e2.type="trade", e2.targetid, NULL)) ' +
    'LEFT JOIN users AS su ON su.uid = events.srcuser ' +
    'LEFT JOIN users AS trader ON trader.uid = IF(e2.type="trade", oh.uid, IF(e2.type="user-register", e2.targetid, NULL)) ' +
    'LEFT JOIN achievements ON achievements.achid = events.targetid AND events.type="achievement" ' +
    'LEFT JOIN mod_notif AS notif ON notif.notifid = events.targetid AND events.type="mod-notification" ' +
    'LEFT JOIN httpresources ON httpresources.uid = c.commenter AND httpresources.role = "profile.image" ' +
    'LEFT JOIN sentemails ON sentemails.mailid = events.targetid AND events.type="email-bounced" ' +
    'LEFT JOIN blogposts ON events.targetid = blogposts.postid AND events.type="blogpost" ' +
    'LEFT JOIN feedblogs ON blogposts.blogid = feedblogs.blogid ' +
    'LEFT JOIN schools ON schools.schoolid = IF(events.type="blogpost", feedblogs.schoolid, IF(e2.type="school-create", e2.targetid, NULL)) ' +
    'WHERE events_users.uid = ? AND events.time >= ? ORDER BY events.time DESC LIMIT ?',
    [ctx.user.uid, since, count]).then(r => {
    return r.map(ev => {
      if (ev.json) {
        const json = JSON.parse(ev.json);
        if (json.delay && (Date.now()/1000 - ev.eventtime < json.delay) && ctx.user.uid !== ev.srcuser) {
          return null;
        }
        
        ev = _.extend(ev, json);
      }
      
      if (ev.postjson) {
        const postjson = JSON.parse(ev.postjson);
        
        // move type to wptype so it does not override the event type
        postjson.wptype = postjson.type;
        delete postjson.type;
        
        ev = _.extend(ev, postjson);
        delete ev.postjson;
      }
      
      if (['gdeleted', 'mdeleted'].indexOf(ev.cstate) !== -1) {
        return null;
      }
      
      delete ev.json;
      return ev;
    }).filter(ev => ev); /* filter out false-y results */
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
FeedController.prototype.markAsSeen = buscomponent.provideWQT('client-mark-as-seen', function(query, ctx) {
  const eventid = parseInt(query.eventid);
  if (eventid !== eventid) { // NaN
    throw new this.FormatError();
  }
  
  return ctx.query('UPDATE events_users SET seen = 1 WHERE eventid = ? AND uid = ?', 
    [eventid, ctx.user.uid]).then(() => {
    return { code: 'mark-as-seen-success' };
  });
});

/**
 * Comment on a given event.
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
FeedController.prototype.commentEvent = buscomponent.provideTXQT('client-comment', function(query, ctx) {
  const eventid = parseInt(query.eventid);
  if (!query.comment || eventid !== eventid) {
    throw new this.FormatError();
  }
  
  let feedschool = null;
  let feedchat = null;
  let feedusers = [];
  let noFollowers = false;
  
  return ctx.query('SELECT events.type, events.targetid, oh.uid AS trader FROM events ' +
    'LEFT JOIN orderhistory AS oh ON oh.orderid = events.targetid WHERE eventid = ? LOCK IN SHARE MODE',
    [eventid]).then(res => {
    if (res.length === 0) {
      throw new this.SoTradeClientError('comment-notfound');
    }
    
    const r = res[0];
    
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
    
    return ctx.query('INSERT INTO ecomments (eventid, commenter, comment, trustedhtml, cstate, time) VALUES(?, ?, ?, ?, "", UNIX_TIMESTAMP())', 
      [eventid, ctx.user.uid, String(query.comment),
       query.ishtml && ctx.access.has('comments') ? 1 : 0]);
  }).then(res => {
    return ctx.feed({
      type: 'comment',
      targetid: res.insertId,
      srcuser: ctx.user.uid,
      feedusers: feedusers,
      feedschool: feedschool,
      feedchat: feedchat,
      noFollowers: noFollowers
    });
  }).then(() => {
    return { code: 'comment-success' };
  });
});

exports.FeedController = FeedController;
