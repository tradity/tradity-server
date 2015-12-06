'use strict';

require('../common.js');
const bus = require('../../bus/bus.js');
const buscomponent = require('../../stbuscomponent.js');
const cfg = require('../../config.js').config();
const _ = require('lodash');
const util = require('util');

exports.fakeBus = function(handlers) {
	const mainBus = new bus.Bus();
	const ManagerType = function() {};
	
	util.inherits(ManagerType, buscomponent.BusComponent);
	
	const defaultHandlers = {
		'get-readability-mode': () => { return { readonly: false } },
		'getServerConfig': () => cfg
	};
	
	handlers = _.defaults(handlers, defaultHandlers);
	
	for (const hname in handlers) {
		// better: allow injection-style array argument names
		const handler = handlers[hname];
		const argumentNames = String(handler).match(/[^\(]*\(([^\)]*)\)/)[1].split(',').map(s => s.trim());
		ManagerType.prototype['handler_' + hname] = buscomponent.provide(hname, argumentNames, handler);
	}
	
	const manager = new ManagerType();
	return manager.setBus(mainBus, 'test-manager').then(() => {
		// better way: destructuring
		mainBus.manager = manager;
		return mainBus;
	});
}
