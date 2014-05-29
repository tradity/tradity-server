(function () { "use strict";

var _ = require('underscore');
var assert = require('assert');
var fs = require('fs');
var crypto = require('crypto');
var os = require('os');
var cluster = require('cluster');

var cfg = require('./config.js').config;
var bus = require('./bus.js');
var buscomponent = require('./buscomponent.js');

var af = require('./arivafinance.js');
var achievementList = require('./achievement-list.js');

var mainBus = new bus.Bus();

mainBus.on('getServerConfig', function(req) { req.reply(cfg); });
mainBus.on('getAuthorizationKey', function(req) { req.reply(authorizationKey); });

process.on('uncaughtException', function(err) {
	mainBus.emit('error', err);
	mainBus.emit('shutdown');
});

var forwardSignals = ['SIGTERM', 'SIGINT'];
for (var i = 0; i < forwardSignals.length; ++i) {
	process.on(forwardSignals[i], function() { mainBus.emit('shutdown'); });
}

var sharedEvents = ['shutdown'];

var authorizationKey;

if (cluster.isWorker) {
	authorizationKey = fs.readFileSync(cfg['auth-key-file']).toString('ascii');
	
	process.on('message', function(msg) {
		if (msg.evdata._originPID == process.pid)
			return;
		
		if (sharedEvents.indexOf(msg.evname) != -1)
			mainBus.emit(msg.evname, msg.evdata);
	});
	
	for (var i = 0; i < sharedEvents.length; ++i) {
		var evname = sharedEvents[i];
		mainBus.on(evname, function(data) {
			data = data || {};
			if (!data._originPID)
				data._originPID = process.pid;
			
			process.send({evname: evname, evdata: data});
		});
	}
	
	worker();
} else {
	assert.ok(cluster.isMaster);
	
	authorizationKey = crypto.randomBytes(64).toString('hex');

	fs.writeFileSync(cfg['auth-key-file'], authorizationKey, {mode: 432});
	
	if (cfg.cluster) {
		var numWorkers = cfg.clusterWorkers || Math.max(Math.round(os.cpus().length * 3 / 4), 1);
		var workers = [];
		
		for (var i = 0; i < numWorkers; ++i) 
			workers.push(cluster.fork());
			
		var shuttingDown = false;
		mainBus.on('shutdown', function() {
			shuttingDown = true;
		});
		
		cluster.on('exit', function(worker, code, signal) {
			console.warn('worker ' + worker.process.pid + ' died with code ' + code + ', signal ' + signal + ' shutdown state ' + shuttingDown);
			
			if (!shuttingDown) {
				console.log('respawning');
				workers.push(cluster.fork());
			}
		});
		
		for (var i = 0; i < workers.length; ++i) { 
			workers[i].on('message', function(msg) {
				if (msg.evdata._originPID == process.pid || msg.evdata._seenByMaster)
					return;
				
				if (sharedEvents.indexOf(msg.evname) != -1)
					mainBus.emit(msg.evname, msg.evdata);
			});
		}
		
		for (var i = 0; i < sharedEvents.length; ++i) {
			var evname = sharedEvents[i];
			mainBus.on(evname, function(data) {
				data = data || {};
				
				if (!data._originPID)
					data._originPID = process.pid;
				data._seenByMaster = true;
				
				for (var j = 0; j < workers.length; ++j)
					workers[j].send({evname: evname, evdata: data});
			});
		}
	} else {
		worker();
	}
}

function worker() {
	var afql = new af.ArivaFinanceQuoteLoader();

	afql.on('error', function(e) { mainBus.emit('error', e); });
	mainBus.on('getStockQuoteLoader', function(req) { req.reply(afql); });
	mainBus.on('getAchievementList', function(req) { req.reply(achievementList.AchievementList); });

	var loadComponents = [
		'./errorhandler.js', './emailsender.js', './dbbackend.js', './feed.js', './user.js', './admin.js', 
		'./schools.js', './stocks.js', './fsdb.js', './achievements.js', './dqueries.js', './misc.js', './template-loader.js'
	];

	for (var i = 0; i < loadComponents.length; ++i) {
		var c = require(loadComponents[i]);
		for (var j in c) 
			if (c[j] && c[j].prototype.setBus)
				new c[j]().setBus(mainBus, loadComponents[i].replace(/\.[^.]+$/, '').replace(/[^\w]/g, ''));
	}

	var server = require('./server.js');
	var stserver = new server.SoTradeServer().setBus(mainBus, 'serverMaster');
	stserver.start();
}

})();
