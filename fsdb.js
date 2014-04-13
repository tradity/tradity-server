(function () { "use strict";

var _ = require('underscore');
var util = require('util');
var url = require('url');
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
			'Content-Type': r.mime,
			'Cache-Control': r.cache ? 'max-age=100000000' : 'no-cache',
			'Last-Modified': new Date(r.uploadtime * 1000).toString(),
			'Date': new Date().toString(),
			'X-Sotrade-Hash': r.hash,
			'X-Sotrade-Source-User-ID': r.user,
			'X-Sotrade-Name': r.name,
			'X-Sotrade-Role': r.role,
			'X-Sotrade-Groupassoc': r.groupassoc
		};
		
		if (r.gzipped) 
			headers['Content-Encoding'] = 'gzip';
		
		if (r.headers)
			headers = _.deepupdate(headers, JSON.parse(r.headers));
			
		res.writeHead(200, headers);
		res.end(r.content);
	});
	
	return true;
}

FileStorageDB.prototype.publish = function(query, user, access, cb) {
	var content = query.content;
	var uniqrole = this.cfg.fsdb.uniqroles[query.role];
	
	if (query.base64)
		content = new Buffer(query.content, 'base64');
	this.query('SELECT SUM(LENGTH(content)) AS total FROM httpresources WHERE user = ?', [user ? user.id : null], function(res) {
		var total = uniqrole ? 0 : res[0].total;
		if (content.length + total > this.cfg.fsdb.userquota && !access.has('filesystem'))
			return cb('publish-quota-exceed');
		if (this.cfg.fsdb.allowroles.indexOf(query.role) == -1 && !access.has('filesystem'))
			return cb('publish-inacceptable-role');
		if (this.cfg.fsdb.allowmime.indexOf(query.mime) == -1 && !access.has('filesystem'))
			return cb('publish-inacceptable-mime');
			
		var filehash = hash('md5', content);
		if (!query.name) query.name = filehash;
		var filename = (user ? user.id + '-' : '') + ((new Date().getTime()) % 8192) + '-' + query.name.replace(/[^-_+\w\.]/g, '');
		var url = this.cfg.fsdb.puburl.replace(/\{\$hostname\}/g, this.cfg.hostname).replace(/\{\$name\}/g, filename);
			
		var continueAfterDelPrevious = _.bind(function() {
			this.query('INSERT INTO httpresources(user, name, url, mime, hash, role, uploadtime, content, groupassoc) '+
				'VALUES (?, ?, ?, ?, ?, ?, UNIX_TIMESTAMP(), ?, ?)',
				[user ? user.id : null, filename, url, query.mime, filehash, query.role, content, query.__groupassoc__], function() {
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
