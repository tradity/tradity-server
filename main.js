#!/usr/bin/env node
// Tradity.de Server
// Copyright (C) 2016 Tradity.de Tech Team <tech@tradity.de>

// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version. 

// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.

// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <http://www.gnu.org/licenses/>.

"use strict";

const _ = require('lodash');
const assert = require('assert');
const https = require('https');
const cluster = require('cluster');

const qctx = require('./qctx.js');
const api = require('./api.js');
const sotradeClient = require('./sotrade-client.js');
const promiseUtil = require('./lib/promise-util.js');
const debug = require('debug')('sotrade:main');

class StockQuoteLoaderProvider extends api.Component {
  constructor() {
    super({
      identifier: 'StockQuoteLoaderProvider',
      description: 'Decides which stock quote loader to use.'
    });
    
    this.defaultStockLoader = null;
  }
  
  resolve() {
    return this.defaultStockLoader;
  }
  
  init() {
    const stockLoaders = {};
    for (let i in cfg.stockloaders) {
      if (!cfg.stockloaders[i] || !cfg.stockloaders[i].path) {
        continue;
      }
      
      const stockloaderConfig = _.clone(cfg.stockloaders[i]);
      stockloaderConfig.userAgent = cfg.userAgent;
      stockloaderConfig.ctx = this.managerCTX.clone();
      
      const slModule = require(stockloaderConfig.path);
      stockLoaders[i] = new slModule.QuoteLoader(stockloaderConfig);
      stockLoaders[i].on('error', e => this.emitError(e)); // XXX
    }

    this.defaultStockLoader = stockLoaders[cfg.stockloaders._defaultStockLoader];
    
    debug('Set up default stock loader');
  }
}

/**
 * Main entry point of this software.
 * This manages – mostly – initial setup, loading modules and
 * coordinating workers.
 */
// XXX split this into PrimaryMain and WorkerMain
class Main extends api.Component {
  constructor(opt) {
    Main.init_();
    
    super();
    
    opt = opt || {};
    this.readonly = this.getServerConfig().readonly; // XXX
    this.managerCTX = null;
    this.useCluster = opt.useCluster == null ? !process.env.SOTRADE_NO_CLUSTER : opt.useCluster;
    this.isWorker = opt.isWorker == null ? cluster.isWorker : opt.isWorker;
    this.isBackgroundWorker = opt.isBackgroundWorker || null;
    
    this.bwpid = null;
    this.workers = [];
    this.assignedPorts = [];
    this.hasReceivedStartCommand = false;
    this.port = opt.port || null;
    
    this.componentModules = [
      './errorhandler.js', './emailsender.js', './signedmsg.js',
      './dbbackend.js', './feed.js', './template-loader.js', './stocks.js', './stocks-financeupdates.js',
      './user.js', './misc.js',
      './background-worker.js', './dqueries.js'
      './admin.js', './schools.js', './fsdb.js', './achievements.js', './chats.js',
      './watchlist.js', './wordpress-feed.js', './questionnaires.js',
      './user-info.js', './ranking.js',
    ];
    
    this.shutdownSignals = ['SIGTERM', 'SIGINT'];
  }
  
  start() {
    debug('Starting');
    
    return this.loadComponents().then(() => {
      this.managerCTX = new qctx.QContext({parentComponent: this});
      
      let isAlreadyShuttingDownDueToError = false;
      const unhandledSomething = err => {
        this.emitError(err);
        // XXX
        if (!isAlreadyShuttingDownDueToError) {
          this.emitImmediate('localShutdown');
        }
        
        isAlreadyShuttingDownDueToError = true;
      };
      
      process.on('uncaughtException', err => {
        debug('Uncaught exception', err, err && err.stack);
        return unhandledSomething(err);
      });
      
      process.on('unhandledRejection', (reason) => {
        debug('Unhandled rejection', reason, reason && reason.stack);
        return unhandledSomething(reason);
      });
      
      // XXX
      this.mainBus.on('localShutdown', () => {
        setTimeout(() => {
          debug('Quitting after localShutdown', process.pid);
          process.exit(0);
        }, 250);
      });
      
      for (let i = 0; i < this.shutdownSignals.length; ++i) {
        process.on(this.shutdownSignals[i], () => this.emitLocal('globalShutdown'));
      }
      
      if (this.isWorker) {
        return this.worker();
      }
      
      debug('Starting master', process.pid);
      assert.ok(cluster.isMaster);
      return this.startMaster().then(() => {
        debug('Started master', process.pid);
      });
    }).then(() => {
      debug('Startup complete!', process.pid);
    });
  }

