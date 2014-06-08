(function () { "use strict";

var _ = require('underscore');
var util = require('util');
var assert = require('assert');
var events = require('events');
var os = require('os');
var hash = require('mhash').hash;

function Bus () {
	this.curId = 0;
	this.busId = this.determineBusID();
	
	this.setMaxListeners(0);
	
	this.unanswered = {};
	
	this.msgCount = 0;
	this.log = [];
	this.logSize = 4096;
	this.debugOutput = false;
}

util.inherits(Bus, events.EventEmitter);

Bus.prototype.determineBusID = function() {
	// return hash of network interfaces, hostname, process id, current time
	return hash('sha256', JSON.stringify(os.networkInterfaces()) + '|' + os.hostname() + '|' + process.pid + '|' + Date.now()).substr(0, 12);
};

Bus.prototype.emit = function(name, data) {
	++this.msgCount;
	
	this.log.push([name, data]);
	if (this.log.length > this.logSize)
		this.log.shift();
	
	if (this.debugOutput)
		console.log('emit', name, data);
	
	return events.EventEmitter.prototype.emit.apply(this, [name, data]);
};

Bus.prototype.request = function(req, onReply) {
	assert.ok(req);
	
	req = _.clone(req);
	assert.ok(req.name);
	assert.ok(!req.requestId);
	assert.ok(!req.reply);
	
	onReply = onReply || function() {};
	
	var requestId = this.busId + '-' + (++this.curId);
	req.requestId = requestId;
	var reqName = req.name;
	
	this.unanswered[req.requestId] = req;
	
	var responseListener = _.bind(function(resp) {
		assert.ok(resp.replyTo);
		if (resp.replyTo != requestId)
			return;
		
		delete this.unanswered[requestId];
		
		onReply.apply(this, resp.arguments);
		this.removeListener(reqName + '-resp', responseListener);
	}, this);
	
	this.on(req.name + '-resp', responseListener);
	
	this.emit(req.name, req);
};

Bus.prototype.unansweredRequests = function() {
	return this.unanswered;
};

Bus.prototype.registerComponent = function(name) {
	this.components.push(name);
};

Bus.prototype.stats = function() {
	return {msgCount: this.msgCount, logEntries: this.log.length, unanswered: _.keys(this.unansweredRequests()).length};
};

exports.Bus = Bus;

})();
