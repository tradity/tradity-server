(function () { "use strict";

var _ = require('lodash');
var Q = require('q');
var util = require('util');
var assert = require('assert');
var qctx = require('./qctx.js');
var buscomponent = require('./stbuscomponent.js');

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
function Achievements () {
	Achievements.super_.apply(this, arguments);
	
	this.achievementList = [];
	this.clientAchievements = [];
};

util.inherits(Achievements, buscomponent.BusComponent);

Achievements.prototype.onBusConnect = function() {
	var self = this;
	
	return self.request({name: 'getAchievementList'}).then(function(al) {
		assert.ok(al);
		return self.registerAchievements(al);
	}).then(function() {
		return self.request({name: 'getClientAchievementList'});
	}).then(function(al) {
		assert.ok(al);
		self.clientAchievements = al;
		return self.markClientAchievements();
	});
};

/**
 * Checks the achievements for the current user for having been completed.
 * 
 * @param {module:qctx~QContext} ctx  A QContext to provide database access and user information.
 * 
 * @function busreq~sellAll
 */
Achievements.prototype.checkAchievements = buscomponent.provide('checkAchievements', ['ctx', 'reply'], function(ctx, cb) {
	var self = this;
	
	if (ctx.getProperty('readonly'))
		return cb();
	
	return ctx.query('SELECT * FROM achievements WHERE userid = ?', [ctx.user.id]).then(function(userAchievements) {
		return Q.all(self.achievementList.map(function(achievementEntry) {
			return self.checkAchievement(achievementEntry, ctx, userAchievements);
		})).then(cb);
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
 * @property {int} userid  The numerical id of the user who completed the achievement.
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
	var self = this;
	
	if (!ctx.user)
		return;
	
	var uid = ctx.user.id;
	assert.equal(uid, parseInt(uid));
	assert.ok(!uid.splice);
	
	uid = parseInt(uid);
	
	return self.getServerConfig().then(function(cfg) {
		if (userAchievements_)
			return userAchievements_;
		
		var lookfor = achievementEntry.requireAchievementInfo;
		lookfor = _.union(lookfor, [achievementEntry.name]); // implicit .uniq
		
		return ctx.query('SELECT * FROM achievements ' +
			'WHERE userid = ? AND achname IN (' + _.map(lookfor, _.constant('?')).join(',') + ')',
			[uid].splice(0).concat(lookfor));
	}).then(function(userAchievements) {
		userAchievements = _.chain(userAchievements).map(function(a) { return [a.achname, a]; }).object().value();
		
		if (userAchievements[achievementEntry.name]) {
			var dbver = userAchievements[achievementEntry.name].version;
			if (dbver > achievementEntry.version)
				self.emitError(new Error('Version mismatch for achievement ' + userAchievements[achievementEntry.name] + ' vs ' + achievementEntry.version));
			
			if (dbver >= achievementEntry.version)
				return;
		}
	
		if (_.difference(achievementEntry.prereqAchievements, _.keys(userAchievements)).length > 0)
			return; // not all prereqs fulfilled
		
		return Q(
			(_.intersection(achievementEntry.implicatingAchievements, _.keys(userAchievements)).length > 0) ?
				true : 
				achievementEntry.check(uid, userAchievements, cfg, ctx)
		).then(function(hasBeenAchieved) {
			if (!hasBeenAchieved)
				return;
			
			return ctx.query('REPLACE LOW_PRIORITY INTO achievements (userid, achname, xp, version) VALUES (?, ?, ?, ?)', 
				[uid, achievementEntry.name, achievementEntry.xp, achievementEntry.version]).then(function(res) {
				return ctx.feed({
					type: 'achievement',
					srcuser: uid,
					targetid: res.insertId
				});
			}).then(function()  {
				return Q.all(self.achievementList.map(function(ae) {
					// look for achievements of which we have changed the prereq/implicating achievements list
					if (_.union(ae.implicatingAchievements, ae.prereqAchievements).indexOf(achievementEntry.name) == -1)
						return -1;
					
					return self.checkAchievement(ae, ctx);
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
	var self = this;
	
	var ctx = new qctx.QContext({parentComponent: self});

	return _.each(achievementEntry.fireOn, function(checkCallback, eventName) {
		self.on(eventName, function(data) {
			return Q(_.bind(checkCallback, achievementEntry)(data, ctx)).then(function(userIDs) {
				assert.ok(userIDs);
				assert.notEqual(typeof userIDs.length, 'undefined');
				
				return Q.all(_.map(userIDs, function(uid) {
					return self.checkAchievement(achievementEntry, new qctx.QContext({user: {id: uid, uid: uid}, parentComponent: self}));
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
		
		self.registerObservers(achievementEntry);
	});
	
	return self.markClientAchievements();
};

/**
 * Sets the <code>isClientAchievement</code> flag on all achievement type entries
 * which have been listed as client-side achievements.
 * 
 * @function module:achievements~Achievements#markClientAchievements
 */
Achievements.prototype.markClientAchievements = function() {
	var self = this;
	
	_.each(self.achievementList, function(ach) {
		ach.isClientAchievement = (self.clientAchievements.indexOf(ach.name) != -1);
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
Achievements.prototype.listAchievements = buscomponent.provideQT('client-list-all-achievements', function(query, ctx, cb) {
	return cb('list-all-achievements-success', {result: this.achievementList});
});

/**
 * Return a string to the user that can be used for verifying that
 * they have been active on a given day.
 * 
 * @return {object}  Returns with <code>get-daily-login-certificate-success</code>
 *                   and sets <code>.cert</code> appropiately.
 * 
 * @function c2s~get-daily-login-certificate
 */
Achievements.prototype.getDailyLoginCertificate = buscomponent.provideWQT('client-get-daily-login-certificate',
	function(query, ctx, cb)
{
	var today = new Date().toJSON().substr(0, 10);
	
	this.request({name: 'createSignedMessage', msg: {
		uid: ctx.user.id,
		date: today,
		certType: 'wasOnline'
	}}).then(function(cert) {
		return cb('get-daily-login-certificate-success', {cert: cert});
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
 * @function c2s~achievements
 */
Achievements.prototype.clientAchievement = buscomponent.provideW('client-achievement',
	['query', 'ctx', 'verified', 'reply'],
	function(query, ctx, verified, cb)
{
	var self = this;
	cb = function(data) { return data; };
	
	if (!query.name)
		return cb('format-error');
	
	query.name = String(query.name);
	
	if (self.clientAchievements.indexOf(query.name) == -1)
		return cb('achievement-unknown-name');
	
	return ctx.query('REPLACE LOW_PRIORITY INTO achievements_client (userid, achname, verified) VALUES(?, ?, ?)',
		[ctx.user.id, query.name, verified || 0]).then(function()
	{
		self.emitImmediate('clientside-achievement', {srcuser: ctx.user.id, name: query.name});
		
		return cb('achievement-success');
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
Achievements.prototype.clientDLAchievement = buscomponent.provideWQT('client-dl-achievement', function(query, ctx, cb) {
	var self = this;
	var uid = ctx.user.id;
	
	if (!query.certs || !query.certs.map)
		return cb('format-error');
	
	Q.all(query.certs.map(function(cert) {
		return self.request({
			name: 'verifySignedMessage',
			maxAge: 100 * 24 * 60 * 60,
			msg: cert
		}).then(function(verifCert) {
			return verifCert;
		});
	})).then(function(verifiedCerts) {
		var dates = verifiedCerts
			.map(function(c) { return c[0]; })
			.filter(function(c) { return c && c.uid == uid && c.certType == 'wasOnline'; })
			.map(function(c) { return new Date(c.date); })
			.sort(function(a, b) { return a.getTime() - b.getTime(); }); // ascending sort
		
		var currentStreak = 1;
		var longestStreak = 1;
		for (var i = 1; i < dates.length; ++i) {
			// not beautiful, but works
			if (dates[i].getTime() - dates[i-1].getTime() == 86400000)
				++currentStreak;
			else
				currentStreak = 1;
			
			longestStreak = Math.max(longestStreak, currentStreak);
		}
		
		return Q.all(_.range(2, Math.min(longestStreak, 20) + 1).map(function(i) {
			return self.clientAchievement({name: 'DAILY_LOGIN_DAYS_' + i}, ctx, 1);
		})).then(function() {
			return cb('dl-achievement-success');
		});
	});
});

exports.Achievements = Achievements;

})();