  getFreePort(pid) {
    if (this.useCluster) {
      // free all ports assigned to dead workers first
      const pids = _.chain(this.workers).map('process').map('pid').value();
      this.assignedPorts = this.assignedPorts.filter(p => pids.indexOf(p.pid) !== -1);
    }
    
    const freePorts = _.difference(this.getServerConfig().wsports, _.map(this.assignedPorts, 'port'));
    assert.ok(freePorts.length > 0);
    this.assignedPorts.push({pid: pid, port: freePorts[0]});
    return freePorts[0];
  }

  newNonClusterWorker(isBackgroundWorker, port) {
    const ev = new promiseUtil.EventEmitter();
    const toMaster = new bus.DirectTransport(ev, 1, true);
    const toWorker = new bus.DirectTransport(ev, 1, true);
    
    assert.ok(isBackgroundWorker || port);
    const m = new Main({
      isBackgroundWorker: isBackgroundWorker,
      isWorker: true,
      transportToMaster: toMaster,
      useCluster: false,
      port: port
    });
    
    return m.start().then(() => {
      debug('Adding transport to non-cluster worker');
      return this.mainBus.addTransport(toWorker).then(() => {
        debug('Added transport to non-cluster worker');
      });
    });
  }

  registerWorker(w) {
    return this.mainBus.addTransport(new bus.ProcessTransport(w));
  }

  forkBackgroundWorker() {
    debug('Forking new background worker', this.useCluster);
    if (!this.useCluster) {
      return this.newNonClusterWorker(true, null);
    }
    
    const bw = cluster.fork();
    let sentSBW = false;

    this.workers.push(bw);

    return this.registerWorker(bw).then(() => {
      bw.on('message', msg => {
        if (msg.cmd === 'startRequest' && !sentSBW) {
          sentSBW = true;
          
          debug('Sending SBW to', bw.process.pid);
          return bw.send({cmd: 'startBackgroundWorker'});
        }
      });
    }).then(() => {
      this.bwpid = bw.process.pid;
      assert.ok(this.bwpid);
      
      return this.bwpid;
    });
  }

  forkStandardWorker() {
    debug('Forking new standard worker', this.useCluster);
    if (!this.useCluster) {
      return this.newNonClusterWorker(false, this.getFreePort(process.pid));
    }
    
    const w = cluster.fork();
    let sentSSW = false;
    
    this.workers.push(w);
    
    return w.on('online', () => {
      return this.registerWorker(w).then(() => {
        w.on('message', msg => {
          if (msg.cmd === 'startRequest' && !sentSSW) {
            sentSSW = true;
            const port = this.getFreePort(w.process.pid);
            
            debug('Sending SSW[', port, '] to', w.process.pid);
            
            w.send({
              cmd: 'startStandardWorker',
              port: port
            });
          }
        });
      });
    });
  }

  startMaster() {
    return Promise.resolve().then(() => {
      const workerStartedPromises = [];
      
      if (this.getServerConfig().startBackgroundWorker) {
        workerStartedPromises.push(Promise.resolve().then(() => this.forkBackgroundWorker()));
      }
      
      for (let i = 0; i < this.getServerConfig().wsports.length; ++i) {
        workerStartedPromises.push(Promise.resolve().then(() => this.forkStandardWorker()));
      }
      
      debug('Starting workers', process.pid, workerStartedPromises.length + ' workers');
      
      return Promise.all(workerStartedPromises);
    }).then(() => {
      debug('All workers started', process.pid);
      
      let shuttingDown = false;
      this.mainBus.on('globalShutdown', () => this.mainBus.emitLocal('localShutdown'));
      this.mainBus.on('localShutdown', () => { shuttingDown = true; });
      
      cluster.on('exit', (worker, code, signal) => {
        this.workers = this.workers.filter(w => (w.process.pid !== worker.process.pid));
        
        let shouldRestart = !shuttingDown;
        
        if (['SIGKILL', 'SIGQUIT', 'SIGTERM'].indexOf(signal) !== -1) {
          shouldRestart = false;
        }
        
        debug('worker ' + worker.process.pid + ' died with code ' + code + ', signal ' + signal + ' shutdown state ' + shuttingDown);
        
        if (!shuttingDown) {
          debug('respawning');
          
          if (worker.process.pid === this.bwpid) {
            return this.forkBackgroundWorker();
          } else {
            return this.forkStandardWorker();
          }
        } else {
          setTimeout(function() {
            process.exit(0);
          }, 1500);
        }
      });
      
      return this.connectToSocketIORemotes().then(() => {
        debug('Connected to socket.io remotes', process.pid);
      });
    });
  }

