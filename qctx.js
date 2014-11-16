(function () { "use strict";

var Access = require('./access.js').Access;
var util = require('util');
var assert = require('assert');
var buscomponent = require('./stbuscomponent.js');
var _ = require('lodash');

/**
 * Provides the {@link module:qctx~QContext} object.
 * 
 * @public
 * @module watchlist
 */

/**
 * Represents the context in which server code gets executed.
 * 
 * @property {?object} user  The current user’s object
 * @property {module:access~Access} access  The current privilege level
 * @property {object} properties  Various high-level properties
 * @property {function[]} debugHandlers  Debug functions to be called when debugging is enabled
 * @property {function[]} errorHandlers  Handlers in case of failures during code execution
 *                                       under this context.
 * @property {function[]} callbackFilters  Filters that are applied to bus request callbacks
 * 
 * @public
 * @constructor module:qctx~QContext
 * @augments module:stbuscomponent~STBusComponent
 */
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

/**
 * Return a copy of this QContext.
 * 
 * @return {module:qctx~QContext}  A shallow copy of this QContext.
 * @function module:qctx~QContext#clonse
 */
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

/**
 * Wrap a callback for exception handling by this callback.
 * 
 * @param {function} callback  A generic function to wrap
 * 
 * @return {function}  A callback of the same signature.
 * @function module:qctx~QContext#errorWrap
 */
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

/**
 * Serialize this QContext into a raw JS object.
 * 
 * @return {object}  An object to be passed to {@link module:qctx~fromJSON}
 * @function module:qctx~QContext#toJSON
 */
QContext.prototype.toJSON = function() {
	return { user: this.user, access: this.access, properties: this.properties };
};

/**
 * Deserialize this JS object into a new QContext.
 * 
 * @param {object} j  A serialized version as returned by {@link module:qctx~QContext#toJSON}.
 * @param {module:buscomponent~BusComponent} parentComponent  A parent component whose bus 
 *                                                            should be connected to.
 * 
 * @return {object}  A freshly created {@link module:qctx~QContext}.
 * @function module:qctx~QContext#errorWrap
 */
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

/**
 * Adds a new property to the list of context properties.
 * 
 * @param {object} propInfo
 * @param {string} propInfo.name  The name of this property
 * @param {module:access~Access} propInfo.access  Access restrictions for
 *                                                changing this property
 * @param propInfo.value  The default/initial value for this property
 * 
 * @function module:qctx~QContext#addProperty
 */
QContext.prototype.addProperty = function(propInfo) {
	this.properties[propInfo.name] = propInfo;
};

/**
 * Fetches a property value.
 * 
 * @param {string} name  The property name.
 * @return  The property value.
 * 
 * @function module:qctx~QContext#getProperty
 */
QContext.prototype.getProperty = function(name) {
	return this.properties[name].value;
};

/**
 * Returns whether a given property value exists.
 * 
 * @param {string} name  The property name.
 * @return  True iff such a property exists.
 * 
 * @function module:qctx~QContext#hasProperty
 */
QContext.prototype.hasProperty = function(name) {
	return this.properties[name] ? true : false;
};

/**
 * Sets a property value.
 * 
 * @param {string} name  The property name.
 * @param value  The new property value.
 * @param {?boolean} hasAccess  If true, pass all access checks.
 * 
 * @function module:qctx~QContext#setProperty
 */
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

/**
 * Shorthand method for pushing feed entries.
 * See {@link busreq~feed}.
 * 
 * @function module:qctx~QContext#feed
 */
QContext.prototype.feed = function(data, onEventId) { 
	return this.request({name: 'feed', data: data, ctx: this}, onEventId || function() {});
};

/**
 * Shorthand method for executing database queries.
 * See {@link busreq~dbQuery}.
 * 
 * @function module:qctx~QContext#query
 */
QContext.prototype.query = function(query, args, cb) {
	this.debug('Executing query [unbound]', query, args);
	return this.request({name: 'dbQuery', query: query, args: args}, cb); 
};

/**
 * Shorthand method for executing database queries.
 * Mostly, see {@link busreq~dbGetConnection}.
 * 
 * @param {boolean} [readonly=false]  Whether the connection requires no write access.
 * @param {function} cb  Callback that will be called with the new connection and 
 *                       commit() and rollback() shortcuts (both releasing the connection).
 * 
 * @function module:qctx~QContext#getConnection
 */
QContext.prototype.getConnection = function(readonly, cb) {
	var self = this;
	
	if (typeof readonly == 'function') {
		cb = readonly;
		readonly = false;
	}
	
	self.request({readonly: readonly, name: 'dbGetConnection'}, function(conn) {
		/* wrapper object for better debugging, no semantic change */
		var conn_ = {
			release: _.bind(conn.release, conn),
			query: function(query, args, cb) {
				self.debug('Executing query [bound]', query, args);
				conn.query(query, args, (cb || function() {}));
			}
		};
		
		var postTransaction = function(doRelease, ecb) {
			if (typeof doRelease == 'function') {
				ecb = doRelease;
				doRelease = true;
			}
			
			if (typeof doRelease == 'undefined')
				doRelease = true;
			
			ecb = ecb || function() {};
			
			if (doRelease)
				conn.release();
			ecb();
		};
		
		/* convenience functions for rollback and commit with implicit release */
		var commit = function(doRelease, ecb) {
			conn.query('COMMIT; UNLOCK TABLES; SET autocommit = 1;', [], function() { postTransaction(doRelease, ecb); });
		};
		
		var rollback = function(doRelease, ecb) {
			conn.query('ROLLBACK; UNLOCK TABLES; SET autocommit = 1;', [], function() { postTransaction(doRelease, ecb); });
		};
		
		cb(conn_, commit, rollback);
	}); 
};

/**
 * If debugging is enabled, pass the arguments of this method to the debug handlers.
 * 
 * @function module:qctx~QContext#debug
 */
QContext.prototype.debug = function() {
	if (!this.hasProperty('debugEnabled') || !this.getProperty('debugEnabled'))
		return;
	
	for (var i = 0; i < this.debugHandlers.length; ++i)
		this.debugHandlers[i](Array.prototype.slice.call(arguments));
};

/**
 * Call context-specific error handlers and pass on to
 * {@link module:buscomponent~BusComponent#emitError}.
 * 
 * @function module:qctx~QContext#emitError
 */
QContext.prototype.emitError = function(e) {
	this.debug('Caught error', e);
	
	for (var i = 0; i < this.errorHandlers.length; ++i)
		this.errorHandlers[i](e);
	
	QContext.super_.prototype.emitError.call(this, e);
};

exports.QContext = QContext;

})();
