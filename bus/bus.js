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
	this.localBusNode.emit(name, data, 'global');
};

Bus.prototype.emitLocal = function(name, data) {
	this.localBusNode.emit(name, data, 'local');
};

Bus.prototype.requestNearest =
Bus.prototype.request = function(req, onReply) {
	this.localBusNode.emit(req, onReply, 'nearest');
};

Bus.prototype.requestLocal = function(req, onReply) {
	this.localBusNode.emit(req, onReply, 'local');
};

Bus.prototype.requestGlobal = function(req, onReply) {
	this.localBusNode.emit(req, onReply, 'global');
};

Bus.prototype.removeListener = function(event, listener) {
	this.localbusnode.removeListener(event, listener);
};

Bus.prototype.on = function(event, listener, raw) {
	this.localbusnode.on(event, listener);
};

Bus.prototype.once = function(event, listener) {
	this.localbusnode.once(event, listener);
};

Bus.prototype.stats = function() {
	this.localbusnode.stats();
};

exports.Bus = Bus;

})();
