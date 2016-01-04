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
/*jshint unused:false */

const _ = require('lodash');
const assert = require('assert');

/**
 * Provides the list of all game achievements.
 * 
 * @public
 * @module achievement-list
 */

/**
 * Represents a single type of achievement.
 * 
 * @typedef module:achievement-list~AchievementType
 * @type object
 * 
 * @property {string} name  An unique achievement id.
 * @property {object} fireOn  An associative array of [bus event] -> [callback]
 *                            entries. When the specified bus event is emitted,
 *                            the callback will be called with the event, a
 *                            {@link module:qctx~QContext} and a second callback,
 *                            the latter receiving a list of numerical user ids.
 *                            The users in this list are then checked for having
 *                            completed the achievement successfully.
 * @property {int} xp  The amount XP to award to the user.
 * @property {function} check  A callback to determine whether the user has completed
 *                             this achievement. The parameters are
 *                             a numerical user id, an [achievement id] -> achievement map
 *                             for the user, the server config, a {@link module:qctx~QContext}
 *                             and a callback which will be called with a boolean indicating
 *                             the check result.
 * @property {int} version  A version for this achievement type.
 *                          This can be used for easier re-checking of achievements after
 *                          changes to the achievement type.
 * @property {string[]} prereqAchievements  Achievements that a user has to have before being able
 *                                          to achieve this one.
 * @property {string[]} implicatingAchievements Achievements that, when awarded to a user, imply that
 *                                              they have completed this achievement.
 * @property {string} category  A category identifier for this achievement type.
 */
 
/**
 * Array of all currently available game achievements.
 * 
 * @constant {module:achievement-list~AchievementType[]} module:achievement-list~AchievementTypeList
 */

const AchievementList = [];

const tradeCountAchievements = {1: 100, 2: 0, 5: 250, 10: 350, 25: 500, 50: 700, 100: 1000, 250: 1200};
const tcaKeys = Object.keys(tradeCountAchievements);

for (let i = 0; i < tcaKeys.length; ++i) {
  const count = tcaKeys[i];
  const prevCount = i === 0 ? null : tcaKeys[i-1];
  
  AchievementList.push({
    name: 'TRADE_COUNT_' + count,
    fireOn: { 'feed-trade': (ev, ctx) => [ev.srcuser] },
    xp: tradeCountAchievements[count],
    check: (uid, userAchievements, cfg, ctx) => {
      return ctx.query('SELECT COUNT(*) AS tradecount FROM orderhistory WHERE uid = ?', [uid])
        .then(res => (res[0].tradecount >= count));
    },
    version: 0,
    prereqAchievements: prevCount ? [ 'TRADE_COUNT_' + prevCount ] : [],
    category: 'TRADING'
  });
}

const followerTradeCountAchievements = {1: 200, 5: 400, 25: 750, 50: 1250};
const ftcaKeys = Object.keys(followerTradeCountAchievements);

for (let i = 0; i < ftcaKeys.length; ++i) {
  const count = ftcaKeys[i];
  const prevCount = i === 0 ? null : ftcaKeys[i-1];
  
  AchievementList.push({
    name: 'TRADE_FOLLOWER_COUNT_' + count,
    fireOn: { 'feed-trade': (ev, ctx) => [ev.srcuser] },
    xp: followerTradeCountAchievements[count],
    check: (uid, userAchievements, cfg, ctx) => {
      return ctx.query('SELECT COUNT(*) AS tradecount FROM orderhistory WHERE uid = ? AND leader IS NOT NULL', [uid])
        .then(res => (res[0].tradecount >= count));
    },
    version: 0,
    prereqAchievements: prevCount ? [ 'TRADE_FOLLOWER_COUNT_' + prevCount ] : [],
    category: 'FOLLOWER'
  });
}

const leaderTradeCountAchievements = {1: 200, 5: 400, 10: 750, 50: 1250};
const ltcaKeys = Object.keys(leaderTradeCountAchievements);

for (let i = 0; i < ltcaKeys.length; ++i) {
  const count = ltcaKeys[i];
  const prevCount = i === 0 ? null : ltcaKeys[i-1];
  
  AchievementList.push({
    name: 'LEADER_TRADED_COUNT_' + count,
    fireOn: { 'feed-trade': (ev, ctx) => ev.leader ? [ev.leader] : [] },
    xp: leaderTradeCountAchievements[count],
    check: (uid, userAchievements, cfg, ctx) => {
      return ctx.query('SELECT COUNT(*) AS tradecount FROM orderhistory WHERE leader = ?', [uid])
        .then(res => (res[0].tradecount >= count));
    },
    version: 0,
    prereqAchievements: prevCount ? [ 'LEADER_TRADED_COUNT_' + prevCount ] : [],
    category: 'LEADER'
  });
}

