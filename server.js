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

const os = require('os');
const assert = require('assert');
const http = require('http');
const https = require('https');
const url = require('url');
const debug = require('debug')('sotrade:server');
const api = require('./api.js');
const qctx = require('./qctx.js');
const promiseUtil = require('./lib/promise-util.js');

/**
 * Provides the HTTP endpoint for all client connections
 * 
 * @property {object} httpServer  The associated node.js HTTP(S) server
 * @property {module:connectiondata~ConnectionData[]} clients  Full list of currently
 *                                                             active clients
 * @property {boolean} isShuttingDown  Indicates whether the serve is in shut-down mode
 * @property {int} creationTime  Unix timestamp of the object creation
 * @property {int} deadQueryCount  Total number of queries of disconnected clients
 * @property {int} connectionCount  Total number of client connections
 * 
 * @public
 */
class SoTradeServer extends api.Component {
  constructor(info, requestables) {
    super({
      anonymous: true,
      description: 'Provides the HTTP endpoint for all client connections',
      depends: ['Database', 'ReadonlyStore']
    });
    
    this.httpServer = null;
    this.clients = [];
    this.isShuttingDown = false;
    this.creationTime = Date.now() / 1000;
    
    this.deadQueryCount = 0;
    
    this.connectionCount = 0;
    this.info = info || {};
    this.requestables = requestables;
    
    this.apiv1Index = JSON.stringify({
      code: 200,
      name: 'API v1 index',
      data: {
        listing: this.requestables.map(rq => {
          return {
            info: Object.assign({}, rq.options, {
              depends: undefined,
              writing: undefined,
              transactional: undefined
            })
          };
        })
      }
    });
  }
  
  internalServerStatistics(qctxDebug) {
    if (typeof gc === 'function') {
      gc(); // perform garbage collection, if available (e.g. via the v8 --expose-gc option)
    }
    
    return {
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
      now: Date.now(),
      qcontexts: qctxDebug ? qctx.QContext.getMasterQueryContext().getStatistics(true) : null,
      readonly: this.load('ReadonlyStore').readonly,
      dbstats: this.load('Database').usageStatistics()
    };
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
    
    return this.listen(port, cfg.wshost);
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
      this.httpServer.on('error', e => this.load('PubSub').emit('error', e));
      
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
    const defaultHeaders = {
      'Cache-Control': 'private, max-age=0, no-cache',
      'Content-Type': 'application/json; charset=utf-8'
    };
    
    if (req.headers['origin']) {
      Object.assign(defaultHeaders, {
        'Access-Control-Allow-Origin': req.headers['origin'],
        'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Authorization,X-Sotrade-Auth,Accept-Encoding,If-Modified-Since'
      });
    }
    
    debug('HTTP Request', req.method, req.url);
    
    const parsedURI = url.parse(req.url, true);
    
    if (parsedURI.pathname.match(/^\/dynamic\/files\//)) {
      // backwards compability
      parsedURI.pathname = '/api/v1' + parsedURI.pathname;
    }
    
    let handled = false;
    let allowedMethods = [];
    
    let handler = null;
    
    if (parsedURI.pathname.match(/^\/api\/v1/)) {
      parsedURI.pathname = parsedURI.pathname.replace(/^\/api\/v1/, '');
      
      if (parsedURI.pathname === '/index' || parsedURI.pathname === '/') {
        res.writeHead(200, {'Content-Type': 'application/json;charset=utf-8'});
        res.end(this.apiv1Index);
      }
      
      for (let rq of this.requestables) {
        if (rq.handledMethods().concat(['OPTIONS']).indexOf(req.method) === -1) {
          continue;
        }
        
        const uriMatch = rq.getURLMatcher().match(parsedURI.pathname);
        if (!uriMatch) {
          continue;
        }
        
        handler = () => rq.handleRequest(req, res, uriMatch, parsedURI, defaultHeaders);
        allowedMethods = allowedMethods.concat(rq.handledMethods());
      }
    }
    
    defaultHeaders['Allow'] = allowedMethods.join(',').toUpperCase();
    defaultHeaders['Access-Control-Allow-Methods'] = allowedMethods.join(',').toUpperCase();
    
    if (handler !== null) {
      if (req.method !== 'OPTIONS') {
        handler();
      } else {
        defaultHeaders['Content-Type'] = 'text/plain;charset=utf-8';
        res.writeHead(200, defaultHeaders);
        res.end();
      }
    } else {
      debug('No handler for URI', parsedURI.pathname);
      res.writeHead(404, {'Content-Type': 'application/json;charset=utf-8'});
      res.end(JSON.stringify({
        code: 404,
        identifier: 'unknown-uri'
      }));
    }
  }
}

exports.Server = SoTradeServer;