  worker() {
    if (!this.useCluster) {
      return this.startWorker();
    }
    
    const startRequestInterval = setInterval(() => {
      if (!this.hasReceivedStartCommand) {
        debug('Requesting start commands', process.pid);
        process.send({cmd: 'startRequest'});
      }
    }, 250);
    
    process.on('message', msg => {
      if (this.hasReceivedStartCommand) {
        return;
      }
      
      if (msg.cmd === 'startBackgroundWorker') {
        debug('received SBW', process.pid);
        
        this.isBackgroundWorker = true;
      } else if (msg.cmd === 'startStandardWorker') {
        assert.ok(msg.port);
        
        debug('received SSW', process.pid, msg.port);
        this.port = msg.port;
        this.isBackgroundWorker = false;
      } else {
        return;
      }
      
      this.hasReceivedStartCommand = true;
      clearInterval(startRequestInterval);
      
      return this.startWorker();
    });
  }

  startWorker() {
    const componentsForLoading = this.basicComponents
      .concat(this.isBackgroundWorker ? this.bwComponents : this.regularComponents);
    
    debug('loading', process.pid);
    
    return this.loadComponents(componentsForLoading).then(() => {
      const server = require('./server.js');
      const stserver = new server.SoTradeServer({isBackgroundWorker: this.isBackgroundWorker});
      
      return stserver.setBus(this.mainBus, 'serverMaster').then(() => stserver);
    }).then(stserver => {
      debug('loaded', process.pid);
      
      if (this.isBackgroundWorker) {
        debug('BW started at', process.pid, 'connecting to remotes...');
        return this.connectToSocketIORemotes().then(() => {
          debug('BW connected to remotes', process.pid);
        });
      } else {
        return stserver.start(this.port).then(() => {
          debug('Server started!', process.pid);
        });
      }
    });
  }

  connectToSocketIORemotes() {
    return Promise.all(
      this.getServerConfig().socketIORemotes.map(
        remote => this.connectToSocketIORemote(remote)
      )
    );
  }

  connectToSocketIORemote(remote) {
    debug('Connecting to socket.io remote', process.pid, remote.url);
    const sslOpts = remote.ssl || this.getServerConfig().ssl;
    let socket = new sotradeClient.SoTradeConnection({
      url: remote.url,
      socketopts: {
        transports: ['websocket'],
        agent: sslOpts && /^(https|wss)/.test(remote.url) ? new https.Agent(sslOpts) : null
      },
      serverConfig: this.getServerConfig()
    });

    this.mainBus.on('localShutdown', () => {
      if (socket) {
        socket.raw().io.reconnectionAttempts(0);
        socket.raw().close();
      }
      
      socket = null;
    });
    
    return socket.once('server-config').then(() => {
      debug('Received server-config from remote', process.pid, remote.url);
      
      return socket.emit('init-bus-transport', {
        weight: remote.weight
      });
    }).then(r => {
      debug('init-bus-transport returned', process.pid, r.code);
      
      if (r.code === 'init-bus-transport-success') {
        return this.mainBus.addTransport(new bus.DirectTransport(socket.raw(), remote.weight || 10, false));
      } else {
        return this.emitError(new Error('Could not connect to socket.io remote: ' + r.code));
      }
    });
  }

  loadComponents(componentsForLoading) {
    return Promise.all(componentsForLoading.map(componentName => {
      const component = require(componentName);
      
      return Promise.all(_.map(component, ComponentClass => {
        if (!ComponentClass || !ComponentClass.prototype.setBus) {
          return Promise.resolve();
        }
        
        const componentID = componentName.replace(/\.[^.]+$/, '').replace(/[^\w]/g, '');
        return new ComponentClass().setBus(this.mainBus, componentID);
      }));
    }));
  }

  ctx() {
    return this.managerCTX;
  }
}

Main.init_ = function() {
  Error.stackTraceLimit = cfg.stackTraceLimit || 20;
  require('events').EventEmitter.defaultMaxListeners = 0;
  require('promise-events').EventEmitter.defaultMaxListeners = 0;
  process.setMaxListeners(0);
  cluster.setMaxListeners(0);
};

exports.Main = Main;

if (require.main === module) {
  new Main().start();
}
