(function () { "use strict";

var _ = require('lodash');
var assert = require('assert');
var fs = require('fs');
var https = require('https');
var cluster = require('cluster');
var events = require('events');
var util = require('util');
var Q = require('q');

var qctx = require('./qctx.js');
var cfg = require('./config.js').config;
var bus = require('./bus/bus.js');
var buscomponent = require('./stbuscomponent.js');
var pt = require('./bus/processtransport.js');
var dt = require('./bus/directtransport.js');
var sio = require('socket.io-client');

var achievementList = require('./achievement-list.js');

/**
 * Main entry point of this software.
 * This manages – mostly – initial setup, loading modules and
 * coordinating workers.
 * 
 * @module main
 */

function Main() {
	Main.init_();
	
	Main.super_.apply(this, arguments);
	
	this.mainBus = new bus.Bus();
	this.defaultStockLoaderDeferred = Q.defer();
	this.defaultStockLoader = this.defaultStockLoaderDeferred.promise;
	this.readonly = this.getServerConfig().readonly;
	this.managerCTX = null;
	
	this.bwpid = null;
	this.workers = [];
	this.assignedPorts = [];
	
	this.superEssentialComponents = [
		'./errorhandler.js', './emailsender.js', './signedmsg.js'
	];
	
	this.basicComponents = [
		'./dbbackend.js', './feed.js', './template-loader.js', './stocks.js', './stocks-financeupdates.js',
		'./user.js', './misc.js'
	];
	
	this.bwComponents = [
		'./background-worker.js', './dqueries.js'
	];
	
	this.regularComponents = [
		'./admin.js', './schools.js', './fsdb.js', './achievements.js', './chats.js',
		'./watchlist.js', './wordpress-feed.js'
	];
	
	this.shutdownSignals = ['SIGTERM', 'SIGINT'];
	
	this.initBus();
}

util.inherits(Main, buscomponent.BusComponent);

Main.init_ = function() {
	Error.stackTraceLimit = cfg.stackTraceLimit || 20;
	Q.longStackSupport = cfg.longStackTraces || false;
	events.EventEmitter.defaultMaxListeners = 0;
};

Main.prototype.initBus = function() {
	var self = this;
	
	self.mainBus.addInputFilter(function(packet) {
		if (packet.data && packet.data.ctx && !packet.data.ctx.toJSON)
			packet.data.ctx = qctx.fromJSON(packet.data.ctx, self);
		
		return packet;
	});

	self.mainBus.addOutputFilter(function(packet) {
		if (packet.data && packet.data.ctx && packet.data.ctx.toJSON &&
			!(packet.recipients.length == 1 && packet.recipients[0] == packet.sender)) // not local
			packet.data.ctx = packet.data.ctx.toJSON();
		
		return packet;
	});
};

Main.prototype.getStockQuoteLoader = buscomponent.provide('getStockQuoteLoader', [], function() {
	return this.defaultStockLoader;
});

Main.prototype.getServerConfig = buscomponent.provide('getServerConfig', [], function() {
	return cfg;
});

Main.prototype.getAchievementList = buscomponent.provide('getAchievementList', [], function() {
	return achievementList.AchievementList;
});

Main.prototype.getClientAchievementList = buscomponent.provide('getClientAchievementList', [], function() {
	return achievementList.ClientAchievements;
});

Main.prototype.getReadabilityMode = buscomponent.provide('get-readability-mode', [], function() {
	return { readonly: this.readonly };
});

Main.prototype.changeReadabilityMode = buscomponent.listener('change-readability-mode', function(event) {
	this.readonly = event.readonly;
});

Main.prototype.setupStockLoaders = function() {
	// setup stock loaders
	var stockLoaders = {};
	for (var i in cfg.stockloaders) {
		if (!cfg.stockloaders[i] || !cfg.stockloaders[i].path)
			continue;
		
		var stockloaderConfig = _.clone(cfg.stockloaders[i]);
		stockloaderConfig.userAgent = cfg.userAgent;
		stockloaderConfig.ctx = this.managerCTX.clone();
		
		var slModule = require(stockloaderConfig.path);
		stockLoaders[i] = new slModule.QuoteLoader(stockloaderConfig);
		stockLoaders[i].on('error', function(e) { this.emitError(e); });
	}

	this.defaultStockLoader = stockLoaders[cfg.stockloaders._defaultStockLoader];
	this.defaultStockLoaderDeferred.resolve(this.defaultStockLoader);
};

Main.prototype.log = function() {
	console.log.apply(console, arguments);
};

Main.prototype.start = function() {
	var self = this;
	
	return self.setBus(self.mainBus, 'manager-' + process.pid).then(function() {
		return self.loadComponents(self.superEssentialComponents);
	}).then(function() {
		self.managerCTX = new qctx.QContext({parentComponent: self});
		
		process.on('uncaughtException', function(err) {
			self.emitError(err);
			self.emitImmediate('localShutdown');
		});
		
		for (var i = 0; i < self.shutdownSignals.length; ++i)
			process.on(self.shutdownSignals[i], function() { self.emitLocal('globalShutdown'); });

		var cfg = self.getServerConfig();
		assert.ok(cfg.busDumpFile);
		process.on('SIGUSR2', function() {
			fs.writeFileSync(cfg.varReplace(cfg.busDumpFile.replace(/\{\$pid\}/g, process.pid)),
				'Log:\n\n' + JSON.stringify(self.mainBus.packetLog) + '\n\n\nUnanswered:\n\n' + JSON.stringify(self.mainBus.unansweredRequests()));
		});
		
		return self.setupStockLoaders();
	}).then(function() {
		if (cluster.isWorker)
			return self.mainBus.addTransport(new pt.ProcessTransport(process), self.worker.bind(self));
		
		assert.ok(cluster.isMaster);
		return self.startMaster();
	}).done();
};

Main.prototype.getFreePort = function(pid) {
	// free all ports assigned to dead workers first
	var pids = _.chain(this.workers).pluck('process').pluck('pid').value();
	this.assignedPorts = _.filter(this.assignedPorts, function(p) { return pids.indexOf(p.pid) != -1; });
	
	var freePorts = _.difference(this.getServerConfig().wsports, _.pluck(this.assignedPorts, 'port'));
	assert.ok(freePorts.length > 0);
	this.assignedPorts.push({pid: pid, port: freePorts[0]});
	return freePorts[0];
};

Main.prototype.registerWorker = function(w, done) {
	return this.mainBus.addTransport(new pt.ProcessTransport(w), done);
};

Main.prototype.forkBackgroundWorker = function() {
	var self = this;
	var bw = cluster.fork();
	var sentSBW = false;

	self.workers.push(bw);

	self.registerWorker(bw, function() {
		bw.on('message', function(msg) {
			if (msg.cmd == 'startRequest' && !sentSBW) {
				sentSBW = true;
				
				self.log('Sending SBW to', bw.process.pid);
				bw.send({cmd: 'startBackgroundWorker'});
			}
		});
	});

	self.bwpid = bw.process.pid;
	assert.ok(self.bwpid);
	
	return self.bwpid;
};

Main.prototype.forkStandardWorker = function() {
	var self = this;
	
	var w = cluster.fork();
	var sentSSW = false;
	
	self.workers.push(w);
	
	w.on('online', function() {
		self.registerWorker(w, function() {
			w.on('message', function(msg) {
				if (msg.cmd == 'startRequest' && !sentSSW) {
					sentSSW = true;
					var port = self.getFreePort(w.process.pid);
					
					self.log('Sending SSW[', port, '] to', w.process.pid);
					
					w.send({
						cmd: 'startStandardWorker',
						port: port
					});
				}
			});
		});
	});
};

Main.prototype.startMaster = function() {
	var self = this;
	
	if (self.getServerConfig().startBackgroundWorker)
		self.forkBackgroundWorker();
	
	for (var i = 0; i < self.getServerConfig().wsports.length; ++i) 
		self.forkStandardWorker();
	
	var shuttingDown = false;
	self.mainBus.on('globalShutdown', function() { self.mainBus.emitLocal('localShutdown'); });
	self.mainBus.on('localShutdown', function() { shuttingDown = true; });
	
	cluster.on('exit', function(worker, code, signal) {
		self.workers = _.filter(self.workers, function(w) { w.process.pid != worker.process.pid; });
		
		var shouldRestart = !shuttingDown;
		
		if (['SIGKILL', 'SIGQUIT', 'SIGTERM'].indexOf(signal) != -1)
			shouldRestart = false;
		
		self.log('worker ' + worker.process.pid + ' died with code ' + code + ', signal ' + signal + ' shutdown state ' + shuttingDown);
		
		if (!shuttingDown) {
			self.log('respawning');
			
			if (worker.process.pid == self.bwpid)
				self.forkBackgroundWorker();
			else 
				self.forkStandardWorker();
		} else {
			setTimeout(function() {
				process.exit(0);
			}, 2000);
		}
	});
	
	return self.connectToSocketIORemotes();
};

Main.prototype.worker = function() {
	var self = this;
	
	var hasReceivedStartCommand = false;
	var startRequestInterval = setInterval(function() {
		if (!hasReceivedStartCommand) {
			self.log('Requesting start commands', process.pid);
			process.send({cmd: 'startRequest'});
		}
	}, 250);
	
	process.on('message', function(msg) {
		if (hasReceivedStartCommand)
			return;
		
		if (msg.cmd == 'startBackgroundWorker') {
			self.log(process.pid, 'received SBW');
			
			process.isBackgroundWorker = true;
		} else if (msg.cmd == 'startStandardWorker') {
			assert.ok(msg.port);
			
			self.log(process.pid, 'received SSW[', msg.port, ']');
			process.isBackgroundWorker = false;
		} else {
			return;
		}
		
		hasReceivedStartCommand = true;
		clearInterval(startRequestInterval);
		
		var componentsForLoading = self.basicComponents
			.concat(process.isBackgroundWorker ? self.bwComponents : self.regularComponents);
		
		self.log(process.pid, 'loading');
		var stserver;
		return self.loadComponents(componentsForLoading).then(function() {
			var server = require('./server.js');
			stserver = new server.SoTradeServer();
			
			return stserver.setBus(self.mainBus, 'serverMaster');
		}).then(function() {
			self.log(process.pid, 'loaded');
			
			if (process.isBackgroundWorker) {
				self.log('BW started at', process.pid, 'connecting to remotes...');
				return self.connectToSocketIORemotes().then(function() {
					self.log('BW connected to remotes', process.pid);
				});
			} else {
				return stserver.start(msg.port);
			}
		}).done();
	});
}

Main.prototype.connectToSocketIORemotes = function() {
	return Q.all(this.getServerConfig().socketIORemotes.map(this.connectToSocketIORemote.bind(this)));
};

Main.prototype.connectToSocketIORemote = function(remote) {
	var self = this;
	
	return self.request({
		name: 'createSignedMessage',
		msg: {
			type: 'init-bus-transport',
			id: 'init-bus-transport',
			weight: remote.weight
		}
	}).then(function(signed) {
		var sslOpts = remote.ssl || null;
		if (sslOpts === 'default')
			sslOpts = self.getServerConfig().ssl;
		
		var socketopts = { transports: ['websocket'] };
		if (sslOpts)
			socketopts.agent = new https.Agent(sslOpts);
		
		var socket = sio.connect(remote.url, socketopts);
		
		socket.on('error', function(e) {
			self.emitError(e);
		});
		
		socket.on('disconnect', function() {
			// auto-reconnect
			socket.close();
			socket = null;
			return self.connectToSocketIORemote(remote);
		});
		
		self.mainBus.on('localShutdown', function() {
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
					self.mainBus.addTransport(new dt.DirectTransport(socket, remote.weight || 10, false));
				else
					self.emitError(new Error('Could not connect to socket.io remote: ' + r.code));
			});
			
			return socket.emit('query', {
				signedContent: signed
			});
		});
	});
};

Main.prototype.loadComponents = function(componentsForLoading) {
	var self = this;
	
	return Q.all(componentsForLoading.map(function(componentName) {
		var component = require(componentName);
		
		return Q.all(_.map(component, function(componentClass) {
			if (!componentClass || !componentClass.prototype.setBus)
				return Q();
			
			var componentID = componentName.replace(/\.[^.]+$/, '').replace(/[^\w]/g, '');
			return new componentClass().setBus(self.mainBus, componentID);
		}));
	}));
};

exports.Main = Main;

if (require.main === module)
	new Main().start();

})();
