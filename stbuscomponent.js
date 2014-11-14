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

STBusComponent.prototype.getServerConfig = function(cb) { this.request({name: 'getServerConfig'}, cb); };

exports.BusComponent = STBusComponent;
exports.provide   = buscomponent.provide;
exports.listener  = buscomponent.listener;
exports.needsInit = buscomponent.needsInit;
exports.errorWrap = buscomponent.errorWrap;

var provide = buscomponent.provide;

function provideW(name, args, fn) {
	return provide(name, args, fn, function(data) {
		if (data.ctx && data.reply && data.ctx.getProperty('readonly')) {
			data.reply('server-readonly');
			return true;
		}
		
		return false;
	});
};

function provideQT(name, fn)  { return provide(name, ['query', 'ctx', 'reply'], fn); };
function provideQTX(name, fn) { return provide(name, ['query', 'ctx', 'xdata', 'reply'], fn); };
function provideWQT(name, fn)  { return provideW(name, ['query', 'ctx', 'reply'], fn); };
function provideWQTX(name, fn) { return provideW(name, ['query', 'ctx', 'xdata', 'reply'], fn); };

exports.provideQT   = provideQT;
exports.provideQTX  = provideQTX;
exports.provideWQT  = provideWQT;
exports.provideWQTX = provideWQTX;

})();
