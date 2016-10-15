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
const promiseUtil = require('./lib/promise-util.js');
const sha256 = require('./lib/sha256.js');

/**
 * Provides the HTTP endpoint for all client connections
 * 
 * @property {object} httpServer  The associated node.js HTTP(S) server
 * @property {module:connectiondata~ConnectionData[]} clients  Full list of currently
 *                                                             active clients
 * @property {boolean} isShuttingDown  Indicates whether the serve is in shut-down mode
 * @property {int} creationTime  Unix timestamp of the object creation
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
    this.isShuttingDown = false;
    this.creationTime = Date.now() / 1000;
    
    this.msgCount = 0;
    
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
    this.apiv1IndexETag = JSON.stringify(sha256(this.apiv1Index));
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
    
    return new Promise((resolve, reject) => {
      let listenSuccess = false;
      
      const listenHandler = () => {
        this.httpServer.on('error', e => this.load('PubSub').emit('error', e));
        
        listenSuccess = true;
        resolve();
      };
      
      this.httpServer.once('error', e => {
        if (listenSuccess) { // only handle pre-listen errors
          return;
        }
        
        this.httpServer.removeListener('listening', listenHandler);
        
        if (e.code !== 'EADDRINUSE') {
          return reject(e);
        }
        
        console.log(process.pid, 'has address in use on', port, host);
        resolve(promiseUtil.delay(500).then(() => {
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
    });
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
    
    let allowedMethods = [];
    
    let handler = null;
    
    if (parsedURI.pathname.match(/^\/api\/v1/)) {
      parsedURI.pathname = parsedURI.pathname.replace(/^\/api\/v1/, '');
      
      if (parsedURI.pathname === '/api-index' || parsedURI.pathname === '/') {
        const headers = Object.assign({'ETag': this.apiv1IndexETag}, defaultHeaders);
        if (req.headers['if-none-match'] === this.apiv1IndexETag) {
          res.writeHead(304, headers);
          res.end();
        } else {
          res.writeHead(200, headers);
          res.end(this.apiv1Index);
        }
        return;
      }
      
      for (let rq of this.requestables) {
        if (rq.handledMethods().concat(['OPTIONS']).indexOf(req.method) === -1) {
          continue;
        }
        
        const uriMatch = rq.getURLMatcher().match(parsedURI.pathname);
        if (!uriMatch) {
          continue;
        }
        
        handler = () => rq.handleRequest( // jshint ignore:line
          req, res, uriMatch, parsedURI,
          defaultHeaders, this);
        
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
  
  internalServerStatistics() {
    if (typeof gc === 'function') {
      gc(); // perform garbage collection, if available (e.g. via the v8 --expose-gc option)
    }
    
    return {
      pid: process.pid,
      hostname: os.hostname(),
      isBackgroundWorker: this.info.isBackgroundWorker,
      creationTime: this.creationTime,
      msgCount: this.msgCount,
      now: Date.now()/1000,
      readonly: this.load('ReadonlyStore').readonly,
      dbstats: this.load('Database').usageStatistics()
    };
  }
}

class InternalServerStatistics extends api.Requestable {
  constructor() {
    super({
      url: '/_srvstats',
      methods: ['GET'],
      returns: [
        { code: 200 }
      ],
      requiredAccess: 'server',
      description: 'Return server status and statistics.'
    });
  }
  
  handleWithRequestInfo(query, ctx, cfg, xdata) {
    return {
      code: 200,
      data: xdata.serverInstance.internalServerStatistics()
    };
  }
}

exports.Server = SoTradeServer;
exports.components = [
  InternalServerStatistics
];
