(function () { "use strict";

var _ = require('underscore');
var events = require('events');
var assert = require('assert');

function ProcessTransport(processObject, weight) {
	assert.ok(processObject);
	
	this.processObject = processObject;
	this.weight = weight || 1;
	
	this.processObject.on('message', function(msg) {
		if (msg.type != 'tmsg')
			return;
		
		return events.EventEmitter.prototype.emit.apply(this, [msg.name, msg.data]);
	});
	
	this.processObject.on('disconnect', function() {
		return events.EventEmitter.prototype.emit.apply(this, ['disconnect']);
	});
}

util.inherits(Bus, events.EventEmitter);

ProcessTransport.prototype.emit = function(name, data) {
	this.processObject.send({type: 'tmsg', name: name, data: data});
	
	return events.EventEmitter.prototype.emit.apply(this, [name, data]);
};

exports.ProcessTransport = ProcessTransport;

})();


