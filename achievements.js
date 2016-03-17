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

const assert = require('assert');
const moment = require('moment-timezone');
const qctx = require('./qctx.js');
const debug = require('debug')('sotrade:achievements');
const api = require('./api.js');

class Achievements extends api.Component {
  constructor() {
    super({
      identifier: 'Achievements',
      depends: ['AchievementListProvider', 'ReadonlyStore']
    });
    
    this.achievementList = [];
  }
  
  init() {
    const al = this.load('AchievementListProvider').getAchievementList();
    
    return this.registerAchievements(al);
  }
  
  /**
   * Checks the achievements for the current user for having been completed.
   * 
   * @param {module:qctx~QContext} ctx  A QContext to provide database access and user information.
   */
  checkAchievements(ctx) {
    debug('Checking achievements for current user', ctx.user.uid);
    
    if (this.load('ReadonlyStore').readonly) {
      return;
    }
    
    return ctx.query('SELECT * FROM achievements WHERE uid = ?', [ctx.user.uid]).then(userAchievements => {
      return Promise.all(this.achievementList.map(achievementEntry => {
        return this.checkAchievement(achievementEntry, ctx, userAchievements);
      }));
    });
  }

  /**
   * Information about a user achievement.
   * 
   * @typedef s2c~achievement
   * @type {Event}
   * 
   * @property {string} achname  The achievement type identifier
   * @property {int} xp  The amount of XP awarded to the user for completing
   *                     this achievement
   */

  /**
   * Represents an achievement completed by a single user.
   * 
   * @typedef module:achievements~Achievement
   * @type {object}
   * 
   * @property {int} achid  An unique numerical identifier for this achievement.
   * @property {int} uid  The numerical id of the user who completed the achievement.
   * @property {string} achname  The achievement type identifier for this achievement.
   * @property {int} xp  The amount of XP awarded for this achievement.
   * @property {int} version  The version of this achievement type when it was completed.
   */

  /**
   * Check a single achievement type for the current user for having been completed.
   * 
   * @param {module:achievement-list~AchievementType} achievementEntry  The achievement type to be checked.
   * @param {module:qctx~QContext} ctx  A QContext to provide database access and user information.
   * @param {?module:achievements~Achievement[]} userAchievements  A list of completed achievements of this user.
   */
  checkAchievement(achievementEntry, ctx, userAchievements_) {
    if (!ctx.user) {
      return;
    }
    
    let uid = ctx.user.uid;
    debug('Checking achievement for user', achievementEntry.name, uid);
    
    assert.equal(uid, parseInt(uid));
    assert.ok(!uid.splice);
    
    uid = parseInt(uid);
    
    const cfg = this.load('Config');
    
    return Promise.resolve().then(() => {
      if (userAchievements_) {
        return userAchievements_;
      }
      
      let lookfor = achievementEntry.requireAchievementInfo;
      lookfor = [...new Set([achievementEntry.name].concat(lookfor))]; // implicit .uniq
      
      return ctx.query('SELECT * FROM achievements ' +
        'WHERE uid = ? AND achname IN (' + lookfor.map(() => '?').join(',') + ')',
        [uid].splice(0).concat(lookfor));
    }).then(userAchievements => {
      userAchievements = new Map(userAchievements.map(a => [a.achname, a]));
      
      if (userAchievements.has(achievementEntry.name)) {
        const dbver = userAchievements.get(achievementEntry.name).version;
        if (dbver > achievementEntry.version) {
          this.load('PubSub').emit('error', new Error(
            'Version mismatch for achievement ' + userAchievements.get(achievementEntry.name) + ' vs ' + achievementEntry.version
          ));
        }
        
        if (dbver >= achievementEntry.version) {
          return;
        }
      }
    
      if (!achievementEntry.prereqAchievements.every(a => userAchievements.has(a))) {
        return; // not all prereqs fulfilled
      }
      
      return Promise.resolve().then(() => {
        if (achievementEntry.implicatingAchievements.some(a => userAchievements.has(a))) {
          return true;
        }
        
        return achievementEntry.check(uid, userAchievements, cfg, ctx);
      }).then(hasBeenAchieved => {
        assert.equal(typeof hasBeenAchieved, 'boolean');
        if (!hasBeenAchieved) {
          return;
        }
        
        return ctx.query('REPLACE INTO achievements (uid, achname, xp, version) VALUES (?, ?, ?, ?)', 
          [uid, achievementEntry.name, achievementEntry.xp, achievementEntry.version]).then(res => {
          if (res.affectedRows !== 1) {
            return;
          }
          
          debug('Give achievement to user', uid, achievementEntry);
          
          // REPLACE INTO actually created a row
          return ctx.feed({
            type: 'achievement',
            srcuser: uid,
            targetid: res.insertId
          });
        }).then(() => {
          return Promise.all(this.achievementList.map(ae => {
            // look for achievements of which we have changed the prereq/implicating achievements list
            if (!new Set(ae.implicatingAchievements.concat(ae.prereqAchievements)).has(achievementEntry.name)) {
              return -1;
            }
            
            return this.checkAchievement(ae, ctx);
          }));
        });
      });
    });
  }

