(function () { "use strict";

var util = require('util');
var _ = require('lodash');

var buscomponent = require('./bus/buscomponent.js');

/**
 * Provides Tradity-specific extensions to the general {@link module:buscomponent} module
 * @public
 * @module stbuscomponent
 */

/**
 * Main object of the {@link module:stbuscomponent} module
 * @public
 * @constructor module:stbuscomponent~STBusComponent
 * @augments module:buscomponent~BusComponent
 */
function STBusComponent () {
	STBusComponent.super_.apply(this, arguments);
}

util.inherits(STBusComponent, buscomponent.BusComponent);

STBusComponent.prototype.getServerConfig = function() { return this.request({name: 'getServerConfig'}); };

exports.provide   = buscomponent.provide;
exports.listener  = buscomponent.listener;
exports.needsInit = buscomponent.needsInit;

var provide = buscomponent.provide;

function provideW(name, args, fn) {
	return provide(name, args, fn, function(data) {
		if (data.ctx && data.reply && data.ctx.getProperty('readonly')) {
			data.reply({ code: 'server-readonly' });
			return true;
		}
		
		return false;
	});
};

function provideQT(name, fn) { return provide(name, ['query', 'ctx', 'xdata'], fn); };
function provideWQT(name, fn) { return provideW(name, ['query', 'ctx', 'xdata'], fn); };

exports.provideW    = provideW;
exports.provideQT   = provideQT;
exports.provideWQT  = provideWQT;

// inheriting from Error is pretty ugly
function SoTradeClientError(code, msg) {
	var tmp = Error.call(this, code);
	tmp.name = this.name = 'SoTradeClientError';
	this.message = msg || tmp.message;
	this.code = code;
	this.busTransmitAsJSON = true;
	this.stack = tmp.stack;
	
	return this;
};

var IntermediateInheritor = function() {};
IntermediateInheritor.prototype = Error.prototype;
SoTradeClientError.prototype = new IntermediateInheritor();

SoTradeClientError.prototype.toJSON = function() {
	return _.pick(this, 'name', 'message', 'code');
};

STBusComponent.prototype.SoTradeClientError = SoTradeClientError;

function PermissionDenied (msg) {
	PermissionDenied.super_.call(this, 'permission-denied', msg);
}

util.inherits(PermissionDenied, SoTradeClientError);
STBusComponent.prototype.PermissionDenied = PermissionDenied;

function FormatError(msg) {
	FormatError.super_.call(this, 'format-error', msg);
}

util.inherits(FormatError, SoTradeClientError);
STBusComponent.prototype.FormatError = FormatError;

exports.BusComponent = STBusComponent;
})();
