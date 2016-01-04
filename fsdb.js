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
const http = require('http');
const https = require('https');
const assert = require('assert');
const sha256 = require('./lib/sha256.js');
const deepupdate = require('./lib/deepupdate.js');
const qctx = require('./qctx.js');
const buscomponent = require('./stbuscomponent.js');
const debug = require('debug')('sotrade:fsdb');
const promiseUtil = require('./lib/promise-util.js');
const spread = promiseUtil.spread;

/**
 * Provides an interface for publishing files and downloading them via HTTP.
 * 
 * @public
 * @module fsdb
 */

/**
 * Main object of the {@link module:fsdb} module
 * @public
 * @constructor module:msdb~FileStorage
 * @augments module:stbuscomponent~STBusComponent
 */
class FileStorage extends buscomponent.BusComponent {
  constructor() {
    super();
  }
}

/**
 * Handles an HTTP file request.
 * 
 * @param {object} request  The HTTP request object.
 * @param {object} result  The HTTP result object.
 * @param {object} requestURL  A parsed version of the request URL.
 * 
 * @function busreq~handleFSDBRequest
 */
FileStorage.prototype.handle = buscomponent.provide('handleFSDBRequest', ['request', 'result', 'requestURL'], function(req, res, reqURL) {
  const ctx = new qctx.QContext({parentComponent: this});
  return this.getServerConfig().then(cfg => {
  
  const fsmatch = reqURL.pathname.match(cfg.fsdb.reqregex);
  
  if (!fsmatch) {
    return false;
  }
  
  const filename = fsmatch[fsmatch.length - 1];
  
  debug('Requested file', filename);
  
  return ctx.query('SELECT * FROM httpresources WHERE name = ?', [filename]).then(rows => {
    if (rows.length === 0) {
      res.writeHead(404, {'Content-Type': 'text/plain'});
      res.end('Not found');
      return true;
    }
    
    assert.equal(rows.length, 1);
    
    const r = rows[0];
    
    const headers = {
      'Date': new Date().toString(),
      'Access-Control-Allow-Origin': '*',
      'X-Sotrade-Hash': r.hash,
      'X-Sotrade-Source-User-ID': r.user,
      'X-Sotrade-Name': r.name,
      'X-Sotrade-Role': r.role,
      'X-Sotrade-Groupassoc': r.groupassoc,
      'X-Sotrade-Proxied': r.proxy
    };
    
    return (r.proxy ? cont => {
      const proxyURL = r.content.toString('utf8');
      
      const httpx = proxyURL.match(/^https/) ? https : http;
      const preq = httpx.request(proxyURL, pres => {
        const pheaders = _.pick(pres.headers, 'cache-control', 'expires', 'last-modified', 'source-age', 'content-type');
        
        _.each(pheaders, (value, key) => {
          headers[key.replace(/(-|^)\w/g, w => w.toUpperCase())] = value;
        });
        
        cont(pres.statusCode, res => pres.pipe(res));
      });
    
      preq.on('error', e => this.emitError(e));
      
      if (req.headers['if-modified-since']) {
        preq.setHeader('If-Modified-Since', req.headers['if-modified-since']);
      }
      
      preq.setHeader('User-Agent', cfg.userAgent);
      preq.end();
      
      return true;
    } : cont => {
      headers['Content-Type'] = r.mime;
      headers['Cache-Control'] = r.cache ? 'max-age=100000000' : 'no-cache';
      headers['Last-Modified'] = new Date(r.uploadtime * 1000).toString();
      
      if (req.headers['if-modified-since']) {
        return cont(304);
      } else {
        if (r.gzipped) {
          headers['Content-Encoding'] = 'gzip';
        }
        
        return cont(200, res => res.end(r.content));
      }
    })((status, finalize) => {
      finalize = finalize || (res => res.end());
      
      let sendHeaders = headers;
      if (r.headers) {
        sendHeaders = deepupdate(headers, JSON.parse(r.headers));
      }
      
      res.writeHead(status, sendHeaders);
      finalize(res);
    });
  });
  });
});

/**
 * Indicates the upload of files by users.
 * 
 * @typedef s2c~file-publish
 * @type {Event}
 */

/**
 * Publishes a file.
 * 
 * @param {boolean} query.proxy  Whether the content of this file is hosted remotely
 *                               and this software acts as a proxy.
 * @param {string} query.mime  The MIME type of this file.
 * @param {string} query.role  A string identifying the role of this file. Allowed roles
 *                             and user-unique roles can be specified in the server config.
 * @param {boolean} query.base64  If truthy, then decode the file content from base64.
 * @param {Buffer} query.content  The file contents (URI in case of proxy publishing).
 * 
 * @return {object} Returns with one of the following codes:
 *                  <ul>
 *                      <li><code>publish-proxy-not-allowed</code></li>
 *                      <li><code>publish-inacceptable-mime</code></li>
 *                      <li><code>publish-quota-exceed</code></li>
 *                      <li><code>publish-inacceptable-role</code></li>
 *                      <li><code>publish-success</code></li>
 *                      <li>or a common error code</li>
 *                  </ul>
 * 
 * @noreadonly
 * @function c2s~publish
 */
