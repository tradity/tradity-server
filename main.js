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
const cluster = require('cluster');
const redis = require('redis');

const qctx = require('./qctx.js');
const api = require('./api.js');
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
    debug('Running StockQuoteLoaderProvider init');
    const stockLoaders = {};
    const cfg = this.load('Config').config();
    
    Error.stackTraceLimit = cfg.stackTraceLimit || 20;
    
    for (let i in cfg.stockloaders) {
      if (!cfg.stockloaders[i] || !cfg.stockloaders[i].path) {
        continue;
      }
      
      const stockloaderConfig = _.clone(cfg.stockloaders[i]);
      stockloaderConfig.userAgent = cfg.userAgent;
      stockloaderConfig.ctx = new qctx.QContext({parentComponent: this});
      
      const slModule = require(stockloaderConfig.path);
      stockLoaders[i] = new slModule.QuoteLoader(stockloaderConfig);
      stockLoaders[i].on('error', e => this.load('PubSub').emit('error', e));
    }

    this.defaultStockLoader = stockLoaders[cfg.stockloaders._defaultStockLoader];
    
    debug('Set up default stock loader');
  }
}

class PubSub extends api._Component {
  constructor() {
    super({
      identifier: 'PubSub',
      description: 'Shortcut redis interface.',
      depends: ['Config']
    });
    
    this.subclient = null;
    this.pubclient = null;
    this.cfg = null;
  }
  
  init() {
    this.cfg = this.load('Config').config().redis;
    this.pubclient = redis.createClient(this.cfg);
    this.subclient = redis.createClient(this.cfg);
    this.subclient.subscribe(this.cfg._channel);
    
    this.subclient.on('message', (channel, message) => {
      const msg = JSON.parse(message);
      this.emit(msg.name, msg.data);
    });
  }
  
  publish(name, data) {
    let kind = 'object';
    
    if (data instanceof Error) {
      kind = 'error';
      data = {
        message: data.message,
        name: data.name,
        stack: data.stack
      };
    }
    
    this.pubclient.publish(this.cfg._channel, JSON.stringify({
      name: name,
      data: data,
      kind: kind
    }));
  }
}

class ReadonlyStore extends api._Component {
  constructor() {
    super({
      identifier: 'ReadonlyStore',
      depends: ['Config']
    });
    
    this.readonly = null;
  }
  
  init() {
    this.readonly = this.load('Config').config().readonly;
  }
}

// XXX split this into PrimaryMain and WorkerMain
class Main extends api.Component {
  constructor(opt) {
    Main.init_();
    
    super({
      identifier: 'Main',
      description: 'Main entry point of this software.',
      notes: 'This manages – mostly – initial setup, loading modules and coordinating workers',
      depends: ['DelayedQueries']
    });
    
    opt = opt || {};
    this.readonly = true;
    this.useCluster = opt.useCluster == null ? !process.env.SOTRADE_NO_CLUSTER : opt.useCluster;
    this.isWorker = opt.isWorker == null ? cluster.isWorker : opt.isWorker;
    this.isBackgroundWorker = opt.isBackgroundWorker || null;
    
    this.bwpid = null;
    this.workers = [];
    this.assignedPorts = [];
    this.hasReceivedStartCommand = false;
    this.port = opt.port || null;
    
    this.registry = new api.Registry();
    this.registry.addComponentClass(StockQuoteLoaderProvider);
    this.registry.addComponentClass(PubSub);
    this.registry.addComponentClass(ReadonlyStore);
    this.registry.addIndependentInstance(this);
    
    this.componentModules = [
      './config.js', './errorhandler.js', './emailsender.js', './signedmsg.js',
      './dbbackend.js', './feed.js', './template-loader.js', './stocks.js', './stocks-financeupdates.js',
      './user.js', './misc.js', './dqueries.js',
      './background-worker.js',
      './admin.js', './schools.js', './fsdb.js', './achievements.js',
      './achievement-list.js', './chats.js',
      './watchlist.js', './wordpress-feed.js', './questionnaires.js',
      './user-info.js', './ranking.js'
    ];
    
    this.shutdownSignals = ['SIGTERM', 'SIGINT'];
  }
  
