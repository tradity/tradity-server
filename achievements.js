(function () { "use strict";

var _ = require('underscore');
var util = require('util');
var assert = require('assert');
var qctx = require('./qctx.js');
var buscomponent = require('./buscomponent.js');

function AchievementsDB () {
	this.achievementList = [];
	this.clientAchievements = [];
};

util.inherits(AchievementsDB, buscomponent.BusComponent);

AchievementsDB.prototype.onBusConnect = function() {
	this.request({name: 'getAchievementList'}, function(al) {
		assert.ok(al);
		this.registerAchievements(al);
	});
	
	this.request({name: 'getClientAchievementList'}, function(al) {
		assert.ok(al);
		this.clientAchievements = al;
		this.markClientAchievements();
	});
};

AchievementsDB.prototype.checkAchievements = buscomponent.provide('checkAchievements', ['ctx', 'reply'], function(ctx, cb) {
	ctx.query('SELECT * FROM achievements WHERE userid = ?', [ctx.user.id], function(userAchievements) {
		_.each(this.achievementList, _.bind(function(achievementEntry) {
			this.checkAchievement(achievementEntry, ctx, userAchievements);
		}, this));
		
		cb();
	});
});

AchievementsDB.prototype.checkAchievement = function(achievementEntry, uid, userAchievements_) {
	assert.ok(ctx.user);
	
	var uid = ctx.user.id;
	assert.equal(uid, parseInt(uid));
	assert.ok(!uid.splice);
	
	uid = parseInt(uid);
	
	this.getServerConfig(function(cfg) {
	
	(userAchievements_ ? function(cont) {
		cont(userAchievements_);
	} : _.bind(function(cont) {
		var lookfor = achievementEntry.requireAchievementInfo;
		lookfor = _.union(lookfor, [achievementEntry.name]); // implicit .uniq
		
		ctx.query('SELECT * FROM achievements WHERE userid = ? AND achname IN (' + _.map(lookfor, _.constant('?')).join(',') + ')',
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
	
		if (_.difference(achievementEntry.prereqAchievements, _.keys(userAchievements)).length > 0)
			return; // not all prereqs fulfilled
		
		(
			(_.intersection(achievementEntry.implicatingAchievements, _.keys(userAchievements)).length > 0) ?
				function(uid, userAchievements, db, cb) { cb(true); } : 
				_.bind(achievementEntry.check, achievementEntry)
		)(uid, userAchievements, cfg, this, _.bind(function(hasBeenAchieved) {
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
				
				process.nextTick(_.bind(function() {
					_.each(this.achievementList, _.bind(function(ae) {
						// look for achievements of which we have changed the prereq/implicating achievements list
						if (_.union(ae.implicatingAchievements, ae.prereqAchievements).indexOf(achievementEntry.name) == -1)
							return -1;
						
						this.checkAchievement(ae, ctx);
					}, this));
				}, this));
			});
		}, this));
	}, this));
	
	});
};

AchievementsDB.prototype.registerObserver = function(achievementEntry) {
	_.each(achievementEntry.fireOn, _.bind(function(checkCallback, eventName) {
		this.on(eventName, _.bind(function(data) {
			_.bind(checkCallback, achievementEntry)(data, this, _.bind(function(userIDs) {
				assert.ok(userIDs);
				assert.notEqual(typeof userIDs.length, 'undefined');
				
				_.each(userIDs, _.bind(function(uid) {
					this.checkAchievement(achievementEntry, new qctx.QContext({user: {id: uid, uid: uid}, parentComponent: this}));
				}, this));
			}, this));
		}, this));
	}, this));
};

AchievementsDB.prototype.registerAchievements = function(list) {
	list = _.map(list, function(achievementEntry) {
		var e = _.defaults(achievementEntry, {
			requireAchievementInfo: [],
			prereqAchievements: [],
			implicatingAchievements: []
		});
		
		e.requireAchievementInfo = _.union(e.requireAchievementInfo, e.prereqAchievements, e.implicatingAchievements);
		
		return e;
	});
	
	this.achievementList = this.achievementList.concat(list);
	
	_.each(list, _.bind(function(achievementEntry) {
		assert.notStrictEqual(achievementEntry.version, null);
		
		this.registerObserver(achievementEntry);
	}, this));
	
	this.markClientAchievements();
};

AchievementsDB.prototype.markClientAchievements = function(list) {
	_.each(this.achievementList, _.bind(function(ach) {
		ach.isClientAchievement = (this.clientAchievements.indexOf(ach.name) != -1);
	}, this));
};

AchievementsDB.prototype.listAchievements = buscomponent.provideQT('client-list-all-achievements', function(query, ctx, cb) {
	cb('list-all-achievements-success', {result: this.achievementList});
}),

AchievementsDB.prototype.clientAchievement = buscomponent.provideQT('client-achievement', function(query, ctx, cb) {
	if (query.name)
		query.name = query.name.toString();
	
	if (!query.name)
		return cb('format-error');
	
	if (this.clientAchievements.indexOf(query.name) == -1)
		return cb('achievement-unknown-name');
	
	ctx.query('REPLACE INTO achievements_client (userid, achname) VALUES(?, ?)', [ctx.user.id, query.name], function() {
		this.emit('clientside-achievement', {srcuser: ctx.user.id, name: query.name});
		
		cb('achievement-success');
	});
});

exports.AchievementsDB = AchievementsDB;

})();
