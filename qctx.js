(function () { "use strict";

var Access = require('./access.js').Access;
var util = require('util');
var buscomponent = require('./buscomponent.js');
var _ = require('underscore');

function QContext(obj) {
	obj = obj || {};
	this.user = obj.user || null;
	this.access = obj.access || new Access();
	this.properties = {};
	
	if (obj.parentComponent)
		this.setBusFromParent(obj.parentComponent);
};

util.inherits(QContext, buscomponent.BusComponent);

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

QContext.prototype.setProperty = function(name, value, hasAccess) {
	if (!this.properties[name])
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

QContext.prototype.feed = function(data, onEventId) { this.request({name: 'feed', data: data, ctx: this}, onEventId || function() {}); };
QContext.prototype.query = function(query, args, cb) { this.request({name: 'dbQuery', query: query, args: args}, cb); };

QContext.prototype.getConnection = function(cb) {
	this.request({name: 'dbGetConnection'}, function(conn) {
		cb({
			release: _.bind(conn.release, conn),
			query: function(query, args, cb) {
				conn.query(query, args, (cb || function() {}));
			}
		});
	}); 
};

exports.QContext = QContext;

})();
