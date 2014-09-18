(function () { "use strict";

var Access = require('./access.js').Access;

var QContext = function(obj) {
	obj = obj || {};
	this.user = obj.user || null;
	this.access = obj.access || new Access();
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

exports.QContext = QContext;

})();
