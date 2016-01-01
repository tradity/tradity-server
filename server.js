"use strict";

const _ = require('lodash');
const os = require('os');
const assert = require('assert');
const http = require('http');
const https = require('https');
const url = require('url');
const sio = require('socket.io');
const debug = require('debug')('sotrade:server');
const buscomponent = require('./stbuscomponent.js');
const qctx = require('./qctx.js');
const ConnectionData = require('./connectiondata.js').ConnectionData;
const promiseUtil = require('./lib/promise-util.js');
const spread = promiseUtil.spread;

/**
 * Provides the HTTP backend for all client connections
 * 
 * @public
 * @module server
 */

/**
 * Controller for socket clients
 * 
 * @property {object} httpServer  The associated node.js HTTP(S) server
 * @property {object} io  The socket.io instance listening for incoming sockets
 * @property {module:connectiondata~ConnectionData[]} clients  Full list of currently
 *                                                             active clients
 * @property {boolean} isShuttingDown  Indicates whether the serve is in shut-down mode
 * @property {int} creationTime  Unix timestamp of the object creation
 * @property {int} deadQueryCount  Total number of queries of disconnected clients
 * @property {int} deadQueryCompressionInfo  Statistical compression support information 
 *                                           of disconnected clients
 * @property {int} connectionCount  Total number of client connections
 * 
 * @public
 * @constructor module:server~SoTradeServer
 * @augments module:stbuscomponent~STBusComponent
 */
class SoTradeServer extends buscomponent.BusComponent {
  constructor(info) {
    super();
    
    this.httpServer = null;
    this.io = null;
    this.clients = [];
    this.isShuttingDown = false;
    this.creationTime = Date.now() / 1000;
    
    this.deadQueryCount = 0;
    this.deadQueryCompressionInfo = {
      supported: {lzma: 0, s: 0},
      used: {lzma: 0, s: 0, si: 0}
    };
    
    this.connectionCount = 0;
    this.info = info || {};
  }
}

/**
 * Return general and statistical information on this server instance
 * 
 * @param {boolean} qctxDebug  Whether to include debugging information on the local QContexts
 * 
 * @return {object} Returns with most information on a {module:server~SoTradeServer} object
 * @function busreq~internalServerStatistics
 */
SoTradeServer.prototype.internalServerStatistics = buscomponent.provide('internalServerStatistics',
  ['qctxDebug'], function(qctxDebug)
{
  if (typeof gc === 'function') {
    gc(); // perform garbage collection, if available (e.g. via the v8 --expose-gc option)
  }
  
  const ret = {
    pid: process.pid,
    hostname: os.hostname(),
    isBackgroundWorker: this.info.isBackgroundWorker,
    creationTime: this.creationTime,
    clients: this.clients.map(x => x.stats()),
    bus: this.bus.stats(),
    msgCount: this.msgCount,
    msgLZMACount: this.msgLZMACount,
    connectionCount: this.connectionCount,
    deadQueryCount: this.deadQueryCount,
    deadQueryCompressionInfo: this.deadQueryCompressionInfo,
    deadQueryLZMACount: this.deadQueryCompressionInfo.supported.lzma, // backwards compatibility
    deadQueryLZMAUsedCount: this.deadQueryCompressionInfo.used.lzma, // backwards compatibility
    now: Date.now(),
    qcontexts: qctxDebug ? qctx.QContext.getMasterQueryContext().getStatistics(true) : null
  };
  
  return Promise.all([
    this.request({name: 'get-readability-mode'}),
    this.request({name: 'dbUsageStatistics'})
  ]).then(spread((readonlyReply, dbstats) => {
    ret.readonly = readonlyReply.readonly;
    ret.dbstats = dbstats;
    
    debug('Collected internal server statistics', ret.bus.id);
    return ret;
  }));
});

/**
 * Set up the server for listening on HTTP
 * 
 * @param {int} port  The port for this server to listen on
 * 
 * @function module:server~SoTradeServer#start
 */
SoTradeServer.prototype.start = function(port) {
  assert.ok(port);
  debug('Start listening', port);
  
  let cfg;
  
  return this.getServerConfig().then(cfg_ => {
    cfg = cfg_;
    
    if (cfg.protocol === 'https') {
      this.httpServer = https.createServer(cfg.http);
    } else {
      this.httpServer = http.createServer();
    }
    
    this.httpServer.on('request', (req, res) => this.handleHTTPRequest(req, res));
    
    return this.listen(port, cfg.wshost);
  }).then(() => {
    this.io = sio.listen(this.httpServer, cfg.configureSocketIO(sio, cfg));
    debug('socket.io set up', process.pid, 'port ' + port);
    
    this.io.sockets.on('connection', socket => this.handleConnection(socket));
  });
};

