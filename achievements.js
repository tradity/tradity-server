(function () { "use strict";

var _ = require('underscore');
var util = require('util');
var assert = require('assert');
var buscomponent = require('./buscomponent.js');

function AchievementsDB () {
	this.achievementList = [];
};

util.inherits(AchievementsDB, buscomponent.BusComponent);

AchievementsDB.prototype.checkAchievements = buscomponent.provide('checkAchievements', ['user'], function(user) {
	this.query('SELECT * FROM achievements WHERE userid = ?', [user.id], function(userAchievements) {
		_.each(this.achievementList, _.bind(function(achievementEntry) {
			this.checkAchievement(achievementEntry, user.id, userAchievements);
		}, this));
	});
});

AchievementsDB.prototype.checkAchievement = function(achievementEntry, uid, userAchievements_) {
	this.getServerConfig(function(cfg) {
	
	(userAchievements_ ? function(cont) {
		cont(userAchievements_);
	} : _.bind(function(cont) {
		var lookfor = achievementEntry.requireAchievementInfo;
		lookfor = _.union(lookfor, [achievementEntry.name]); // implicit .uniq
		
		this.query('SELECT * FROM achievements WHERE userid = ? AND achname IN (' + _.map(lookfor, _.constant('?')).join(',') + ')',
			[uid].splice(0).concat(lookfor), cont);
	}, this))(_.bind(function(userAchievements) {
		userAchievements = _.chain(userAchievements).map(function(a) { return [a.achname, a]; }).object().value();
		
		if (userAchievements[achievementEntry.name]) {
			var dbver = userAchievements[achievementEntry.name].version;
			if (dbver > achievementEntry.version)
				this.emit('error', new Error('Version mismatch for achievement ' + userAchievements[achievementEntry.name] + ' vs ' + achievementEntry.version));
			
			if (dbver >= achievementEntry.version)
				return;
		}
		
		this.locked(achievementEntry.checkLocks, null, function(cb) {
			if (_.difference(achievementEntry.prereqAchievements, _.keys(userAchievements)).length > 0)
				return; // not all prereqs fulfilled
			
			(
				(_.intersection(achievementEntry.implicatingAchievements, _.keys(userAchievements)).length > 0) ?
					function(uid, userAchievements, db, cb) { cb(true); } : 
					_.bind(achievementEntry.check, achievementEntry)
			)(uid, userAchievements, cfg, this, _.bind(function(hasBeenAchieved) {
				if (!hasBeenAchieved)
					return;
				
				this.query('REPLACE INTO achievements (userid, 	achname, xp, version) VALUES (?, ?, ?, ?)', 
					[uid, achievementEntry.name, achievementEntry.xp, achievementEntry.version], function(res) {
					this.feed({
						type: 'achievement',
						srcuser: uid,
						targetid: res.insertId,
						json: {
							achname: achievementEntry.name,
							xp: achievementEntry.xp
						}
					});
					
					process.nextTick(_.bind(function() {
						_.each(this.achievementList, _.bind(function(ae) {
							// look for achievements of which we have changed the prereq/implicating achievements list
							if (_.union(ae.implicatingAchievements, ae.prereqAchievements).indexOf(achievementEntry.name) == -1)
								return -1;
							
							this.checkAchievement(ae, uid);
						}, this));
					}, this));
				});
			}, this));
		});
	}, this));
	
	});
};

AchievementsDB.prototype.registerObserver = function(achievementEntry) {
	_.each(achievementEntry.fireOn, _.bind(function(checkCallback, eventName) {
		this.on(eventName, _.bind(function(data) {
			_.bind(checkCallback, achievementEntry)(data, this, _.bind(function(userIDs) {
				_.each(userIDs, _.bind(function(uid) {
					this.checkAchievement(achievementEntry, uid);
				}, this));
			}, this));
		}, this));
	}, this));
};

AchievementsDB.prototype.registerAchievements = function(list) {
	list = _.map(list, function(achievementEntry) {
		var e = _.defaults(achievementEntry, {
			checkLocks: [],
			requireAchievementInfo: [],
			prereqAchievements: [],
			implicatingAchievements: []
		});
		
		e.requireAchievementInfo = _.union(e.requireAchievementInfo, e.prereqAchievements, e.implicatingAchievements);
		
		return e;
	});
	
	this.achievementList = this.achievementList.concat(list);
	
	_.each(list, _.bind(function(achievementEntry) {
		this.registerObserver(achievementEntry);
	}, this));
};

exports.AchievementsDB = AchievementsDB;

})();
