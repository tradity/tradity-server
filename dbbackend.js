(function () { "use strict";

var _ = require('underscore');
var util = require('util');
var events = require('events');
var assert = require('assert');

function Database (options) {
	this.connectionPool = null;
	this._init(options);
}
util.inherits(Database, events.EventEmitter);

Database.prototype._init = function(options) {
	this.dbmod = options['dbmod'] || require('mysql');
	this.connectionPool = this.dbmod.createPool(options['db']);
}

Database.prototype.query = function(query, args, cb) {
	this.getConnection(function(err, connection) {
		if (err)
			return cb(err, null);
		connection.query(query, args, function() {
			connection.end();
			cb.apply(this, arguments);
		});
	});
}

Database.prototype.getConnection = function(cb) {
	return this.connectionPool.getConnection(cb);
}

Database.prototype.escape = function(str) {
	return this.dbmod.escape(str);
}

exports.Database = Database;

})();