  /**
   * Registers all <code>fireOn</code> handlers for an achievement type.
   * 
   * @param {module:achievement-list~AchievementType} achievementEntry  The achievement type for which
   *                                                                    event listeners will be installed.
   */
  registerObservers(achievementEntry) {
    const ctx = new qctx.QContext({parentComponent: this});

    return Promise.all(Object.keys(achievementEntry.fireOn).map(eventName => {
      const checkCallback = achievementEntry.fireOn[eventName];
      
      return this.load('PubSub').on(eventName, data => {
        return Promise.resolve(checkCallback.call(achievementEntry, data, ctx)).then(userIDs => {
          assert.ok(userIDs);
          assert.notEqual(typeof userIDs.length, 'undefined');
          
          return Promise.all(userIDs.map(uid => {
            return this.checkAchievement(achievementEntry, new qctx.QContext({user: {uid: uid}, parentComponent: this}));
          }));
        });
      });
    }));
  }

  /**
   * Load and setup achievement types.
   * 
   * @param {module:achievement-list~AchievementType[]} list  The list of added achievement types.
   */
  registerAchievements(list) {
    list = list.map(achievementEntry => {
      const e = Object.assign({}, achievementEntry, {
        requireAchievementInfo: [],
        prereqAchievements: [],
        implicatingAchievements: []
      });
      
      e.requireAchievementInfo = [...new Set(
        e.requireAchievementInfo
          .concat(e.prereqAchievements)
          .concat(e.implicatingAchievements)
        )];
      
      return e;
    });
    
    this.achievementList = this.achievementList.concat(list);
    
    return Promise.all(list.map(achievementEntry => {
      assert.notStrictEqual(achievementEntry.version, null);
      
      return this.registerObservers(achievementEntry);
    }));
  }
}

class ListAllAchievements extends api.Requestable {
  constructor() {
    super({
      url: '/achievements/list',
      methods: ['GET'],
      returns: [
        { code: 200 },
      ],
      description: 'Lists all achievement types.',
      depends: ['Achievements']
    });
  }
  
  handle() {
    return {
      code: 200,
      data: this.load('Achievements').achievementList
    };
  }
}

class GetDailyLoginCertificate extends api.Requestable {
  constructor() {
    super({
      url: '/achievements/client/daily-login-cert',
      methods: ['GET'],
      returns: [
        { code: 200 },
      ],
      schema: {
        type: 'object',
        properties: {
          today: {
            type: 'string',
            description: 'If executed with appropiate privileges, sets the date for the certificate.'
          }
        }
      },
      description: 'Return a string to the user that can be used for verifying that ' +
        'they have been active on a given day.',
      depends: ['SignedMessaging']
    });
  }
  
