(function () { "use strict";

var _ = require('underscore');
var util = require('util');
var events = require('events');
var assert = require('assert');

function Database (options) {
	this.connection = null;
	this.reconnectTimeout = null;
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
		clearTimeout(this.reconnectTimeout);
		this.reconnectTimeout = setTimeout(_.bind(function() {
			this._init(options);
		}, this), 5000);
	}, this));
	
	this.reconnectTimeout = null;
	this.connection.connect();
}

Database.prototype.query = function(query, args, cb) {
	/*var qST = new Date().getTime();
	var xcb = function() {
		var qET = new Date().getTime();
		console.log('Query ' + query.substr(0,50) + ' in ' + (qET - qST) + ' ms (' + (qST % 3600) + ' to ' + (qET % 3600) + ')');
		cb.apply(this, arguments);
	};*/
	this.connection.query(query, args, cb);
}

Database.prototype.escape = function(str) {
	return this.connection.escape(str);
}

exports.Database = Database;

})();
