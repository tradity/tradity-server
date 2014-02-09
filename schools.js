(function () { "use strict";
	
var _ = require('underscore');
var util = require('util');
var assert = require('assert');

function SchoolsDB (db, config) {
	this.db = db;
	this.cfg = config;
}
util.inherits(SchoolsDB, require('./objects.js').DBSubsystemBase);

SchoolsDB.prototype.loadSchoolInfo = function(lookfor, user, access, cb) {
	this.query('SELECT * FROM schools WHERE ? IN (id, path, name) LIMIT 1', [lookfor], {
		
	});
};

SchoolsDB.prototype.getSchoolInfo = function(query, user, access, cb) {
	cb('get-school-info-success', SchoolsDB.loadSchoolInfo(query.lookfor, user, access));
};

exports.SchoolsDB = SchoolsDB;

})();