  start() {
    debug('Starting');
    
    return this.loadComponents().then(() => {
      debug('Loaded components');
      
      let isAlreadyShuttingDownDueToError = false;
      const unhandledSomething = err => {
        this.load('PubSub').emit('error', err);
        if (!isAlreadyShuttingDownDueToError) {
          this.load('PubSub').emit('shutdown');
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
      
      debug('Set up error handlers');
      
      this.readonly = this.load('Config').config().readonly;
      
      this.load('PubSub').on('shutdown', () => {
        setTimeout(() => {
          debug('Quitting after "shutdown" event', process.pid);
          process.exit(0);
        }, 250);
      });
      
      for (let i = 0; i < this.shutdownSignals.length; ++i) {
        process.on(this.shutdownSignals[i], () => { // jshint ignore:line
          this.load('PubSub').emit('shutdown');
        
          this.workers.forEach(w => {
            w.kill(this.shutdownSignals[i]);
          });
        });
      }
      
      if (this.isWorker) {
        return this.worker();
      } else {
        debug('Starting master', process.pid);
        assert.ok(cluster.isMaster);
        return this.startMaster().then(() => {
          debug('Started master', process.pid);
        });
      }
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
    
    const freePorts = _.difference(this.load('Config').config().wsports, _.map(this.assignedPorts, 'port'));
    assert.ok(freePorts.length > 0);
    this.assignedPorts.push({pid: pid, port: freePorts[0]});
    return freePorts[0];
  }

  newNonClusterWorker(isBackgroundWorker, port) {
    assert.ok(isBackgroundWorker || port);
    const m = new Main({
      isBackgroundWorker: isBackgroundWorker,
      isWorker: true,
      useCluster: false,
      port: port
    });
    
    return m.start();
  }

  forkBackgroundWorker() {
    debug('Forking new background worker', this.useCluster);
    if (!this.useCluster) {
      return this.newNonClusterWorker(true, null);
    }
    
    const bw = cluster.fork();
    let sentSBW = false;

    this.workers.push(bw);

    return Promise.resolve().then(() => {
      bw.on('message', msg => {
        if (msg.cmd === 'startRequest' && !sentSBW) {
          sentSBW = true;
          
          debug('Sending SBW to ' + bw.process.pid);
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
      return Promise.resolve().then(() => {
        w.on('message', msg => {
          if (msg.cmd === 'startRequest' && !sentSSW) {
            sentSSW = true;
            const port = this.getFreePort(w.process.pid);
            
            debug('Sending SSW[' + port + '] to ' + w.process.pid);
            
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
      
      if (this.load('Config').config().startBackgroundWorker) {
        workerStartedPromises.push(Promise.resolve().then(() => this.forkBackgroundWorker()));
      }
      
      for (let i = 0; i < this.load('Config').config().wsports.length; ++i) {
        workerStartedPromises.push(Promise.resolve().then(() => this.forkStandardWorker()));
      }
      
      debug('Starting workers', process.pid, workerStartedPromises.length + ' workers');
      
      return Promise.all(workerStartedPromises);
    }).then(() => {
      debug('All workers started', process.pid);
      
      let shuttingDown = false;
      this.load('PubSub').on('shutdown', () => { shuttingDown = true; });
      
      return cluster.on('exit', (worker, code, signal) => {
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
          setTimeout(() => {
            process.exit(0);
          }, 1500);
        }
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
        this.load('DelayedQueries').enable();
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
    debug('loading', process.pid);
    
    return this.loadComponents().then(() => {
      const server = require('./server.js');
      const stserver = new server.Server({
        isBackgroundWorker: this.isBackgroundWorker
      }, this.registry.listInstances().filter(f => f instanceof api.Requestable));
      
      return stserver.initRegistryFromParent(this).then(() => stserver);
    }).then(stserver => {
      debug('loaded', process.pid);
      
      if (!this.isBackgroundWorker) {
        return stserver.start(this.port).then(() => {
          debug('Server started!', process.pid);
        });
      }
    });
  }

  loadComponents() {
    return Promise.all(this.componentModules.map(moduleName => {
      const components = require(moduleName).components;
      
      if (!components) {
        return;
      }
      
      return Promise.all(components.map(Class => {
        return this.registry.addComponentClass(Class);
      }));
    })).then(() => {
      debug('Running registry init');
      return this.registry.init();
    });
  }
}

Main.init_ = function() {
  require('events').EventEmitter.defaultMaxListeners = 0;
  require('promise-events').EventEmitter.defaultMaxListeners = 0;
  process.setMaxListeners(0);
  cluster.setMaxListeners(0);
};

exports.Main = Main;

if (require.main === module) {
  new Main().start().catch(err => {
    console.log('Starting failed: ', err);
    process.exit(1);
  });
}
