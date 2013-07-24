(function () { "use strict";

var _ = require('underscore');
var util = require('util');
var events = require('events');
var assert = require('assert');

function Database (options) {
	this.connection = null;
	this.transactions = [];
	this._init(options);
}
util.inherits(Database, events.EventEmitter);

Database.prototype.pushTransaction = function(qcb) {
	var t = new Date().getTime();
	if (this.transactions.length == 0) {
		this.query('START TRANSACTION', [], _.bind(function(err, res) {
			if (err !== null)
				return qcb(err, res);
			this.transactions.push(t);
			qcb(err, res);
		}, this));
	} else {
		if (t - this.transactions[0] > 10000)
			this.emit('error', 'Transaction not stopped within 10 seconds');
		qcb(null, []);
	}
}

Database.prototype.popTransaction = function(qcb) {
	assert.ok(this.transactions.length >= 0);
	this.transactions.shift();
	if (this.transactions.length == 0)
		this.query('COMMIT', [], qcb);
	else
		qcb(null, []);
}

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
