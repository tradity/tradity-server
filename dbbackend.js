(function () { "use strict";

var _ = require('underscore');
var util = require('util');
var events = require('events');

function Database (options) {
	this.connection = null;
	this._init(options);
}
util.inherits(Database, events.EventEmitter);

Database.prototype._init = function(options) {
	var dbmod = options['dbmod'] || require('mysql');
	this.connection = dbmod.createConnection(options['db']);
	this.connection.on('error', _.bind(function(err) {
		this.emit('error', err);
	}, this));
	this.connection.on('end', _.bind(function(err) {
		setTimeout(_.bind(function() {
			this._init(options);
		}, this), 500);
	}, this));
	
	this.connection.connect();
}

Database.prototype.query = function(query, args, cb) {
	this.connection.query(query, args, cb);
}

Database.prototype.escape = function(str) {
	return this.connection.escape(str);
}

exports.Database = Database;

})();
