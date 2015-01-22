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

exports.BusComponent = STBusComponent;
exports.provide   = buscomponent.provide;
exports.listener  = buscomponent.listener;
exports.needsInit = buscomponent.needsInit;

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

function provideQT(name, fn) { return provide(name, ['query', 'ctx', 'xdata'], fn); };
function provideWQT(name, fn) { return provideW(name, ['query', 'ctx', 'xdata'], fn); };

exports.provideW    = provideW;
exports.provideQT   = provideQT;
exports.provideWQT  = provideWQT;

})();
