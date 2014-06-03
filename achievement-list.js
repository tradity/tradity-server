(function () { "use strict";

var _ = require('underscore');
var assert = require('assert');

var AchievementList = [];

var dailyLoginAchievements = _.range(2,21); 

for (var i = 0; i < dailyLoginAchievements.length; ++i) {
	(function() {
		var count = dailyLoginAchievements[i];
		var prevCount = i == 0 ? null : dailyLoginAchievements[i-1];
		
		AchievementList.push({
			name: 'DAILY_LOGIN_DAYS_' + count,
			fireOn: { 'client-get-user-info': function (ev, db, cb) {
				var lf = ev.query.lookfor;
				cb((lf && parseInt(lf) == lf ? [parseInt(lf)] : []).concat(ev.user ? [ev.user.id] : []));
			} },
			xp: 30 + 10 * count,
			check: function(uid, userAchievements, cfg, db, cb) {
				db.query('SELECT MAX(daycount) AS maxdaycount FROM ' +
					'(SELECT @s := IF(t - @r = 0, 0, @s+1) AS daycount, @r := t FROM ' +
						'(SELECT time, MAX(ticks) AS t ' +
						'FROM valuehistory WHERE userid = ? GROUP BY FLOOR(time/86400)) AS dayticks, ' +
					'(SELECT @r := 0, @s := 0) AS cbase) AS dx', [uid],
					function(res) { cb(res[0].maxdaycount >= count); });
			},
			version: 0,
			prereqAchievements: prevCount ? [ 'DAILY_LOGIN_DAYS_' + prevCount ] : []
		});
	})();
}

var tradeCountAchievements = {1: 100, 2: 0, 5: 250, 10: 500, 25: 500, 50: 700, 100: 1000, 250: 1200};
var tcaKeys = _.keys(tradeCountAchievements);

for (var i = 0; i < tcaKeys.length; ++i) {
	(function() {
		var count = tcaKeys[i];
		var prevCount = i == 0 ? null : tcaKeys[i-1];
		
		AchievementList.push({
			name: 'TRADE_COUNT_' + count,
			fireOn: { 'feed-trade': function (ev, db, cb) { cb([ev.srcuser]); } },
			xp: tradeCountAchievements[count],
			check: function(uid, userAchievements, cfg, db, cb) {
				db.query('SELECT COUNT(*) AS tradecount FROM orderhistory WHERE userid = ?', [uid],
					function(res) { cb(res[0].tradecount >= count); });
			},
			version: 0,
			prereqAchievements: prevCount ? [ 'TRADE_COUNT_' + prevCount ] : []
		});
	})();
}

var followerTradeCountAchievements = {1: 200, 5: 400, 25: 750, 50: 1250};
var ftcaKeys = _.keys(followerTradeCountAchievements);

for (var i = 0; i < ftcaKeys.length; ++i) {
	(function() {
		var count = ftcaKeys[i];
		var prevCount = i == 0 ? null : ftcaKeys[i-1];
		
		AchievementList.push({
			name: 'TRADE_FOLLOWER_COUNT_' + count,
			fireOn: { 'feed-trade': function (ev, db, cb) { cb([ev.srcuser]); } },
			xp: followerTradeCountAchievements[count],
			check: function(uid, userAchievements, cfg, db, cb) {
				db.query('SELECT COUNT(*) AS tradecount FROM orderhistory WHERE userid = ? AND leader IS NOT NULL', [uid],
					function(res) { cb(res[0].tradecount >= count); });
			},
			version: 0,
			prereqAchievements: prevCount ? [ 'TRADE_FOLLOWER_COUNT_' + prevCount ] : []
		});
	})();
}

var referralCountAchievements = {1: 100, 3: 200, 5: 300, 10: 500, 20: 750, 30: 1000, 50: 1500, 75: 2000, 100: 2500, 222: 3333};
var rcaKeys = _.keys(referralCountAchievements);

for (var i = 0; i < rcaKeys.length; ++i) {
	(function() {
		var count = rcaKeys[i];
		var prevCount = i == 0 ? null : rcaKeys[i-1];
		
		AchievementList.push({
			name: 'REFERRAL_COUNT_' + count,
			fireOn: {
				'feed-user-register': function(ev, db, cb) {
					db.query('SELECT il.uid AS invitor ' +
						'FROM inviteaccept AS ia ' +
						'JOIN invitelink AS il ON il.id = ia.iid ' +
						'WHERE ia.uid = ?', [ev.srcuser], function(res) {
						assert.ok(res.length <= 1);
						cb(res.length == 0 ? [] : [res[0].invitor]);
					});
				}
			},
			xp: referralCountAchievements[count],
			check: function(uid, userAchievements, cfg, db, cb) {
				db.query('SELECT SUM((SELECT COUNT(*) > 0 FROM orderhistory AS oh WHERE oh.userid = ia.uid)) AS invitecount ' +
					'FROM invitelink AS il ' +
					'JOIN inviteaccept AS ia ON il.id = ia.iid ' +
					'WHERE il.uid = ?', [uid], function(res) {
					assert.equal(res.length, 1);
					
					return res[0].invitecount >= count;
				});
			},
			version: 0,
			prereqAchievements: prevCount ? [ 'REFERRAL_COUNT_' + prevCount ] : []
		});
	})();
}

var commentCountAchievements = [[1, 1, 50], [5, 2, 150], [15, 10, 250], [50, 25, 750], [100, 50, 1001], [5, 1, 50]];

for (var i = 0; i < commentCountAchievements.length; ++i) {
	(function() {
		var counts = commentCountAchievements[i];
		var prevCounts = null;
		for (var j = 0; j < commentCountAchievements.length; ++j) {
			var p = commentCountAchievements[j];
			if (p[0] < counts[0] && p[1] <= counts[1])
				prevCounts = p;
		}
		
		counts = counts.slice(0, 2);
		prevCounts = prevCounts ? prevCounts.slice(0, 2) : null;
		
		AchievementList.push({
			name: 'COMMENT_COUNT_' + counts.join('_'),
			fireOn: { 'feed-comment': function (ev, db, cb) { cb([ev.srcuser]); } },
			xp: commentCountAchievements[i][2],
			check: function(uid, userAchievements, cfg, db, cb) {
				db.query('SELECT COUNT(eventid) AS c, COUNT(DISTINCT eventid) AS cd FROM `ecomments` WHERE commenter = ? ' +
					'AND (SELECT type FROM events WHERE events.eventid=ecomments.eventid) != "chat-start"', [uid], function(res) {
					assert.equal(res.length, 1);
					
					return res[0].c >= counts[0] && res[0].dc >= counts[1];
				});
			},
			version: 0,
			prevCounts: prevCounts ? [ 'COMMENT_COUNT_' + prevCounts.join('_') ] : []
		});
	})();
}

AchievementList.push({
	name: 'CHAT_PARTICIPANTS_5',
	fireOn: {
		'feed-chat-start': function (ev, db, cb) { cb(ev.endpoints); },
		'feed-chat-user-added': function (ev, db, cb) { cb(_.union([ev.addedUser], _.pluck(ev.endpoints, 'uid'))); }
	},
	xp: 400,
	check: function(uid, userAchievements, cfg, db, cb) {
		db.query('SELECT MAX((SELECT COUNT(*) FROM chatmembers WHERE chatid = cm.chatid)) AS membercount FROM `chatmembers` AS cm WHERE userid = ?', [uid],
			function(res) { cb(res[0].membercount >= 5); });
	},
	version: 0
});

AchievementList.push({
	name: 'TRADE_VOLUME_25K',
	fireOn: { 'feed-trade': function (ev, db, cb) { cb([ev.srcuser]); } },
	xp: 100,
	check: function(uid, userAchievements, cfg, db, cb) {
		db.query('SELECT COUNT(*) AS tradecount FROM orderhistory WHERE userid = ? AND money >= 250000000', [uid],
			function(res) { cb(res[0].tradecount >= 1); });
	},
	version: 0,
	prereqAchievements: ['TRADE_COUNT_1']
});

AchievementList.push({
	name: 'TRADE_STOCKNAME_AZ',
	fireOn: { 'feed-trade': function (ev, db, cb) { cb([ev.srcuser]); } },
	xp: 250,
	check: function(uid, userAchievements, cfg, db, cb) {
		db.query('SELECT COUNT(*) AS tradecount FROM orderhistory WHERE userid = ? AND stockname LIKE "A%"', [uid], function(resA) {
			if (resA[0].tradecount == 0) 
				return cb(false);
			db.query('SELECT COUNT(*) AS tradecount FROM orderhistory WHERE userid = ? AND stockname LIKE "Z%"', [uid], function(resZ) {
				cb(resZ[0].tradecount > 0) 
			});
		});
	},
	version: 0,
	prereqAchievements: ['TRADE_COUNT_1']
});

AchievementList.push({
	name: 'TRADE_STOCKNAME_AZ',
	fireOn: { 'feed-trade': function (ev, db, cb) { cb([ev.srcuser]); } },
	xp: 100,
	check: function(uid, userAchievements, cfg, db, cb) {
		db.query('SELECT COUNT(*) AS tradecount FROM orderhistory WHERE userid = ? AND stockname LIKE "A%"', [uid], function(resA) {
			if (resA[0].tradecount == 0) 
				return cb(false);
			db.query('SELECT COUNT(*) AS tradecount FROM orderhistory WHERE userid = ? AND stockname LIKE "Z%"', [uid], function(resZ) {
				cb(resZ[0].tradecount > 0) 
			});
		});
	},
	version: 0,
	prereqAchievements: ['TRADE_COUNT_2']
});

AchievementList.push({
	name: 'TRADE_SPLIT_BUY',
	fireOn: { 'feed-trade': function (ev, db, cb) { cb([ev.srcuser]); } },
	xp: 250,
	check: function(uid, userAchievements, cfg, db, cb) {
		db.query('SELECT COUNT(*) AS tradecount FROM orderhistory WHERE userid = ? AND amount > 0 AND prevamount > 0', [uid],
			function(res) { cb(res[0].tradecount > 0); });
	},
	version: 0,
	prereqAchievements: ['TRADE_COUNT_2']
});

AchievementList.push({
	name: 'TRADE_SPLIT_SELL',
	fireOn: { 'feed-trade': function (ev, db, cb) { cb([ev.srcuser]); } },
	xp: 250,
	check: function(uid, userAchievements, cfg, db, cb) {
		db.query('SELECT COUNT(*) AS tradecount FROM orderhistory WHERE userid = ? AND amount < 0 AND amount != -prevamount', [uid], 
			function(res) { cb(res[0].tradecount > 0); });
	},
	version: 0,
	prereqAchievements: ['TRADE_COUNT_2']
});

AchievementList.push({
	name: 'TRADE_RESELL_1H',
	fireOn: { 'trade': function (ev, db, cb) { cb([ev.srcuser]); } },
	xp: 100,
	check: function(uid, userAchievements, cfg, db, cb) {
		db.query('SELECT COUNT(*) AS tradecount ' + 
			'FROM orderhistory AS o1 ' +
			'JOIN orderhistory AS o2 ON o1.userid = o2.userid AND ' +
				'o1.stocktextid = o2.stocktextid AND ' +
				'o1.buytime < o2.buytime AND o1.buytime > o2.buytime - 3600 '+
			'WHERE o1.userid = ?', [uid], 
			function(res) { cb(res[0].tradecount > 0); });
	},
	version: 0,
	prereqAchievements: ['TRADE_COUNT_2']
});

AchievementList.push({
	name: 'TRADE_RESELL_10D',
	fireOn: { 'trade': function (ev, db, cb) { cb([ev.srcuser]); } },
	xp: 500,
	check: function(uid, userAchievements, cfg, db, cb) {
		db.query('SELECT COUNT(*) AS tradecount ' + 
			'FROM orderhistory AS o1 ' +
			'JOIN orderhistory AS o2 ON o1.userid = o2.userid AND ' +
				'o1.stocktextid = o2.stocktextid AND ' +
				'o1.buytime < o2.buytime - 864000 '+
			'WHERE o1.userid = ?', [uid], 
			function(res) { cb(res[0].tradecount > 0); });
	},
	version: 0,
	prereqAchievements: ['TRADE_COUNT_2']
});

AchievementList.push({
	name: 'LEADER_PROFILE_IMAGE',
	fireOn: { 'feed-file-publish': function (ev, db, cb) { cb([ev.srcuser]); } },
	xp: 150,
	check: function(uid, userAchievements, cfg, db, cb) {
		db.query('SELECT COUNT(*) AS imgcount FROM httpresources WHERE user = ? AND role = "profile.image"', [uid], 
			function(res) { cb(res[0].imgcount > 1); });
	},
	version: 0
});

AchievementList.push({
	name: 'LEADER_WPROV_CHANGE',
	fireOn: { 'feed-user-provchange': function (ev, db, cb) { cb([ev.srcuser]); } },
	xp: 100,
	check: function(uid, userAchievements, cfg, db, cb) {
		db.query('SELECT wprovision FROM users WHERE id = ?', [uid], function(res) {
			assert.equal(res.length, 1);
			cb(res[0].wprovision != cfg.defaultWProvision);
		});
	},
	version: 0
});

AchievementList.push({
	name: 'LEADER_LPROV_CHANGE',
	fireOn: { 'feed-user-provchange': function (ev, db, cb) { cb([ev.srcuser]); } },
	xp: 100,
	check: function(uid, userAchievements, cfg, db, cb) {
		db.query('SELECT lprovision FROM users WHERE id = ?', [uid], function(res) {
			assert.equal(res.length, 1);
			cb(res[0].lprovision != cfg.defaultLProvision);
		});
	},
	version: 0
});

AchievementList.push({
	name: 'LEADER_DESC_CHANGE',
	fireOn: { 'feed-user-descchange': function (ev, db, cb) { cb([ev.srcuser]); } },
	xp: 150,
	check: function(uid, userAchievements, cfg, db, cb) {
		db.query('SELECT `desc` FROM users WHERE id = ?', [uid], function(res) {
			assert.equal(res.length, 1);
			cb(res[0].desc != '');
		});
	},
	version: 0
});

exports.AchievementList = AchievementList;

})();
