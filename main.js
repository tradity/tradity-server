(function () { "use strict";

var _ = require('underscore');
var assert = require('assert');
var fs = require('fs');
var crypto = require('crypto');

var cfg = require('./config.js').config;
var bus = require('./bus.js');
var buscomponent = require('./buscomponent.js');

var af = require('./arivafinance.js');
var achievementList = require('./achievement-list.js');

crypto.randomBytes(64, _.bind(function(ex, buf) {
var authorizationKey = buf.toString('hex');
fs.writeFileSync(cfg['auth-key-file'], authorizationKey, {mode: 432});

var afql = new af.ArivaFinanceQuoteLoader();
var mainBus = new bus.Bus();

afql.on('error', function(e) { mainBus.emit('error', e); });
mainBus.on('getServerConfig', function(req) { req.reply(cfg); });
mainBus.on('getAuthorizationKey', function(req) { req.reply(authorizationKey); });
mainBus.on('getStockQuoteLoader', function(req) { req.reply(afql); });
mainBus.on('getAchievementList', function(req) { req.reply(achievementList.AchievementList); });

var loadComponents = [
	'./errorhandler.js', './emailsender.js', './dbbackend.js', './feed.js', './user.js', './admin.js', 
	'./schools.js', './stocks.js', './fsdb.js', './achievements.js', './dqueries.js', './misc.js'
];

for (var i = 0; i < loadComponents.length; ++i) {
	var c = require(loadComponents[i]);
	for (var j in c) 
		if (c[j] && c[j].prototype.setBus) 
			new c[j]().setBus(mainBus, loadComponents[i].replace(/\.[^.]+$/, '').replace(/[^\w]/g, ''));
}

process.on('uncaughtException', function(err) {
	mainBus.emit('error', err);
	mainBus.emit('shutdown');
});

var forwardSignals = ['SIGTERM', 'SIGINT'];
for (var i = 0; i < forwardSignals.length; ++i) {
	process.on(forwardSignals[i], function() { mainBus.emit('shutdown'); });
}

var server = require('./server.js');
var stserver = new server.SoTradeServer().setBus(mainBus, 'serverMaster');
stserver.start();

}, this));
})();
