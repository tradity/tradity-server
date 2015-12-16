(function () { "use strict";

var _ = require('lodash');
var util = require('util');
var assert = require('assert');
var qctx = require('./qctx.js');
var debug = require('debug')('sotrade:achievements');
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
class Achievements extends buscomponent.BusComponent {
	constructor() {
		super();
		
		this.achievementList = [];
		this.clientAchievements = [];
	}
}

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
 * @function busreq~checkAchievements
 */
Achievements.prototype.checkAchievements = buscomponent.provide('checkAchievements', ['ctx'], function(ctx) {
	var self = this;
	
	debug('Checking achievements for current user');
	
	if (ctx.getProperty('readonly'))
		return;
	
	return ctx.query('SELECT * FROM achievements WHERE uid = ?', [ctx.user.uid]).then(function(userAchievements) {
		return Promise.all(self.achievementList.map(function(achievementEntry) {
			return self.checkAchievement(achievementEntry, ctx, userAchievements);
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
	var self = this;
	
	if (!ctx.user)
		return;
	
	var uid = ctx.user.uid;
	assert.equal(uid, parseInt(uid));
	assert.ok(!uid.splice);
	
	uid = parseInt(uid);
	
	var cfg;
	return self.getServerConfig().then(function(cfg_) {
		cfg = cfg_;
		
		if (userAchievements_)
			return userAchievements_;
		
		var lookfor = achievementEntry.requireAchievementInfo;
		lookfor = _.union(lookfor, [achievementEntry.name]); // implicit .uniq
		
		return ctx.query('SELECT * FROM achievements ' +
			'WHERE uid = ? AND achname IN (' + _.map(lookfor, _.constant('?')).join(',') + ')',
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
		
		return Promise.resolve(
			(_.intersection(achievementEntry.implicatingAchievements, _.keys(userAchievements)).length > 0) ?
				true : 
				achievementEntry.check(uid, userAchievements, cfg, ctx)
		).then(function(hasBeenAchieved) {
			assert.equal(typeof hasBeenAchieved, 'boolean');
			if (!hasBeenAchieved)
				return;
			
			return ctx.query('REPLACE INTO achievements (uid, achname, xp, version) VALUES (?, ?, ?, ?)', 
				[uid, achievementEntry.name, achievementEntry.xp, achievementEntry.version]).then(function(res) {
				if (res.affectedRows != 1)
					return;
				
				debug('Give achievement to user', uid, achievementEntry);
				
				// REPLACE INTO actually created a row
				return ctx.feed({
					type: 'achievement',
					srcuser: uid,
					targetid: res.insertId
				});
			}).then(function()  {
				return Promise.all(self.achievementList.map(function(ae) {
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
			return Promise.resolve(_.bind(checkCallback, achievementEntry)(data, ctx)).then(function(userIDs) {
				assert.ok(userIDs);
				assert.notEqual(typeof userIDs.length, 'undefined');
				
				return Promise.all(_.map(userIDs, function(uid) {
					return self.checkAchievement(achievementEntry, new qctx.QContext({user: {uid: uid}, parentComponent: self}));
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
Achievements.prototype.listAchievements = buscomponent.provideQT('client-list-all-achievements', function(query, ctx) {
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
	var today = new Date().toJSON().substr(0, 10);
	
	if (query.today) {
		if (!ctx.access.has('achievements'))
			throw new this.PermissionDenied();
		
		today = String(query.today);
	}
	
	debug('Signing daily login certificate', ctx.user.uid, today);
	return this.request({name: 'createSignedMessage', msg: {
		uid: ctx.user.uid,
		date: today,
		certType: 'wasOnline'
	}}).then(function(cert) {
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
	var self = this;
	
	if (!query.name)
		throw new self.FormatError();
	
	query.name = String(query.name);
	
	if (self.clientAchievements.indexOf(query.name) == -1)
		throw new self.SoTradeClientError('achievement-unknown-name');
	
	return ctx.query('REPLACE INTO achievements_client (uid, achname, verified) VALUES(?, ?, ?)',
		[ctx.user.uid, query.name, verified || 0]).then(function()
	{
		self.emitImmediate('clientside-achievement', {srcuser: ctx.user.uid, name: query.name});
		
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
	var self = this;
	var uid = ctx.user.uid;
	
	if (!query.certs || !query.certs.map)
		throw new self.FormatError();
		
	return self.getServerConfig().then(function(cfg) {
		return Promise.all(query.certs.map(function(cert) {
			return self.request({
				name: 'verifySignedMessage',
				maxAge: cfg.DLAValidityDays * 24 * 60 * 60,
				msg: cert
			});
		}));
	}).then(function(verifiedCerts) {
		var dates = verifiedCerts
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
		
		return _.range(2, Math.min(longestStreak, 20) + 1).map(function(i) {
			return function() {
				return self.clientAchievement({name: 'DAILY_LOGIN_DAYS_' + i}, ctx, 1);
			};
		}).reduce(Q.when, Promise.resolve()).then(function() {
			return { code: 'dl-achievement-success', streak: longestStreak };
		});
	});
});

exports.Achievements = Achievements;

})();
