(function () { "use strict";

var _ = require('underscore');
var util = require('util');
var localbusnode = require('./localbusnode.js');

function Bus() {
	this.localBusNode = new localbusnode.LocalBusNode();
	
	this.setMaxListeners(0);
}

util.inherits(Bus, events.EventEmitter);

Bus.prototype.emitGlobal =
Bus.prototype.emit = function(name, data) {
	...
};

Bus.prototype.emitLocal = function(name, data) {
	...
};

Bus.prototype.requestNearest =
Bus.prototype.request = function(req, onReply) {
	...
};

Bus.prototype.requestLocal = function(req, onReply) {
	...
};

Bus.prototype.requestGlobal = function(req, onReply) {
	...
};

Bus.prototype.removeListener = function(event, listener) {
	...
};

Bus.prototype.on = function(event, listener, raw) {
	...
};

Bus.prototype.once = function(event, listener) {
	...
};

Bus.prototype.stats = function() {
	...
};

exports.Bus = Bus;

})();
