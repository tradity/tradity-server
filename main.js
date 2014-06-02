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

var afql = new af.ArivaFinanceQuoteLoader();

afql.on('error', function(e) { mainBus.emit('error', e); });

var bwpid = null;

var mainBus = new bus.Bus();
var manager = new buscomponent.BusComponent();
manager.getServerConfig = buscomponent.provide('getServerConfig', ['reply'], function(reply) { reply(cfg); });
manager.getAuthorizationKey = buscomponent.provide('getAuthorizationKey', ['reply'], function(reply) { reply(authorizationKey); });
manager.getStockQuoteLoader = buscomponent.provide('getStockQuoteLoader', ['reply'], function(reply) { reply(afql); });
manager.getAchievementList = buscomponent.provide('getAchievementList', ['reply'], function(reply) { reply(achievementList.AchievementList); });
manager.getBackgroundWorkerPID = buscomponent.provide('getBackgroundWorkerPID', ['reply'], function(reply) { if (cluster.isMaster) reply(bwpid); });
manager.setBus(mainBus);

process.on('uncaughtException', function(err) {
	mainBus.emit('error', err);
	mainBus.emit('localShutdown');
});

var forwardSignals = ['SIGTERM', 'SIGINT'];
for (var i = 0; i < forwardSignals.length; ++i) {
	process.on(forwardSignals[i], function() { mainBus.emit('globalShutdown'); });
}

var sharedEvents = [
	'globalShutdown', 'getServerStatistics', 'pushServerStatistics',
	'getBackgroundWorkerPID',
	// dqueries + prod
	'stock-update', 'client-prod', 'neededStocksDQ', 
	'client-dquery-list', 'client-dquery-remove', 'client-dquery', 'dqueriesResetUser'
];

sharedEvents = _.union(sharedEvents, _.map(sharedEvents, function(e) { return e + '-resp'; }));

var authorizationKey;

if (cluster.isWorker) {
	authorizationKey = fs.readFileSync(cfg['auth-key-file']).toString('ascii');
	
	process.on('message', function(msg) {
		if (msg.evdata._originPID == process.pid)
			return;
		
		if (sharedEvents.indexOf(msg.evname) != -1)
			mainBus.emit(msg.evname, msg.evdata);
	});
	
	for (var i = 0; i < sharedEvents.length; ++i) { (function() {
		var evname = sharedEvents[i];
		mainBus.on(evname, function(data) {
			data = data || {};
			if (!data._originPID)
				data._originPID = process.pid;
			
			process.send({evname: evname, evdata: data});
		});
	})(); }
	
	mainBus.request({name: 'getBackgroundWorkerPID'}, function(p) {
		worker(p == process.pid);
	});
} else {
	assert.ok(cluster.isMaster);
	
	authorizationKey = crypto.randomBytes(64).toString('hex');

	fs.writeFileSync(cfg['auth-key-file'], authorizationKey, {mode: 432});
	
	var numWorkers = cfg.clusterWorkers || Math.max(Math.round(os.cpus().length * 3 / 4), 1);
	var workers = [];
	
	var forkBackgroundWorker = function() {
		var bw = cluster.fork();
		workers.push(bw);
		bwpid = bw.process.pid;
		assert.ok(bwpid);
	}
	
	forkBackgroundWorker();
	for (var i = 0; i < numWorkers; ++i) 
		workers.push(cluster.fork());
	
	var shuttingDown = false;
	mainBus.on('globalShutdown', function() { mainBus.emit('localShutdown'); });
	mainBus.on('localShutdown', function() { shuttingDown = true; });
	
	cluster.on('exit', function(worker, code, signal) {
		console.warn('worker ' + worker.process.pid + ' died with code ' + code + ', signal ' + signal + ' shutdown state ' + shuttingDown);
		
		if (!shuttingDown) {
			console.log('respawning');
			
			if (worker.process.pid == bwpid)
				forkBackgroundWorker();
			else 
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
	
	for (var i = 0; i < sharedEvents.length; ++i) { (function() {
		var evname = sharedEvents[i];
		mainBus.on(evname, function(data) {
			data = data || {};
			
			if (!data._originPID)
				data._originPID = process.pid;
			data._seenByMaster = true;
			
			for (var j = 0; j < workers.length; ++j) {
				if (workers[j].state != 'dead')
					workers[j].send({evname: evname, evdata: data});
			}
		});
	})(); }
}

function worker(isBackgroundWorker) {
	var loadComponents = [
		'./errorhandler.js', './emailsender.js', './dbbackend.js', './feed.js', './template-loader.js', './stocks.js', './user.js'
	].concat(isBackgroundWorker ? [
		'./background-worker.js', './dqueries.js'
	] : [
		'./admin.js', './schools.js', './fsdb.js', './achievements.js', './misc.js'
	]);

	for (var i = 0; i < loadComponents.length; ++i) {
		var c = require(loadComponents[i]);
		for (var j in c) 
			if (c[j] && c[j].prototype.setBus)
				new c[j]().setBus(mainBus, loadComponents[i].replace(/\.[^.]+$/, '').replace(/[^\w]/g, ''));
	}

	var server = require('./server.js');
	var stserver = new server.SoTradeServer().setBus(mainBus, 'serverMaster');
	
	if (isBackgroundWorker) {
		console.log('bw started');
	} else {
		stserver.start();
	}
}

})();