/*
const referralCountAchievements = {1: 100, 3: 200, 5: 300, 10: 500, 20: 750, 30: 1000, 50: 1500, 75: 2000, 100: 2500, 222: 3333};
const rcaKeys = Object.keys(referralCountAchievements);

for (let i = 0; i < rcaKeys.length; ++i) {
  const count = rcaKeys[i];
  const prevCount = i == 0 ? null : rcaKeys[i-1];
  
  AchievementList.push({
    name: 'REFERRAL_COUNT_' + count,
    fireOn: {
      'feed-user-register': (ev, ctx) => {
        return ctx.query('SELECT il.uid AS invitor ' +
          'FROM inviteaccept AS ia ' +
          'JOIN invitelink AS il ON il.iid = ia.iid ' +
          'WHERE ia.uid = ?', [ev.srcuser]).then(res => {
          assert.ok(res.length <= 1);
          return res.length == 0 ? [] : [res[0].invitor];
        });
      }
    },
    xp: referralCountAchievements[count],
    check: (uid, userAchievements, cfg, ctx) => {
      return ctx.query('SELECT SUM((SELECT COUNT(*) > 0 ' +
          'FROM orderhistory AS oh WHERE oh.uid = ia.uid)) ' +
        'AS invitecount ' +
        'FROM invitelink AS il ' +
        'JOIN inviteaccept AS ia ON il.iid = ia.iid ' +
        'WHERE il.uid = ?', [uid]).then(res => {
        assert.equal(res.length, 1);
        
        return res[0].invitecount >= count;
      });
    },
    version: 0,
    prereqAchievements: prevCount ? [ 'REFERRAL_COUNT_' + prevCount ] : [],
    category: 'SOCIAL'
  });
})();
}
*/

const commentCountAchievements = [[1, 1, 50], [3, 1, 50], [5, 2, 150], [15, 10, 250], [50, 25, 750], [100, 50, 1001]];

for (let i = 0; i < commentCountAchievements.length; ++i) {
  let counts = commentCountAchievements[i];
  let prevCounts = null;
  for (let j = 0; j < commentCountAchievements.length; ++j) {
    const p = commentCountAchievements[j];
    if (p[0] < counts[0] && p[1] <= counts[1]) {
      prevCounts = p;
    }
  }
  
  counts = counts.slice(0, 2);
  prevCounts = prevCounts ? prevCounts.slice(0, 2) : null;
  
  AchievementList.push({
    name: 'COMMENT_COUNT_' + counts.join('_'),
    fireOn: { 'feed-comment': (ev, ctx) => [ev.srcuser] },
    xp: commentCountAchievements[i][2],
    check: (uid, userAchievements, cfg, ctx) => {
      return ctx.query('SELECT COUNT(eventid) AS c, COUNT(DISTINCT eventid) AS cd FROM `ecomments` WHERE commenter = ? ' +
        'AND (SELECT type FROM events WHERE events.eventid=ecomments.eventid) != "chat-start" ' +
        'AND cstate != "mdeleted" AND cstate != "gdeleted"', [uid]).then(res => {
        assert.equal(res.length, 1);
        
        return res[0].c >= counts[0] && res[0].cd >= counts[1];
      });
    },
    version: 0,
    prereqAchievements: prevCounts ? [ 'COMMENT_COUNT_' + prevCounts.join('_') ] : [],
    category: 'SOCIAL'
  });
}

const ClientAchievements = [
  { name: 'LEARNING_GREEN_INVESTMENTS', xp: 100, requireVerified: false, category: 'LEARNING' },
  { name: 'LEARNING_LOW_INTEREST_RATES', xp: 100, requireVerified: false, category: 'LEARNING' },
  { name: 'LEARNING_WHAT_ARE_SHARES', xp: 100, requireVerified: false, category: 'LEARNING' },
  { name: 'LEARNING_TERMINOLOGY', xp: 100, requireVerified: false, category: 'LEARNING' },
  { name: 'LEARNING_OPPORTUNITIES_AND_RISKS', xp: 100, requireVerified: false, category: 'LEARNING' },
  { name: 'LEARNING_FUNDAMENTAL_ANALYSIS', xp: 100, requireVerified: false, category: 'LEARNING' },
  { name: 'LEARNING_TECHNICAL_ANALYSIS', xp: 100, requireVerified: false, category: 'LEARNING' },
];

