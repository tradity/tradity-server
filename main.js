(function () { "use strict";

var _ = require('underscore');
var util = require('util');
var events = require('events');
var assert = require('assert');
var fs = require('fs');
var crypto = require('crypto');

var cfg = require('./config.js').config;
var bus = require('./bus.js');
var buscomponent = require('./buscomponent.js');

var usr = require('./user.js');
var adm = require('./admin.js');
var sch = require('./schools.js');
var ach = require('./achievements.js');
var feedctrl = require('./feed.js');
var stocks = require('./stocks.js');
var fsdb = require('./fsdb.js');
var dqueries = require('./dqueries.js');
var eh_ = require('./errorhandler.js');
var db_ = require('./dbbackend.js');
var af = require('./arivafinance.js');
var misc = require('./misc.js');
var emailsender = require('./emailsender.js');
var server = require('./server.js');
var AchievementList = require('./achievement-list.js').AchievementList;

crypto.randomBytes(64, _.bind(function(ex, buf) {
var authorizationKey = buf.toString('hex');
fs.writeFileSync(cfg['auth-key-file'], authorizationKey, {mode: 432});

var afql = new af.ArivaFinanceQuoteLoader();

var mainBus = new bus.Bus();

mainBus.on('getServerConfig', function(req) { req.reply(cfg); });
mainBus.on('getAuthorizationKey', function(req) { req.reply(authorizationKey); });

var eh = new eh_.ErrorHandler().setBus(mainBus, 'errorhandling');
var MailerDB = new emailsender.MailerDB().setBus(mainBus, 'mailer');
var db = new db_.Database().setBus(mainBus, 'db');
var FeedControllerDB = new feedctrl.FeedControllerDB().setBus(mainBus, 'feed');
var UserDB = new usr.UserDB().setBus(mainBus, 'user');
var AdminDB = new adm.AdminDB().setBus(mainBus, 'admin');
var SchoolsDB = new sch.SchoolsDB().setBus(mainBus, 'schools');
var StocksDB = new stocks.StocksDB(afql).setBus(mainBus, 'stocks');
var FileStorageDB = new fsdb.FileStorageDB().setBus(mainBus, 'fsdb');
var AchievementsDB = new ach.AchievementsDB().setBus(mainBus, 'achievements');
var dqDB = new dqueries.DelayedQueriesDB().setBus(mainBus, 'dqueries');
var MiscDB = new misc.MiscDB().setBus(mainBus, 'misc');

AchievementsDB.registerAchievements(AchievementList);

afql.on('error', function(e) { eh.err(e); });

process.on('uncaughtException', function(err) {
	eh.err(err);
	
	setTimeout(function() {
		process.exit(1);
	}, 1000);
});

var stserver = new server.SoTradeServer().setBus(mainBus, 'serverMaster');
stserver.start();

}, this));
})();
