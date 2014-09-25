(function () { "use strict";

var assert = require('assert');
var _ = require('underscore');

// load qctx at runtime to prevent cycle
var qctx_ = null;
var qctx = function() { if (qctx_) return qctx_; else return qctx_ = require('../qctx.js'); };

function BusComponent () {
}

BusComponent.objCount = 0;

BusComponent.prototype.setBus = function(bus, componentName) {
	assert.ok(bus);
	assert.ok(!this.bus);
	
	this.bus = bus;
	this.componentName = componentName;
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

BusComponent.prototype.request = function(req, onReply) {
	onReply = _.bind(onReply || function () {}, this);
	assert.ok(this.bus);
	assert.ok(req);
	
	this.unansweredBusRequests++;
	this.bus.request(this.imprint(req), _.bind(function() {
		this.unansweredBusRequests--;
		if (this.wantsUnplug)
			this.unplugBus();
		
		onReply.apply(this, arguments);
	}, this));
};

BusComponent.prototype.removeListener = function(event, listener) {
	assert.ok(this.bus);
	return this.bus.removeListener(event, listener);
};

BusComponent.prototype.on = function(event, listener, raw) {
	assert.ok(this.bus);
	return this.bus.on(event, raw ? listener : _.bind(listener, this));
};

BusComponent.prototype.once = function(event, listener) {
	assert.ok(this.bus);
	return this.bus.once(event, _.bind(listener, this));
};

BusComponent.prototype.emit = function() {
	var args = Array.prototype.slice.call(arguments);
	args.unshift(this.imprint(args.shift()));
	return this.bus.emit.apply(this.bus, args);
};

BusComponent.prototype.message = function(name, msg, level) {
	level = level || 'debug';
	
	this.emit({name: 'debug', message: msg, type: name, level: level});
};

BusComponent.prototype.getServerConfig = function(cb) { this.request({name: 'getServerConfig'}, cb); };

function provide(name, args, fn) {
	fn.isProvider = true;
	fn.providedRequest = name;
	
	fn.requestCB = function(data) {
		data.reply = _.bind(function() {
			var args = Array.prototype.slice.call(arguments);
			this.emit(name + '-resp', { arguments: args, replyTo: data.requestId });
		}, this);
		
		if (data.ctx && !data.ctx.toJSON)
			data.ctx = qctx().fromJSON(data.ctx, this);
		
		var passArgs = [];
		for (var i = 0; i < args.length; ++i)
			passArgs.push(data[args[i]]);
		fn.apply(this, passArgs);
	};
	
	return fn;
};

function listener(name, fn) {
	fn.isProvider = true;
	fn.providedRequest = name;
	fn.requestCB = fn;
	
	return fn;
};

function provideQT(name, fn)  { return provide(name, ['query', 'ctx', 'reply'], fn); };
function provideQTX(name, fn) { return provide(name, ['query', 'ctx', 'xdata', 'reply'], fn); };

BusComponent.prototype.registerProviders = function() {
	for (var i in this) {
		if (this[i] && this[i].isProvider) {
			// create and store a bound version so it can be removed later
			if (!this[i+'-bound'])
				this[i+'-bound'] = _.bind(this[i].requestCB, this);
			
			var requests = Array.isArray(this[i].providedRequest) ? this[i].providedRequest : [this[i].providedRequest];
			
			_.each(requests, _.bind(function(r) {
				this.on(r, this[i+'-bound'], true); // true -> raw listener / no extra binding
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
			this.emit('error', e);
		}
	};
};

exports.BusComponent = BusComponent;
exports.provide      = provide;
exports.listener     = listener;
exports.provideQT    = provideQT;
exports.provideQTX  = provideQTX;
exports.needsInit    = needsInit;
exports.errorWrap    = errorWrap;

})();
