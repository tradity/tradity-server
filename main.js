#!/usr/bin/env node
(function () { "use strict";

var _ = require('lodash');
var assert = require('assert');
var fs = require('fs');
var https = require('https');
var cluster = require('cluster');
var events = require('promise-events');
var util = require('util');

var qctx = require('./qctx.js');
var cfg = require('./config.js').config();
var bus = require('./bus/bus.js');
var buscomponent = require('./stbuscomponent.js');
var pt = require('./bus/processtransport.js');
var dt = require('./bus/directtransport.js');
var sotradeClient = require('./sotrade-client.js');
var debug = require('debug')('sotrade:main');

var achievementList = require('./achievement-list.js');

/**
 * Main entry point of this software.
 * This manages – mostly – initial setup, loading modules and
 * coordinating workers.
 * 
 * @module main
 */

class Main extends buscomponent.BusComponent {
  constructor(opt) {
    Main.init_();
    
    super();
    
    opt = opt || {};
    this.mainBus = new bus.Bus();
    this.defaultStockLoaderDeferred = Promise.defer();
    this.defaultStockLoader = this.defaultStockLoaderDeferred.promise;
    this.readonly = this.getServerConfig().readonly;
    this.managerCTX = null;
    this.useCluster = opt.useCluster == null ? !process.env.SOTRADE_NO_CLUSTER : opt.useCluster;
    this.isWorker = opt.isWorker == null ? cluster.isWorker : opt.isWorker;
    this.isBackgroundWorker = opt.isBackgroundWorker || null;
    this.transportToMaster = opt.transportToMaster || null;
    
    this.bwpid = null;
    this.workers = [];
    this.assignedPorts = [];
    this.hasReceivedStartCommand = false;
    this.port = opt.port || null;
    
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
      './watchlist.js', './wordpress-feed.js', './questionnaires.js'
    ];
    
    this.shutdownSignals = ['SIGTERM', 'SIGINT'];
  }
}

Main.init_ = function() {
  Error.stackTraceLimit = cfg.stackTraceLimit || 20;
  events.EventEmitter.defaultMaxListeners = 0;
  process.setMaxListeners(0);
  cluster.setMaxListeners(0);
};

Main.prototype.initBus = function() {
  return this.mainBus.init().then(() => Promise.all([
    this.mainBus.addInputFilter(packet => {
      if (packet.data && packet.data.ctx && !packet.data.ctx.toJSON)
        packet.data.ctx = qctx.fromJSON(packet.data.ctx, self);
      
      return packet;
    }),

    this.mainBus.addOutputFilter(packet => {
      if (packet.data && packet.data.ctx && packet.data.ctx.toJSON &&
        !(packet.recipients.length == 1 && packet.recipients[0] == packet.sender)) // not local
        packet.data.ctx = packet.data.ctx.toJSON();
      
      return packet;
    })
  ]));
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
  debug('Change readability mode', event.readonly);
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
  
  debug('Set up default stock loader');
};

Main.prototype.start = function() {
  debug('Starting');
  
  return this.initBus().then(() => {
    return this.setBus(this.mainBus, 'manager-' + process.pid);
  }).then(() => {
    return this.loadComponents(this.superEssentialComponents);
  }).then(() => {
    this.managerCTX = new qctx.QContext({parentComponent: this});
    
    process.on('uncaughtException', err => {
      debug('Uncaught exception', err);
      this.emitError(err);
      this.emitImmediate('localShutdown');
    });
    
    process.on('unhandledRejection', (reason, p) => {
      debug('Unhandled rejection', reason, p);
      this.emitError(reason);
      this.emitImmediate('localShutdown');
    });
    
    this.mainBus.on('localShutdown', () => {
      setTimeout(() => {
        process.exit(0);
      }, 250);
    });
    
    for (var i = 0; i < this.shutdownSignals.length; ++i)
      process.on(this.shutdownSignals[i], () => { this.emitLocal('globalShutdown'); });

    var cfg = this.getServerConfig();
    
    return this.setupStockLoaders();
  }).then(() => {
    if (!this.transportToMaster)
      this.transportToMaster = new pt.ProcessTransport(process);
    
    if (this.isWorker)
      return this.mainBus.addTransport(this.transportToMaster, this.worker.bind(this));
    
    assert.ok(cluster.isMaster);
    return this.startMaster();
  });
};

Main.prototype.getFreePort = function(pid) {
  if (this.useCluster) {
    // free all ports assigned to dead workers first
    var pids = _.chain(this.workers).pluck('process').pluck('pid').value();
    this.assignedPorts = _.filter(this.assignedPorts, function(p) { return pids.indexOf(p.pid) != -1; });
  }
  
  var freePorts = _.difference(this.getServerConfig().wsports, _.pluck(this.assignedPorts, 'port'));
  assert.ok(freePorts.length > 0);
  this.assignedPorts.push({pid: pid, port: freePorts[0]});
  return freePorts[0];
};

Main.prototype.newNonClusterWorker = function(isBackgroundWorker, port) {
  var self = this;
  var ev = new events.EventEmitter();
  var toMaster = new dt.DirectTransport(ev, 1, true);
  var toWorker = new dt.DirectTransport(ev, 1, true);
  
  assert.ok(isBackgroundWorker || port);
  var m = new Main({
    isBackgroundWorker: isBackgroundWorker,
    isWorker: true,
    transportToMaster: toMaster,
    useCluster: false,
    port: port
  });
  
  return m.start().then(function() {
    return self.mainBus.addTransport(toWorker);
  });
};

Main.prototype.registerWorker = function(w) {
  return this.mainBus.addTransport(new pt.ProcessTransport(w));
};

Main.prototype.forkBackgroundWorker = function() {
  var self = this;
  
  if (!self.useCluster)
    return self.newNonClusterWorker(true, null);
  
  var bw = cluster.fork();
  var sentSBW = false;

  self.workers.push(bw);

  return self.registerWorker(bw).then(function() {
    bw.on('message', function(msg) {
      if (msg.cmd == 'startRequest' && !sentSBW) {
        sentSBW = true;
        
        debug('Sending SBW to', bw.process.pid);
        bw.send({cmd: 'startBackgroundWorker'});
      }
    });
  }).then(function() {
    self.bwpid = bw.process.pid;
    assert.ok(self.bwpid);
    
    return self.bwpid;
  });
};

Main.prototype.forkStandardWorker = function() {
  var self = this;
  
  if (!self.useCluster)
    return self.newNonClusterWorker(false, self.getFreePort(process.pid));
  
  var w = cluster.fork();
  var sentSSW = false;
  
  self.workers.push(w);
  
  w.on('online', function() {
    self.registerWorker(w, function() {
      w.on('message', function(msg) {
        if (msg.cmd == 'startRequest' && !sentSSW) {
          sentSSW = true;
          var port = self.getFreePort(w.process.pid);
          
          debug('Sending SSW[', port, '] to', w.process.pid);
          
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
  
  return Promise.resolve().then(function() {
    var workerStartedPromises = [];
    
    if (self.getServerConfig().startBackgroundWorker)
      workerStartedPromises.push(Promise.resolve().then(self.forkBackgroundWorker.bind(self)));
    
    for (var i = 0; i < self.getServerConfig().wsports.length; ++i) 
      workerStartedPromises.push(Promise.resolve().then(self.forkStandardWorker.bind(self)));
    
    return Promise.all(workerStartedPromises);
  }).then(function() {
    var shuttingDown = false;
    self.mainBus.on('globalShutdown', function() { self.mainBus.emitLocal('localShutdown'); });
    self.mainBus.on('localShutdown', function() { shuttingDown = true; });
    
    cluster.on('exit', function(worker, code, signal) {
      self.workers = _.filter(self.workers, function(w) { w.process.pid != worker.process.pid; });
      
      var shouldRestart = !shuttingDown;
      
      if (['SIGKILL', 'SIGQUIT', 'SIGTERM'].indexOf(signal) != -1)
        shouldRestart = false;
      
      debug('worker ' + worker.process.pid + ' died with code ' + code + ', signal ' + signal + ' shutdown state ' + shuttingDown);
      
      if (!shuttingDown) {
        debug('respawning');
        
        if (worker.process.pid == self.bwpid)
          self.forkBackgroundWorker();
        else 
          self.forkStandardWorker();
      } else {
        setTimeout(function() {
          process.exit(0);
        }, 1500);
      }
    });
    
    return self.connectToSocketIORemotes();
  });
};

Main.prototype.worker = function() {
  var self = this;
  
  if (!self.useCluster)
    return self.startWorker();
  
  var startRequestInterval = setInterval(function() {
    if (!self.hasReceivedStartCommand) {
      debug('Requesting start commands', process.pid);
      process.send({cmd: 'startRequest'});
    }
  }, 250);
  
  process.on('message', function(msg) {
    if (self.hasReceivedStartCommand)
      return;
    
    if (msg.cmd == 'startBackgroundWorker') {
      debug(process.pid, 'received SBW');
      
      self.isBackgroundWorker = true;
    } else if (msg.cmd == 'startStandardWorker') {
      assert.ok(msg.port);
      
      debug(process.pid, 'received SSW[', msg.port, ']');
      self.port = msg.port;
      self.isBackgroundWorker = false;
    } else {
      return;
    }
    
    self.hasReceivedStartCommand = true;
    clearInterval(startRequestInterval);
    
    return self.startWorker();
  });
};

Main.prototype.startWorker = function() {
  var self = this;
  
  var componentsForLoading = self.basicComponents
    .concat(self.isBackgroundWorker ? self.bwComponents : self.regularComponents);
  
  debug(process.pid, 'loading');
  var stserver;
  return self.loadComponents(componentsForLoading).then(function() {
    var server = require('./server.js');
    stserver = new server.SoTradeServer({isBackgroundWorker: self.isBackgroundWorker});
    
    return stserver.setBus(self.mainBus, 'serverMaster');
  }).then(function() {
    debug(process.pid, 'loaded');
    
    if (self.isBackgroundWorker) {
      debug('BW started at', process.pid, 'connecting to remotes...');
      return self.connectToSocketIORemotes().then(function() {
        debug('BW connected to remotes', process.pid);
      });
    } else {
      return stserver.start(self.port);
    }
  });
}

Main.prototype.connectToSocketIORemotes = function() {
  return Promise.all(this.getServerConfig().socketIORemotes.map(this.connectToSocketIORemote.bind(this)));
};

Main.prototype.connectToSocketIORemote = function(remote) {
  var self = this;
  
  var sslOpts = remote.ssl || self.getServerConfig().ssl;
  var socket = new sotradeClient.SoTradeConnection({
    url: remote.url,
    socketopts: {
      transports: ['websocket'],
      agent: sslOpts && /^(https|wss)/.test(remote.url) ? new https.Agent(sslOpts) : null
    },
    serverConfig: self.getServerConfig()
  });

  self.mainBus.on('localShutdown', function() {
    if (socket) {
      socket.raw().io.reconnectionAttempts(0);
      socket.raw().close();
    }
    
    socket = null;
  });
  
  return socket.once('server-config').then(function() {
    return socket.emit('init-bus-transport', {
      weight: remote.weight
    }).then(function(r) {
      debug('init-bus-transport returned', r.code);
      
      if (r.code == 'init-bus-transport-success')
        return self.mainBus.addTransport(new dt.DirectTransport(socket.raw(), remote.weight || 10, false));
      else
        return self.emitError(new Error('Could not connect to socket.io remote: ' + r.code));
    });
  });
};

Main.prototype.loadComponents = function(componentsForLoading) {
  var self = this;
  
  return Promise.all(componentsForLoading.map(function(componentName) {
    var component = require(componentName);
    
    return Promise.all(_.map(component, function(componentClass) {
      if (!componentClass || !componentClass.prototype.setBus)
        return Promise.resolve();
      
      var componentID = componentName.replace(/\.[^.]+$/, '').replace(/[^\w]/g, '');
      return new componentClass().setBus(self.mainBus, componentID);
    }));
  }));
};

Main.prototype.ctx = function() {
  return this.managerCTX;
};

exports.Main = Main;

if (require.main === module)
  new Main().start();

})();
