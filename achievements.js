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
const qctx = require('./qctx.js');
const debug = require('debug')('sotrade:achievements');
const buscomponent = require('./stbuscomponent.js');

/**
 * Achievement checking and awarding system.
 * 
 * @public
 * @module achievements
 */

/**
 * Main entry point of {@link module:achievements}
 * 
 * @property {module:achievement-list~AchievementType[]} achievementList  List of avaiable achievements.
 * @property {string[]} clientAchievements  List of ids of achievements which are complete
 *                            solely on the client side.
 * 
 * @public
 * @constructor module:achievements~Achievements
 * @augments module:stbuscomponent~STBusComponent
 */
class Achievements extends buscomponent.BusComponent {
  constructor() {
    super();
    
    this.achievementList = [];
    this.clientAchievements = [];
  }
}

Achievements.prototype.onBusConnect = function() {
  return this.request({name: 'getAchievementList'}).then(al => {
    assert.ok(al);
    return this.registerAchievements(al);
  }).then(() => {
    return this.request({name: 'getClientAchievementList'});
  }).then(al => {
    assert.ok(al);
    this.clientAchievements = al;
    return this.markClientAchievements();
  });
};

/**
 * Checks the achievements for the current user for having been completed.
 * 
 * @param {module:qctx~QContext} ctx  A QContext to provide database access and user information.
 * 
 * @function busreq~checkAchievements
 */
Achievements.prototype.checkAchievements = buscomponent.provide('checkAchievements', ['ctx'], function(ctx) {
  debug('Checking achievements for current user', ctx.user.uid);
  
  if (ctx.getProperty('readonly')) {
    return;
  }
  
  return ctx.query('SELECT * FROM achievements WHERE uid = ?', [ctx.user.uid]).then(userAchievements => {
    return Promise.all(this.achievementList.map(achievementEntry => {
      return this.checkAchievement(achievementEntry, ctx, userAchievements);
    }));
  });
});

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
 * 
 * @function module:achievements~Achievements#checkAchievement
 */
Achievements.prototype.checkAchievement = function(achievementEntry, ctx, userAchievements_) {
  if (!ctx.user) {
    return;
  }
  
  let uid = ctx.user.uid;
  debug('Checking achievement for user', achievementEntry.name, uid);
  
  assert.equal(uid, parseInt(uid));
  assert.ok(!uid.splice);
  
  uid = parseInt(uid);
  
  let cfg;
  return this.getServerConfig().then(cfg_ => {
    cfg = cfg_;
    
    if (userAchievements_) {
      return userAchievements_;
    }
    
    let lookfor = achievementEntry.requireAchievementInfo;
    lookfor = _.union(lookfor, [achievementEntry.name]); // implicit .uniq
    
    return ctx.query('SELECT * FROM achievements ' +
      'WHERE uid = ? AND achname IN (' + lookfor.map(() => '?').join(',') + ')',
      [uid].splice(0).concat(lookfor));
  }).then(userAchievements => {
    userAchievements = _.chain(userAchievements).map(a => [a.achname, a]).zipObject().value();
    
    if (userAchievements[achievementEntry.name]) {
      const dbver = userAchievements[achievementEntry.name].version;
      if (dbver > achievementEntry.version) {
        this.emitError(new Error('Version mismatch for achievement ' + userAchievements[achievementEntry.name] + ' vs ' + achievementEntry.version));
      }
      
      if (dbver >= achievementEntry.version) {
        return;
      }
    }
  
    if (_.difference(achievementEntry.prereqAchievements, _.keys(userAchievements)).length > 0) {
      return; // not all prereqs fulfilled
    }
    
    return Promise.resolve(
      (_.intersection(achievementEntry.implicatingAchievements, _.keys(userAchievements)).length > 0) ?
        true : 
        achievementEntry.check(uid, userAchievements, cfg, ctx)
    ).then(hasBeenAchieved => {
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
          if (_.union(ae.implicatingAchievements, ae.prereqAchievements).indexOf(achievementEntry.name) === -1) {
            return -1;
          }
          
          return this.checkAchievement(ae, ctx);
        }));
      });
    });
  });
};

/**
 * Registers all <code>fireOn</code> handlers for an achievement type.
 * 
 * @param {module:achievement-list~AchievementType} achievementEntry  The achievement type for which
 *                                                                    event listeners will be installed.
 * 
 * @function module:achievements~Achievements#registerObservers
 */
Achievements.prototype.registerObservers = function(achievementEntry) {
  const ctx = new qctx.QContext({parentComponent: this});

  return _.each(achievementEntry.fireOn, (checkCallback, eventName) => {
    this.on(eventName, (data) => {
      return Promise.resolve(checkCallback.call(achievementEntry, data, ctx)).then(userIDs => {
        assert.ok(userIDs);
        assert.notEqual(typeof userIDs.length, 'undefined');
        
        return Promise.all(userIDs.map(uid => {
          return this.checkAchievement(achievementEntry, new qctx.QContext({user: {uid: uid}, parentComponent: this}));
        }));
      });
    });
  });
};

/**
 * Load and setup achievement types.
 * 
 * @param {module:achievement-list~AchievementType[]} list  The list of added achievement types.
 * 
 * @function module:achievements~Achievements#registerAchievements
 */
