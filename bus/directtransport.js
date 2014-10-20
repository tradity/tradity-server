(function () { "use strict";

var _ = require('underscore');
var events = require('events');
var assert = require('assert');
var util = require('util');

function DirectTransport(baseEmitter, weight, isLocal) {
	var self = this;
	
	assert.ok(baseEmitter);
	
	self.baseEmitter = baseEmitter;
	self.isLocal = isLocal || false;
	self.weight = weight || 1;
	
	self.on = _.bind(self.baseEmitter.on, self.baseEmitter);
	self.emit = _.bind(self.baseEmitter.emit, self.baseEmitter);
}

util.inherits(DirectTransport, events.EventEmitter);

DirectTransport.prototype.toJSON = function() {
	return _.omit(this, 'baseEmitter');
};

exports.DirectTransport = DirectTransport;

})();


