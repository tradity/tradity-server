(function () { "use strict";

var _ = require('underscore');
var events = require('events');
var assert = require('assert');
var util = require('util');

function ProcessTransport(processObject, weight) {
	var self = this;
	
	assert.ok(processObject);
	
	self.processObject = processObject;
	self.isLocal = true;
	self.weight = weight || 1;
	
	self.processObject.on('message', function(msg) {
		if (msg.type != 'tmsg')
			return;
		
		return events.EventEmitter.prototype.emit.apply(self, [msg.name, msg.data]);
	});
	
	self.processObject.on('disconnect', function() {
		return events.EventEmitter.prototype.emit.apply(self, ['disconnect']);
	});
}

util.inherits(ProcessTransport, events.EventEmitter);

ProcessTransport.prototype.emit = function(name, data) {
	this.processObject.send({type: 'tmsg', name: name, data: data});
	
	return events.EventEmitter.prototype.emit.apply(this, [name, data]);
};

exports.ProcessTransport = ProcessTransport;

})();


