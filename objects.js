(function () { "use strict";

var util = require('util');
var events = require('events');
var locking = require('./locking.js');
var templates = require('./templates-compiled.js');
var assert = require('assert');
var _ = require('underscore');

function DBSubsystemBase () {
	this.db = null;
	this.lockAuthority = null;
	this.feedController = null;
}

util.inherits(DBSubsystemBase, events.EventEmitter);

DBSubsystemBase.prototype.timeQueryWrap = function(fn, connid) {
	if (this.cfg && this.cfg.timeQueries) {
		return _.bind(function(query, data, cb) {
			var tStart = new Date().getTime();
			
			fn(query, data, _.bind(function() {
				var tEnd = new Date().getTime();
				console.log('Query ', connid, query.substr(0, 60), ' took ', tEnd - tStart, 'ms');
				
				cb.apply(this, arguments);
			}, this));
		}, this);
	} else {
		return fn;
	}
};

DBSubsystemBase.prototype.query = function(query, data, cb) {
	data = data || [];
	
	this.timeQueryWrap(_.bind(this.db.query, this.db), '*')(query, data, this.queryCallback(cb, query, data));
};

DBSubsystemBase.prototype.getConnection = function(conncb) {
	this.db.getConnection(_.bind(function(err, cn) {
		if (err)
			this.emit('error', err);
			
		if (!this.dbconnid)
			this.dbconnid = 0;
		var connid = ++this.dbconnid;
		
		conncb({
			query: _.bind(function(q, data, cb) {
				data = data || [];
				this.timeQueryWrap(_.bind(cn.query, cn), connid)(q, data, this.queryCallback(cb, q, data));
			}, this),
			release: _.bind(function() {
				cn.release();
			}, this)
		});
	}, this));
};

DBSubsystemBase.prototype.queryCallback = function(cb, query, data) {	
	return _.bind(function(err, res) {
		var datajson = JSON.stringify(data);
		var querydesc = '<<' + query + '>>' + (datajson.length <= 1024 ? ' with arguments [' + new Buffer(datajson).toString('base64') + ']' : '');
		
		this.db.logQuery(querydesc);
		
		if (err) 
			this.emit('error', query ? new Error(
				err + '\nCaused by ' + querydesc
			) : err);
		else if (cb)
			_.bind(cb, this)(res);
	}, this);
};

DBSubsystemBase.prototype.feed = function(data, onEventId) {
	assert.ok(this.feedController);
	
	return this.feedController.feed(data, onEventId);
};

DBSubsystemBase.prototype.setFeedController = function(fc) {
	this.feedController = fc;
};

DBSubsystemBase.prototype.getNeededStocks = function() {
	return [];
};

DBSubsystemBase.prototype.locked = function(locks, origCB, fn) {
	if (!this.lockAuthority)
		this.lockAuthority = locking.Lock.globalLockAuthority;
	
	this.lockAuthority.locked(locks, origCB, _.bind(fn, this));
};

DBSubsystemBase.prototype.readTemplate = function(template, variables) {
	var t = templates[template];
	
	if (!t) {
		this.emit('error', new Error('Template not found: ' + template));
		return null;
	}
	
	_.chain(variables).keys().each(function(e) {
		var r = new RegExp('\\$\\{' + e + '\\}', 'g');
		t = t.replace(r, variables[e]);
	});
	
	var unresolved = t.match(/\$\{([^\}]*)\}/);
	if (unresolved) {
		this.emit('error', new Error('Unknown variable “' + unresolved[1] + '” in template ' + template));
		return null;
	}
	
	return t;
};

DBSubsystemBase.prototype.readEMailTemplate = function(template, variables) {
	var t = this.readTemplate(template, variables);
	
	var headerend = t.indexOf('\n\n');
	
	var headers = t.substr(0, headerend).split('\n');
	var body = t.substr(headerend + 2);
	
	var opt = {headers:{}};
	
	for (var i = 0; i < headers.length; ++i) {
		var h = headers[i];
		var headerNameEnd = h.indexOf(':');
		var headerName = h.substr(0, headerNameEnd).trim();
		var headerValue = h.substr(headerNameEnd + 1).trim();
		
		var camelCaseHeaderName = headerName.toLowerCase().replace(/-\w/g, function(w) { return w.toUpperCase(); }).replace(/-/g, '');
		
		if (['subject', 'from', 'to'].indexOf(camelCaseHeaderName) != -1)
			opt[camelCaseHeaderName] = headerValue;
		else
			opt.headers[headerName] = headerValue;
	}
	
	opt.html = body;
	opt.generateTextFromHTML = true;
	return opt;
};

exports.DBSubsystemBase = DBSubsystemBase;

})();
