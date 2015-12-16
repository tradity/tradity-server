(function () { "use strict";

var _ = require('lodash');
var util = require('util');
var http = require('http');
var https = require('https');
var assert = require('assert');
var Q = require('q');
var sha256 = require('./lib/sha256.js');
var deepupdate = require('./lib/deepupdate.js');
var qctx = require('./qctx.js');
var buscomponent = require('./stbuscomponent.js');
var debug = require('debug')('sotrade:fsdb');

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
	var self = this;
	
	var ctx = new qctx.QContext({parentComponent: self});
	return self.getServerConfig().then(function(cfg) {
	
	var fsmatch = reqURL.pathname.match(cfg.fsdb.reqregex);
	
	if (!fsmatch)
		return false;
	
	var filename = fsmatch[fsmatch.length - 1];
	
	debug('Requested file', filename);
	
	return ctx.query('SELECT * FROM httpresources WHERE name = ?', [filename]).then(function(rows) {
		if (rows.length == 0) {
			res.writeHead(404, {'Content-Type': 'text/plain'});
			res.end('Not found');
			return true;
		}
		
		assert.equal(rows.length, 1);
		
		var r = rows[0];
		
		var headers = {
			'Date': new Date().toString(),
			'Access-Control-Allow-Origin': '*',
			'X-Sotrade-Hash': r.hash,
			'X-Sotrade-Source-User-ID': r.user,
			'X-Sotrade-Name': r.name,
			'X-Sotrade-Role': r.role,
			'X-Sotrade-Groupassoc': r.groupassoc,
			'X-Sotrade-Proxied': r.proxy
		};
		
		return (r.proxy ? function(cont) {
			var proxyURL = r.content.toString('utf8');
			
			var httpx = proxyURL.match(/^https/) ? https : http;
			var preq = httpx.request(proxyURL, function(pres) {
				var pheaders = _.pick(pres.headers, 'cache-control', 'expires', 'last-modified', 'source-age', 'content-type');
				
				_.each(pheaders, function(value, key) {
					headers[key.replace(/(-|^)\w/g, function(w) { return w.toUpperCase(); })] = value;
				});
				
				cont(pres.statusCode, function(res) { pres.pipe(res); });
			});
		
			preq.on('error', function(e) { self.emitError(e); });
			
			if (req.headers['if-modified-since'])
				preq.setHeader('If-Modified-Since', req.headers['if-modified-since']);
			
			preq.setHeader('User-Agent', cfg.userAgent);
			preq.end();
			
			return true;
		} : function(cont) {
			headers['Content-Type'] = r.mime;
			headers['Cache-Control'] = r.cache ? 'max-age=100000000' : 'no-cache';
			headers['Last-Modified'] = new Date(r.uploadtime * 1000).toString();
			
			if (req.headers['if-modified-since']) {
				return cont(304);
			} else {
				if (r.gzipped) 
					headers['Content-Encoding'] = 'gzip';
				
				return cont(200, function(res) { res.end(r.content) });
			}
		})(function (status, finalize) {
			finalize = finalize || function(res) { res.end(); };
			
			if (r.headers)
				headers = deepupdate(headers, JSON.parse(r.headers));
			
			res.writeHead(status, headers);
			finalize(res);
		});
	});
	
	return true;
	
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
	var self = this;
	
	if (ctx.getProperty('readonly'))
		throw new self.SoTradeClientError('server-readonly');
	
	var content = query.content;
	var uniqrole, filehash, filename, url, content;
	
	debug('Upload file', query.mime, query.role);
	
	return Q.all([
		self.getServerConfig(),
		ctx.startTransaction()
	]).spread(function(cfg, conn) {
	uniqrole = cfg.fsdb.uniqroles[query.role];
	
	query.proxy = query.proxy ? true : false;
	query.mime = query.mime || 'application/octet-stream';
	
	if (query.base64)
		content = new Buffer(query.content, 'base64');
	
	return conn.query('SELECT SUM(LENGTH(content)) AS total FROM httpresources WHERE uid = ? FOR UPDATE',
		[ctx.user ? ctx.user.uid : null]).then(function(res) {
		var total = uniqrole ? 0 : res[0].total;
		
		if (!ctx.access.has('filesystem')) {
			if (content.length + total > cfg.fsdb.userquota)
				throw new self.SoTradeClientError('publish-quota-exceed');
			if (cfg.fsdb.allowroles.indexOf(query.role) == -1)
				throw new self.SoTradeClientError('publish-inacceptable-role');
				
			if (query.proxy) {
				var hasRequiredAccess = false;
				
				for (var i = 0; i < cfg.fsdb.allowProxyURIs.length && !hasRequiredAccess; ++i) {
					var p = cfg.fsdb.allowProxyURIs[i];
					assert.ok(p.regex);
					assert.ok(p.requireAccess);
					
					var match = query.content.match(p.regex);
					if (match) {
						if (typeof p.requireAccess == 'function') {
							hasRequiredAccess = p.requireAccess(ctx, match);
						} else {
							hasRequiredAccess = p.requireAccess.length == 0;
							for (var i = 0; i < p.requireAccess.length; ++i) {
								if (ctx.access.has(p.requireAccess[i])) {
									hasRequiredAccess = true;
									break;
								}
							}
						}
					}
				}
				
				if (!hasRequiredAccess)
					throw new self.SoTradeClientError('publish-proxy-not-allowed');
			} else {
				// local mime type is ignored for proxy requests
				
				if (cfg.fsdb.allowmime.indexOf(query.mime) == -1)
					throw new self.SoTradeClientError('publish-inacceptable-mime');
			}
		}
		
		filehash = sha256(content + String(Date.now())).substr(0, 32);
		query.name = query.name ? String(query.name) : filehash;
		
		filename = (ctx.user ? ctx.user.uid + '-' : '') + ((Date.now()) % 8192) + '-' + query.name.replace(/[^-_+\w\.]/g, '');
		url = cfg.varReplace(cfg.fsdb.puburl.replace(/\{\$name\}/g, filename));
		
		groupassoc = parseInt(groupassoc) == groupassoc ? parseInt(groupassoc) : null;
		
		if (uniqrole && ctx.user && !(ctx.access.has('filesystem') && query.retainOldFiles)) {
			var sql = 'DELETE FROM httpresources WHERE role = ? ';
			var dataarr = [String(query.role)];
			
			for (var i = 0; i < uniqrole.length; ++i) {
				var fieldname = uniqrole[i];
				sql += 'AND `' + fieldname + '` = ? ';
				
				switch (fieldname) {
					case 'uid': dataarr.push(ctx.user.uid); break;
					case 'groupassoc': dataarr.push(groupassoc); break;
					default: self.emitError(new Error('Unknown uniqrole field: ' + fieldname));
				}
			}
			
			return conn.query(sql, dataarr);
		}
	}).then(function() {
		return conn.query('INSERT INTO httpresources(uid, name, url, mime, hash, role, uploadtime, content, groupassoc, proxy) '+
			'VALUES (?, ?, ?, ?, ?, ?, UNIX_TIMESTAMP(), ?, ?, ?)',
			[ctx.user ? ctx.user.uid : null, filename, url, query.mime ? String(query.mime) : null, filehash,
			String(query.role), content, groupassoc, query.proxy ? 1:0]);
	}).then(function(res) {
		if (ctx.user) {
			return ctx.feed({
				'type': 'file-publish',
				'targetid': res.insertId,
				'srcuser': ctx.user.uid,
				'conn': conn
			});
		}
		
		return Q();
	}).then(conn.commit, conn && conn.rollbackAndThrow);
	}).then(function() {
		return { code: 'publish-success', extra: 'repush' };
	});
});

exports.FileStorage = FileStorage;

})();