const dailyLoginAchievements = _.range(2,21);

for (let i = 0; i < dailyLoginAchievements.length; ++i) {
  const count = dailyLoginAchievements[i];
  const prevCount = i === 0 ? null : dailyLoginAchievements[i-1];
  
  ClientAchievements.push({
    name: 'DAILY_LOGIN_DAYS_' + count,
    xp: 30 + 10 * count,
    requireVerified: true,
    category: 'SOCIAL',
    prereqAchievements: prevCount ? [ 'DAILY_LOGIN_DAYS_' + prevCount ] : [],
  });
}

for (let i = 0; i < ClientAchievements.length; ++i) {
  const achievement = ClientAchievements[i];
  
  AchievementList.push({
    name: achievement.name,
    fireOn: { 'clientside-achievement': (ev, ctx) => ev.name === achievement.name ? [ev.srcuser] : [] },
    xp: achievement.xp,
    check: (uid, userAchievements, cfg, ctx) => {
      return ctx.query('SELECT COUNT(*) AS c FROM achievements_client WHERE uid = ? AND achname = ? ' +
        (achievement.requireVerified ? 'AND verified = 1 ' : ''),
        [uid, achievement.name]).then(res => {
        assert.equal(res.length, 1);
        
        return res[0].c > 0;
      });
    },
    version: 0,
    prereqAchievements: achievement.prereqAchievements || [],
    implicatingAchievements: achievement.implicatingAchievements || [],
    category: achievement.category,
    requireVerified: achievement.requireVerified
  });
}

AchievementList.push({
  name: 'CHAT_PARTICIPANTS_5',
  fireOn: {
    'feed-chat-start': (ev, ctx) => ev.endpoints,
    'feed-chat-user-added': (ev, ctx) => _.union([ev.addedChats], _.pluck(ev.endpoints, 'uid'))
  },
  xp: 400,
  check: (uid, userAchievements, cfg, ctx) => {
    return ctx.query('SELECT MAX((SELECT COUNT(*) ' +
        'FROM chatmembers ' +
        'WHERE chatid = cm.chatid)) ' +
      'AS membercount ' +
      'FROM `chatmembers` AS cm WHERE uid = ?', [uid])
      .then(res => (res[0].membercount >= 5));
  },
  version: 0,
  category: 'SOCIAL'
});

AchievementList.push({
  name: 'TRADE_VOLUME_25K',
  fireOn: { 'feed-trade': (ev, ctx) => [ev.srcuser] },
  xp: 100,
  check: (uid, userAchievements, cfg, ctx) => {
    return ctx.query('SELECT COUNT(*) AS tradecount FROM orderhistory WHERE uid = ? AND money >= 250000000', [uid])
      .then(res => (res[0].tradecount >= 1));
  },
  version: 0,
  prereqAchievements: ['TRADE_COUNT_1'],
  category: 'TRADING'
});

AchievementList.push({
  name: 'TRADE_STOCKNAME_AZ',
  fireOn: { 'feed-trade': (ev, ctx) => [ev.srcuser] },
  xp: 100,
  check: (uid, userAchievements, cfg, ctx) => {
    return ctx.query('SELECT COUNT(*) AS tradecount FROM orderhistory WHERE uid = ? AND stockname LIKE "A%"', [uid])
      .then(resA => {
      if (resA[0].tradecount === 0) {
        return false;
      }
      
      return ctx.query('SELECT COUNT(*) AS tradecount FROM orderhistory WHERE uid = ? AND stockname LIKE "Z%"', [uid])
        .then(resZ => (resZ[0].tradecount > 0));
    });
  },
  version: 0,
  prereqAchievements: ['TRADE_COUNT_2'],
  category: 'TRADING'
});

AchievementList.push({
  name: 'TRADE_SPLIT_BUY',
  fireOn: { 'feed-trade': (ev, ctx) => [ev.srcuser] },
  xp: 250,
  check: function(uid, userAchievements, cfg, ctx) {
    return ctx.query('SELECT COUNT(*) AS tradecount FROM orderhistory WHERE uid = ? AND amount > 0 AND prevamount > 0', [uid])
      .then(res => (res[0].tradecount > 0));
  },
  version: 0,
  prereqAchievements: ['TRADE_COUNT_2'],
  category: 'TRADING'
});