  handle(query, ctx, cfg) {
    let today = moment.tz(cfg.timezone).format('YYYY-MM-DD');
    
    if (query.today) {
      if (!ctx.access.has('achievements')) {
        throw new this.Forbidden();
      }
      
      today = String(query.today);
    }
    
    debug('Signing daily login certificate', ctx.user.uid, today);
    return this.load('SignedMessaging').createSignedMessage({
      uid: ctx.user.uid,
      date: today,
      certType: 'wasOnline'
    }).then(cert => {
      return { code: 200, data: cert };
    });
  }
}

class ClientAchievement extends api.Requestable {
  constructor() {
    super({
      url: '/achievements/client',
      methods: ['POST'],
      returns: [
        { code: 204 },
        { code: 404, identifier: 'unknown-achievement' },
      ],
      schema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'The id of the achievement type which should be marked.'
          }
        },
        required: ['name']
      },
      writing: true,
      description: 'Mark a client-side achievement as completed.',
      depends: ['AchievementListProvider']
    });
  }
  
  handle(query, ctx, cfg, verified) {
    debug('Entering client-side achievement', query.name, verified);
    
    if (this.load('AchievementListProvider').getClientAchievementList().map(a => a.name)
      .indexOf(query.name) === -1)
    {
      throw new this.ClientError('unknown-achievement');
    }
    
    return ctx.query('REPLACE INTO achievements_client (uid, achname, verified) VALUES(?, ?, ?)',
      [ctx.user.uid, query.name, verified ? 1 : 0]).then(() => {
      return this.load('PubSub').publish('clientside-achievement', {srcuser: ctx.user.uid, name: query.name});
    }).then(() => ({ code: 204 }));
  }
}

class ClientDLAchievement extends api.Requestable {
  constructor() {
    super({
      url: '/achievements/client/daily-login-submit',
      methods: ['POST'],
      returns: [
        { code: 200 }
      ],
      schema: {
        type: 'object',
        properties: {
          certs: {
            type: 'array',
            items: { type: 'string' },
            uniqueItems: true,
            description: 'A list of activity certificates.'
          }
        },
        required: ['certs']
      },
      writing: true,
      description: 'Mark a client-side daily login achievement as completed.',
      depends: ['SignedMessaging', ClientAchievement]
    });
  }
  
  handle(query, ctx, cfg) {
    const uid = ctx.user.uid;

    return Promise.all(query.certs.map(cert => 
      this.load('SignedMessaging').verifySignedMessage(cert, cfg.DLAValidityDays * 24 * 60 * 60)
    )).then(verifiedCerts => {
      const dates = verifiedCerts
        .filter(c => c && c.uid === uid && c.certType === 'wasOnline')
        .map(c => moment.tz(c.date, 'YYYY-MM-DD', cfg.timezone))
        .sort((a, b) => a.isBefore(b) ? -1 : +1); // ascending sort
      
      let currentStreak = 1;
      let longestStreak = 1;
      for (let i = 1; i < dates.length; ++i) {
        if (dates[i-1].clone().add(1, 'day').isSame(dates[i])) {
          ++currentStreak;
        } else {
          currentStreak = 1;
        }
        
        longestStreak = Math.max(longestStreak, currentStreak);
      }
      
      // range(2, min(ls, 20)+1)
      return [...Array(Math.min(longestStreak, 20) + 1).keys()].slice(2).map(i => {
        return () => {
          return this.load(ClientAchievement).handle({name: 'DAILY_LOGIN_DAYS_' + i}, ctx, cfg, true);
        };
      }).reduce((a,b) => Promise.resolve(a).then(b), Promise.resolve()).then(() => {
        return { code: 200, streak: longestStreak };
      });
    });
  }
}

exports.components = [
  Achievements,
  ListAllAchievements,
  GetDailyLoginCertificate,
  ClientAchievement,
  ClientDLAchievement
];
