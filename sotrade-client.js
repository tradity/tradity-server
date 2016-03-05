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

const debug = require('debug')('sotrade:s-client');
const request = require('request');

function NodeSoTradeConnection (opt) {
  opt = opt || {};
  
  const Config = require('./config.js');
  const cfg = opt.serverConfig || new Config().reloadConfig().config();
  
  if (!opt.url) {
    const port = cfg.wsporte || cfg.wsports[parseInt(Math.random() * cfg.wsports.length)];
    opt.url = cfg.protocol + '://' + (cfg.wshoste || cfg.wshost) + ':' + port + '/api/v1/';
  }
  
  try {
    if (!opt.messageSigner) {
      const SignedMessaging = require('./signedmsg.js').SignedMessaging;
      const smdb = new SignedMessaging();
      smdb.useConfig(cfg);
      opt.messageSigner = smdb;
    }
  } catch (e) {
    console.error(e);
  }
  
  let ownVersion = 'SOTS0';
  try {
    ownVersion = require('./buildstamp.js');
  } catch(e) {
    console.warn(e);
  }
  
  opt.clientSoftwareVersion = opt.clientSoftwareVersion || ownVersion;
  
  const req = request.defaults({
    baseUrl: opt.url,
    headers: {
      'User-Agent': opt.clientSoftwareVersion
    }
  });
  
  let key = null;
  
  const fn = options => {
    options = Object.assign({
      hawk: (!opt.noSignByDefault || options.__sign__) ? {
        credentials: cfg.hawk || {
          id: 'KCHpWKIpisiKqUN',
          key: cfg.db.password,
          algorithm: 'sha256'
        }
      } : undefined,
      json: true
    }, options, {
      headers: Object.assign({
        'X-Sotrade-Auth': key
      }, options.headers),
      qs: options.qs || options.cache === false ? Object.assign({
        noCache: Date.now()
      }, options.qs || {}) : undefined
    });
      
    return new Promise((resolve, reject) => {
      req(options, (err, httpResponse, body) => {
        if (err) {
          return reject(err);
        }
        
        if (!options.json &&
            httpResponse.headers['content-type'].match(/^application\/json/)) {
          try {
            body = JSON.parse(body);
          } catch (e) {}
        }
        
        if (!body) {
          body = {};
        }
        
        body._success = httpResponse.statusCode >= 200 && httpResponse.statusCode <= 299;
        
        debug('Got response with status code', httpResponse.statusCode, body._success ? '' : JSON.stringify(body));
        
        if (body.key) {
          debug('Setting session key', body.key);
          key = body.key;
        }
        
        return resolve(body);
      });
    });
  };
  
  fn.get    = (uri, opt) => fn(Object.assign({ uri: uri, method: 'GET'    }, opt || {}));
  fn.post   = (uri, opt) => fn(Object.assign({ uri: uri, method: 'POST'   }, opt || {}));
  fn.delete = (uri, opt) => fn(Object.assign({ uri: uri, method: 'DELETE' }, opt || {}));
  fn.update = (uri, opt) => fn(Object.assign({ uri: uri, method: 'UPDATE' }, opt || {}));
  fn.put    = (uri, opt) => fn(Object.assign({ uri: uri, method: 'PUT'    }, opt || {}));
  
  return fn;
}

exports.SoTradeConnection = NodeSoTradeConnection;