Achievements.prototype.registerAchievements = function(list) {
  list = list.map(achievementEntry => {
    const e = _.defaults(achievementEntry, {
      requireAchievementInfo: [],
      prereqAchievements: [],
      implicatingAchievements: []
    });
    
    e.requireAchievementInfo = _.union(e.requireAchievementInfo, e.prereqAchievements, e.implicatingAchievements);
    
    return e;
  });
  
  this.achievementList = this.achievementList.concat(list);
  
  list.forEach(achievementEntry => {
    assert.notStrictEqual(achievementEntry.version, null);
    
    this.registerObservers(achievementEntry);
  });
  
  return this.markClientAchievements();
};

/**
 * Sets the <code>isClientAchievement</code> flag on all achievement type entries
 * which have been listed as client-side achievements.
 * 
 * @function module:achievements~Achievements#markClientAchievements
 */
Achievements.prototype.markClientAchievements = function() {
  return this.achievementList.map(ach => {
    return ach.isClientAchievement = (this.clientAchievements.indexOf(ach.name) !== -1);
  });
};

/**
 * Lists all achievement types.
 * 
 * @return {object}  Returns with <code>list-all-achievements-success</code> and sets
 *                   <code>.results</code> to a {module:achievement-list~AchievementType[]}.
 * 
 * @function c2s~list-all-achievements
 */
Achievements.prototype.listAchievements = buscomponent.provideQT('client-list-all-achievements', function() {
  return { code: 'list-all-achievements-success', result: this.achievementList };
});

/**
 * Return a string to the user that can be used for verifying that
 * they have been active on a given day.
 * 
 * @param {string} [query.today]  If executed with appropiate privileges,
 *                                sets the date for the certificate.
 * 
 * @return {object}  Returns with <code>get-daily-login-certificate-success</code>
 *                   and sets <code>.cert</code> appropiately.
 * 
 * @function c2s~get-daily-login-certificate
 */
Achievements.prototype.getDailyLoginCertificate = buscomponent.provideWQT('client-get-daily-login-certificate',
  function(query, ctx)
{
  let today = new Date().toJSON().substr(0, 10);
  
  if (query.today) {
    if (!ctx.access.has('achievements')) {
      throw new this.PermissionDenied();
    }
    
    today = String(query.today);
  }
  
  debug('Signing daily login certificate', ctx.user.uid, today);
  return this.request({name: 'createSignedMessage', msg: {
    uid: ctx.user.uid,
    date: today,
    certType: 'wasOnline'
  }}).then(cert => {
    return { code: 'get-daily-login-certificate-success', cert: cert };
  });
});

/**
 * Mark a client-side achievement as completed.
 * 
 * @param {string} query.name  The id of the achievement type which should be marked.
 * 
 * @return {object}  Returns with <code>achievement-unknown-name</code>,
 *                   <code>achievement-success</code> or a common error code.
 * 
 * @function c2s~achievement
 */
Achievements.prototype.clientAchievement = buscomponent.provideW('client-achievement',
  ['query', 'ctx', 'verified'],
  function(query, ctx, verified)
{
  if (!query.name) {
    throw new this.FormatError();
  }
  
  query.name = String(query.name);
  
  if (this.clientAchievements.indexOf(query.name) === -1) {
    throw new this.SoTradeClientError('achievement-unknown-name');
  }
  
  return ctx.query('REPLACE INTO achievements_client (uid, achname, verified) VALUES(?, ?, ?)',
    [ctx.user.uid, query.name, verified || 0]).then(() =>
  {
    this.emitImmediate('clientside-achievement', {srcuser: ctx.user.uid, name: query.name});
    
    return { code: 'achievement-success' };
  });
});

/**
 * Mark a client-side daily login achievement as completed.
 * 
 * @param {string} query.certs  A list of activity certificates.
 * 
 * @return {object}  Returns with <code>dl-achievement-success</code>
 *                   or a common error code.
 * 
 * @function c2s~dl-achievement
 */
Achievements.prototype.clientDLAchievement = buscomponent.provideWQT('client-dl-achievement', function(query, ctx) {
  const uid = ctx.user.uid;
  
  if (!query.certs || !query.certs.map) {
    throw new this.FormatError();
  }
    
  return this.getServerConfig().then(cfg => {
    return Promise.all(query.certs.map(cert => {
      return this.request({
        name: 'verifySignedMessage',
        maxAge: cfg.DLAValidityDays * 24 * 60 * 60,
        msg: cert
      });
    }));
  }).then(verifiedCerts => {
    const dates = verifiedCerts
      .filter(c => c && c.uid === uid && c.certType === 'wasOnline')
      .map(c => new Date(c.date))
      .sort((a, b) => a.getTime() - b.getTime()); // ascending sort
    
    let currentStreak = 1;
    let longestStreak = 1;
    for (let i = 1; i < dates.length; ++i) {
      // not beautiful, but works
      if (dates[i].getTime() - dates[i-1].getTime() === 86400000) {
        ++currentStreak;
      } else {
        currentStreak = 1;
      }
      
      longestStreak = Math.max(longestStreak, currentStreak);
    }
    
    return _.range(2, Math.min(longestStreak, 20) + 1).map(i => {
      return () => {
        return this.clientAchievement({name: 'DAILY_LOGIN_DAYS_' + i}, ctx, 1);
      };
    }).reduce((a,b) => Promise.resolve(a).then(b), Promise.resolve()).then(() => {
      return { code: 'dl-achievement-success', streak: longestStreak };
    });
  });
});

exports.Achievements = Achievements;
