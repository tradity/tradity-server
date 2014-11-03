(function () { "use strict";

var Access = require('./access.js').Access;
var util = require('util');
var assert = require('assert');
var buscomponent = require('./stbuscomponent.js');
var _ = require('lodash');

function QContext(obj) {
	var self = this;
	
	QContext.super_.apply(self);
	
	obj = obj || {};
	self.user = obj.user || null;
	self.access = obj.access || new Access();
	self.properties = {};
	self.debugHandlers = [];
	self.errorHandlers = [];
	
	self.callbackFilters.push(function(callback) {
		return self.errorWrap(callback);
	});
	
	if (obj.parentComponent)
		self.setBusFromParent(obj.parentComponent);
	
	self.addProperty({name: 'debugEnabled', value: false, access: 'server'});
};

util.inherits(QContext, buscomponent.BusComponent);

QContext.prototype.clone = function() {
	var c = new QContext({
		user: this.user,
		access: this.access.clone(),
		parentComponent: this
	});
	
	c.properties = _.clone(this.properties);
	c.debugHandlers = this.debugHandlers.slice();
	c.errorHandlers = this.errorHandlers.slice();
	
	return c;
};

QContext.prototype.errorWrap = function(callback) {
	var self = this;
	
	return function() {
		try {
			return callback.apply(self, arguments);
		} catch (e) {
			self.emitError(e);
		}
	};
};

QContext.prototype.onBusConnect = function() {
	var self = this;
	
	self.request({name: 'get-readability-mode'}, function(reply) {
		assert.ok(reply.readonly === true || reply.readonly === false);
		
		if (!self.hasProperty('readonly')) {
			self.addProperty({
				name: 'readonly',
				value: reply.readonly
			});
		}
	});
};

QContext.prototype.changeReadabilityMode = buscomponent.listener('change-readability-mode', function(event) {
	if (this.hasProperty('readonly'))
		this.setProperty('readonly', event.readonly);
});

QContext.prototype.toJSON = function() {
	return { user: this.user, access: this.access, properties: this.properties };
};

exports.fromJSON =
QContext.fromJSON = function(j, parentComponent) {
	var ctx = new QContext({parentComponent: parentComponent});
	if (!j)
		return ctx;
	
	ctx.user = j.user || null;
	ctx.access = Access.fromJSON(j.access);
	ctx.properties = j.properties || {};
	
	_.each(ctx.properties, function(value, key) {
		if (!value.access)
			value.access = function() { return false; };
	});
	
	return ctx;
};

QContext.prototype.addProperty = function(propInfo) {
	this.properties[propInfo.name] = propInfo;
};

QContext.prototype.getProperty = function(name) {
	return this.properties[name].value;
};

QContext.prototype.hasProperty = function(name) {
	return this.properties[name] ? true : false;
};

QContext.prototype.setProperty = function(name, value, hasAccess) {
	if (!this.hasProperty(name))
		throw new Error('Property ' + name + ' not defined yet');
	
	var requiredAccess = this.properties[name].access;
	if (!requiredAccess) {
		hasAccess = true;
	} else if (typeof requiredAccess == 'string') {
		hasAccess = hasAccess || this.access.has(requiredAccess);
	} else if (typeof requiredAccess == 'function') {
		hasAccess = hasAccess || requiredAccess(this);
	} else {
		throw new Error('Unknown access restriction ' + JSON.stringify(requiredAccess));
	}
	
	if (hasAccess)
		this.properties[name].value = value;
	else
		throw new Error('Access for changing property ' + name + ' not granted');
};

QContext.prototype.feed = function(data, onEventId) { 
	return this.request({name: 'feed', data: data, ctx: this}, onEventId || function() {});
};

QContext.prototype.query = function(query, args, cb) {
	this.debug('Executing query [unbound]', query, args);
	return this.request({name: 'dbQuery', query: query, args: args}, cb); 
};

QContext.prototype.getConnection = function(readonly, cb) {
	var self = this;
	
	if (typeof readonly == 'function') {
		cb = readonly;
		readonly = false;
	}
	
	self.request({readonly: readonly, name: 'dbGetConnection'}, function(conn) {
		cb({
			release: _.bind(conn.release, conn),
			query: function(query, args, cb) {
				self.debug('Executing query [bound]', query, args);
				conn.query(query, args, (cb || function() {}));
			}
		});
	}); 
};

QContext.prototype.debug = function() {
	if (!this.hasProperty('debugEnabled') || !this.getProperty('debugEnabled'))
		return;
	
	for (var i = 0; i < this.debugHandlers.length; ++i)
		this.debugHandlers[i](Array.prototype.slice.call(arguments));
};

QContext.prototype.emitError = function(e) {
	this.debug('Caught error', e);
	
	for (var i = 0; i < this.errorHandlers.length; ++i)
		this.errorHandlers[i](e);
	
	QContext.super_.prototype.emitError.call(this, e);
};

exports.QContext = QContext;

})();
