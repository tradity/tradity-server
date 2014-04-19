(function () { "use strict";

var _ = require('underscore');
var util = require('util');
var url = require('url');
var http = require('http');
var https = require('https');
var assert = require('assert');
var hash = require('mhash').hash;

function FileStorageDB (db, cfg) {
	this.db = db;
	this.cfg = cfg;
}
util.inherits(FileStorageDB, require('./objects.js').DBSubsystemBase);

FileStorageDB.prototype.handle = function(req, res) {
	var loc = url.parse(req.url, true);
	var fsmatch = loc.pathname.match(this.cfg.fsdb.reqregex);
	
	if (!fsmatch)
		return false;
	
	var filename = fsmatch[fsmatch.length - 1];
	
	this.query('SELECT * FROM httpresources WHERE name = ?', [filename], function(rows) {
		if (rows.length == 0) {
			res.writeHead(404, {'Content-Type': 'text/plain'});
			res.end('Not found');
			return;
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
		
		_.bind(r.proxy ? function(cont) {
			var proxyURL = r.content.toString('utf8');
			
			var httpx = proxyURL.match(/^https/) ? https : http;
			var preq = httpx.request(proxyURL, _.bind(function(pres) {
				var pheaders = _.pick(pres.headers, 'cache-control', 'expires', 'last-modified', 'source-age', 'content-type');
				
				_.each(pheaders, function(value, key) {
					headers[key.replace(/(-|^)\w/g, function(w) { return w.toUpperCase(); })] = value;
				});
				
				cont(pres.statusCode, function(res) { pres.pipe(res); });
			}, this));
		
			preq.on('error', _.bind(function(e) { this.emit('error', e); }, this));
			
			if (req.headers['if-modified-since'])
				preq.setHeader('If-Modified-Since', req.headers['if-modified-since']);
			
			preq.setHeader('User-Agent', 'tradity.de +' + hash('md5', r.hash + r.user) + ' (contact: tech@tradity.de) (NodeJS ' + process.version + ' http)');
			preq.end();
		} : function(cont) {
			headers['Content-Type'] = r.mime;
			headers['Cache-Control'] = r.cache ? 'max-age=100000000' : 'no-cache';
			headers['Last-Modified'] = new Date(r.uploadtime * 1000).toString();
			
			if (req.headers['if-modified-since']) {
				cont(304);
			} else {
				if (r.gzipped) 
					headers['Content-Encoding'] = 'gzip';
				
				cont(200, function(res) { res.end(r.content) });
			}
		}, this)(_.bind(function (status, finalize) {
			finalize = finalize || function(res) { res.end(); };
			
			if (r.headers)
				headers = _.deepupdate(headers, JSON.parse(r.headers));
			
			res.writeHead(status, headers);
			finalize(res);
		}, this));
	});
	
	return true;
}

FileStorageDB.prototype.publish = function(query, user, access, cb) {
	var content = query.content;
	var uniqrole = this.cfg.fsdb.uniqroles[query.role];
	
	query.proxy = query.proxy ? true : false;
	
	if (query.base64)
		content = new Buffer(query.content, 'base64');
	this.query('SELECT SUM(LENGTH(content)) AS total FROM httpresources WHERE user = ?', [user ? user.id : null], function(res) {
		var total = uniqrole ? 0 : res[0].total;
		
		if (!access.has('filesystem')) {
			if (content.length + total > this.cfg.fsdb.userquota)
				return cb('publish-quota-exceed');
			if (this.cfg.fsdb.allowroles.indexOf(query.role) == -1)
				return cb('publish-inacceptable-role');
				
			if (query.proxy) {
				for (var i = 0; i < this.cfg.fsdb.allowProxyURIs.length; ++i) {
					var p = this.cfg.fsdb.allowProxyURIs[i];
					assert.ok(p.regex);
					assert.ok(p.requireAccess);
					
					if (p.test(query.content)) {
						
						var hasRequiredAccess = p.requireAccess.length == 0;
						for (var i = 0; i < p.requireAccess.length; ++i) {
							if (access.has(p.requireAccess[i])) {
								hasRequiredAccess = true;
								break;
							}
						}
						
						if (!hasRequiredAccess)
							return cb('publish-proxy-not-allowed');
					}
				}
			} else {
				// local mime type is ignored for proxy requests
				
				if (this.cfg.fsdb.allowmime.indexOf(query.mime) == -1)
					return cb('publish-inacceptable-mime');
			}
		}
		
		var filehash = hash('md5', content + new Date().getTime().toString());
		query.name = query.name || filehash;
		
		var filename = (user ? user.id + '-' : '') + ((new Date().getTime()) % 8192) + '-' + query.name.replace(/[^-_+\w\.]/g, '');
		var url = this.cfg.fsdb.puburl.replace(/\{\$hostname\}/g, this.cfg.hostname).replace(/\{\$name\}/g, filename);
			
		var continueAfterDelPrevious = _.bind(function() {
			this.query('INSERT INTO httpresources(user, name, url, mime, hash, role, uploadtime, content, groupassoc, proxy) '+
				'VALUES (?, ?, ?, ?, ?, ?, UNIX_TIMESTAMP(), ?, ?, ?)',
				[user ? user.id : null, filename, url, query.mime, filehash, query.role, content, query.__groupassoc__, query.proxy], function() {
				return cb('publish-success');
			});
		}, this);
		
		if (uniqrole && user && !(access.has('filesystem') && query.retainOldFiles)) {
			var sql = 'DELETE FROM httpresources WHERE role = ? ';
			var dataarr = [query.role];
			
			for (var i = 0; i < uniqrole.length; ++i) {
				var fieldname = uniqrole[i];
				sql += 'AND `' + fieldname + '` = ? ';
				
				switch (fieldname) {
					case 'user': dataarr.push(user.id); break;
					case 'groupassoc': dataarr.push(query.__groupassoc__); break;
					default: this.emit('error', new Error('Unknown uniqrole field: ' + fieldname));
				}
			}
			
			this.query(sql, dataarr, continueAfterDelPrevious);
		} else {
			continueAfterDelPrevious();
		}
	});
}

exports.FileStorageDB = FileStorageDB;

})();
