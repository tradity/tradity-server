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
const api = require('./api.js');
const debug = require('debug')('sotrade:feed');

class FeedInserter extends api.Component {
  constructor() {
    super({
      identifier: 'FeedInserter',
      description: 'Inserts an event into the event tables and user feeds.',
      schema: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            description: 'A short identifier for the kind of event'
          },
          srcuser: {
            type: 'integer',
            description: 'The numerical identifier of the user who caused this event'
          },
          json: {
            description: 'Additional information specific to the event type'
          },
          everyone: {
            type: 'boolean',
            description: 'Write this event to all user feeds?'
          },
          noFollowers: {
            type: 'boolean',
            description: 'Do not write this event automatically to follower feeds'
          },
          feedusers: {
            type: 'array',
            items: { type: 'integer' },
            description: 'A list of users to whose feeds this event should be written'
          },
          feedchat: {
            type: 'integer',
            description: 'The ID of a chat of which all members should be notified about this event'
          },
          feedschool: {
            type: 'int',
            description: 'The ID of a group of which all members should be notified about this event'
          }
        },
        required: ['type', 'srcuser']
      }
    });
  }
  
  // XXX conn? onEventId?
  insert(data, ctx, conn, onEventId) {
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
            return this.load('PubSub').emit('error', new Error('Bad additional user for feed event: ' + additional[i]));
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
      debug('Publishing event', data.type);
      this.load('PubSub').publish('feed-' + data.type, data);
      return eventid;
    });
  }
}

class FeedFetcher extends api.Requestable {
  constructor() {
    super({
      url: '/events',
      identifier: 'FeedFetcher',
      description: 'Loads events for a given user’s feed.',
      schema: {
        type: 'object',
        properties: {
          since: {
            type: 'integer',
            description: 'A unix timestamp indicating the maximum age of events',
          },
          upto: {
            type: 'integer',
            description: 'A unix timestamp indicating the minimum age of events'
          },
          omitUidFilter: {
            type: 'boolean',
            description: 'If possible, list events for *all* users'
          },
          types: {
            type: 'string',
            description: 'Comma-separated list of event types to filer for'
          }
        }
      }
    });
  }
  
  handle(query, ctx) {
    let since, upto, count;
    assert.ok(query);
    
    since = parseInt(query.since);
    upto = parseInt(query.upto);
    count = parseInt(query.count);
    const types = String(query.types || '').split(',').filter(t => t);
    
    if (since !== since) {
      since = parseInt(Date.now() / 1000);
    }
    
    if (upto !== upto) {
      upto = parseInt(Date.now() / 1000);
    }
    
    if (count !== count) {
      count = 10000;
    }
    
    const omitUidFilter = query.omitUidFilter && ctx.access.has('feed');
    const includeDeletedComments = query.includeDeletedComments || false;
    
    return ctx.query('SELECT events.*, c.*, oh.*, events.time AS eventtime, events.eventid AS eventid, ' +
      'e2.eventid AS baseeventid, e2.type AS baseeventtype, trader.uid AS traderid, trader.name AS tradername, ' +
      'schools.schoolid, schools.name AS schoolname, schools.path AS schoolpath, ' +
      'su.name AS srcusername, notif.content AS notifcontent, notif.sticky AS notifsticky, url AS profilepic, ' +
      'achievements.achname, achievements.xp, sentemails.messageid, sentemails.sendingtime, sentemails.bouncetime, ' +
      'sentemails.mailtype, sentemails.recipient AS mailrecipient, sentemails.diagnostic_code, ' +
      'blogposts.* ' +
      (omitUidFilter ? '' : ', events_users.*') +
      'FROM events ' +
      (omitUidFilter ? '' : 
        'JOIN events_users ON events_users.eventid = events.eventid ') +
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
      'WHERE events.time >= ? AND events.time <= ? ' +
      (omitUidFilter ? ' ' : 'AND events_users.uid = ? ') +
      (types.length > 0 ? 'AND events.type IN (' + types.map(() => '?').join(',') + ') ' : ' ') +
      'ORDER BY events.time DESC LIMIT ?',
      [since, upto].concat(omitUidFilter ? [] : [ctx.user.uid]).concat(types).concat([count])).then(r => {
      return r.map(ev => {
        if (ev.json) {
          const json = JSON.parse(ev.json);
          if (json.delay && (Date.now()/1000 - ev.eventtime < json.delay) &&
              ctx.user.uid !== ev.srcuser &&
              !omitUidFilter) // omitUidFilter implies administrative overview
          {
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
        
        if (!includeDeletedComments && 
            ['gdeleted', 'mdeleted'].indexOf(ev.cstate) !== -1)
        {
          return null;
        }
        
        delete ev.json;
        return ev;
      }).filter(ev => ev); /* filter out false-y results */
    }).then(evlist => ({ code: 200, data: evlist }));
  }
}

class MarkEventAsSeen extends api.Requestable {
  constructor() {
    super({
      url: '/events/:eventid/seen',
      methods: ['POST'],
      returns: [
        { code: 204 }
      ],
      schema: {
        type: 'object',
        properties: {
          eventid: {
            type: 'integer',
            description: 'The numerical identifier of the target event.'
          }
        },
        required: ['eventid']
      },
      writing: true,
      description: 'Indicates that the current user has been notified a given event.'
    });
  }
  
  handle(query, ctx) {
    return ctx.query('UPDATE events_users SET seen = 1 WHERE eventid = ? AND uid = ?', 
      [query.eventid, ctx.user.uid]).then(() => {
      return { code: 204 };
    });
  }
}

class CommentPost extends api.Requestable {
  constructor() {
    super({
      url: '/events/:eventid/comments',
      methods: ['POST'],
      returns: [
        { code: 204 },
        { code: 400, identifier: 'not-found' }
      ],
      schema: {
        type: 'object',
        properties: {
          eventid: {
            type: 'integer',
            description: 'The numerical identifier of the target event.'
          },
          comment: {
            type: 'string'
          },
          ishtml: {
            type: 'boolean'
          }
        },
        required: ['eventid', 'comment']
      },
      transactional: true,
      description: 'Comment on a given event.'
    });
  }
  
  handle(query, ctx) {
    const eventid = parseInt(query.eventid);
    
    let feedschool = null;
    let feedchat = null;
    let feedusers = [];
    let noFollowers = false;
    
    return ctx.query('SELECT events.type, events.targetid, oh.uid AS trader FROM events ' +
      'LEFT JOIN orderhistory AS oh ON oh.orderid = events.targetid WHERE eventid = ? LOCK IN SHARE MODE',
      [eventid]).then(res => {
      if (res.length === 0) {
        throw new this.Client('not-found');
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
      return { code: 204 };
    });
  }
}

exports.components = [
  FeedInserter,
  FeedFetcher,
  MarkEventAsSeen,
  CommentPost
];
