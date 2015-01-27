(function () { "use strict";

var assert = require('assert');
var _ = require('lodash');
var Q = require('q');

function BusComponent () {
	this.bus = null;
	this.componentName = null;
	this.wantsUnplug = false;
	this.callbackFilters = [];
}

BusComponent.objCount = 0;

BusComponent.prototype.setBus = function(bus, componentName) {
	assert.ok(bus);
	assert.ok(!this.bus);
	
	this.bus = bus;
	this.componentName = componentName;
	this.unansweredBusRequests = 0;
	this.wantsUnplug = false;
	this.initPromise = null;
	
	this.registerProviders();
	
	return Q(this.onBusConnect());
};

BusComponent.prototype.setBusFromParent = function(component) {
	assert.ok(component.bus);
	
	return this.setBus(component.bus, component.componentName + '-' + (BusComponent.objCount++));
};

BusComponent.prototype.unplugBus = function() {
	assert.ok(this.bus);
	
	this.wantsUnplug = true;
	
	if (this.unansweredBusRequests == 0) {
		this.unregisterProviders();
		this.bus = null;
		this.componentName = null;
		this.initPromise = null;
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
	assert.ok(!onReply); // temporary
	assert.ok(this.bus);
	assert.ok(req);
	
	var deferred = Q.defer();
	
	onReply = function(result) {
		return deferred.resolve(result);
	};
	
	for (var i = 0; i < this.callbackFilters.length; ++i)
		onReply = this.callbackFilters[i](onReply);
	
	this.unansweredBusRequests++;
	this.bus[requestType](this.imprint(req), _.bind(function() {
		this.unansweredBusRequests--;
		if (this.wantsUnplug)
			this.unplugBus();
		
		var returnValue = Array.prototype.slice.apply(arguments); 
		if (requestType == 'request' || requestType == 'requestNearest')
			returnValue = returnValue[0];
		
		return onReply(returnValue);
	}, this));
	
	return deferred.promise;
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
	if (!this.bus)
		throw new Error('Cannot emit event "' + name + '" without bus connection');
	return this.bus.emit(name, data);
};

BusComponent.prototype.emitImmediate = function(name, data) {
	if (!this.bus)
		throw new Error('Cannot emit event "' + name + '" without bus connection');
	return this.bus.emitImmediate(name, data);
};

BusComponent.prototype.emitLocal = function(name, data) {
	if (!this.bus)
		throw new Error('Cannot emit event "' + name + '" without bus connection');
	return this.bus.emitLocal(name, data);
};

BusComponent.prototype.emitGlobal = function(name, data) {
	if (!this.bus)
		throw new Error('Cannot emit event "' + name + '" without bus connection');
	return this.bus.emitGlobal(name, data);
};

BusComponent.prototype.emitError = function(e) {
	if (!this.bus)
		throw e;
	return this.bus.emitImmediate('error', e);
};

function provide(name, args, fn, prefilter) {
	fn.isProvider = true;
	fn.providedRequest = name;
	
	fn.requestCB = function(data) {
		if (prefilter && prefilter(data))
			return;
		
		var passArgs = [];
		for (var i = 0; i < args.length; ++i)
			passArgs.push(data[args[i]]);
		
		var this_ = this;
		
		return Q().then(function() {
			return fn.apply(this_, passArgs);
		}).then(function(result) {
			return data.reply(result);
		}).catch(function(e) {
			this_.emitError(e);
		}).done();
	};
	
	return fn;
};

function listener(name, fn) {
	fn.isProvider = true;
	fn.providedRequest = name;
	fn.requestCB = fn;
	
	return fn;
};

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

BusComponent.prototype._init = function() { this.initPromise = null; };
BusComponent.prototype.onBusConnect = function() {};

function needsInit (fn) {
	return function() {
		var this_ = this;
		var arguments_ = arguments;
		
		if (this.initPromise === null)
			this.initPromise = Q(this._init());
		
		return this.initPromise.then(function() {
			return fn.apply(this_, arguments_);
		});
	};
};

exports.BusComponent = BusComponent;
exports.listener     = listener;
exports.provide      = provide;
exports.needsInit    = needsInit;

})();
