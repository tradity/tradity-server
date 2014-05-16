(function () { "use strict";

var locking = require('./locking.js');
var assert = require('assert');
var _ = require('underscore');

function BusComponent () {
}

BusComponent.prototype.setBus = function(bus, componentName) {
	assert.ok(bus);
	assert.ok(!this.bus);
	
	this.bus = bus;
	this.componentName = componentName;
	
	this.registerProviders();
	_.bind(this.onBusConnect, this)();
	return this;
};

BusComponent.prototype.unplugBus = function() {
	assert.ok(this.bus);
	
	this.unregisterProviders();
	this.bus = null;
	this.componentName = null;
	this.inited = false;
};

BusComponent.prototype.imprint = function(obj) {
	obj = _.clone(obj);
	assert.ok(!obj.senderComponent);
	assert.ok(!obj.senderComponentName);
	
	obj.senderComponent = this;
	obj.senderComponentName = this.componentName;
	
	return obj;
};

BusComponent.prototype.request = function(req, onReply) {
	onReply = onReply || function () {};
	assert.ok(this.bus);
	assert.ok(req);
	
	this.bus.request(this.imprint(req), _.bind(onReply, this));
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
BusComponent.prototype.query = function(query, args, cb) { this.request({name: 'dbQuery', query: query, args: args}, cb); };

BusComponent.prototype.getConnection = function(cb) {
	this.request({name: 'dbGetConnection'}, function(conn) {
		cb({
			release: _.bind(conn.release, conn),
			query: _.bind(function(query, args, cb) {
				conn.query(query, args, _.bind(cb, this));
			}, this)
		});
	}); 
};

BusComponent.prototype.feed = function(data, onEventId) { this.request({name: 'feed', data: data}, onEventId); };

function provide(name, args, fn) {
	fn.isProvider = true;
	fn.providedRequest = name;
	
	fn.requestCB = function(data) {
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

function provideQUA(name, fn)  { return provide(name, ['query', 'user', 'access', 'reply'], fn); };
function provideQUAX(name, fn) { return provide(name, ['query', 'user', 'access', 'xdata', 'reply'], fn); };

BusComponent.prototype.registerProviders = function() {
	for (var i in this) {
		if (this[i] && this[i].isProvider) {
			// create and store a bound version so it can be removed later
			if (!this[i].requestCBBound)
				this[i].requestCBBound = _.bind(this[i].requestCB, this);
			
			this.on(this[i].providedRequest, this[i].requestCBBound);
		}
	}
};

BusComponent.prototype.unregisterProviders = function() {
	for (var i in this) {
		if (this[i] && this[i].isProvider) {
			assert.ok(this[i].requestCBBound);
			
			this.removeListener(this[i].providedRequest, this[i].requestCBBound);
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

// XXX this should be removed in favor of DB-side locking
BusComponent.prototype.locked = function(locks, origCB, fn) {
	if (!this.lockAuthority)
		this.lockAuthority = locking.Lock.globalLockAuthority;
	
	this.lockAuthority.locked(locks, origCB, _.bind(fn, this));
};


exports.BusComponent = BusComponent;
exports.provide      = provide;
exports.listener     = listener;
exports.provideQUA   = provideQUA;
exports.provideQUAX  = provideQUAX;
exports.needsInit    = needsInit;

})();
