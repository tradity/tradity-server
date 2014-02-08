(function () { "use strict";

// server,filesystem,stocks,userdb,moderate,schooldb
var Access = function() {
	this.areas = [];
	this.hasAnyAccess = false;
}

Access.fromJSON = function(j) {
	var a = new Access();
	if (!j)
		return a;
		
	if (j.trim() == '*') {
		a.grant('*');
	} else {
		var p = JSON.parse(j);
		
		for (var i = 0; i < p.length; ++i) 
			a.grant(p[i]);
	}
	
	return a;
}

Access.prototype.toString =
Access.prototype.toJSON = function() {
	if (this.hasAnyAccess)
		return '["*"]';
	return JSON.stringify(this.areas);
}

Access.prototype.toArray = function() {
	if (this.hasAnyAccess)
		return ['*'];
	return this.areas;
}

Access.prototype.has = function(area) {
	return this.hasAnyAccess || (this.areas.indexOf(area) != -1);
}

Access.prototype.update = function(otherAccess) {
	if (otherAccess.hasAnyAccess)
		this.grant('*');
	
	for (var i = 0; i < otherAccess.areas.length; ++i)
		this.grant(otherAccess.areas[i]);
}

Access.prototype.grant = function(area) {
	area = area.trim();
	if (!area)
		return;
	
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
