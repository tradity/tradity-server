(function () { "use strict";
	
var _ = require('underscore');
var util = require('util');
var assert = require('assert');

function SchoolsDB (db, config) {
	this.db = db;
	this.cfg = config;
}
util.inherits(SchoolsDB, require('./objects.js').DBSubsystemBase);

SchoolsDB.prototype.getSchoolInfo = function(query, user, access, cb) {
};

exports.SchoolsDB = SchoolsDB;

})();
