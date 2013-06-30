(function () { "use strict";

var _ = require('underscore');
var util = require('util');
var events = require('events');

function Database (options) {
	var dbmod = options['dbmod'] || require('mysql');
	this.connection = dbmod.createConnection(options['db']);
	this.connection.on('error', _.bind(function(err) {
		this.emit('error', err);
	}, this));
	
	this.connection.connect();
}
util.inherits(Database, events.EventEmitter);

Database.prototype.query = function(query, args, cb) {
	this.connection.query(query, args, cb);
}

exports.Database = Database;

})();