/**
 * Set up the server for listening
 * 
 * @param {int} port  The port for this server to listen on
 * @param {string} host  The host to listen on
 * 
 * @return {object}  A Promise fulfilled when the server is fully available
 * 
 * @function module:server~SoTradeServer#listen
 */
SoTradeServer.prototype.listen = function(port, host) {
  assert.ok(port);
  
  const deferred = Promise.defer();
  
  let listenSuccess = false;
  
  const listenHandler = () => {
    this.httpServer.on('error', e => this.emitError(e));
    
    listenSuccess = true;
    deferred.resolve();
  };
  
  this.httpServer.once('error', e => {
    if (listenSuccess) { // only handle pre-listen errors
      return;
    }
    
    this.httpServer.removeListener('listening', listenHandler);
    
    if (e.code !== 'EADDRINUSE') {
      return deferred.reject(e);
    }
    
    console.log(process.pid, 'has address in use on', port, host);
    deferred.resolve(promiseUtil.delay(500).then(() => {
      try {
        this.httpServer.close();
      } catch(e2) {
        console.warn(e2);
      }
      
      return this.listen(port, host);
    }));
  });
  
  this.httpServer.addListener('listening', listenHandler);
  
  process.nextTick(() => {
    debug('listening', process.pid, 'port ' + port, 'host ' + host);
    this.httpServer.listen(port, host);
  });
  
  return deferred.promise;
};

/**
 * Handles a single HTTP request in the format of standard
 * node.js HTTP handlers.
 * 
 * @function module:server~SoTradeServer#handleHTTPRequest
 */
SoTradeServer.prototype.handleHTTPRequest = function(req, res) {
  debug('HTTP Request', req.url);
  
  const loc = url.parse(req.url, true);
  if (loc.pathname.match(/^(\/dynamic)?\/?ping/)) {
    res.writeHead(200, {'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*'});
    res.end('pong');
    return;
  }
  
  if (loc.pathname.match(/^(\/dynamic)?\/?statistics/)) {
    return this.request({name: 'gatherPublicStatistics'}).then(result => {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*', 'Cache-Control': 
        'max-age=500'
      });
      
      res.end(JSON.stringify(result));
    });
  }
  
  this.request({name: 'handleFSDBRequest', 
    request: req,
    result: res,
    requestURL: loc
  }).then(isBeingHandled => {
    if (!isBeingHandled) {
      res.writeHead(404, {'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*'});
      res.end('Hi (not really found)!');
    }
  });
};

/**
 * Handles an incoming connection in the format of standard
 * socket.io connection handlers.
 * 
 * @function module:server~SoTradeServer#handleConnection
 */
SoTradeServer.prototype.handleConnection = function(socket) {
  debug('Incoming connection');
  
  assert.ok(this.bus);
  
  this.connectionCount++;
  
  const d = new ConnectionData(socket);
  assert.ok(d.cdid);
  d.setBus(this.bus, 'cdata-' + d.cdid);
  this.clients.push(d);
};

/**
 * Removes a connection from this server’s list of clients.
 * 
 * @property id  The {module:connectiondata~ConnectionData} identifier
 * 
 * @function busreq~deleteConnectionData
 */
SoTradeServer.prototype.removeConnection = buscomponent.provide('deleteConnectionData', ['id'], function(id) {
  debug('Remove connection', id);
  
  const removeClient = _.find(this.clients, client => client.cdid === id);
  
  if (removeClient) {
    this.clients = _.without(this.clients, removeClient);
    this.deadQueryCount          += removeClient.queryCount;
    
    for (let i in removeClient.queryCompressionInfo.supported) {
      this.deadQueryCompressionInfo.supported[i] += removeClient.queryCompressionInfo.supported[i];
    }
    
    for (let i in removeClient.queryCompressionInfo.used) {
      this.deadQueryCompressionInfo.used[i] += removeClient.queryCompressionInfo.used[i];
    }
  }
  
  if (this.isShuttingDown) {
    return this.shutdown();
  }
});

/**
 * Sets this server instance into shutdown mode.
 * 
 * @function module:server~SoTradeServer#shutdown
 */
SoTradeServer.prototype.shutdown = buscomponent.listener(['localShutdown', 'globalShutdown'], function() {
  debug('Server shutdown');
  
  this.isShuttingDown = true;
  
  if (this.clients.length === 0) {
    this.emitImmediate('localMasterShutdown').catch(e => {
      console.error(e);
    });
    
    if (this.httpServer) {
      this.httpServer.close();
    }
    
    return this.unplugBus();
  }
});

/**
 * Dummy listener.
 * 
 * This only exists to inform other bus nodes that we handle the
 * <code>push-events</code> event for cases in which there are no
 * {module:connectiondata~ConnectionData} instances.
 * 
 * @function module:server~SoTradeServer#dummyListener
 */
SoTradeServer.prototype.dummyListener = buscomponent.listener(['push-events'], function() {
});

exports.SoTradeServer = SoTradeServer;