FileStorage.prototype.publish = buscomponent.provideW('client-publish',
  ['query', 'ctx', 'groupassoc'], function(query, ctx, groupassoc) {
  if (ctx.getProperty('readonly')) {
    throw new this.SoTradeClientError('server-readonly');
  }
  
  let content = query.content;
  let uniqrole, filehash, filename, url;
  
  debug('Upload file', query.mime, query.role);
  
  return Promise.all([
    this.getServerConfig(),
    ctx.startTransaction()
  ]).then(spread((cfg, conn) => {
  uniqrole = cfg.fsdb.uniqroles[query.role];
  
  query.proxy = query.proxy ? true : false;
  query.mime = query.mime || 'application/octet-stream';
  
  if (query.base64) {
    content = new Buffer(query.content, 'base64');
  }
  
  return conn.query('SELECT SUM(LENGTH(content)) AS total FROM httpresources WHERE uid = ? FOR UPDATE',
    [ctx.user ? ctx.user.uid : null]).then(res => {
    const total = uniqrole ? 0 : res[0].total;
    
    if (!ctx.access.has('filesystem')) {
      if (content.length + total > cfg.fsdb.userquota) {
        throw new this.SoTradeClientError('publish-quota-exceed');
      }
      
      if (cfg.fsdb.allowroles.indexOf(query.role) === -1) {
        throw new this.SoTradeClientError('publish-inacceptable-role');
      }
        
      if (query.proxy) {
        let hasRequiredAccess = false;
        
        for (let i = 0; i < cfg.fsdb.allowProxyURIs.length && !hasRequiredAccess; ++i) {
          const p = cfg.fsdb.allowProxyURIs[i];
          assert.ok(p.regex);
          assert.ok(p.requireAccess);
          
          const match = query.content.match(p.regex);
          if (match) {
            if (typeof p.requireAccess === 'function') {
              hasRequiredAccess = p.requireAccess(ctx, match);
            } else {
              hasRequiredAccess = p.requireAccess.length === 0;
              for (let i = 0; i < p.requireAccess.length; ++i) {
                if (ctx.access.has(p.requireAccess[i])) {
                  hasRequiredAccess = true;
                  break;
                }
              }
            }
          }
        }
        
        if (!hasRequiredAccess) {
          throw new this.SoTradeClientError('publish-proxy-not-allowed');
        }
      } else {
        // local mime type is ignored for proxy requests
        
        if (cfg.fsdb.allowmime.indexOf(query.mime) === -1) {
          throw new this.SoTradeClientError('publish-inacceptable-mime');
        }
      }
    }
    
    filehash = sha256(content + String(Date.now())).substr(0, 32);
    query.name = query.name ? String(query.name) : filehash;
    
    filename = (ctx.user ? ctx.user.uid + '-' : '') + ((Date.now()) % 8192) + '-' + query.name.replace(/[^-_+\w\.]/g, '');
    url = cfg.varReplace(cfg.fsdb.puburl.replace(/\{\$name\}/g, filename));
    
    groupassoc = parseInt(groupassoc);
    if (groupassoc !== groupassoc) { // NaN
      groupassoc = null;
    }
    
    if (uniqrole && ctx.user && !(ctx.access.has('filesystem') && query.retainOldFiles)) {
      let sql = 'DELETE FROM httpresources WHERE role = ? ';
      let dataarr = [String(query.role)];
      
      for (let i = 0; i < uniqrole.length; ++i) {
        const fieldname = uniqrole[i];
        sql += 'AND `' + fieldname + '` = ? ';
        
        switch (fieldname) {
          case 'uid': dataarr.push(ctx.user.uid); break;
          case 'groupassoc': dataarr.push(groupassoc); break;
          default: this.emitError(new Error('Unknown uniqrole field: ' + fieldname));
        }
      }
      
      return conn.query(sql, dataarr);
    }
  }).then(() => {
    return conn.query('INSERT INTO httpresources(uid, name, url, mime, hash, role, uploadtime, content, groupassoc, proxy) '+
      'VALUES (?, ?, ?, ?, ?, ?, UNIX_TIMESTAMP(), ?, ?, ?)',
      [ctx.user ? ctx.user.uid : null, filename, url, query.mime ? String(query.mime) : null, filehash,
      String(query.role), content, groupassoc, query.proxy ? 1:0]);
  }).then(res => {
    if (ctx.user) {
      return ctx.feed({
        'type': 'file-publish',
        'targetid': res.insertId,
        'srcuser': ctx.user.uid,
        'conn': conn
      });
    }
  }).then(conn.commit, conn && conn.rollbackAndThrow);
  })).then(() => {
    return { code: 'publish-success', extra: 'repush' };
  });
});

exports.FileStorage = FileStorage;