AchievementList.push({
  name: 'TRADE_SPLIT_SELL',
  fireOn: { 'feed-trade': (ev, ctx) => [ev.srcuser] },
  xp: 250,
  check: (uid, userAchievements, cfg, ctx) => {
    return ctx.query('SELECT COUNT(*) AS tradecount FROM orderhistory WHERE uid = ? AND amount < 0 AND amount != -prevamount', [uid])
      .then(res => (res[0].tradecount > 0));
  },
  version: 0,
  prereqAchievements: ['TRADE_COUNT_2'],
  category: 'TRADING'
});

AchievementList.push({
  name: 'TRADE_RESELL_1H',
  fireOn: { 'trade': (ev, ctx) => [ev.srcuser] },
  xp: 100,
  check: (uid, userAchievements, cfg, ctx) => {
    return ctx.query('SELECT COUNT(*) AS tradecount ' + 
      'FROM orderhistory AS o1 ' +
      'JOIN orderhistory AS o2 ON o1.uid = o2.uid AND ' +
        'o1.stocktextid = o2.stocktextid AND ' +
        'o1.buytime < o2.buytime AND o1.buytime > o2.buytime - 3600 '+
      'WHERE o1.uid = ?', [uid])
      .then(res => (res[0].tradecount > 0));
  },
  version: 0,
  prereqAchievements: ['TRADE_COUNT_2'],
  category: 'TRADING'
});

AchievementList.push({
  name: 'TRADE_RESELL_10D',
  fireOn: { 'trade': (ev, ctx) => [ev.srcuser] },
  xp: 500,
  check: (uid, userAchievements, cfg, ctx) => {
    return ctx.query('SELECT COUNT(*) AS tradecount ' + 
      'FROM orderhistory AS o1 ' +
      'JOIN orderhistory AS o2 ON o1.uid = o2.uid AND ' +
        'o1.stocktextid = o2.stocktextid AND ' +
        'o1.buytime < o2.buytime - 864000 '+
      'WHERE o1.uid = ?', [uid])
      .then(res => (res[0].tradecount > 0));
  },
  version: 0,
  prereqAchievements: ['TRADE_COUNT_2'],
  category: 'TRADING'
});

AchievementList.push({
  name: 'LEADER_PROFILE_IMAGE',
  fireOn: { 'feed-file-publish': (ev, ctx) => [ev.srcuser] },
  xp: 150,
  check: (uid, userAchievements, cfg, ctx) => {
    return ctx.query('SELECT COUNT(*) AS imgcount FROM httpresources WHERE uid = ? AND role = "profile.image"', [uid])
      .then(res => (res[0].imgcount >= 1));
  },
  version: 0,
  category: 'LEADER'
});

AchievementList.push({
  name: 'LEADER_WPROV_CHANGE',
  fireOn: { 'feed-user-provchange': (ev, ctx) => [ev.srcuser] },
  xp: 100,
  check: (uid, userAchievements, cfg, ctx) => {
    return ctx.query('SELECT wprovision FROM users_finance WHERE uid = ?', [uid]).then(res => {
      assert.equal(res.length, 1);
      return res[0].wprovision !== cfg.defaultWProvision;
    });
  },
  version: 0,
  category: 'LEADER'
});

AchievementList.push({
  name: 'LEADER_LPROV_CHANGE',
  fireOn: { 'feed-user-provchange': (ev, ctx) => [ev.srcuser] },
  xp: 100,
  check: (uid, userAchievements, cfg, ctx) => {
    return ctx.query('SELECT lprovision FROM users_finance WHERE uid = ?', [uid]).then(res => {
      assert.equal(res.length, 1);
      return res[0].lprovision !== cfg.defaultLProvision;
    });
  },
  version: 0,
  category: 'LEADER'
});

AchievementList.push({
  name: 'LEADER_DESC_CHANGE',
  fireOn: { 'feed-user-descchange': (ev, ctx) => [ev.srcuser] },
  xp: 150,
  check: function(uid, userAchievements, cfg, ctx) {
    return ctx.query('SELECT `desc` FROM users_data WHERE uid = ?', [uid]).then(res => {
      assert.equal(res.length, 1);
      return res[0].desc !== '';
    });
  },
  version: 0,
  category: 'LEADER'
});

exports.AchievementList = AchievementList;
exports.ClientAchievements = _.pluck(ClientAchievements, 'name');
