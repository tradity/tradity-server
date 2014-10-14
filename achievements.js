(function () { "use strict";

var _ = require('underscore');
var util = require('util');
var assert = require('assert');
var qctx = require('./qctx.js');
var buscomponent = require('./bus/buscomponent.js');

function AchievementsDB () {
	this.achievementList = [];
	this.clientAchievements = [];
};

util.inherits(AchievementsDB, buscomponent.BusComponent);

AchievementsDB.prototype.onBusConnect = function() {
	var self = this;
	
	self.request({name: 'getAchievementList'}, function(al) {
		assert.ok(al);
		self.registerAchievements(al);
	});
	
	self.request({name: 'getClientAchievementList'}, function(al) {
		assert.ok(al);
		self.clientAchievements = al;
		self.markClientAchievements();
	});
};

AchievementsDB.prototype.checkAchievements = buscomponent.provide('checkAchievements', ['ctx', 'reply'], function(ctx, cb) {
	var self = this;
	
	ctx.query('SELECT * FROM achievements WHERE userid = ?', [ctx.user.id], function(userAchievements) {
		_.each(self.achievementList, function(achievementEntry) {
			self.checkAchievement(achievementEntry, ctx, userAchievements);
		});
		
		cb();
	});
});

AchievementsDB.prototype.checkAchievement = function(achievementEntry, ctx, userAchievements_) {
	var self = this;
	
	assert.ok(ctx.user);
	
	var uid = ctx.user.id;
	assert.equal(uid, parseInt(uid));
	assert.ok(!uid.splice);
	
	uid = parseInt(uid);
	
	self.getServerConfig(function(cfg) {
	
	(userAchievements_ ? function(cont) {
		cont(userAchievements_);
	} : function(cont) {
		var lookfor = achievementEntry.requireAchievementInfo;
		lookfor = _.union(lookfor, [achievementEntry.name]); // implicit .uniq
		
		ctx.query('SELECT * FROM achievements WHERE userid = ? AND achname IN (' + _.map(lookfor, _.constant('?')).join(',') + ')',
			[uid].splice(0).concat(lookfor), cont);
	})(function(userAchievements) {
		userAchievements = _.chain(userAchievements).map(function(a) { return [a.achname, a]; }).object().value();
		
		if (userAchievements[achievementEntry.name]) {
			var dbver = userAchievements[achievementEntry.name].version;
			if (dbver > achievementEntry.version)
				self.emit('error', new Error('Version mismatch for achievement ' + userAchievements[achievementEntry.name] + ' vs ' + achievementEntry.version));
			
			if (dbver >= achievementEntry.version)
				return;
		}
	
		if (_.difference(achievementEntry.prereqAchievements, _.keys(userAchievements)).length > 0)
			return; // not all prereqs fulfilled
		
		(
			(_.intersection(achievementEntry.implicatingAchievements, _.keys(userAchievements)).length > 0) ?
				function(uid, userAchievements, ctx, cb) { cb(true); } : 
				_.bind(achievementEntry.check, achievementEntry)
		)(uid, userAchievements, cfg, ctx, function(hasBeenAchieved) {
			if (!hasBeenAchieved)
				return;
			
			ctx.query('REPLACE INTO achievements (userid, achname, xp, version) VALUES (?, ?, ?, ?)', 
				[uid, achievementEntry.name, achievementEntry.xp, achievementEntry.version], function(res) {
				ctx.feed({
					type: 'achievement',
					srcuser: uid,
					targetid: res.insertId,
					json: {
						achname: achievementEntry.name,
						xp: achievementEntry.xp
					}
				});
				
				process.nextTick(function() {
					_.each(self.achievementList, function(ae) {
						// look for achievements of which we have changed the prereq/implicating achievements list
						if (_.union(ae.implicatingAchievements, ae.prereqAchievements).indexOf(achievementEntry.name) == -1)
							return -1;
						
						self.checkAchievement(ae, ctx);
					});
				});
			});
		});
	});
	
	});
};

AchievementsDB.prototype.registerObserver = function(achievementEntry) {
	var self = this;
	
	var ctx = new qctx.QContext({parentComponent: self});

	_.each(achievementEntry.fireOn, function(checkCallback, eventName) {
		self.on(eventName, function(data) {
			_.bind(checkCallback, achievementEntry)(data, ctx, function(userIDs) {
				assert.ok(userIDs);
				assert.notEqual(typeof userIDs.length, 'undefined');
				
				_.each(userIDs, function(uid) {
					self.checkAchievement(achievementEntry, new qctx.QContext({user: {id: uid, uid: uid}, parentComponent: self}));
				});
			});
		});
	});
};

AchievementsDB.prototype.registerAchievements = function(list) {
	var self = this;
	
	list = _.map(list, function(achievementEntry) {
		var e = _.defaults(achievementEntry, {
			requireAchievementInfo: [],
			prereqAchievements: [],
			implicatingAchievements: []
		});
		
		e.requireAchievementInfo = _.union(e.requireAchievementInfo, e.prereqAchievements, e.implicatingAchievements);
		
		return e;
	});
	
	self.achievementList = self.achievementList.concat(list);
	
	_.each(list, function(achievementEntry) {
		assert.notStrictEqual(achievementEntry.version, null);
		
		self.registerObserver(achievementEntry);
	});
	
	self.markClientAchievements();
};

AchievementsDB.prototype.markClientAchievements = function(list) {
	var self = this;
	
	_.each(self.achievementList, function(ach) {
		ach.isClientAchievement = (self.clientAchievements.indexOf(ach.name) != -1);
	});
};

AchievementsDB.prototype.listAchievements = buscomponent.provideQT('client-list-all-achievements', function(query, ctx, cb) {
	cb('list-all-achievements-success', {result: this.achievementList});
}),

AchievementsDB.prototype.clientAchievement = buscomponent.provideQT('client-achievement', function(query, ctx, cb) {
	var self = this;
	
	if (query.name)
		query.name = query.name.toString();
	
	if (!query.name)
		return cb('format-error');
	
	if (self.clientAchievements.indexOf(query.name) == -1)
		return cb('achievement-unknown-name');
	
	ctx.query('REPLACE INTO achievements_client (userid, achname) VALUES(?, ?)', [ctx.user.id, query.name], function() {
		self.emit('clientside-achievement', {srcuser: ctx.user.id, name: query.name});
		
		cb('achievement-success');
	});
});

exports.AchievementsDB = AchievementsDB;

})();
