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
const os = require('os');
const assert = require('assert');
const http = require('http');
const https = require('https');
const url = require('url');
const sio = require('socket.io');
const debug = require('debug')('sotrade:server');
const api = require('./api.js');
const qctx = require('./qctx.js');
const ConnectionData = require('./connectiondata.js').ConnectionData;
const promiseUtil = require('./lib/promise-util.js');
const spread = promiseUtil.spread;

/**
 * Provides the HTTP endpoint for all client connections
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
 */
class SoTradeServer extends api.Component {
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
  
  internalServerStatistics(qctxDebug) {
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
  }

  /**
   * Set up the server for listening on HTTP
   * 
   * @param {int} port  The port for this server to listen on
   */
  start(port) {
    assert.ok(port);
    debug('Start listening', port);
    
    const cfg = this.load('Config').config();
    
    if (cfg.protocol === 'https') {
      this.httpServer = https.createServer(cfg.http);
    } else {
      this.httpServer = http.createServer();
    }
    
    this.httpServer.on('request', (req, res) => this.handleHTTPRequest(req, res));
    
    return this.listen(port, cfg.wshost).then(() => {
      this.io = sio.listen(this.httpServer, cfg.configureSocketIO(sio, cfg));
      debug('socket.io set up', process.pid, 'port ' + port);
      
      this.io.sockets.on('connection', socket => this.handleConnection(socket));
    });
  }

  /**
   * Set up the server for listening
   * 
   * @param {int} port  The port for this server to listen on
   * @param {string} host  The host to listen on
   * 
   * @return {object}  A Promise fulfilled when the server is fully available
   */
  listen(port, host) {
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
  }

  /**
   * Handles a single HTTP request in the format of standard
   * Node.js HTTP handlers.
   */
  handleHTTPRequest(req, res) {
    debug('HTTP Request', req.url);
    
    const loc = url.parse(req.url, true);
    let handled = false;
    for (let rq of this.requestables) {
      const uriMatch = rq.getURLMatcher().match(loc.pathname);
      if (!uriMatch) {
        continue;
      }
      
      handled = true;
      rq.handleRequest(req, res, uriMatch);
    }
    
    if (!handled) {
      res.writeHead(404, {'Content-Type': 'application/json;charset=utf-8'});
      res.write(JSON.stringify({
        code: 404,
        identifier: 'unknown-uri'
      }));
    }
  }

  /**
   * Sets this server instance into shutdown mode.
   */
  // XXX was listener for localShutdown, globalShutdown
  shutdown() {
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
}

exports.components = [
  SoTradeServer
];
