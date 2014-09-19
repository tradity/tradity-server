(function () { "use strict";

var Access = require('./access.js').Access;

var QContext = function(obj) {
	obj = obj || {};
	this.user = obj.user || null;
	this.access = obj.access || new Access();
	this.props = {};
};

QContext.prototype.toJSON = function() {
	return { user: this.user, access: this.access };
};

exports.fromJSON =
QContext.fromJSON = function(j) {
	var ctx = new QContext();
	if (!j)
		return ctx;
	
	ctx.user = j.user || null;
	ctx.access = Access.fromJSON(j.access);
	return ctx;
};

QContext.prototype.addProperty = function(propInfo) {
	this.props[propInfo.name] = propInfo;
};

QContext.prototype.getProperty = function(name) {
	return this.props[name].value;
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

exports.QContext = QContext;

})();
