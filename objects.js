(function () { "use strict";

var util = require('util');
var events = require('events');
var _ = require('underscore');

function DBSubsystemBase () {
	this.db = null;
}
util.inherits(DBSubsystemBase, events.EventEmitter);

DBSubsystemBase.prototype.dbevent = function(name, data, access) {
	this.emit('dbevent', {name:name, data:data, access:access});
}

DBSubsystemBase.prototype.query = function(query, data, cb) {
	data = data || [];
	
	this.db.query(query, data, this.queryCallback(cb, query));
}

DBSubsystemBase.prototype.queryCallback = function(cb, query) {
	if (!cb)
		return (function() {});
	
	return _.bind(function(err, res) {
		if (err) 
			this.emit('error', query ? new Error(err + '\nCaused by <<' + query + '>>') : err);
		else
			_.bind(cb, this)(res);
	}, this);
}

exports.DBSubsystemBase = DBSubsystemBase;

})();
