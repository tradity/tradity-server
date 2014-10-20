(function () { "use strict";

var assert = require('assert');
var _ = require('underscore');

function BusComponent () {
	this.bus = null;
	this.componentName = null;
	this.wantsUnplug = false;
}

BusComponent.objCount = 0;

BusComponent.prototype.setBus = function(bus, componentName) {
	assert.ok(bus);
	assert.ok(!this.bus);
	
	this.bus = bus;
	this.componentName = componentName;
	this.bus.addComponent(componentName);
	this.unansweredBusRequests = 0;
	this.wantsUnplug = false;
	
	this.registerProviders();
	_.bind(this.onBusConnect, this)();
	return this;
};

BusComponent.prototype.setBusFromParent = function(component) {
	assert.ok(component.bus);
	
	this.setBus(component.bus, component.componentName + '-' + (BusComponent.objCount++));
};

BusComponent.prototype.unplugBus = function() {
	assert.ok(this.bus);
	
	this.wantsUnplug = true;
	
	if (this.unansweredBusRequests == 0) {
		this.unregisterProviders();
		this.bus.removeComponent(this.componentName);
		this.bus = null;
		this.componentName = null;
		this.inited = false;
	}
};

BusComponent.prototype.imprint = function(obj) {
	obj = _.clone(obj);
	assert.ok(!obj.senderComponentName);
	
	obj.senderComponentName = this.componentName;
	
	return obj;
};

for (var requestType_ in {request:0, requestImmediate:0, requestNearest:0, requestLocal:0, requestGlobal:0})
(function() { var requestType = requestType_;

BusComponent.prototype[requestType] = function(req, onReply) {
	onReply = _.bind(onReply || function () {}, this);
	assert.ok(this.bus);
	assert.ok(req);
	
	this.unansweredBusRequests++;
	this.bus[requestType](this.imprint(req), _.bind(function() {
		this.unansweredBusRequests--;
		if (this.wantsUnplug)
			this.unplugBus();
		
		onReply.apply(this, arguments);
	}, this));
};

})();

BusComponent.prototype.removeListener = function(event, listener) {
	assert.ok(this.bus);
	return this.bus.removeListener(event, listener);
};

BusComponent.prototype.on = function(event, listener) {
	assert.ok(this.bus);
	return this.bus.on(event, listener);
};

BusComponent.prototype.once = function(event, listener) {
	assert.ok(this.bus);
	return this.bus.once(event, listener);
};

BusComponent.prototype.emit = function(name, data) {
	return this.bus.emit(name, data);
};

BusComponent.prototype.emitImmediate = function(name, data) {
	return this.bus.emitImmediate(name, data);
};

BusComponent.prototype.emitLocal = function(name, data) {
	return this.bus.emitLocal(name, data);
};

BusComponent.prototype.emitGlobal = function(name, data) {
	return this.bus.emitGlobal(name, data);
};

BusComponent.prototype.emitError = function(e) {
	return this.bus.emitImmediate('error', e);
};

BusComponent.prototype.getServerConfig = function(cb) { this.request({name: 'getServerConfig'}, cb); };

function provide(name, args, fn, prefilter) {
	fn.isProvider = true;
	fn.providedRequest = name;
	
	fn.requestCB = function(data) {
		if (prefilter && prefilter(data))
			return;
		
		var passArgs = [];
		for (var i = 0; i < args.length; ++i)
			passArgs.push(data[args[i]]);
		fn.apply(this, passArgs);
	};
	
	return fn;
};

function provideW(name, args, fn) {
	return provide(name, args, fn, function(data) {
		if (data.ctx && data.reply && data.ctx.getProperty('readonly')) {
			data.reply('server-readonly');
			return true;
		}
		
		return false;
	});
};

function listener(name, fn) {
	fn.isProvider = true;
	fn.providedRequest = name;
	fn.requestCB = fn;
	
	return fn;
};

function provideQT(name, fn)  { return provide(name, ['query', 'ctx', 'reply'], fn); };
function provideQTX(name, fn) { return provide(name, ['query', 'ctx', 'xdata', 'reply'], fn); };
function provideWQT(name, fn)  { return provideW(name, ['query', 'ctx', 'reply'], fn); };
function provideWQTX(name, fn) { return provideW(name, ['query', 'ctx', 'xdata', 'reply'], fn); };

BusComponent.prototype.registerProviders = function() {
	for (var i in this) {
		if (this[i] && this[i].isProvider) {
			// create and store a bound version so it can be removed later
			if (!this[i+'-bound'])
				this[i+'-bound'] = _.bind(this[i].requestCB, this);
			
			var requests = Array.isArray(this[i].providedRequest) ? this[i].providedRequest : [this[i].providedRequest];
			
			_.each(requests, _.bind(function(r) {
				this.on(r, this[i+'-bound']);
			}, this));
		}
	}
};

BusComponent.prototype.unregisterProviders = function() {
	for (var i in this) {
		if (this[i] && this[i].isProvider) {
			assert.ok(this[i+'-bound']);
			
			var requests = Array.isArray(this[i].providedRequest) ? this[i].providedRequest : [this[i].providedRequest];
			
			_.each(requests, _.bind(function(r) {
				this.removeListener(r, this[i+'-bound']);
			}, this));
		}
	}
};

BusComponent.prototype._init = function() { this.inited = true; };
BusComponent.prototype.onBusConnect = function() {};

function needsInit (fn) {
	return function() {
		var this_ = this;
		var arguments_ = arguments;
		
		_.bind(this.inited ? function(cont) { cont(); } : function(cont) { this._init(cont); }, this)(_.bind(function() {
			assert.ok(this.inited);
			fn.apply(this_, arguments_);
		}, this));
	};
};

function errorWrap (fn) {
	return function() {
		try {
			fn.apply(this, arguments);
		} catch (e) {
			this.emitError(e);
		}
	};
};

exports.BusComponent = BusComponent;
exports.listener     = listener;
exports.provide      = provide;
exports.provideQT    = provideQT;
exports.provideQTX   = provideQTX;
exports.provideWQT   = provideWQT;
exports.provideWQTX  = provideWQTX;
exports.needsInit    = needsInit;
exports.errorWrap    = errorWrap;

})();
