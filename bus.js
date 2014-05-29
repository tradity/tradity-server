(function () { "use strict";

var _ = require('underscore');
var util = require('util');
var assert = require('assert');
var events = require('events');

function Bus () {
	this.curId = 0;
	this.reservedEvents = ['request', 'response'];
	
	this.setMaxListeners(0);
	
	this.unanswered = {};
	
	this.msgCount = 0;
	this.log = [];
	this.logSize = 4096;
	this.debugOutput = false;
}

util.inherits(Bus, events.EventEmitter);

Bus.prototype.emit = function(name, data) {
	++this.msgCount;
	
	this.log.push([name, data]);
	if (this.log.length > this.logSize)
		this.log.shift();
	
	if (this.debugOutput)
		console.debug('emit', name, data);
	
	return events.EventEmitter.prototype.emit.apply(this, [name, data]);
};

Bus.prototype.request = function(req, onReply) {
	assert.ok(req);
	
	req = _.clone(req);
	assert.ok(req.name);
	assert.ok(!req.requestId);
	assert.ok(!req.reply);
	
	onReply = onReply || function() {};
	
	req.requestId = ++this.curId;
	
	if (this.listeners(req.name).length == 0 && !req.acceptDrop) {
		if (req.onDrop)
			return req.onDrop();
		else
			return this.emit('error', new Error('Rejecting bus request because there are no listeners for "' + req.name + '"'));
	} else {
		this.unanswered[req.requestId] = req;
	}
	
	req.reply = _.bind(function() {
		var args = Array.prototype.slice.call(arguments);
		this.emit('response', args, req);
		
		args.push(req);
		delete this.unanswered[req.requestId];
		
		onReply.apply(this, arguments);
	}, this);
	
	this.emit('request', req);
	this.emit(req.name, req);
};

Bus.prototype.unansweredRequests = function() {
	return this.unanswered;
};

Bus.prototype.registerComponent = function(name) {
	this.components.push(name);
};

Bus.prototype.stats = function() {
	return {msgCount: this.msgCount, logEntries: this.log.length };
};

exports.Bus = Bus;

})();
