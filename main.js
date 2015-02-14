(function () { "use strict";

var _ = require('lodash');
var assert = require('assert');
var fs = require('fs');
var crypto = require('crypto');
var os = require('os');
var https = require('https');
var cluster = require('cluster');
var Q = require('q');

var qctx = require('./qctx.js');
var cfg = require('./config.js').config;
var bus = require('./bus/bus.js');
var buscomponent = require('./stbuscomponent.js');
var pt = require('./bus/processtransport.js');
var dt = require('./bus/directtransport.js');
var sio = require('socket.io-client');

var af = require(cfg.stockloader.path);
var achievementList = require('./achievement-list.js');

/**
 * Main entry point of this software.
 * This manages – mostly – initial setup, loading modules and
 * coordinating workers. But honestly, the code has grown
 * somewhat unstructured and should be refactored before larger
 * modifications are made to it.
 * 
 * @module main
 */

var bwpid = null;

Error.stackTraceLimit = cfg.stackTraceLimit || 20;
Q.longStackSupport = cfg.longStackTraces || false;

var mainBus = new bus.Bus();
var manager = new buscomponent.BusComponent();

mainBus.addInputFilter(function(packet) {
	if (packet.data && packet.data.ctx && !packet.data.ctx.toJSON)
		packet.data.ctx = qctx.fromJSON(packet.data.ctx, manager);
	
	return packet;
});

mainBus.addOutputFilter(function(packet) {
	if (packet.data && packet.data.ctx && packet.data.ctx.toJSON &&
	    !(packet.recipients.length == 1 && packet.recipients[0] == packet.sender)) // not local
		packet.data.ctx = packet.data.ctx.toJSON();
	
	return packet;
});

var afql = new af.ArivaFinanceQuoteLoader(cfg.stockloader);
afql.on('error', function(e) { manager.emitError(e); });

manager.getServerConfig = buscomponent.provide('getServerConfig', [], function() { return cfg; });
manager.getStockQuoteLoader = buscomponent.provide('getStockQuoteLoader', [], function() { return afql; });
manager.getAchievementList = buscomponent.provide('getAchievementList', [], function() { return achievementList.AchievementList; });
manager.getClientAchievementList = buscomponent.provide('getClientAchievementList', [], function() { return achievementList.ClientAchievements; });

var readonly = cfg.readonly;

manager.getReadabilityMode = buscomponent.provide('get-readability-mode', [], function() { return {readonly: readonly}; });
manager.changeReadabilityMode = buscomponent.listener('change-readability-mode', function(event) { readonly = event.readonly; });

manager.setBus(mainBus, 'manager-' + process.pid).then(function() {
	// load super-essential components
	return loadComponents(['./errorhandler.js', './emailsender.js', './signedmsg.js']);
}).then(function() {
	process.on('uncaughtException', function(err) {
		manager.emitError(err);
		manager.emitImmediate('localShutdown');
	});

	var shutdownSignals = ['SIGTERM', 'SIGINT'];
	for (var i = 0; i < shutdownSignals.length; ++i) {
		process.on(shutdownSignals[i], function() { mainBus.emitLocal('globalShutdown'); });
	}

	assert.ok(cfg.busDumpFile);
	process.on('SIGUSR2', function() {
		fs.writeFileSync(cfg.varReplace(cfg.busDumpFile.replace(/\{\$pid\}/g, process.pid)),
			'Log:\n\n' + JSON.stringify(mainBus.packetLog) + '\n\n\nUnanswered:\n\n' + JSON.stringify(mainBus.unansweredRequests()));
	});

	if (cluster.isWorker) {
		mainBus.addTransport(new pt.ProcessTransport(process), worker);
	} else {
		assert.ok(cluster.isMaster);
		
		var workers = [];
		var assignedPorts = [];
		
		var getFreePort = function(pid) {
			// free all ports assigned to dead workers first
			var pids = _.chain(workers).pluck('process').pluck('pid').value();
			assignedPorts = _.filter(assignedPorts, function(p) { return pids.indexOf(p.pid) != -1; });
			
			var freePorts = _.difference(cfg.wsports, _.pluck(assignedPorts, 'port'));
			assert.ok(freePorts.length > 0);
			assignedPorts.push({pid: pid, port: freePorts[0]});
			return freePorts[0];
		};
		
		var registerWorker = function(w, done) {
			mainBus.addTransport(new pt.ProcessTransport(w), done);
		};
		
		var forkBackgroundWorker = function() {
			var bw = cluster.fork();
			var sentSBW = false;
			
			workers.push(bw);
			
			registerWorker(bw, function() {
				bw.on('message', function(msg) {
					if (msg.cmd == 'startRequest' && !sentSBW) {
						sentSBW = true;
						bw.send({cmd: 'startBackgroundWorker'});
					}
				});
			});
			
			bwpid = bw.process.pid;
			assert.ok(bwpid);
		};
		
		var forkStandardWorker = function() {
			var w = cluster.fork();
			var sentSSW = false;
			
			workers.push(w);
			
			w.on('online', function() {
				registerWorker(w, function() {
					w.on('message', function(msg) {
						if (msg.cmd == 'startRequest' && !sentSSW) {
							sentSSW = true;
							
							w.send({
								cmd: 'startStandardWorker',
								port: getFreePort(w.process.pid)
							});
						}
					});
				});
			});
		};
		
		if (cfg.startBackgroundWorker)
			forkBackgroundWorker();
		
		for (var i = 0; i < cfg.wsports.length; ++i) 
			forkStandardWorker();
		
		var shuttingDown = false;
		mainBus.on('globalShutdown', function() { mainBus.emitLocal('localShutdown'); });
		mainBus.on('localShutdown', function() { shuttingDown = true; });
		
		cluster.on('exit', function(worker, code, signal) {
			workers = _.filter(workers, function(w) { w.process.pid != worker.process.pid; });
			
			console.warn('worker ' + worker.process.pid + ' died with code ' + code + ', signal ' + signal + ' shutdown state ' + shuttingDown);
			
			if (!shuttingDown) {
				console.log('respawning');
				
				if (worker.process.pid == bwpid)
					forkBackgroundWorker();
				else 
					forkStandardWorker();
			} else {
				setTimeout(function() {
					process.exit(0);
				}, 2000);
			}
		});
		
		connectToSocketIORemotes().done();
	}
});

function worker() {
	var hasReceivedStartCommand = false;
	var startRequestInterval = setInterval(function() {
		if (!hasReceivedStartCommand)
			process.send({cmd: 'startRequest'});
	}, 250);
	
	process.on('message', function(msg) {
		if (hasReceivedStartCommand)
			return;
		
		if (msg.cmd == 'startBackgroundWorker') {
			process.isBackgroundWorker = true;
		} else if (msg.cmd == 'startStandardWorker') {
			assert.ok(msg.port);
			process.isBackgroundWorker = false;
		} else {
			return;
		}
		
		hasReceivedStartCommand = true;
		clearInterval(startRequestInterval);
		
		var componentsForLoading = [
			'./dbbackend.js', './feed.js', './template-loader.js', './stocks.js', './stocks-financeupdates.js',
			'./user.js', './misc.js'
		].concat(process.isBackgroundWorker ? [
			'./background-worker.js', './dqueries.js'
		] : [
			'./admin.js', './schools.js', './fsdb.js', './achievements.js', './chats.js',
			'./watchlist.js', './wordpress-feed.js'
		]);
		
		var stserver;
		return loadComponents(componentsForLoading).then(function() {
			var server = require('./server.js');
			stserver = new server.SoTradeServer();
			
			return stserver.setBus(mainBus, 'serverMaster');
		}).then(function() {
			if (process.isBackgroundWorker) {
				console.log('bw started');
				return connectToSocketIORemotes();
			} else {
				return stserver.start(msg.port);
			}
		}).done();
	});
}

function connectToSocketIORemotes() {
	return Q.all(cfg.socketIORemotes.map(connectToSocketIORemote));
}

function connectToSocketIORemote(remote) {
	return manager.request({
		name: 'createSignedMessage',
		msg: {
			type: 'init-bus-transport',
			id: 'init-bus-transport',
			weight: remote.weight
		}
	}).then(function(signed) {
		var sslOpts = remote.ssl || null;
		if (sslOpts === 'default')
			sslOpts = cfg.ssl;
		
		var socketopts = { transports: ['websocket'] };
		if (sslOpts)
			socketopts.agent = new https.Agent(sslOpts);
		
		var socket = sio.connect(remote.url, socketopts);
		
		socket.on('error', function(e) {
			manager.emitError(e);
		});
		
		socket.on('disconnect', function() {
			// auto-reconnect
			socket.close();
			socket = null;
			connectToSocketIORemote(remote);
		});
		
		mainBus.on('localShutdown', function() {
			if (socket) {
				socket.io.reconnectionAttempts(0);
				socket.close();
			}
			socket = null;
		});
		
		socket.on('connect', function() {
			socket.on('response', function(response) {
				assert.equal(response.e, 'raw');
				
				var r = JSON.parse(response.s);
				if (r.code == 'init-bus-transport-success')
					mainBus.addTransport(new dt.DirectTransport(socket, remote.weight || 10, false));
				else
					manager.emitError(new Error('Could not connect to socket.io remote: ' + r.code));
			});
			
			socket.emit('query', {
				signedContent: signed
			});
		});
	});
}

function loadComponents(componentsForLoading) {
	return Q.all(componentsForLoading.map(function(componentName) {
		var component = require(componentName);
		
		return Q.all(_.map(component, function(componentClass) {
			if (!componentClass || !componentClass.prototype.setBus)
				return Q();
			
			var componentID = componentName.replace(/\.[^.]+$/, '').replace(/[^\w]/g, '');
			return new componentClass().setBus(mainBus, componentID);
		}));
	}));
}

})();
