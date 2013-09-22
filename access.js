(function () { "use strict";

// server,filesystem,stocks,userdb
var Access = function() {
	this.areas = [];
	this.hasAnyAccess = false;
}

Access.fromJSON = function(j) {
	var a = new Access();
	if (!j)
		return a;
	var p = JSON.parse(j);
	
	for (var i = 0; i < p.length; ++i) 
		a.grant(p[i]);
}

Access.prototype.toString =
Access.prototype.toJSON = function() {
	if (this.hasAnyAccess)
		return '["*"]';
	return JSON.stringify(this.areas);
}

Access.prototype.has = function(area) {
	return this.hasAnyAccess || (this.areas.indexOf(area) != -1);
}

Access.prototype.update = function(otherAccess) {
	for (var i = 0; i < otherAccess.areas.length; ++i)
		this.grant(otherAccess.areas[i]);
}

Access.prototype.grant = function(area) {
	if (area == '*')
		return this.grantAny();
	
	if (this.areas.indexOf(area) == -1)
		this.areas.push(area);
}

Access.prototype.grantAny = function() {
	this.hasAnyAccess = true;
}

exports.Access = Access;

})();